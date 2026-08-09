import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import * as vm from "node:vm";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const BASELINE_DIRECTORY = path.join(REPOSITORY_ROOT, "test", "contracts");
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

const DEPLOYABLES = Object.freeze([
  { id: "backend", directory: "services/cloudflare-licensing-backend", expectedRoutes: 19 },
  { id: "admin", directory: "services/cloudflare-license-admin", expectedRoutes: 65 },
  { id: "portal", directory: "services/cloudflare-customer-portal", expectedRoutes: 18 },
  { id: "backup", directory: "services/cloudflare-d1-backup" },
]);

export function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") {
    throw new TypeError(`Contract values must be JSON-compatible; found ${typeof value}.`);
  }
  const result = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    result[key] = canonicalize(value[key]);
  }
  return result;
}

export function assertNoDuplicateEntries(entries, label) {
  const seen = new Set();
  for (const entry of entries) {
    const key = Array.isArray(entry) ? entry[0] : entry;
    const printable = String(key);
    if (seen.has(printable)) {
      const noun = /component/i.test(label)
        ? "component key"
        : /route/i.test(label)
          ? "route key"
          : /openapi operation/i.test(label)
            ? "OpenAPI operation"
            : "key";
      throw new Error(`Duplicate ${noun} ${JSON.stringify(printable)} in ${label}.`);
    }
    seen.add(printable);
  }
}

export function validateRouteInventory(routes, routeKeys, label) {
  if (!Array.isArray(routes) || !Array.isArray(routeKeys)) {
    throw new TypeError(`${label} must export a route array and a route-key array.`);
  }
  const inventoryKeys = routes.map((route) => {
    if (!route || typeof route.method !== "string" || typeof route.path !== "string") {
      throw new TypeError(`${label} contains a route without string method and path fields.`);
    }
    return `${route.method.toUpperCase()} ${route.path}`;
  });
  assertNoDuplicateEntries(inventoryKeys, `${label} route inventory`);
  assertNoDuplicateEntries(routeKeys, `${label} route keys`);
  return { inventoryKeys, routeKeys: [...routeKeys] };
}

export function validateOpenApiDocument(document, label) {
  if (!document || typeof document !== "object" || !document.paths || typeof document.paths !== "object" || Array.isArray(document.paths)) {
    throw new TypeError(`${label} must expose an OpenAPI document with an object-valued paths field.`);
  }
  const operations = [];
  const operationIds = [];
  assertNoDuplicateEntries(Object.entries(document.paths), `${label} OpenAPI paths`);
  for (const [pathName, pathItem] of Object.entries(document.paths)) {
    if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      operations.push(`${method.toUpperCase()} ${pathName}`);
      if (operation && typeof operation === "object" && typeof operation.operationId === "string") {
        operationIds.push(operation.operationId);
      }
    }
  }
  assertNoDuplicateEntries(operations, `${label} OpenAPI operation keys`);
  assertNoDuplicateEntries(operationIds, `${label} OpenAPI operation identifiers`);

  if (document.components !== undefined) {
    if (!document.components || typeof document.components !== "object" || Array.isArray(document.components)) {
      throw new TypeError(`${label} components must be an object when present.`);
    }
    for (const [componentType, entries] of Object.entries(document.components)) {
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      assertNoDuplicateEntries(Object.entries(entries), `${label} components.${componentType}`);
    }
  }
  return { operationCount: operations.length, operationKeys: operations };
}

function propertyNameText(node, typescript, sourceFile) {
  if (!node.name || typescript.isComputedPropertyName(node.name)) return undefined;
  if (typescript.isIdentifier(node.name) || typescript.isStringLiteral(node.name) || typescript.isNumericLiteral(node.name)) {
    return node.name.text;
  }
  return node.name.getText(sourceFile);
}

