import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const workerRoot = new URL("../../src/worker/", import.meta.url);
const workerTestRoot = fileURLToPath(new URL("./", import.meta.url));

function source(relativePath) {
  return readFileSync(new URL(relativePath, workerRoot), "utf8");
}

function workerTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return workerTestFiles(path);
    return entry.name.endsWith(".test.mjs") ? [path] : [];
  });
}

test("entrypoint, app, and registry contain no context SQL or transitions", () => {
  for (const relativePath of ["index.ts", "app.ts", "operations.ts"]) {
    const contents = source(relativePath);
    assert.doesNotMatch(contents, /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/);
    assert.doesNotMatch(contents, /transitionWithGuard|transitionEntitlement|forceReleaseLiveSeats/);
  }
});

test("entrypoint has one module-worker edge and the adapter contains no business implementation", () => {
  const entrypoint = source("index.ts");
  const entrypointEdges = [...entrypoint.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(entrypointEdges, ["./module-worker.js"]);

  const adapter = source("module-worker.ts");
  assert.match(adapter, /import\s+\{\s*adminApp\s*\}\s+from\s+["']\.\/app\.js["']/);
  assert.match(adapter, /import\s+\{\s*API_BINDING_KEYS,\s*adminInternalsForTests\s*\}\s+from\s+["']\.\/operations\.js["']/);
  assert.match(adapter, /import\s+type\s+\{\s*Env\s*\}\s+from\s+["']\.\/env\.js["']/);
  assert.match(adapter, /export\s+\{\s*adminApp,\s*API_BINDING_KEYS,\s*adminInternalsForTests\s*\}/);
  assert.match(adapter, /export\s+type\s+\{\s*Env\s*\}/);
  assert.match(adapter, /export\s+default\s+adminApp/);
  assert.doesNotMatch(adapter, /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/);
  assert.doesNotMatch(adapter, /transitionWithGuard|transitionEntitlement|forceReleaseLiveSeats/);
  assert.doesNotMatch(adapter, /\b(?:async\s+function|function\s+\w+|=>)\b/);
});

test("every bounded context has a local operation implementation", () => {
  for (const group of [
    "summary-reports",
    "customers",
    "catalog",
    "policies",
    "entitlements",
    "devices",
    "sync",
  ]) {
    const contents = source(`groups/${group}/operations.ts`);
    assert.match(contents, /export async function/);
  }
  assert.match(source("webhooks.ts"), /export async function/);
  assert.match(source("groups/meta.ts"), /async handle/);
  assert.match(source("groups/entitlements/validation.ts"), /validateEntitlementInput/);
  assert.match(source("groups/catalog/validation.ts"), /validateCatalogImportInput/);
  assert.doesNotMatch(source("support.ts"), /validate(?:Entitlement|Catalog|Plan)/);
});

test("Worker route coverage has no residual catch-all test module", () => {
  assert.equal(existsSync(join(workerTestRoot, "core-regressions.test.mjs")), false);
  for (const path of workerTestFiles(workerTestRoot)) {
    const lineCount = readFileSync(path, "utf8").split(/\r?\n/).length;
    assert.ok(lineCount <= 1000, `${path} is a residual >1000-line catch-all`);
  }
});
