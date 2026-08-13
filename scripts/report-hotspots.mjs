import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_EXTENSION = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|js|mjs|ts|tsx)$/u;
const PRODUCTION_SOURCE = /^(?:src|packages\/[^/]+\/src|services\/[^/]+\/src)\//u;

function trackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer" });
  if (result.status !== 0) throw new Error("unable to list tracked hotspot inputs");
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function countLines(path) {
  const source = readFileSync(path, "utf8");
  if (source === "") return 0;
  return source.split(/\r?\n/u).length - (source.endsWith("\n") ? 1 : 0);
}

export function collectHotspots({ root = repositoryRoot, limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("hotspot limit must be a positive integer");
  return trackedFiles(root)
    .filter((path) => PRODUCTION_SOURCE.test(path) && SOURCE_EXTENSION.test(path))
    .map((path) => ({ path, lines: countLines(resolve(root, path)) }))
    .sort((left, right) => right.lines - left.lines || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .slice(0, limit);
}

function main() {
  const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
  const limit = limitArgument === undefined ? 20 : Number(limitArgument.slice("--limit=".length));
  const hotspots = collectHotspots({ limit });
  console.log("Lines\tPath");
  for (const hotspot of hotspots) console.log(`${hotspot.lines}\t${hotspot.path}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