function objectLiteralContext(node, typescript, sourceFile) {
  const ancestorPropertyNames = [];
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (typescript.isPropertyAssignment(parent) && parent.initializer === current) {
      const name = propertyNameText(parent, typescript, sourceFile);
      if (name !== undefined) ancestorPropertyNames.push(name);
    }
    current = parent;
  }
  if (ancestorPropertyNames.includes("components")) return "component key";
  if (ancestorPropertyNames[0] === "paths") return "OpenAPI path";
  if (ancestorPropertyNames.includes("paths")) return "OpenAPI operation key";
  return "OpenAPI object key";
}

/**
 * Runtime objects cannot preserve duplicate literal keys. Scan the compiled JS
 * AST before importing its OpenAPI export so duplicate schema/path/method keys
 * fail before JavaScript has a chance to overwrite an earlier declaration.
 */
export function findDuplicateOpenApiObjectKeys(source, fileName, typescript) {
  const sourceFile = typescript.createSourceFile(fileName, source, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS);
  if (sourceFile.parseDiagnostics.length) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    const position = diagnostic.start ?? 0;
    const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1;
    throw new Error(`${fileName}:${line}: compiled OpenAPI source is not parseable: ${typescript.flattenDiagnosticMessageText(diagnostic.messageText, " ")}.`);
  }
  const duplicates = [];
  const visit = (node) => {
    if (typescript.isObjectLiteralExpression(node)) {
      const keys = new Map();
      for (const property of node.properties) {
        const key = propertyNameText(property, typescript, sourceFile);
        if (key === undefined) continue;
        const existing = keys.get(key);
        if (existing !== undefined) {
          const line = sourceFile.getLineAndCharacterOfPosition(property.getStart(sourceFile)).line + 1;
          duplicates.push({
            key,
            line,
            kind: objectLiteralContext(node, typescript, sourceFile),
          });
        } else {
          keys.set(key, property);
        }
      }
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return duplicates;
}

export function assertNoDuplicateOpenApiObjectKeys(source, fileName, typescript) {
  const duplicates = findDuplicateOpenApiObjectKeys(source, fileName, typescript);
  if (duplicates.length) {
    const duplicate = duplicates[0];
    throw new Error(`${fileName}:${duplicate.line}: Duplicate ${duplicate.kind} ${JSON.stringify(duplicate.key)} in compiled OpenAPI source.`);
  }
}

export function resolveTypeScriptCompilerPath(repoRoot) {
  const rootCompilerPath = path.join(repoRoot, "node_modules", "typescript", "lib", "typescript.js");
  const serviceCompilerPaths = DEPLOYABLES
    .map((deployable) => path.join(repoRoot, deployable.directory, "node_modules", "typescript", "lib", "typescript.js"));
  const compilerPath = [rootCompilerPath, ...serviceCompilerPaths].find(existsSync);
  if (!compilerPath) throw new Error("Cannot find the root workspace TypeScript compiler (or a service-local fallback) required for compiled OpenAPI duplicate-key checks.");
  return compilerPath;
}

export async function loadTypeScript(repoRoot) {
  const compilerPath = resolveTypeScriptCompilerPath(repoRoot);
  const module = await import(pathToFileURL(compilerPath).href);
  return module.default ?? module;
}

async function assertCompiledOpenApiSources(repoRoot, compiler) {
  const files = [
    ["cloudflare-licensing-backend", path.join(repoRoot, "services", "cloudflare-licensing-backend", "dist", "openapi", "document.js")],
    ["cloudflare-license-admin", path.join(repoRoot, "services", "cloudflare-license-admin", "dist-worker", "worker", "openapi", "document.js")],
    ["cloudflare-customer-portal", path.join(repoRoot, "services", "cloudflare-customer-portal", "dist-worker", "worker", "openapi", "document.js")],
  ];
  for (const [service, filePath] of files) {
    if (!existsSync(filePath)) throw new Error(`Compiled OpenAPI module is missing: ${path.relative(repoRoot, filePath)}.`);
    assertNoDuplicateOpenApiObjectKeys(await readFile(filePath, "utf8"), `${service}/${path.relative(repoRoot, filePath)}`, compiler);
  }
}

function makeRouteContract({ service, routes, routeKeys, routeField, routeKeysField, openApi, openApiField, expectedRoutes }) {
  const routeInventory = validateRouteInventory(routes, routeKeys, service);
  const openApiInventory = validateOpenApiDocument(openApi, service);
  if (routes.length !== expectedRoutes) {
    throw new Error(`${service} route inventory changed: expected ${expectedRoutes}, found ${routes.length}. Update the reviewed contract deliberately.`);
  }
  if (routeKeys.length === 0 || routeKeys.length > routes.length) {
    throw new Error(`${service} exported route-key inventory must be non-empty and no longer than its canonical route inventory.`);
  }
  const canonicalKeys = new Set(routeInventory.inventoryKeys);
  const undeclaredKeys = routeInventory.routeKeys.filter((key) => !canonicalKeys.has(key));
  if (undeclaredKeys.length) {
    throw new Error(`${service} exported route keys are absent from its canonical route inventory: ${undeclaredKeys.sort().join(", ")}.`);
  }
  return canonicalize({
    service,
    routeCount: routes.length,
    routeKeyCount: routeKeys.length,
    openApiOperationCount: openApiInventory.operationCount,
    [routeField]: routes,
    [routeKeysField]: routeKeys,
    [openApiField]: openApi,
  });
}

function importCompiled(filePath) {
  if (!existsSync(filePath)) throw new Error(`Compiled contract module is missing: ${path.relative(REPOSITORY_ROOT, filePath)}.`);
  return import(pathToFileURL(filePath).href);
}

function runNpmBuild(directory, repoRoot) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolveBuild, rejectBuild) => {
    const args = ["--prefix", directory, "run", "build"];
    const options = {
      cwd: repoRoot,
      shell: false,
      stdio: "inherit",
    };
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    let retriedWithCli = false;
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const attach = (command, commandArgs, allowFallback) => {
      let child;
      let abandoned = false;
      try {
        // npm.cmd is the Windows command by policy. Some Node-for-Windows builds
        // reject direct .cmd spawning with shell:false (EINVAL); retain shell:false
        // and invoke that exact npm installation's JavaScript CLI only in that case.
        child = spawn(command, commandArgs, options);
      } catch (error) {
        if (allowFallback && process.platform === "win32" && error?.code === "EINVAL" && existsSync(npmCli)) {
          retriedWithCli = true;
          attach(process.execPath, [npmCli, ...args], false);
          return;
        }
        settle(() => rejectBuild(error));
        return;
      }
      child.once("error", (error) => {
        if (allowFallback && !retriedWithCli && process.platform === "win32" && error?.code === "EINVAL" && existsSync(npmCli)) {
          abandoned = true;
          retriedWithCli = true;
          attach(process.execPath, [npmCli, ...args], false);
          return;
        }
        settle(() => rejectBuild(error));
      });
      child.once("exit", (code, signal) => {
        if (abandoned) return;
        if (code === 0) settle(resolveBuild);
        else settle(() => rejectBuild(new Error(`${npm} --prefix ${directory} run build failed with ${signal ? `signal ${signal}` : `exit ${code}`}.`)));
      });
    };
    attach(npm, args, true);
  });
}

