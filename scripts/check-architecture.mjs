import { readFileSync } from "node:fs";
import { dirname, normalize, relative, resolve, sep } from "node:path";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const SOURCE_EXTENSIONS = Object.freeze([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SOURCE_FILE_PATTERN = /^(?:services|packages)\/[^/]+\/src\/.+\.(?:[cm]?[jt]sx?|jsx)$/i;
const TASK4 = "org/04-shared-packages";
const TASK2 = "org/02-build-purity";

function debtKey(from, specifier) {
  return `${normalizeRepoPath(from)}\u0000${specifier}`;
}

/**
 * Task 4 completes with no documented service-to-service edges. The empty inventory
 * remains explicit so fixture tests can prove that an allowance must be justified
 * rather than accidentally reintroduced.
 */
export const CURRENT_SERVICE_DEBT_KEYS = Object.freeze([]);

export function normalizeRepoPath(value) {
  const slashPath = String(value).replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashPath).replace(/^(?:\.\/)+/, "");
  return normalized === "." ? "" : normalized.replace(/^\/+/, "");
}

function tokenise(source) {
  const tokens = [];
  let cursor = 0;

  const add = (kind, value, offset) => tokens.push({
    kind,
    value,
    line: 1 + (source.slice(0, offset).match(/\n/g)?.length ?? 0),
  });
  const isIdentifierStart = (character) => /[A-Za-z_$]/.test(character);
  const isIdentifierPart = (character) => /[A-Za-z0-9_$]/.test(character);

  while (cursor < source.length) {
    const character = source[cursor];
    const next = source[cursor + 1];
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      cursor += 2;
      while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") cursor += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      cursor += 2;
      while (cursor < source.length && !(source[cursor] === "*" && source[cursor + 1] === "/")) cursor += 1;
      cursor = Math.min(source.length, cursor + 2);
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      const start = cursor;
      let value = "";
      cursor += 1;
      while (cursor < source.length) {
        const current = source[cursor];
        if (current === "\\") {
          const escaped = source[cursor + 1];
          if (escaped !== undefined) value += escaped;
          cursor += 2;
          continue;
        }
        if (current === quote) {
          cursor += 1;
          break;
        }
        value += current;
        cursor += 1;
      }
      add(quote === "`" ? "template" : "string", value, start);
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = cursor;
      let value = character;
      cursor += 1;
      while (cursor < source.length && isIdentifierPart(source[cursor])) {
        value += source[cursor];
        cursor += 1;
      }
      add("word", value, start);
      continue;
    }
    add("punctuation", character, cursor);
    cursor += 1;
  }
  return tokens;
}

/** Extract only syntactically static module specifiers; comments and strings are never searched. */
export function parseModuleSpecifiers(source) {
  const tokens = tokenise(source);
  const imports = [];
  const add = (specifier, kind, line) => {
    if (!imports.some((entry) => entry.specifier === specifier && entry.kind === kind)) {
      imports.push({ specifier, kind, line });
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "word") continue;

    if (token.value === "import") {
      const next = tokens[index + 1];
      if (next?.kind === "string") {
        add(next.value, "import", token.line);
        continue;
      }
      if (next?.value === "(" && tokens[index + 2]?.kind === "string" && tokens[index + 3]?.value === ")") {
        add(tokens[index + 2].value, "dynamic-import", token.line);
        continue;
      }
      for (let candidate = index + 1; candidate < tokens.length; candidate += 1) {
        const current = tokens[candidate];
        if (current.value === ";") break;
        if (current.value === "from" && tokens[candidate + 1]?.kind === "string") {
          add(tokens[candidate + 1].value, "import", token.line);
          break;
        }
      }
      continue;
    }

    if (token.value === "export") {
      for (let candidate = index + 1; candidate < tokens.length; candidate += 1) {
        const current = tokens[candidate];
        if (current.value === ";") break;
        if (current.value === "from" && tokens[candidate + 1]?.kind === "string") {
          add(tokens[candidate + 1].value, "re-export", token.line);
          break;
        }
      }
      continue;
    }

    if (token.value === "require" && tokens[index + 1]?.value === "(" && tokens[index + 2]?.kind === "string" && tokens[index + 3]?.value === ")") {
      add(tokens[index + 2].value, "require", token.line);
    }
  }
  return imports;
}

