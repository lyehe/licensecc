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
import { openApiDocument } from "../dist-worker/worker/openapi.js";
import { ALL_ROUTES, META_ROUTES, PUBLIC_ROUTES, SESSION_ROUTES } from "../dist-worker/worker/routes.js";
import worker, { PORTAL_ROUTE_KEYS } from "../dist-worker/worker/index.js";

const keyOf = (r) => `${r.method} ${r.path}`;

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

test("spec is OpenAPI 3.1.0 with the shared envelope/server conventions", () => {
  assert.equal(openApiDocument.openapi, "3.1.0");
  assert.deepEqual(openApiDocument.servers, [{ url: "/" }]);
  assert.equal(typeof openApiDocument.info.title, "string");
  assert.equal(typeof openApiDocument.info.version, "string");
  assert.ok(openApiDocument.components.schemas.Envelope, "Envelope schema missing");
  assert.ok(openApiDocument.components.schemas.ErrorEnvelope, "ErrorEnvelope schema missing");
  assert.ok(openApiDocument.components.securitySchemes.sessionCookie, "sessionCookie security scheme missing");
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
