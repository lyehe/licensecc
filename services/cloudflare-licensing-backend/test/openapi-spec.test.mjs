// Build-time CROSS-CHECK that PINS the OpenAPI spec to the Worker's actual routes so the doc cannot
// silently drift. Zero-dep (node:test). It compares three COMPILED artifacts — the route inventory
// (dist/routes.js, the single source of truth), the dispatch table keys the Worker actually serves
// (dist/app.js BACKEND_ROUTE_KEYS), and the spec (dist/openapi/document.js) — instead of grepping the
// TypeScript source, so moving/refactoring handler code can never break this test; only a real
// route/spec divergence can.
//
// This Worker has NO path parameters — every route is a static literal — so the cross-check is a
// literal-set comparison; the inventory composes the full set via allCanonicalRoutes().

import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleComponents, assemblePaths, assertUniqueOperationIds } from "../dist/openapi/assemble.js";
import { openApiSpec } from "../dist/openapi/document.js";
import { META_ROUTES, CLIENT_ROUTES, allCanonicalRoutes } from "../dist/routes.js";
import worker from "../dist/app.js";
import { BACKEND_ROUTE_KEYS } from "../dist/app.js";
import { normalizeOrderEventForReplay } from "../src/fulfillment/order_event.mjs";

const keyOf = (r) => `${r.method} ${r.path}`;
const DISPATCHED_INVENTORY = [...META_ROUTES, ...CLIENT_ROUTES];
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
  // The table must equal META + CLIENT — nothing more (no unlisted route), nothing less (no dead
  // entry) — and that inventory is the whole canonical set.
  assert.deepEqual([...BACKEND_ROUTE_KEYS].sort(), DISPATCHED_INVENTORY.map(keyOf).sort());
  assert.deepEqual(CANONICAL.map(keyOf).sort(), DISPATCHED_INVENTORY.map(keyOf).sort());
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
    ["/v1/orders", [{ orderKeyId: [], orderTimestamp: [], orderSignature: [] }]],
    ["/v2/device-authorizations", []],
    ["/v2/device-challenges", []],
    ["/v2/device-authorizations/exchange", []],
    ["/v2/device-leases/renew", []],
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
  const policy = docs.headers.get("content-security-policy") ?? "";
  const nonce = /script-src 'nonce-([^']+)'/u.exec(policy)?.[1];
  assert.ok(nonce, "docs must bind inline code to a CSP nonce");
  assert.doesNotMatch(policy, /unsafe-(?:inline|eval)/u);
  const html = await docs.text();
  assert.equal(html.split(`nonce="${nonce}"`).length - 1, 2);
  assert.doesNotMatch(html, /innerHTML/u, "docs renderer must not contain a DOM HTML injection sink");
  // Health reads the protected configuration, so an empty env is a readiness failure, never a throw.
  const health = await worker.fetch(new Request("http://test/health"), {});
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { ok: false, service: "licensecc-online-verifier", protected_device_ready: false });
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
    assert.match(JSON.stringify(response), route.path.startsWith("/v2/") ? /temporarily_unavailable/ : /config_error/, route.path + " 503 documents its config failure envelope");
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

test("health documents protected readiness, warnings, and invalid-mode config errors", () => {
  const schemas = openApiSpec.components.schemas;
  const healthy = schemas.HealthSuccess;
  assert.deepEqual(healthy.required, ["ok", "service", "protected_device_ready"]);
  assert.deepEqual(healthy.properties.protected_device_ready.enum, [true]);
  assert.equal(healthy.properties.config_warnings.type, "array");
  const failure = schemas.HealthConfigError;
  assert.deepEqual(failure.required, ["ok", "service", "protected_device_ready"]);
  assert.equal(failure.properties.protected_device_ready.type, "boolean");
  assert.deepEqual(failure.dependentRequired, { code: ["invalid_config_modes"], invalid_config_modes: ["code"] });
  assert.deepEqual(Object.keys(healthy.properties).sort(), ["config_warnings", "ok", "protected_device_ready", "service"]);
  assert.deepEqual(Object.keys(failure.properties).sort(), ["code", "config_warnings", "invalid_config_modes", "ok", "protected_device_ready", "service"]);

  const healthOperation = openApiSpec.paths["/health"].get;
  assert.ok(healthOperation.responses["503"]);
  assert.match(JSON.stringify(healthOperation.responses["503"]), /config_error/);
  assert.deepEqual(Object.keys(healthOperation.responses["503"].content["application/json"].examples).sort(), ["config_error", "protected_not_ready"]);
  assert.equal(healthOperation.responses["503"].content["application/json"].schema.$ref, "#/components/schemas/HealthConfigError");
  assert.doesNotMatch(JSON.stringify(healthOperation), /account_token/);
});

