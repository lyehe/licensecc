import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_EXTENSION = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|js|mjs|ts|tsx)$/u;
const PRODUCTION_SOURCE = /^(?:src|packages\/[^/]+\/src|services\/[^/]+\/src)\//u;
const THIRD_PARTY_SOURCE = /^src\/library\/ini\//u;

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

export function collectProductionHotspots({ root = repositoryRoot } = {}) {
  return trackedFiles(root)
    .filter((path) => PRODUCTION_SOURCE.test(path) && SOURCE_EXTENSION.test(path) && !THIRD_PARTY_SOURCE.test(path))
    .map((path) => ({ path, lines: countLines(resolve(root, path)) }))
    .sort((left, right) => right.lines - left.lines || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function collectHotspots({ root = repositoryRoot, limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("hotspot limit must be a positive integer");
  return collectProductionHotspots({ root }).slice(0, limit);
}

function baselineError(code, path, message) {
  return { code, path, message };
}

export function evaluateHotspotBaseline(baseline, hotspots) {
  const errors = [];
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    return [baselineError("HOTSPOT_BASELINE_ROOT", "scripts/hotspot-baseline.json", "baseline must be an object")];
  }
  if (baseline.schema_version !== 1) {
    errors.push(baselineError("HOTSPOT_BASELINE_SCHEMA", "scripts/hotspot-baseline.json", "schema_version must equal 1"));
  }
  if (!Number.isInteger(baseline.threshold_lines) || baseline.threshold_lines < 1) {
    errors.push(baselineError("HOTSPOT_BASELINE_THRESHOLD", "scripts/hotspot-baseline.json", "threshold_lines must be a positive integer"));
  }
  if (!baseline.files || typeof baseline.files !== "object" || Array.isArray(baseline.files) || Object.keys(baseline.files).length === 0) {
    errors.push(baselineError("HOTSPOT_BASELINE_FILES", "scripts/hotspot-baseline.json", "files must be a non-empty object"));
    return errors;
  }

  const current = new Map(hotspots.map(({ path, lines }) => [path, lines]));
  for (const [path, maximum] of Object.entries(baseline.files)) {
    if (!PRODUCTION_SOURCE.test(path) || THIRD_PARTY_SOURCE.test(path) || !SOURCE_EXTENSION.test(path) || path.includes("\\") || path.includes("..")) {
      errors.push(baselineError("HOTSPOT_BASELINE_PATH", path, "baseline path must name normalized first-party production source"));
      continue;
    }
    if (!Number.isInteger(maximum) || maximum < 1) {
      errors.push(baselineError("HOTSPOT_BASELINE_LIMIT", path, "baseline line limit must be a positive integer"));
      continue;
    }
    if (!current.has(path)) {
      errors.push(baselineError("HOTSPOT_BASELINE_MISSING_FILE", path, "baseline target is not tracked production source"));
    } else if (current.get(path) > maximum) {
      errors.push(baselineError("HOTSPOT_GROWTH", path, `line count grew from ${maximum} to ${current.get(path)}`));
    }
  }
  if (Number.isInteger(baseline.threshold_lines) && baseline.threshold_lines > 0) {
    for (const { path, lines } of hotspots) {
      if (lines >= baseline.threshold_lines && !Object.hasOwn(baseline.files, path)) {
        errors.push(baselineError("HOTSPOT_UNRATCHETED", path, `${lines} lines meets the ${baseline.threshold_lines}-line review threshold`));
      }
    }
  }
  return errors.sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path));
}

export function checkHotspotBaseline({ root = repositoryRoot } = {}) {
  const baseline = JSON.parse(readFileSync(resolve(root, "scripts/hotspot-baseline.json"), "utf8"));
  return { baseline, errors: evaluateHotspotBaseline(baseline, collectProductionHotspots({ root })) };
}

function main() {
  const knownArguments = process.argv.slice(2).filter((argument) => argument === "--check" || argument.startsWith("--limit="));
  if (knownArguments.length !== process.argv.slice(2).length) throw new Error("unknown hotspot-report argument");
  if (process.argv.includes("--check")) {
    const { baseline, errors } = checkHotspotBaseline();
    if (errors.length > 0) {
      for (const error of errors) console.error(`${error.code} ${error.path}: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Hotspot growth check passed: ${Object.keys(baseline.files).length} files ratcheted at ${baseline.threshold_lines}+ lines.`);
    return;
  }
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
