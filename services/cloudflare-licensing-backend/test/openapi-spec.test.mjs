// Build-time CROSS-CHECK that PINS the OpenAPI spec to the Worker's actual routes so the doc cannot
// silently drift. Zero-dep (node:test). It compares three COMPILED artifacts — the route inventory
// (dist/routes.js, the single source of truth), the dispatch table keys the Worker actually serves
// (dist/index.js BACKEND_ROUTE_KEYS), and the spec (dist/openapi.js) — instead of grepping the
// TypeScript source, so moving/refactoring handler code can never break this test; only a real
// route/spec divergence can.
//
// This Worker has NO path parameters — every route is a static literal — so the cross-check is a
// literal-set comparison. Emergency break-glass routes are the scoped routes re-served under the
// /v1/emergency prefix; the inventory composes them via allCanonicalRoutes().

import assert from "node:assert/strict";
import { test } from "node:test";
import { openApiSpec } from "../dist/openapi.js";
import { META_ROUTES, CLIENT_ROUTES, SCOPED_ROUTES, EMERGENCY_PREFIX, allCanonicalRoutes } from "../dist/routes.js";
import worker, { BACKEND_ROUTE_KEYS } from "../dist/index.js";

const keyOf = (r) => `${r.method} ${r.path}`;
const DISPATCHED_INVENTORY = [...META_ROUTES, ...CLIENT_ROUTES, ...SCOPED_ROUTES];
const CANONICAL = allCanonicalRoutes();
const CANONICAL_PATHS = new Set(CANONICAL.map((r) => r.path));

test("the dispatch table serves exactly the literal route inventory", () => {
  // Emergency composites are served via the prefix gate, not the literal table, so the table must
  // equal META + CLIENT + SCOPED — nothing more (no unlisted route), nothing less (no dead entry).
  assert.deepEqual([...BACKEND_ROUTE_KEYS].sort(), DISPATCHED_INVENTORY.map(keyOf).sort());
});

test("the canonical set composes every scoped route under the emergency prefix", () => {
  for (const r of SCOPED_ROUTES) {
    assert.ok(
      CANONICAL_PATHS.has(`${EMERGENCY_PREFIX}${r.path}`),
      `missing emergency composite for ${r.path}`,
    );
  }
  assert.equal(CANONICAL.length, DISPATCHED_INVENTORY.length + SCOPED_ROUTES.length);
});

test("spec.paths == canonical route set (no drift in either direction)", () => {
  const specPaths = new Set(Object.keys(openApiSpec.paths));
  const onlyInCanonical = [...CANONICAL_PATHS].filter((p) => !specPaths.has(p));
  const onlyInSpec = [...specPaths].filter((p) => !CANONICAL_PATHS.has(p));
  assert.deepEqual(onlyInCanonical, [], `canonical paths missing from spec: ${onlyInCanonical.join(", ")}`);
  assert.deepEqual(onlyInSpec, [], `spec paths missing from canonical list: ${onlyInSpec.join(", ")}`);
});

test("each spec path documents exactly the method the inventory declares", () => {
  const canonicalByPath = new Map(CANONICAL.map((r) => [r.path, r.method.toLowerCase()]));
  for (const [p, ops] of Object.entries(openApiSpec.paths)) {
    const methods = Object.keys(ops).filter((k) => ["get", "post", "put", "delete", "patch"].includes(k));
    assert.equal(methods.length, 1, `spec path ${p} should document exactly one method`);
    assert.equal(
      methods[0],
      canonicalByPath.get(p),
      `spec path ${p} documents ${methods[0]} but the route is ${canonicalByPath.get(p)}`,
    );
  }
});

test("spec is OpenAPI 3.1 with a root server and reusable error envelope", () => {
  assert.equal(openApiSpec.openapi, "3.1.0");
  assert.deepEqual(openApiSpec.servers, [{ url: "/" }]);
  assert.ok(openApiSpec.components.schemas.ErrorEnvelope, "ErrorEnvelope schema must exist");
});

test("the doc routes are served without credentials or environment (behavioral)", async () => {
  // Replaces the old source-offset "docs before auth" check with the actual guarantee: the doc
  // handlers never touch env or auth, so they must succeed with an EMPTY env and no credentials.
  const spec = await worker.fetch(new Request("http://test/openapi.json"), {});
  assert.equal(spec.status, 200);
  const body = await spec.json();
  assert.equal(body.openapi, "3.1.0");
  const docs = await worker.fetch(new Request("http://test/docs"), {});
  assert.equal(docs.status, 200);
  assert.match(docs.headers.get("content-type") ?? "", /text\/html/);
});
