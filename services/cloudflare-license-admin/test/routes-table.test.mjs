import test from "node:test";
import assert from "node:assert/strict";
// Runs against compiled output; tsconfig.worker.json's outDir preserves the src/worker/ path.
import { ALL_ROUTES, API_ROUTES, pathToPattern } from "../dist-worker/worker/routes.js";

test("pathToPattern compiles templates to anchored regexes", () => {
  const re = pathToPattern("/api/admin/policies/{id}");
  assert.deepEqual("/api/admin/policies/p-1".match(re)?.slice(1), ["p-1"]);
  assert.equal("/api/admin/policies/p-1/disable".match(re), null);
  const re2 = pathToPattern("/api/admin/entitlements/{id}/devices/{deviceKeyId}/revoke");
  assert.deepEqual("/api/admin/entitlements/e1/devices/d1/revoke".match(re2)?.slice(1), ["e1", "d1"]);
});

test("route inventory has no duplicate method+path keys", () => {
  const keys = ALL_ROUTES.map((r) => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("every API_ROUTES templated path compiles and matches concrete instances", () => {
  for (const r of API_ROUTES) {
    if (!r.path.includes("{")) continue;
    const re = pathToPattern(r.path);
    const concrete = r.path.replace(/\{[^/}]+\}/g, "x");
    assert.ok(concrete.match(re), `${r.path} pattern did not match its concrete instance`);
  }
});
