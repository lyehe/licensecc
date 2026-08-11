import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pinnedWranglerEntrypoint = resolve(repositoryRoot, "node_modules", "wrangler", "bin", "wrangler.js");

export function runWranglerTypes({
  outputPath,
  configPath,
  cwd = process.cwd(),
  spawnSync = defaultSpawnSync,
} = {}) {
  if (!outputPath || !configPath) {
    throw new Error("Usage: generate-wrangler-types.mjs <output-path> <wrangler-config>");
  }

  mkdirSync(dirname(resolve(cwd, outputPath)), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [pinnedWranglerEntrypoint, "types", outputPath, "--config", configPath],
    { cwd, stdio: "inherit" },
  );

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outputPath, configPath] = process.argv.slice(2);
  process.exitCode = runWranglerTypes({ outputPath, configPath });
}
