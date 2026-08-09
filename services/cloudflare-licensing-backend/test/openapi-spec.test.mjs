// Build-time CROSS-CHECK that PINS the OpenAPI spec to the Worker's actual routes so the doc cannot
// silently drift. Zero-dep (node:test). It compares three COMPILED artifacts — the route inventory
// (dist/routes.js, the single source of truth), the dispatch table keys the Worker actually serves
// (dist/app.js BACKEND_ROUTE_KEYS), and the spec (dist/openapi/document.js) — instead of grepping the
// TypeScript source, so moving/refactoring handler code can never break this test; only a real
// route/spec divergence can.
//
// This Worker has NO path parameters — every route is a static literal — so the cross-check is a
// literal-set comparison. Emergency break-glass routes are the scoped routes re-served under the
// /v1/emergency prefix; the inventory composes them via allCanonicalRoutes().

import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleComponents, assemblePaths, assertUniqueOperationIds } from "../dist/openapi/assemble.js";
import { openApiSpec } from "../dist/openapi/document.js";
import { META_ROUTES, CLIENT_ROUTES, SCOPED_ROUTES, EMERGENCY_PREFIX, allCanonicalRoutes } from "../dist/routes.js";
import worker from "../dist/index.js";
import { BACKEND_ROUTE_KEYS } from "../dist/app.js";

const keyOf = (r) => `${r.method} ${r.path}`;
const DISPATCHED_INVENTORY = [...META_ROUTES, ...CLIENT_ROUTES, ...SCOPED_ROUTES];
const CANONICAL = allCanonicalRoutes();
const CANONICAL_PATHS = new Set(CANONICAL.map((r) => r.path));

test("OpenAPI assembly rejects collisions without mutating its fragments", () => {
  const initialPaths = {
    label: "initial",
    entries: [["/shared", { get: { operationId: "getShared" } }]],
  };
  const postPaths = {
    label: "post",
    entries: [["/shared", { post: { operationId: "postShared" } }]],
  };
  const initialPathsBefore = structuredClone(initialPaths);
  const assembled = assemblePaths(initialPaths, postPaths);
  assert.deepEqual(Object.keys(assembled["/shared"]), ["get", "post"]);
  assert.deepEqual(initialPaths, initialPathsBefore, "assembly must not mutate input fragments");
  assert.throws(
    () => assemblePaths(initialPaths, { label: "duplicate-method", entries: [["/shared", { get: {} }]] }),
    /Duplicate OpenAPI path item field "get"/,
  );
  assert.throws(
    () => assemblePaths(initialPaths, { label: "duplicate-path-field", entries: [["/shared", { parameters: [] }]] }, { label: "duplicate-path-field-2", entries: [["/shared", { parameters: [] }]] }),
    /Duplicate OpenAPI path item field "parameters"/,
  );
  assert.throws(
    () => assertUniqueOperationIds(assemblePaths(initialPaths, { label: "duplicate-operation", entries: [["/other", { post: { operationId: "getShared" } }]] })),
    /Duplicate OpenAPI operationId "getShared"/,
  );

  const schemaComponents = { label: "schemas", namespaces: [["schemas", [["Shared", { type: "object" }]]]] };
  const schemaComponentsBefore = structuredClone(schemaComponents);
  const components = assembleComponents(
    schemaComponents,
    { label: "security", namespaces: [["securitySchemes", [["Shared", { type: "http" }]]]] },
  );
  assert.ok(components.schemas.Shared);
  assert.ok(components.securitySchemes.Shared, "the same key is valid in a different namespace");
  assert.deepEqual(schemaComponents, schemaComponentsBefore, "component assembly must not mutate input fragments");
  assert.throws(
    () => assembleComponents({ label: "schemas", namespaces: [["schemas", [["Shared", {}]]]] }, { label: "schemas-duplicate", namespaces: [["schemas", [["Shared", {}]]]] }),
    /Duplicate OpenAPI component key "Shared" in schemas/,
  );
});

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