async function buildAllDeployables(repoRoot) {
  for (const deployable of DEPLOYABLES) {
    await runNpmBuild(deployable.directory, repoRoot);
  }
}

function collectBackupSurfaceFromVm(repoRoot) {
  if (typeof vm.SourceTextModule !== "function" || typeof vm.SyntheticModule !== "function") {
    throw new Error("Backup contract capture requires Node's --experimental-vm-modules mode.");
  }
  const context = vm.createContext({
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Request,
    Response,
    Headers,
    fetch,
    crypto,
    setTimeout,
    clearTimeout,
  });
  const cache = new Map();
  const workflowShim = new vm.SyntheticModule(["WorkflowEntrypoint"], function initializeCloudflareWorkers() {
    this.setExport("WorkflowEntrypoint", class WorkflowEntrypoint {
      constructor(env = {}) {
        this.env = env;
      }
    });
  }, { context, identifier: "cloudflare:workers" });

  const loadModule = async (absolutePath) => {
    const identifier = pathToFileURL(absolutePath).href;
    const existing = cache.get(identifier);
    if (existing) return existing;
    const source = readFileSync(absolutePath, "utf8");
    const module = new vm.SourceTextModule(source, { context, identifier });
    cache.set(identifier, module);
    await module.link(async (specifier, referencingModule) => {
      if (specifier === "cloudflare:workers") return workflowShim;
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        throw new Error(`Backup compiled module imports unsupported external specifier ${specifier}.`);
      }
      const target = fileURLToPath(new URL(specifier, referencingModule.identifier));
      return loadModule(target);
    });
    return module;
  };

  return (async () => {
    const entryPath = path.join(repoRoot, "services", "cloudflare-d1-backup", "dist", "index.js");
    const module = await loadModule(entryPath);
    await module.evaluate();
    const namespace = module.namespace;
    const defaultHandler = namespace.default;
    if (!defaultHandler || typeof defaultHandler !== "object") throw new Error("Backup compiled entry must export a default handler object.");
    const workflow = namespace.D1BackupWorkflow;
    if (typeof workflow !== "function") throw new Error("Backup compiled entry must export D1BackupWorkflow.");
    return canonicalize({
      service: "cloudflare-d1-backup",
      compiledEntry: "services/cloudflare-d1-backup/dist/index.js",
      namedExports: Object.keys(namespace).sort((left, right) => left.localeCompare(right)),
      defaultHandlerMethods: Object.keys(defaultHandler).sort((left, right) => left.localeCompare(right)),
      workflow: {
        export: "D1BackupWorkflow",
        prototypeMethods: Object.getOwnPropertyNames(workflow.prototype)
          .filter((name) => name !== "constructor")
          .sort((left, right) => left.localeCompare(right)),
      },
    });
  })();
}