function makeError(code, pathName, message, kind = "policy", details = {}) {
  return {
    code,
    path: normalizeRepoPath(pathName),
    message,
    kind,
    line: details.line,
    specifier: details.specifier,
  };
}

function importError(code, from, moduleImport, message, kind = "policy") {
  return makeError(code, from, message, kind, {
    line: moduleImport.line,
    specifier: moduleImport.specifier,
  });
}

function sortErrors(errors) {
  return [...errors].sort((left, right) =>
    `${left.code}\u0000${left.path}\u0000${left.line ?? 0}\u0000${left.specifier ?? ""}\u0000${left.message}`.localeCompare(`${right.code}\u0000${right.path}\u0000${right.line ?? 0}\u0000${right.specifier ?? ""}\u0000${right.message}`),
  );
}

function isProductionSource(pathName) {
  return SOURCE_FILE_PATTERN.test(normalizeRepoPath(pathName));
}

function workspaceRootFor(pathName) {
  const match = normalizeRepoPath(pathName).match(/^(services|packages)\/([^/]+)(?:\/|$)/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function classifyWorkspace(root) {
  if (root?.startsWith("services/")) return "service";
  if (root?.startsWith("packages/")) return "package";
  return undefined;
}

function splitWorkspaceSpecifier(rawSpecifier) {
  const specifier = String(rawSpecifier).replace(/\\/g, "/");
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2 || !parts[1]) return undefined;
    return {
      packageName: `${parts[0]}/${parts[1]}`,
      subpath: parts.length > 2 ? `./${parts.slice(2).join("/")}` : ".",
    };
  }
  if (!parts[0]) return undefined;
  return {
    packageName: parts[0],
    subpath: parts.length > 1 ? `./${parts.slice(1).join("/")}` : ".",
  };
}

function exportEntryFor(manifest, subpath) {
  const exportsField = manifest.exports;
  if (exportsField === undefined) return subpath === "." ? {} : undefined;
  if (typeof exportsField === "string" || Array.isArray(exportsField)) return subpath === "." ? exportsField : undefined;
  if (exportsField === null || typeof exportsField !== "object") return undefined;

  const keys = Object.keys(exportsField);
  const hasSubpathMap = keys.some((key) => key.startsWith("."));
  if (!hasSubpathMap) return subpath === "." ? exportsField : undefined;
  if (Object.hasOwn(exportsField, subpath)) return exportsField[subpath];

  for (const key of keys.sort()) {
    if (!key.includes("*")) continue;
    const [prefix, suffix] = key.split("*");
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) return exportsField[key];
  }
  return undefined;
}

function exportTargets(entry) {
  if (typeof entry === "string") return [entry];
  if (Array.isArray(entry)) return entry.flatMap(exportTargets);
  if (entry && typeof entry === "object") return Object.values(entry).flatMap(exportTargets);
  return [];
}

function exportsWorkerSource(workspace, entry) {
  return exportTargets(entry).some((target) => {
    if (!target.startsWith(".")) return false;
    const resolved = path.posix.normalize(path.posix.join(workspace.root, target));
    return resolved.includes("/src/worker/") || resolved.endsWith("/src/worker");
  });
}

function relativeImportTarget(fromPath, rawSpecifier, allSourcePaths) {
  const sourcePath = normalizeRepoPath(fromPath);
  const specifier = String(rawSpecifier).replace(/\\/g, "/");
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  if (target === ".." || target.startsWith("../")) return undefined;

  const extension = path.posix.extname(target);
  const withoutExtension = extension ? target.slice(0, -extension.length) : target;
  const candidates = [target];
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    candidates.push(...SOURCE_EXTENSIONS.map((candidateExtension) => `${withoutExtension}${candidateExtension}`));
  } else if (!extension) {
    candidates.push(...SOURCE_EXTENSIONS.map((candidateExtension) => `${target}${candidateExtension}`));
    candidates.push(...SOURCE_EXTENSIONS.map((candidateExtension) => `${target}/index${candidateExtension}`));
  }
  return candidates.find((candidate) => allSourcePaths.has(candidate));
}

