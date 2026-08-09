// Build-time CROSS-CHECK that PINS the OpenAPI spec to the Worker's actual routes so the two cannot
// silently drift. This is a "doc-of-existing" guard, not a generator. It compares COMPILED artifacts
// — the route inventory (dist-worker/worker/routes.js, the single source of truth), the dispatch
// keys the Worker actually serves (dist-worker/worker/index.js PORTAL_ROUTE_KEYS), and the spec —
// instead of grepping the TypeScript source, so refactoring handler code can never break this test;
// only a real route/spec divergence can.
//
// Zero-dep node:test. Every portal route is a static literal (no path parameters).

import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleComponents, assemblePaths, assertUniqueOperationIds } from "../dist-worker/worker/openapi/assemble.js";
import { openApiDocument } from "../dist-worker/worker/openapi/document.js";
import { ALL_ROUTES, META_ROUTES, PUBLIC_ROUTES, SESSION_ROUTES } from "../dist-worker/worker/routes.js";
import worker, { PORTAL_ROUTE_KEYS } from "../dist-worker/worker/index.js";

const keyOf = (r) => `${r.method} ${r.path}`;

function documentedErrorCodes(path, status) {
  const response = openApiDocument.paths[path]?.post?.responses?.[String(status)];
  const code = response?.content?.["application/json"]?.schema?.properties?.code;
  if (typeof code?.const === "string") return [code.const];
  if (Array.isArray(code?.enum) && code.enum.every((value) => typeof value === "string")) return code.enum;
  throw new Error(`${path} ${status} does not declare an exact error-code schema`);
}

test("OpenAPI assembly rejects collisions without mutating portal fragments", () => {
  const getFragment = { label: "get", entries: [["/shared", { get: { operationId: "getShared" } }]] };
  const postFragment = { label: "post", entries: [["/shared", { post: { operationId: "postShared" } }]] };
  const before = structuredClone(getFragment);
  const paths = assemblePaths(getFragment, postFragment);
  assert.deepEqual(Object.keys(paths["/shared"]), ["get", "post"]);
  assert.deepEqual(getFragment, before, "assembly must not mutate input fragments");
  assert.throws(
    () => assemblePaths(getFragment, { label: "duplicate", entries: [["/shared", { get: {} }]] }),
    /Duplicate OpenAPI path item field "get"/,
  );
  assert.throws(
    () => assemblePaths({ label: "parameters-a", entries: [["/shared", { parameters: [] }]] }, { label: "parameters-b", entries: [["/shared", { parameters: [] }]] }),
    /Duplicate OpenAPI path item field "parameters"/,
  );
  assert.throws(
    () => assertUniqueOperationIds(assemblePaths(getFragment, { label: "duplicate-operation", entries: [["/other", { post: { operationId: "getShared" } }]] })),
    /Duplicate OpenAPI operationId "getShared"/,
  );
  const schemaComponents = { label: "schemas", namespaces: [["schemas", [["Shared", { type: "object" }]]]] };
  const schemaComponentsBefore = structuredClone(schemaComponents);
  const components = assembleComponents(
    schemaComponents,
    { label: "security", namespaces: [["securitySchemes", [["Shared", { type: "http" }]]]] },
  );
  assert.ok(components.schemas.Shared);
  assert.ok(components.securitySchemes.Shared);
  assert.deepEqual(schemaComponents, schemaComponentsBefore, "component assembly must not mutate input fragments");
  assert.throws(
    () => assembleComponents({ label: "schemas-a", namespaces: [["schemas", [["Shared", {}]]]] }, { label: "schemas-b", namespaces: [["schemas", [["Shared", {}]]]] }),
    /Duplicate OpenAPI component key "Shared" in schemas/,
  );
});

test("route inventory is well-formed (no duplicates, session routes under the prefix root)", () => {
  const keys = ALL_ROUTES.map(keyOf);
  assert.equal(new Set(keys).size, keys.length, "duplicate method+path in the inventory");
  assert.equal(ALL_ROUTES.length, META_ROUTES.length + PUBLIC_ROUTES.length + SESSION_ROUTES.length);
  for (const r of SESSION_ROUTES) {
    assert.ok(r.path.startsWith("/api/portal/"), `session route outside the dispatch root: ${r.path}`);
  }
});

test("the dispatch tables serve exactly the route inventory (both directions)", () => {
  assert.deepEqual([...PORTAL_ROUTE_KEYS].sort(), ALL_ROUTES.map(keyOf).sort());
});

test("spec.paths equal the canonical 'inSpec' route set (no spec-only / no missing)", () => {
  const specPaths = new Set(Object.keys(openApiDocument.paths));
  const expected = new Set(ALL_ROUTES.filter((r) => r.inSpec).map((r) => r.path));
  for (const p of expected) {
    assert.ok(specPaths.has(p), `canonical route ${p} is documented in the inventory but MISSING from spec.paths`);
  }
  for (const p of specPaths) {
    assert.ok(expected.has(p), `spec.paths declares ${p} which is NOT in the canonical inventory (spec drifted ahead of code)`);
  }
});

test("self-describing meta routes stay served but intentionally outside the document", () => {
  for (const route of META_ROUTES) {
    assert.equal(route.inSpec, false, `${route.path} must keep its explicit inSpec:false exception`);
    assert.equal(openApiDocument.paths[route.path], undefined, `${route.path} must not be self-documented`);
  }
});