test("order ingest documents distinct config/write failures and raw-wire body semantics", () => {
  const operation = openApiSpec.paths["/v1/orders"].post;
  assert.deepEqual(operation.security, [{ orderKeyId: [], orderTimestamp: [], orderSignature: [] }]);
  assert.equal(openApiSpec.components.securitySchemes.orderKeyId.name, "X-LCC-Key-Id");
  assert.equal(openApiSpec.components.securitySchemes.orderTimestamp.name, "X-LCC-Timestamp");
  assert.equal(openApiSpec.components.securitySchemes.orderSignature.name, "X-LCC-Signature");
  assert.match(operation.description, /exact raw request-body bytes|original raw wire bytes/);
  assert.deepEqual(
    Object.keys(operation.responses["403"].content["application/json"].examples),
    ["signer_scope_forbidden"],
  );
  assert.deepEqual(
    Object.keys(operation.responses["409"].content["application/json"].examples).sort(),
    ["entitlement_owner_mismatch", "entitlement_revoked", "event_id_conflict", "fingerprint_owned", "seq_conflict"],
  );
  assert.match(operation.responses["409"].description, /entitlement_owner_mismatch/);
  const order503 = operation.responses["503"];
  const examples = order503.content["application/json"].examples;
  assert.deepEqual(Object.keys(examples).sort(), ["config_error", "write_failed"]);
  assert.match(order503.description, /config_error/);
  assert.match(order503.description, /write_failed/);
  assert.match(operation.responses["400"].description, /UTF-8/);
  assert.match(operation.responses["413"].description, /raw wire bytes/);
});

test("OrderRequest matches the runtime normalizer's closed contract", () => {
  const schema = openApiSpec.components.schemas.OrderRequest;
  const intents = [
    "subscription.active", "subscription.renewed", "subscription.past_due", "subscription.paused",
    "subscription.payment_failed", "subscription.canceled_at_period_end", "subscription.resumed",
    "quantity.changed", "fraud.confirmed", "chargeback",
  ];
  assert.deepEqual([...schema.required].sort(), ["customer", "event_id", "intent", "project", "seq", "subscription_id"]);
  assert.deepEqual(schema.properties.customer.required, ["id"]);
  assert.equal(schema.properties.feature.description, "Defaults to project when omitted.");
  assert.equal(schema.properties.ts, undefined);
  assert.deepEqual(schema.properties.intent.enum, intents);
  assert.deepEqual(Object.keys(schema.properties.quantity.properties), ["max_active_devices"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.quantity.additionalProperties, false);
  assert.equal(schema.properties.customer.additionalProperties, false);

  const now = 1_700_000_000;
  for (const intent of intents) {
    const body = {
      event_id: `evt_${intent}`,
      subscription_id: "sub_A",
      project: "DEFAULT",
      intent,
      seq: 1,
      customer: { id: "cus_A" },
      ...(intent === "quantity.changed" ? { quantity: { max_active_devices: 1 } } : {}),
    };
    const normalized = normalizeOrderEventForReplay(body, now);
    assert.equal(normalized.error, undefined, intent);
    assert.equal(normalized.feature, "DEFAULT", intent);
    const { customer: _omitted, ...withoutCustomer } = body;
    assert.equal(normalizeOrderEventForReplay(withoutCustomer, now).error, "invalid_order", intent);
  }
  assert.equal(normalizeOrderEventForReplay({
    event_id: "evt_pool", subscription_id: "sub_A", project: "DEFAULT", intent: "quantity.changed", seq: 1,
    customer: { id: "cus_A" }, quantity: { pool_size: 1 },
  }, now).error, "invalid_order");
});