function parseDate(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function validateServiceAllowances(config, errors, now) {
  const allowances = config.serviceImportAllowances;
  if (!Array.isArray(allowances)) {
    errors.push(makeError("ARCH_MALFORMED_ALLOWANCE", "scripts/architecture-boundaries.json", "serviceImportAllowances must be an array.", "setup"));
    return new Map();
  }
  const result = new Map();
  for (const allowance of allowances) {
    const pathName = allowance?.from ?? "scripts/architecture-boundaries.json";
    if (!allowance || typeof allowance !== "object" || typeof allowance.from !== "string" || typeof allowance.specifier !== "string" || typeof allowance.reason !== "string" || !allowance.reason.trim() || typeof allowance.removeBy !== "string" || !allowance.removeBy.trim() || /[*?]/.test(allowance.from) || /[*?]/.test(allowance.specifier)) {
      errors.push(makeError("ARCH_MALFORMED_ALLOWANCE", pathName, "Each service allowance needs exact from, specifier, reason, and removeBy fields; wildcards are forbidden.", "setup"));
      continue;
    }
    const key = debtKey(allowance.from, allowance.specifier);
    if (result.has(key)) {
      errors.push(makeError("ARCH_MALFORMED_ALLOWANCE", allowance.from, `Duplicate service allowance for ${allowance.specifier}.`, "setup"));
      continue;
    }
    const expiry = parseDate(allowance.expiresOn);
    if (expiry === null) {
      errors.push(makeError("ARCH_MALFORMED_ALLOWANCE", allowance.from, "expiresOn must use YYYY-MM-DD when supplied.", "setup"));
      continue;
    }
    result.set(key, { ...allowance, from: normalizeRepoPath(allowance.from), expiry, used: false });
    if (expiry !== undefined && expiry.getTime() < now.getTime()) {
      errors.push(makeError("ARCH_EXPIRED_ALLOWANCE", allowance.from, `Allowance for ${allowance.specifier} expired on ${allowance.expiresOn}.`));
    }
  }
  return result;
}

function validateHygieneAllowances(config, errors, now) {
  const allowances = config.hygieneAllowances;
  if (!Array.isArray(allowances)) {
    errors.push(makeError("ARCH_MALFORMED_HYGIENE_ALLOWANCE", "scripts/architecture-boundaries.json", "hygieneAllowances must be an array.", "setup"));
    return new Map();
  }
  const result = new Map();
  for (const allowance of allowances) {
    const pathName = allowance?.path ?? "scripts/architecture-boundaries.json";
    if (!allowance || typeof allowance !== "object" || allowance.path !== "pyvenv.cfg" || typeof allowance.reason !== "string" || !allowance.reason.trim() || allowance.owner !== TASK2 || allowance.removeBy !== TASK2) {
      errors.push(makeError("ARCH_MALFORMED_HYGIENE_ALLOWANCE", pathName, `Only the exact root pyvenv.cfg debt may be allowed, with reason and owner/removeBy ${TASK2}.`, "setup"));
      continue;
    }
    if (result.has(allowance.path)) {
      errors.push(makeError("ARCH_MALFORMED_HYGIENE_ALLOWANCE", allowance.path, "Duplicate hygiene allowance.", "setup"));
      continue;
    }
    const expiry = parseDate(allowance.expiresOn);
    if (expiry === null) {
      errors.push(makeError("ARCH_MALFORMED_HYGIENE_ALLOWANCE", allowance.path, "expiresOn must use YYYY-MM-DD when supplied.", "setup"));
      continue;
    }
    result.set(allowance.path, { ...allowance, expiry, used: false });
    if (expiry !== undefined && expiry.getTime() < now.getTime()) {
      errors.push(makeError("ARCH_EXPIRED_HYGIENE_ALLOWANCE", allowance.path, `Allowance expired on ${allowance.expiresOn}.`));
    }
  }
  return result;
}

function matchesCurrentDebtInventory(config, allowances, errors) {
  if (config.assertCurrentServiceDebt !== true) return;
  const current = new Set(CURRENT_SERVICE_DEBT_KEYS);
  const actual = new Set(allowances.keys());
  const missing = [...current].filter((key) => !actual.has(key));
  const unexpected = [...actual].filter((key) => !current.has(key));
  const wrongRemovalTask = [...allowances.values()].filter((allowance) => allowance.removeBy !== TASK4);
  if (missing.length || unexpected.length || wrongRemovalTask.length) {
    const details = [
      missing.length ? `missing ${missing.length}` : "",
      unexpected.length ? `unexpected ${unexpected.length}` : "",
      wrongRemovalTask.length ? `wrong removeBy ${wrongRemovalTask.length}` : "",
    ].filter(Boolean).join(", ");
    errors.push(makeError("ARCH_DEBT_INVENTORY_DRIFT", "scripts/architecture-boundaries.json", `Current service debt inventory must exactly match the reviewed entries (${details}).`, "setup"));
  }
}

function dependencyDeclared(manifest, dependencyName) {
  return Boolean(manifest.dependencies && Object.hasOwn(manifest.dependencies, dependencyName));
}

const DETERMINISTIC_VECTOR_SUFFIXES = Object.freeze([
  ".assertion",
  ".b64",
  ".config",
  ".der.hex",
  ".expected-result",
  ".hex",
  ".id",
  ".key_id",
  ".license",
  ".lic",
  ".md",
  ".mjs",
  ".payload",
  ".pem",
  ".token",
  ".txt",
]);

function isGeneratedPrivateKey(filename) {
  return /(?:^|[_.-])(?:private|secret)[_.-]?(?:key|keys?)(?:[_.-]|$)/i.test(filename)
    || /(?:private|secret)[_.-]?key.*\.(?:pem|key|rsa|der)$/i.test(filename);
}

function isAllowedDeterministicVector(pathName, filename) {
  return pathName.startsWith("test/vectors/")
    && DETERMINISTIC_VECTOR_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

function isExampleFile(filename) {
  return /\.example\./i.test(filename);
}

function isLocalWranglerConfig(filename) {
  return /^wrangler(?:\.[^.]+)*\.(?:toml|json|jsonc|ya?ml)$/i.test(filename) && !isExampleFile(filename);
}

function isLocalEnvironmentSecret(filename) {
  if (isExampleFile(filename)) return false;
  return /^\.env(?:\..*)?$/i.test(filename) || /^\.dev\.vars(?:\..*)?$/i.test(filename);
}

function evaluateHygiene(trackedPaths, hygieneAllowances, errors) {
  for (const rawPath of [...new Set(trackedPaths.map(normalizeRepoPath))].sort()) {
    const pathName = normalizeRepoPath(rawPath);
    if (!pathName) continue;
    if (pathName === "build/.gitkeep") continue;
    if (/(?:^|\/)build(?:\/|$)/.test(pathName)) {
      errors.push(makeError("ARCH_TRACKED_BUILD_ARTIFACT", pathName, "Tracked build output is forbidden except build/.gitkeep."));
      continue;
    }
    if (/(?:^|\/)dist(?:\/|$)/.test(pathName)) {
      errors.push(makeError("ARCH_TRACKED_DIST_ARTIFACT", pathName, "Tracked dist output is forbidden."));
      continue;
    }
    if (/(?:^|\/)\.wrangler(?:\/|$)/.test(pathName)) {
      errors.push(makeError("ARCH_TRACKED_WRANGLER_STATE", pathName, "Tracked .wrangler state is forbidden."));
      continue;
    }
    if (/(?:^|\/)node_modules(?:\/|$)/.test(pathName)) {
      errors.push(makeError("ARCH_TRACKED_NODE_MODULES", pathName, "Tracked node_modules content is forbidden."));
      continue;
    }
    const filename = path.posix.basename(pathName).toLowerCase();
    if (isGeneratedPrivateKey(filename)) {
      errors.push(makeError("ARCH_GENERATED_PRIVATE_KEY", pathName, "Generated private key material is forbidden, including test vectors."));
      continue;
    }
    if (pathName.startsWith("test/vectors/")) {
      if (!isAllowedDeterministicVector(pathName, filename)) {
        errors.push(makeError("ARCH_UNAPPROVED_VECTOR_FIXTURE", pathName, "Tracked test/vectors fixtures must use an explicit deterministic public-fixture suffix."));
      }
      continue;
    }
    if (pathName === "pyvenv.cfg") {
      const allowance = hygieneAllowances.get(pathName);
      if (allowance) {
        allowance.used = true;
      } else {
        errors.push(makeError("ARCH_ROOT_PYVENV", pathName, "Tracked root pyvenv.cfg requires the exact temporary Task 2 allowance."));
      }
      continue;
    }
    if (isLocalWranglerConfig(filename)) {
      errors.push(makeError("ARCH_LOCAL_WRANGLER_CONFIG", pathName, "Tracked local Wrangler configuration must be an explicit wrangler.example.* file."));
      continue;
    }
    if (isLocalEnvironmentSecret(filename)) {
      errors.push(makeError("ARCH_LOCAL_ENVIRONMENT_SECRET", pathName, "Tracked local environment secrets are forbidden."));
      continue;
    }
    if (filename.endsWith(".lic") || filename.endsWith(".license")) {
      errors.push(makeError("ARCH_GENERATED_LICENSE", pathName, "Generated license material belongs only in deterministic test/vectors fixtures."));
      continue;
    }
  }
  for (const allowance of hygieneAllowances.values()) {
    if (!allowance.used) {
      errors.push(makeError("ARCH_UNUSED_HYGIENE_ALLOWANCE", allowance.path, "Temporary hygiene allowance no longer matches a tracked path."));
    }
  }
}

function buildWorkspaces(manifests, errors) {
  const byRoot = new Map();
  const byName = new Map();
  for (const entry of manifests) {
    const root = normalizeRepoPath(entry?.root ?? "");
    const manifest = entry?.json;
    if (!root || !manifest || typeof manifest !== "object" || typeof manifest.name !== "string" || !manifest.name) {
      errors.push(makeError("ARCH_MALFORMED_WORKSPACE_MANIFEST", root || "package.json", "Workspace manifests need a root and a non-empty name.", "setup"));
      continue;
    }
    if (byRoot.has(root) || byName.has(manifest.name)) {
      errors.push(makeError("ARCH_MALFORMED_WORKSPACE_MANIFEST", root, `Duplicate workspace root or package name ${manifest.name}.`, "setup"));
      continue;
    }
    const workspace = { root, category: classifyWorkspace(root), ...manifest };
    byRoot.set(root, workspace);
    byName.set(manifest.name, workspace);
  }
  return { byRoot, byName };
}

/**
 * Pure checker core. Production code supplies only tracked source/path data;
 * fixture tests pass an in-memory equivalent to prove each policy branch.
 */
export function evaluateArchitecture({ sourceFiles = [], manifests = [], trackedPaths = [], config, now = new Date() } = {}) {
  const errors = [];
  if (!config || typeof config !== "object" || config.version !== 1) {
    errors.push(makeError("ARCH_MALFORMED_CONFIG", "scripts/architecture-boundaries.json", "Expected version: 1 architecture-boundaries configuration.", "setup"));
    const sortedErrors = sortErrors(errors);
    return { errors: sortedErrors, diagnostics: sortedErrors.map(formatDiagnostic), exitCode: 2 };
  }

  const validNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const allowances = validateServiceAllowances(config, errors, validNow);
  const hygieneAllowances = validateHygieneAllowances(config, errors, validNow);
  matchesCurrentDebtInventory(config, allowances, errors);
  const { byRoot: workspaceByRoot, byName: workspaceByName } = buildWorkspaces(manifests, errors);

  const productionFiles = sourceFiles
    .filter((entry) => entry && typeof entry.path === "string" && typeof entry.source === "string" && isProductionSource(entry.path))
    .map((entry) => ({ path: normalizeRepoPath(entry.path), source: entry.source }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const allResolvablePaths = new Set([
    ...trackedPaths.map(normalizeRepoPath),
    ...productionFiles.map((entry) => entry.path),
  ]);

  for (const { path: from, source } of productionFiles) {
    const importerRoot = workspaceRootFor(from);
    const importer = workspaceByRoot.get(importerRoot);
    if (!importer) {
      errors.push(makeError("ARCH_MISSING_WORKSPACE_MANIFEST", from, "Tracked production source has no tracked workspace package.json.", "setup"));
      continue;
    }

    for (const moduleImport of parseModuleSpecifiers(source)) {
      const { specifier } = moduleImport;
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const target = specifier.startsWith("/") ? undefined : relativeImportTarget(from, specifier, allResolvablePaths);
        if (!target) {
          errors.push(importError("ARCH_UNRESOLVED_RELATIVE", from, moduleImport, `Cannot resolve relative import ${specifier}.`));
          continue;
        }
        const targetRoot = workspaceRootFor(target);
        const targetWorkspace = workspaceByRoot.get(targetRoot);
        if (from.includes("/src/ui/") && target.includes("/src/worker/")) {
          errors.push(importError("ARCH_UI_TO_WORKER", from, moduleImport, "UI source may not import Worker source."));
        }
        if (targetWorkspace && targetRoot !== importerRoot) {
          errors.push(importError("ARCH_CROSS_WORKSPACE_RELATIVE", from, moduleImport, "Cross-workspace relative imports are forbidden; import an exported workspace package and declare it in dependencies."));
        }
        continue;
      }

      const parsed = splitWorkspaceSpecifier(specifier);
      const target = parsed ? workspaceByName.get(parsed.packageName) : undefined;
      if (!target || !parsed) continue;

      if (!dependencyDeclared(importer, parsed.packageName)) {
        errors.push(importError("ARCH_UNDECLARED_WORKSPACE_DEPENDENCY", from, moduleImport, `${parsed.packageName} is not declared in dependencies.`));
      }
      const exportEntry = exportEntryFor(target, parsed.subpath);
      if (exportEntry === undefined) {
        errors.push(importError("ARCH_UNRESOLVED_WORKSPACE_SUBPATH", from, moduleImport, `${specifier} is not exported by ${parsed.packageName}.`));
      }

      if (importer.category === "package" && target.category === "service") {
        errors.push(importError("ARCH_PACKAGE_TO_SERVICE", from, moduleImport, `Package source may not import deployable ${parsed.packageName}.`));
      }
      if (from.includes("/src/ui/") && exportEntry !== undefined && exportsWorkerSource(target, exportEntry)) {
        errors.push(importError("ARCH_UI_TO_WORKER", from, moduleImport, `UI source may not import a workspace export implemented under ${target.root}/src/worker/.`));
      }
      if (importer.category === "service" && target.category === "service" && importer.root !== target.root) {
        const allowance = allowances.get(debtKey(from, specifier));
        if (allowance) {
          allowance.used = true;
        } else {
          errors.push(importError("ARCH_SERVICE_TO_SERVICE", from, moduleImport, `Service ${importer.name} may not import deployable ${parsed.packageName}.`));
        }
      }
    }
  }

  for (const allowance of allowances.values()) {
    if (!allowance.used) {
      errors.push(makeError("ARCH_UNUSED_ALLOWANCE", allowance.from, `Temporary service allowance for ${allowance.specifier} no longer matches production source.`));
    }
  }
  evaluateHygiene(trackedPaths, hygieneAllowances, errors);

  const sortedErrors = sortErrors(errors);
  const exitCode = sortedErrors.some((error) => error.kind === "setup") ? 2 : sortedErrors.length ? 1 : 0;
  return { errors: sortedErrors, diagnostics: sortedErrors.map(formatDiagnostic), exitCode };
}

function formatDiagnostic(error) {
  const location = error.line === undefined ? error.path : `${error.path}:${error.line}`;
  const edge = error.specifier === undefined ? "" : ` -> ${error.specifier}`;
  return `[${error.code}] ${location}${edge}: ${error.message}`;
}

function trackedPathsFromGit(repoRoot) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "buffer", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ls-files -z exited ${result.status}: ${result.stderr?.toString("utf8") ?? ""}`);
  return result.stdout.toString("utf8").split("\0").filter(Boolean).map(normalizeRepoPath);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function repositoryInput(repoRoot) {
  const trackedPaths = trackedPathsFromGit(repoRoot);
  const sourceFiles = trackedPaths
    .filter(isProductionSource)
    .map((pathName) => ({ path: pathName, source: readFileSync(resolve(repoRoot, ...pathName.split("/")), "utf8") }));
  const manifests = trackedPaths
    .filter((pathName) => /^(?:services|packages)\/[^/]+\/package\.json$/.test(pathName))
    .map((pathName) => ({
      root: path.posix.dirname(pathName),
      json: readJson(resolve(repoRoot, ...pathName.split("/"))),
    }));
  return {
    sourceFiles,
    manifests,
    trackedPaths,
    config: readJson(resolve(repoRoot, "scripts", "architecture-boundaries.json")),
  };
}

export function runArchitectureCheck(repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  try {
    const result = evaluateArchitecture(repositoryInput(repoRoot));
    for (const diagnostic of result.diagnostics) console.error(diagnostic);
    if (result.exitCode === 0) console.log("Architecture policy passed.");
    return result.exitCode;
  } catch (error) {
    console.error(`[ARCH_SETUP] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = runArchitectureCheck();
}
