import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// These are the only legacy JavaScript graphs.  They are all checked with
// checkJs; noImplicitAny remains explicitly false until the public JSDoc
// migration can be reviewed independently (current debt: domain 80, runtime
// 214, backend graph 291, portal graph 52 diagnostics under noImplicitAny).
// Keeping this closed list prevents a new unchecked JavaScript graph or a
// silent per-file suppression from turning the quality gate false-green.
const LEGACY_JS_CONFIGS = new Set([
  "packages/licensing-domain/tsconfig.json",
  "packages/cloudflare-runtime/tsconfig.json",
  "services/cloudflare-licensing-backend/tsconfig.json",
  "services/cloudflare-customer-portal/tsconfig.worker.json",
]);

const JS_SOURCE_ROOTS = [
  "packages/licensing-domain/src/",
  "packages/cloudflare-runtime/src/",
  "services/cloudflare-licensing-backend/src/",
  "services/cloudflare-customer-portal/src/auth/",
];

// Wrangler's generated bindings stay ignored, but TypeScript must consume them
// after each fresh generation. These no-emit configurations keep production
// builds rooted at src/ while making binding drift a real typecheck input.
const WORKER_TYPECHECK_CONFIGS = new Set([
  "services/cloudflare-licensing-backend/tsconfig.typecheck.json",
  "services/cloudflare-license-admin/tsconfig.worker.typecheck.json",
  "services/cloudflare-customer-portal/tsconfig.worker.typecheck.json",
  "services/cloudflare-d1-backup/tsconfig.typecheck.json",
]);

const WORKER_BUILD_CONFIGS = new Set([
  "services/cloudflare-licensing-backend/tsconfig.json",
  "services/cloudflare-license-admin/tsconfig.worker.json",
  "services/cloudflare-customer-portal/tsconfig.worker.json",
  "services/cloudflare-d1-backup/tsconfig.json",
]);

const WORKER_BUILD_SCRIPTS = new Map([
  ["services/cloudflare-licensing-backend/package.json", "build"],
  ["services/cloudflare-license-admin/package.json", "build:worker"],
  ["services/cloudflare-customer-portal/package.json", "build:worker"],
  ["services/cloudflare-d1-backup/package.json", "build"],
]);

function trackedFiles() {
  return execFileSync("git", ["-C", REPOSITORY_ROOT, "ls-files", "-z", "--", "packages", "services", "scripts"], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function fail(message) {
  console.error(`typecheck coverage: ${message}`);
  process.exitCode = 1;
}

const files = trackedFiles();
const tsconfigs = files.filter((file) => basename(file).match(/^tsconfig(?:\.[^.]+)*\.json$/));
const parsedConfigs = new Map();
const configPaths = [...new Set([...tsconfigs, ...WORKER_TYPECHECK_CONFIGS])];

for (const file of files) {
  if (/(?:^|\/)\.wrangler\/.+\.d\.ts$/.test(file)) {
    fail(`${file} is generated Wrangler binding output and must remain untracked`);
  }
}

for (const configPath of configPaths) {
  if (!existsSync(resolve(REPOSITORY_ROOT, configPath))) {
    fail(`expected TypeScript config is missing: ${configPath}`);
    continue;
  }
  const parsed = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, configPath), "utf8"));
  parsedConfigs.set(configPath, parsed);
  const options = parsed.compilerOptions ?? {};
  const raw = readFileSync(resolve(REPOSITORY_ROOT, configPath), "utf8");
  const optionOccurrences = Object.fromEntries(
    ["allowJs", "checkJs", "noImplicitAny"].map((option) => [
      option,
      raw.match(new RegExp(`"${option}"\\s*:`, "g"))?.length ?? 0,
    ]),
  );

  for (const [option, occurrences] of Object.entries(optionOccurrences)) {
    if (occurrences > 1) {
      fail(`${configPath} declares ${option} more than once`);
    }
  }
  if (options.checkJs === false) {
    fail(`${configPath} explicitly disables checkJs`);
  }

  if (options.allowJs !== true) continue;
  if (options.checkJs !== true) {
    fail(`${configPath} enables allowJs without checkJs:true`);
  }
  if (!LEGACY_JS_CONFIGS.has(configPath)) {
    fail(`${configPath} is a new JavaScript graph; add a reviewed typecheck policy first`);
  }
  if (options.noImplicitAny !== false || optionOccurrences.noImplicitAny !== 1) {
    fail(`${configPath} must carry one explicit noImplicitAny:false legacy-JSDoc policy`);
  }
}

for (const configPath of LEGACY_JS_CONFIGS) {
  if (!tsconfigs.includes(configPath)) {
    fail(`expected legacy JavaScript config is missing: ${configPath}`);
  }
}

for (const configPath of WORKER_TYPECHECK_CONFIGS) {
  const config = parsedConfigs.get(configPath);
  if (config === undefined) {
    fail(`expected Worker typecheck config is missing: ${configPath}`);
    continue;
  }
  if (!Array.isArray(config.include) || !config.include.includes(".wrangler/worker-configuration.d.ts")) {
    fail(`${configPath} must include generated Wrangler bindings`);
  }
  if (config.compilerOptions?.noEmit !== true) {
    fail(`${configPath} must be no-emit only`);
  }
}

for (const configPath of WORKER_BUILD_CONFIGS) {
  const config = parsedConfigs.get(configPath);
  if (config === undefined) {
    fail(`expected Worker build config is missing: ${configPath}`);
    continue;
  }
  if (!Array.isArray(config.include) || !config.include.includes(".wrangler/worker-configuration.d.ts")) {
    fail(`${configPath} must include generated Wrangler bindings`);
  }
}

for (const [manifestPath, buildScript] of WORKER_BUILD_SCRIPTS) {
  const manifest = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, manifestPath), "utf8"));
  if (typeof manifest.scripts?.[buildScript] !== "string" || !manifest.scripts[buildScript].includes("generate:wrangler-types")) {
    fail(`${manifestPath} ${buildScript} must generate Wrangler bindings before TypeScript`);
  }
}

const sourceFiles = files.filter((file) => /\.(?:js|mjs|ts|tsx)$/.test(file));
for (const file of sourceFiles) {
  const source = readFileSync(resolve(REPOSITORY_ROOT, file), "utf8");
  if (/@ts-(?:nocheck|ignore|expect-error)\b/.test(source)) {
    fail(`${file} contains a prohibited TypeScript suppression`);
  }
  if (/\.(?:js|mjs)$/.test(file) && /^(?:packages|services)\/.*\/src\//.test(file) && !JS_SOURCE_ROOTS.some((root) => file.startsWith(root))) {
    fail(`${file} is production JavaScript outside the reviewed checkJs roots`);
  }
}

if (process.exitCode === undefined) {
  console.log(`typecheck coverage ok (${sourceFiles.length} tracked production/source files)`);
}