test("every documented operation has unique identity, expected auth, and a response", () => {
  assertUniqueOperationIds(openApiSpec.paths);
  const expectedSecurity = new Map([
    ["/openapi.json", []],
    ["/docs", []],
    ["/health", []],
    ["/v1/verify", [{ requestProof: [] }]],
    ["/v1/orders", [{ orderHmac: [] }]],
    ["/v1/activate", [{ accountToken: [] }, { leaseBearer: [] }]],
    ["/v1/renew", [{ accountToken: [] }, { leaseBearer: [] }]],
    ["/v1/checkout", [{ accountToken: [] }, { leaseBearer: [] }]],
    ["/v1/heartbeat", [{ accountToken: [] }, { leaseBearer: [] }]],
    ["/v1/release", [{ accountToken: [] }, { leaseBearer: [] }]],
    ["/v1/meter", [{ accountToken: [] }, { leaseBearer: [] }]],
    ["/v1/admin/report", [{ accountToken: [] }, { leaseBearer: [] }]],
    ["/v1/emergency/v1/activate", [{ emergencyBearer: [] }]],
    ["/v1/emergency/v1/renew", [{ emergencyBearer: [] }]],
    ["/v1/emergency/v1/checkout", [{ emergencyBearer: [] }]],
    ["/v1/emergency/v1/heartbeat", [{ emergencyBearer: [] }]],
    ["/v1/emergency/v1/release", [{ emergencyBearer: [] }]],
    ["/v1/emergency/v1/meter", [{ emergencyBearer: [] }]],
    ["/v1/emergency/v1/admin/report", [{ emergencyBearer: [] }]],
  ]);
  for (const [path, item] of Object.entries(openApiSpec.paths)) {
    const [operation] = Object.values(item);
    assert.equal(typeof operation.operationId, "string", `${path} is missing operationId`);
    assert.deepEqual(operation.security, expectedSecurity.get(path), `${path} auth declaration drifted`);
    assert.ok(operation.responses && Object.keys(operation.responses).length > 0, `${path} has no documented response`);
    for (const [status, response] of Object.entries(operation.responses)) {
      assert.equal(typeof response.description, "string", `${path} ${status} is missing a response description`);
    }
  }
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

test("invalid security-mode config leaves static docs available and is documented on every gated operation", async () => {
  const staticMeta = new Set(["/openapi.json", "/docs"]);
  for (const route of CANONICAL) {
    const operation = openApiSpec.paths[route.path][route.method.toLowerCase()];
    if (staticMeta.has(route.path)) {
      assert.equal(operation.responses["503"], undefined, route.path + " stays available during invalid security config");
      continue;
    }
    const response = operation.responses["503"];
    assert.ok(response, route.path + " documents the global invalid-config response");
    assert.match(JSON.stringify(response), /config_error/, route.path + " 503 documents config_error");
  }

  const invalidEnv = { REQUEST_SIGNATURE_MODE: "not-a-mode" };
  const spec = await worker.fetch(new Request("http://test/openapi.json"), invalidEnv);
  assert.equal(spec.status, 200);
  const docs = await worker.fetch(new Request("http://test/docs"), invalidEnv);
  assert.equal(docs.status, 200);
  const health = await worker.fetch(new Request("http://test/health"), invalidEnv);
  assert.equal(health.status, 503);
  assert.equal((await health.json()).code, "config_error");
});

test("health documents normalized readiness fields, warnings, and invalid-mode config errors", () => {
  const schemas = openApiSpec.components.schemas;
  const healthy = schemas.HealthSuccess;
  assert.ok(healthy.required.includes("account_token_mode"));
  assert.equal(healthy.properties.account_token_mode.type, "string");
  assert.equal(healthy.properties.config_warnings.type, "array");

  const healthOperation = openApiSpec.paths["/health"].get;
  assert.ok(healthOperation.responses["503"]);
  assert.match(JSON.stringify(healthOperation.responses["503"]), /config_error/);
  assert.equal(healthOperation.responses["503"].content["application/json"].schema.$ref, "#/components/schemas/HealthConfigError");
});

test("order ingest documents distinct config/write failures and raw-wire body semantics", () => {
  const operation = openApiSpec.paths["/v1/orders"].post;
  const order503 = operation.responses["503"];
  const examples = order503.content["application/json"].examples;
  assert.deepEqual(Object.keys(examples).sort(), ["config_error", "write_failed"]);
  assert.match(order503.description, /config_error/);
  assert.match(order503.description, /write_failed/);
  assert.match(operation.responses["400"].description, /UTF-8/);
  assert.match(operation.responses["413"].description, /raw wire bytes/);
});
