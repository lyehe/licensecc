import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const catalogPath = resolve(repositoryRoot, "scripts/script-catalog.json");

function error(code, message, path = undefined) {
  return { code, message, ...(path === undefined ? {} : { path }) };
}

export function evaluateScriptCatalog(catalog, scriptPaths) {
  const errors = [];
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    return [error("SCRIPT_CATALOG_ROOT", "catalog must be an object")];
  }
  if (catalog.schema_version !== 1) errors.push(error("SCRIPT_CATALOG_SCHEMA", "schema_version must equal 1"));
  if (!Array.isArray(catalog.categories) || catalog.categories.length === 0) {
    errors.push(error("SCRIPT_CATALOG_CATEGORIES", "categories must be a non-empty array"));
    return errors;
  }

  const categoryIds = new Set();
  const catalogedPaths = new Map();
  for (const category of catalog.categories) {
    if (!category || typeof category !== "object" || Array.isArray(category)) {
      errors.push(error("SCRIPT_CATALOG_CATEGORY", "each category must be an object"));
      continue;
    }
    if (typeof category.id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(category.id)) {
      errors.push(error("SCRIPT_CATALOG_CATEGORY_ID", "category id must be lowercase kebab-case"));
    } else if (categoryIds.has(category.id)) {
      errors.push(error("SCRIPT_CATALOG_DUPLICATE_CATEGORY", `duplicate category ${category.id}`));
    } else {
      categoryIds.add(category.id);
    }
    if (typeof category.purpose !== "string" || category.purpose.trim().length < 12) {
      errors.push(error("SCRIPT_CATALOG_PURPOSE", `category ${category.id ?? "<unknown>"} needs a specific purpose`));
    }
    if (!Array.isArray(category.paths) || category.paths.length === 0) {
      errors.push(error("SCRIPT_CATALOG_PATHS", `category ${category.id ?? "<unknown>"} needs at least one path`));
      continue;
    }
    for (const path of category.paths) {
      if (typeof path !== "string" || !/^scripts\/(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+$/u.test(path) || path.includes("\\")) {
        errors.push(error("SCRIPT_CATALOG_PATH", "catalog paths must be normalized repository-relative scripts paths", String(path)));
        continue;
      }
      const previous = catalogedPaths.get(path);
      if (previous) {
        errors.push(error("SCRIPT_CATALOG_DUPLICATE_PATH", `path is categorized by both ${previous} and ${category.id}`, path));
      } else {
        catalogedPaths.set(path, category.id);
      }
    }
  }

  const actual = new Set(scriptPaths.map((path) => path.replaceAll("\\", "/")));
  for (const path of [...actual].sort()) {
    if (!catalogedPaths.has(path)) errors.push(error("SCRIPT_CATALOG_MISSING", "script path is not categorized", path));
  }
  for (const path of [...catalogedPaths.keys()].sort()) {
    if (!actual.has(path)) errors.push(error("SCRIPT_CATALOG_STALE", "catalog references a missing script path", path));
  }
  return errors.sort((left, right) => left.code.localeCompare(right.code) || (left.path ?? "").localeCompare(right.path ?? ""));
}

function repositoryScriptPaths(root) {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "scripts"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  ).split("\0").filter(Boolean).sort();
}

export function checkScriptCatalog({ root = repositoryRoot } = {}) {
  const catalog = JSON.parse(readFileSync(resolve(root, "scripts/script-catalog.json"), "utf8"));
  return evaluateScriptCatalog(catalog, repositoryScriptPaths(root));
}

function main() {
  const errors = checkScriptCatalog();
  if (errors.length > 0) {
    for (const item of errors) console.error(`${item.code}${item.path ? ` ${item.path}` : ""}: ${item.message}`);
    process.exitCode = 1;
    return;
  }
  console.log("Script catalog check passed: every scripts/ path has one owner category.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (failure) {
    console.error(failure instanceof Error ? failure.message : String(failure));
    process.exitCode = 1;
  }
}