test("each spec path documents exactly the method the inventory declares", () => {
  const methodByPath = new Map(ALL_ROUTES.filter((r) => r.inSpec).map((r) => [r.path, r.method.toLowerCase()]));
  for (const [p, ops] of Object.entries(openApiDocument.paths)) {
    const methods = Object.keys(ops).filter((k) => ["get", "post", "put", "delete", "patch"].includes(k));
    assert.equal(methods.length, 1, `spec path ${p} should document exactly one method`);
    assert.equal(methods[0], methodByPath.get(p), `spec path ${p} documents ${methods[0]} but the route is ${methodByPath.get(p)}`);
  }
});

test("each spec operation has the required documentation fields", () => {
  for (const [path, item] of Object.entries(openApiDocument.paths)) {
    for (const [method, op] of Object.entries(item)) {
      assert.equal(typeof op.summary, "string", `${method.toUpperCase()} ${path} missing summary`);
      assert.equal(typeof op.operationId, "string", `${method.toUpperCase()} ${path} missing operationId`);
      assert.ok(Array.isArray(op.security), `${method.toUpperCase()} ${path} missing security array`);
      assert.ok(op.responses && typeof op.responses === "object", `${method.toUpperCase()} ${path} missing responses`);
      assert.ok(Object.keys(op.responses).length > 0, `${method.toUpperCase()} ${path} has no responses`);
      // Every documented response must carry a description.
      for (const [code, resp] of Object.entries(op.responses)) {
        assert.equal(typeof resp.description, "string", `${method.toUpperCase()} ${path} ${code} missing description`);
      }
    }
  }
});

test("operation identifiers and route-class auth declarations stay exact", () => {
  assertUniqueOperationIds(openApiDocument.paths);
  for (const route of PUBLIC_ROUTES) {
    if (route.path === "/portal/v1/auth/logout" || route.path === "/portal/v1/admin/bootstrap-otp") continue;
    const operation = openApiDocument.paths[route.path]?.[route.method.toLowerCase()];
    if (!operation) continue;
    assert.deepEqual(operation.security, [], `${route.path} must remain public`);
  }
  for (const route of SESSION_ROUTES) {
    const operation = openApiDocument.paths[route.path][route.method.toLowerCase()];
    assert.deepEqual(operation.security, [{ sessionCookie: [] }], `${route.path} must remain session-scoped`);
  }
  assert.deepEqual(openApiDocument.paths["/portal/v1/auth/logout"].post.security, [{ sessionCookie: [] }, {}]);
  assert.deepEqual(openApiDocument.paths["/portal/v1/admin/bootstrap-otp"].post.security, [{ bootstrapBearer: [] }, { bootstrapBearer: [], cfAccess: [] }]);
});

test("spec is OpenAPI 3.1.0 with the shared envelope/server conventions", () => {
  assert.equal(openApiDocument.openapi, "3.1.0");
  assert.deepEqual(openApiDocument.servers, [{ url: "/" }]);
  assert.equal(typeof openApiDocument.info.title, "string");
  assert.equal(typeof openApiDocument.info.version, "string");
  assert.ok(openApiDocument.components.schemas.Envelope, "Envelope schema missing");
  assert.ok(openApiDocument.components.schemas.ErrorEnvelope, "ErrorEnvelope schema missing");
  assert.ok(openApiDocument.components.securitySchemes.sessionCookie, "sessionCookie security scheme missing");
});

test("health OpenAPI keeps the reviewed readiness envelope and status contract", () => {
  const health = openApiDocument.paths["/health"].get;
  assert.deepEqual(Object.keys(health.responses), ["200", "503"]);
  assert.equal(health.responses["200"].content["application/json"].schema.properties.code.const, "healthy");
  assert.equal(
    health.responses["200"].content["application/json"].schema.properties.data.properties.account_token_mode_required.const,
    true,
  );
  assert.equal(health.responses["503"].content["application/json"].schema.properties.code.const, "account_token_mode_not_required");
});

test("OpenAPI models exact action and device-release runtime error-code alternatives", () => {
  for (const path of ["/api/portal/checkout", "/api/portal/heartbeat", "/api/portal/release", "/api/portal/download"]) {
    assert.deepEqual(documentedErrorCodes(path, 502), ["backend_unreachable", "backend_invalid_response"], `${path} 502 alternatives`);
    assert.deepEqual(documentedErrorCodes(path, 503), ["backend_unconfigured", "config_error"], `${path} 503 alternatives`);
  }
  assert.deepEqual(documentedErrorCodes("/api/portal/devices/release", 500), ["portal_error"]);
});

test("the doc routes are served without credentials or environment (behavioral)", async () => {
  // The doc handlers must never touch env or auth: they must succeed with an EMPTY env and no
  // cookies. (The SPA fallback and every other route may require env bindings — not these two.)
  const spec = await worker.fetch(new Request("http://test/openapi.json"), {});
  assert.equal(spec.status, 200);
  const body = await spec.json();
  assert.equal(body.openapi, "3.1.0");
  const docs = await worker.fetch(new Request("http://test/docs"), {});
  assert.equal(docs.status, 200);
  assert.match(docs.headers.get("content-type") ?? "", /text\/html/);
});
