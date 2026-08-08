import test from "node:test";
import assert from "node:assert/strict";
// Runs against compiled output; tsconfig.worker.json's outDir preserves the src/worker/ path.
import { ALL_ROUTES, API_ROUTES, pathToPattern } from "../dist-worker/worker/routes.js";
import { ROUTE_DESCRIPTORS, matchRoute } from "../dist-worker/worker/dispatch.js";
import worker from "../dist-worker/worker/index.js";

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

test("every canonical route has one bounded-context owner and preserves raw template captures", () => {
  const expectedKeys = ALL_ROUTES.map((route) => `${route.method} ${route.path}`).sort();
  const descriptorKeys = ROUTE_DESCRIPTORS.map((route) => `${route.method} ${route.path}`).sort();
  assert.deepEqual(descriptorKeys, expectedKeys);
  assert.equal(new Set(descriptorKeys).size, descriptorKeys.length, "each route has exactly one descriptor");

  for (const route of ALL_ROUTES) {
    const expectedParams = {};
    let parameter = 0;
    const concretePath = route.path.replace(/\{([^/}]+)\}/g, (_whole, name) => {
      const rawCapture = `raw%2F${parameter}`;
      expectedParams[name] = rawCapture;
      parameter += 1;
      return rawCapture;
    });
    const matched = matchRoute(route.method, concretePath);
    assert.ok(matched, `${route.method} ${route.path} did not resolve`);
    assert.equal(matched.descriptor.path, route.path);
    assert.match(matched.descriptor.group, /^(meta|summary-reports|customers|catalog|policies|entitlements|devices|webhooks|sync)$/);
    assert.deepEqual(matched.params, expectedParams, `${route.method} ${route.path} decoded or lost a path capture`);
  }
});

test("route descriptors make API authorization explicit for every bounded context", () => {
  for (const descriptor of ROUTE_DESCRIPTORS) {
    if (descriptor.group === "meta") {
      assert.equal(descriptor.authorization, "public", `${descriptor.path} must remain public`);
    } else if (descriptor.group === "sync") {
      assert.equal(descriptor.authorization, "sync", `${descriptor.path} must keep dedicated sync auth`);
    } else if (descriptor.method === "GET") {
      assert.equal(descriptor.authorization, "reader", `${descriptor.method} ${descriptor.path} must allow readers`);
    } else {
      assert.equal(descriptor.authorization, "admin", `${descriptor.method} ${descriptor.path} must require admin`);
    }
  }
});

test("every route group rejects unauthenticated API and destructive requests before D1 work", async () => {
  const noAuthEnv = { DB: {} };
  for (const route of ALL_ROUTES) {
    const concretePath = route.path.replace(/\{[^/}]+\}/g, "raw%2Fcapture");
    const response = await worker.fetch(new Request(`https://admin.example${concretePath}`, { method: route.method }), noAuthEnv);
    if (route.path === "/openapi.json" || route.path === "/docs") {
      assert.equal(response.status, 200, `${route.method} ${route.path} must remain public`);
      continue;
    }
    assert.equal(response.status, route.path.startsWith("/api/sync/") ? 401 : 401, `${route.method} ${route.path} bypassed authentication`);
    const body = await response.json();
    assert.equal(
      body.code,
      route.path.startsWith("/api/sync/") ? "sync_auth_not_configured" : "admin_auth_not_configured",
      `${route.method} ${route.path} reached a handler before authentication`,
    );
  }
});
