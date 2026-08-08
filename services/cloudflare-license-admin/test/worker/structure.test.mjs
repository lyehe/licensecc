import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workerRoot = new URL("../../src/worker/", import.meta.url);

function source(relativePath) {
  return readFileSync(new URL(relativePath, workerRoot), "utf8");
}

test("entrypoint, app, and registry contain no context SQL or transitions", () => {
  for (const relativePath of ["index.ts", "app.ts", "operations.ts"]) {
    const contents = source(relativePath);
    assert.doesNotMatch(contents, /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/);
    assert.doesNotMatch(contents, /transitionWithGuard|transitionEntitlement|forceReleaseLiveSeats/);
  }
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