function captureBackupSurface(repoRoot) {
  const child = spawnSync(process.execPath, ["--experimental-vm-modules", SCRIPT_PATH, "--capture-backup", repoRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`Backup compiled contract capture failed: ${child.stderr || child.stdout}`.trim());
  }
  try {
    return JSON.parse(child.stdout);
  } catch (error) {
    throw new Error(`Backup compiled contract capture did not produce JSON: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

async function captureContracts(repoRoot) {
  const compiler = await loadTypeScript(repoRoot);
  await assertCompiledOpenApiSources(repoRoot, compiler);
  const backendRoot = path.join(repoRoot, "services", "cloudflare-licensing-backend", "dist");
  const adminRoot = path.join(repoRoot, "services", "cloudflare-license-admin", "dist-worker", "worker");
  const portalRoot = path.join(repoRoot, "services", "cloudflare-customer-portal", "dist-worker", "worker");
  const [backendRoutes, backendWorker, backendOpenApi, adminRoutes, adminWorker, adminOpenApi, portalRoutes, portalWorker, portalOpenApi] = await Promise.all([
    importCompiled(path.join(backendRoot, "routes.js")),
    importCompiled(path.join(backendRoot, "index.js")),
    importCompiled(path.join(backendRoot, "openapi", "document.js")),
    importCompiled(path.join(adminRoot, "routes.js")),
    importCompiled(path.join(adminRoot, "index.js")),
    importCompiled(path.join(adminRoot, "openapi", "document.js")),
    importCompiled(path.join(portalRoot, "routes.js")),
    importCompiled(path.join(portalRoot, "index.js")),
    importCompiled(path.join(portalRoot, "openapi", "document.js")),
  ]);

  return {
    backend: makeRouteContract({
      service: "cloudflare-licensing-backend",
      routes: backendRoutes.allCanonicalRoutes(),
      routeKeys: backendWorker.BACKEND_ROUTE_KEYS,
      routeField: "allCanonicalRoutes",
      routeKeysField: "BACKEND_ROUTE_KEYS",
      openApi: backendOpenApi.openApiSpec,
      openApiField: "openApiSpec",
      expectedRoutes: 19,
    }),
    admin: makeRouteContract({
      service: "cloudflare-license-admin",
      routes: adminRoutes.ALL_ROUTES,
      routeKeys: adminWorker.API_BINDING_KEYS,
      routeField: "ALL_ROUTES",
      routeKeysField: "API_BINDING_KEYS",
      openApi: adminOpenApi.openApiDocument,
      openApiField: "openApiDocument",
      expectedRoutes: 65,
    }),
    portal: makeRouteContract({
      service: "cloudflare-customer-portal",
      routes: portalRoutes.ALL_ROUTES,
      routeKeys: portalWorker.PORTAL_ROUTE_KEYS,
      routeField: "ALL_ROUTES",
      routeKeysField: "PORTAL_ROUTE_KEYS",
      openApi: portalOpenApi.openApiDocument,
      openApiField: "openApiDocument",
      expectedRoutes: 18,
    }),
    backup: captureBackupSurface(repoRoot),
  };
}

function baselineText(contract) {
  return `${JSON.stringify(canonicalize(contract), null, 2)}\n`;
}

async function writeOrCompareBaselines(contracts, write) {
  if (write) await mkdir(BASELINE_DIRECTORY, { recursive: true });
  for (const deployable of DEPLOYABLES) {
    const baselinePath = path.join(BASELINE_DIRECTORY, `${deployable.id}.json`);
    const expected = baselineText(contracts[deployable.id]);
    if (write) {
      await writeFile(baselinePath, expected, "utf8");
      continue;
    }
    let actual;
    try {
      actual = await readFile(baselinePath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        throw new Error(`Missing reviewed contract baseline ${path.relative(REPOSITORY_ROOT, baselinePath)}. Run npm run write:contract-baselines deliberately.`);
      }
      throw error;
    }
    if (actual !== expected) {
      throw new Error(`Contract changed for ${deployable.id}: ${path.relative(REPOSITORY_ROOT, baselinePath)} differs. Review the compiled export change, then run npm run write:contract-baselines deliberately.`);
    }
  }
}

export async function runContractCheck({ repoRoot = REPOSITORY_ROOT, write = false } = {}) {
  await buildAllDeployables(repoRoot);
  const contracts = await captureContracts(repoRoot);
  await writeOrCompareBaselines(contracts, write);
  const summary = DEPLOYABLES.map((deployable) => {
    const contract = contracts[deployable.id];
    return deployable.expectedRoutes === undefined
      ? `${deployable.id} (composition surface)`
      : `${deployable.id} (${contract.routeCount} routes)`;
  }).join(", ");
  console.log(`Canonical contracts ${write ? "written" : "passed"}: ${summary}.`);
  return contracts;
}

async function runBackupCaptureChild(repoRoot) {
  const contract = await collectBackupSurfaceFromVm(repoRoot);
  process.stdout.write(JSON.stringify(contract));
}

const argumentsAfterScript = process.argv.slice(2);
const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (argumentsAfterScript[0] === "--capture-backup") {
  runBackupCaptureChild(argumentsAfterScript[1] ? path.resolve(argumentsAfterScript[1]) : REPOSITORY_ROOT).catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
} else if (invokedPath === import.meta.url) {
  const unexpected = argumentsAfterScript.filter((argument) => argument !== "--write");
  if (unexpected.length) {
    console.error(`Unsupported argument(s): ${unexpected.join(", ")}. Only --write is accepted.`);
    process.exitCode = 2;
  } else {
    runContractCheck({ write: argumentsAfterScript.includes("--write") }).catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
  }
}
