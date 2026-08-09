import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { entitlementId } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";

import { openApiDocument } from "../../dist-worker/worker/openapi/document.js";
import { handleCustomerTransition } from "../../dist-worker/worker/groups/customers/operations.js";
import { handlePolicyTransition } from "../../dist-worker/worker/groups/policies/operations.js";
import {
  transitionCatalogFeature,
  transitionCatalogPlan,
  transitionCatalogPlanFeature,
} from "../../dist-worker/worker/groups/catalog/plan-operations.js";
import { handleDeviceTransition, handleReleaseSeats } from "../../dist-worker/worker/groups/devices/operations.js";
import { handleBatchTransition, handleMutation } from "../../dist-worker/worker/groups/entitlements/operations.js";
import { handleWebhookMutation } from "../../dist-worker/worker/webhooks.js";
import { MockD1, fingerprint } from "./fixtures.mjs";

const ACTOR = { subject: "transition-contract-test", email: "admin@example.com", role: "admin", actorType: "dev" };
const REQUEST_ID = "transition-contract-request";
const PROJECT = "DEFAULT";
const FEATURE = "DEFAULT";
const ENTITLEMENT_ID = entitlementId(PROJECT, FEATURE, fingerprint);
const DEVICE_KEY_ID = `sha256:${"d".repeat(64)}`;

function post(path, body = {}, headers = {}) {
  return new Request(`https://admin.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function operation(path) {
  const operation = openApiDocument.paths[path]?.post;
  assert.ok(operation, `missing POST operation ${path}`);
  return operation;
}

function operationResponseSchema(path, status = "200") {
  const schema = operation(path).responses?.[status]?.content?.["application/json"]?.schema;
  assert.ok(schema, `missing JSON ${status} schema for ${path}`);
  return schema;
}

function operationSuccessSchema(path) {
  return operationResponseSchema(path);
}

function resolveReference(reference) {
  assert.match(reference, /^#\//, `unsupported OpenAPI reference ${reference}`);
  return reference.slice(2).split("/").reduce((value, key) => value?.[key], openApiDocument);
}

function schemaRequiresProperty(schema, property, visited = new Set()) {
  if (schema === true || schema === false || schema === undefined) return false;
  if (schema.$ref !== undefined) {
    if (visited.has(schema.$ref)) return false;
    visited.add(schema.$ref);
    return schemaRequiresProperty(resolveReference(schema.$ref), property, visited);
  }
  if (schema.allOf !== undefined) return schema.allOf.some((item) => schemaRequiresProperty(item, property, new Set(visited)));
  if (schema.oneOf !== undefined || schema.anyOf !== undefined) {
    const branches = schema.oneOf ?? schema.anyOf;
    return branches.every((item) => schemaRequiresProperty(item, property, new Set(visited)));
  }
  return schema.required?.includes(property) === true;
}

function typeMatches(value, expected) {
  switch (expected) {
    case "array": return Array.isArray(value);
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "null": return value === null;
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "string": return typeof value === "string";
    default: throw new Error(`unsupported test schema type ${expected}`);
  }
}

function schemaMismatch(value, schema, path = "$") {
  if (schema === true || schema === undefined) return null;
  if (schema === false) return `${path} is forbidden`;
  if (schema.$ref !== undefined) return schemaMismatch(value, resolveReference(schema.$ref), path);
  if (schema.const !== undefined && !isDeepStrictEqual(value, schema.const)) {
    return `${path} must equal ${JSON.stringify(schema.const)}`;
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => isDeepStrictEqual(value, candidate))) {
    return `${path} must be one of ${JSON.stringify(schema.enum)}`;
  }
  if (schema.allOf !== undefined) {
    for (const item of schema.allOf) {
      const mismatch = schemaMismatch(value, item, path);
      if (mismatch !== null) return mismatch;
    }
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((item) => schemaMismatch(value, item, path) === null).length;
    if (matches !== 1) return `${path} must satisfy exactly one oneOf branch`;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      return `${path} must have type ${types.join(" | ")}`;
    }
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    return `${path} must be at least ${schema.minimum}`;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        const mismatch = schemaMismatch(value[key], propertySchema, `${path}.${key}`);
        if (mismatch !== null) return mismatch;
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `${path} must contain at least ${schema.minItems} items`;
    }
    for (const [index, item] of value.entries()) {
      const mismatch = schemaMismatch(item, schema.items, `${path}[${index}]`);
      if (mismatch !== null) return mismatch;
    }
  }
  if (Array.isArray(value) && schema.uniqueItems === true) {
    for (let index = 0; index < value.length; index += 1) {
      if (value.slice(index + 1).some((candidate) => isDeepStrictEqual(candidate, value[index]))) {
        return `${path} must not contain duplicate items`;
      }
    }
  }
  return null;
}

function assertSchemaMatches(value, schema, label) {
  assert.equal(schemaMismatch(value, schema), null, `${label} must satisfy the assembled OpenAPI schema`);
}

function assertSchemaRejects(value, schema, label) {
  assert.notEqual(schemaMismatch(value, schema), null, `${label} must be rejected by the assembled OpenAPI schema`);
}

function assertEvidence(actual, expected, label) {
  if (Array.isArray(expected)) {
    assert.deepEqual(actual, expected, `${label} must preserve the expected array values and order`);
    return;
  }
  if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object" && !Array.isArray(actual), `${label} must be an object`);
    for (const [key, expectedValue] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actual, key), `${label}.${key} must be present`);
      assertEvidence(actual[key], expectedValue, `${label}.${key}`);
    }
    return;
  }
  assert.deepEqual(actual, expected, `${label} must equal the expected runtime value`);
}

class StatementFixture {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.db.first(this.sql);
  }

  async all() {
    return { results: [] };
  }

  async run() {
    return { meta: { changes: 1 } };
  }
}

// This deliberately small D1 fixture drives envelope assembly in the real compiled handlers.
// It deliberately does NOT validate SQL text/bindings or persistence: callers inject `after`.
// Migration-backed SQLite 3x3, CAS-race, zero-write, and rollback proof lives in
// services/cloudflare-licensing-backend/test/sql/device-transition.test.mjs so this
// contract test cannot be mistaken for storage-semantics coverage.
class TransitionFixtureDb {
  constructor(before, after, { view = after, seats = [], deviceStatus = "active" } = {}) {
    this.before = before;
    this.after = after;
    this.view = view;
    this.seats = seats;
    this.deviceStatus = deviceStatus;
    this.committed = false;
  }

  prepare(sql) {
    return new StatementFixture(this, sql);
  }

  first(sql) {
    if (sql.includes("mutation_idempotency")) return null;
    if (sql.includes("JOIN catalog_plans")) return this.view;
    if (sql.includes("FROM entitlement_devices") && sql.includes("SELECT status")) return { status: this.deviceStatus };
    if (sql.startsWith("UPDATE webhook_deliveries")) return this.after;
    if (sql.startsWith("SELECT") && sql.includes("FROM entitlements")) return this.committed ? this.after : this.before;
    if (sql.startsWith("SELECT")) return this.before;
    if (sql.startsWith("UPDATE")) return this.after;
    throw new Error(`unexpected transition fixture SQL: ${sql}`);
  }

  async batch(statements) {
    this.committed = true;
    if (statements[0]?.sql.includes("FROM seat_checkouts")) {
      return [{ results: [] }, { results: this.seats.map((seat_id) => ({ seat_id })) }];
    }
    return statements.map((statement, index) => {
      if (index === 0) return { results: [this.after] };
      // Extra-statement entitlement mutations finish with a read-only snapshot
      // in the same D1 batch. This envelope fixture returns its real handler
      // evidence there; storage/SQL semantics remain covered by the migration-
      // backed transition suites.
      if (statement.sql.startsWith("SELECT project, feature, license_fingerprint") && statement.sql.includes("FROM entitlements")) {
        return { results: [this.after] };
      }
      return { results: [] };
    });
  }
}

// This fixture forces the compiled handler down the actual guarded-CAS loser
// branch. It is intentionally envelope-only; the migration-backed SQL proof
// for the same branch lives in the backend runtime test named above.
class CasLoserFixtureDb extends TransitionFixtureDb {
  async batch(statements) {
    this.committed = true;
    return statements.map(() => ({ results: [] }));
  }
}

class SameKeyReplayFixtureDb extends CasLoserFixtureDb {
  constructor(before, after, responseJson) {
    super(before, after);
    this.responseJson = responseJson;
    this.idempotencyReads = 0;
  }

  first(sql) {
    if (sql.includes("mutation_idempotency")) {
      this.idempotencyReads += 1;
      return this.idempotencyReads === 1 ? null : { response_json: this.responseJson };
    }
    return super.first(sql);
  }
}

function entitlementRecord(status, revocationSeq = 7) {
  return {
    id: ENTITLEMENT_ID,
    project: PROJECT,
    feature: FEATURE,
    license_fingerprint: fingerprint,
    device_hash: "",
    status,
    assertion_ttl_seconds: 300,
    revocation_seq: revocationSeq,
    valid_from: null,
    valid_until: null,
    notes: "",
    customer_id: null,
    license_id: null,
    created_at: 1,
    updated_at: 2,
  };
}

function guardedHandler(handler, path, body, before, after, ...args) {
  return handler(post(path, body), { DB: new TransitionFixtureDb(before, after) }, ACTOR, ...args, REQUEST_ID);
}

function deviceTransitionPath(action) {
  return `/api/admin/entitlements/${ENTITLEMENT_ID}/devices/${encodeURIComponent(DEVICE_KEY_ID)}/${action}`;
}

function invokeDeviceTransition(action, deviceStatus, beforeSeq, returnedSeq) {
  const body = action === "reenable" ? {} : { reason: "support" };
  return handleDeviceTransition(
    post(deviceTransitionPath(action), body),
    { DB: new TransitionFixtureDb(entitlementRecord("active", beforeSeq), entitlementRecord("active", returnedSeq), { deviceStatus }) },
    ACTOR,
    ENTITLEMENT_ID,
    encodeURIComponent(DEVICE_KEY_ID),
    action,
    REQUEST_ID,
  );
}

function entitlementTransitionPath(action) {
  return `/api/admin/entitlements/${ENTITLEMENT_ID}/${action}`;
}

async function invokeEntitlementTransition(action, sourceStatus) {
  const db = new MockD1();
  const env = { DB: db };
  const created = await handleMutation(
    post("/api/admin/entitlements", { project: PROJECT, feature: FEATURE, license_fingerprint: fingerprint, status: sourceStatus }),
    env,
    ACTOR,
    REQUEST_ID,
  );
  assert.equal(created.status, 200, `setup ${sourceStatus} entitlement`);
  const id = (await created.json()).data.id;
  const body = action === "reenable" ? {} : { reason: "support" };
  return handleMutation(post(`/api/admin/entitlements/${id}/${action}`, body), env, ACTOR, REQUEST_ID);
}

const TRANSITION_CONTRACTS = [
  {
    name: "customer disable",
    path: "/api/admin/customers/{id}/disable",
    code: "customer_disabled",
    data: { id: "customer-1", status: "disabled" },
    identity: ["id"],
    expectedStatus: "disabled",
    invoke: () => guardedHandler(handleCustomerTransition, "/api/admin/customers/customer-1/disable", { reason: "support" }, { id: "customer-1", status: "active" }, { id: "customer-1", status: "disabled" }, "customer-1", "disable"),
  },
  {
    name: "customer re-enable",
    path: "/api/admin/customers/{id}/reenable",
    code: "customer_reenabled",
    data: { id: "customer-1", status: "active" },
    identity: ["id"],
    expectedStatus: "active",
    invoke: () => guardedHandler(handleCustomerTransition, "/api/admin/customers/customer-1/reenable", {}, { id: "customer-1", status: "disabled" }, { id: "customer-1", status: "active" }, "customer-1", "reenable"),
  },
  {
    name: "policy disable",
    path: "/api/admin/policies/{id}/disable",
    code: "policy_disabled",
    data: { id: "policy-1", status: "disabled" },
    identity: ["id"],
    expectedStatus: "disabled",
    invoke: () => guardedHandler(handlePolicyTransition, "/api/admin/policies/policy-1/disable", { reason: "support" }, { id: "policy-1", status: "active" }, { id: "policy-1", status: "disabled" }, "policy-1", "disable", { reason: "support" }),
  },
  {
    name: "policy re-enable",
    path: "/api/admin/policies/{id}/reenable",
    code: "policy_reenabled",
    data: { id: "policy-1", status: "active" },
    identity: ["id"],
    expectedStatus: "active",
    invoke: () => guardedHandler(handlePolicyTransition, "/api/admin/policies/policy-1/reenable", {}, { id: "policy-1", status: "disabled" }, { id: "policy-1", status: "active" }, "policy-1", "reenable", {}),
  },
  {
    name: "catalog feature disable",
    path: "/api/admin/catalog/features/{id}/disable",
    code: "catalog_feature_disabled",
    data: { id: "feature-1", status: "disabled" },
    identity: ["id"],
    expectedStatus: "disabled",
    invoke: () => guardedHandler(transitionCatalogFeature, "/api/admin/catalog/features/feature-1/disable", { reason: "support" }, { id: "feature-1", status: "active" }, { id: "feature-1", status: "disabled" }, "feature-1", "disable"),
  },
  {
    name: "catalog feature re-enable",
    path: "/api/admin/catalog/features/{id}/reenable",
    code: "catalog_feature_reenabled",
    data: { id: "feature-1", status: "active" },
    identity: ["id"],
    expectedStatus: "active",
    invoke: () => guardedHandler(transitionCatalogFeature, "/api/admin/catalog/features/feature-1/reenable", {}, { id: "feature-1", status: "disabled" }, { id: "feature-1", status: "active" }, "feature-1", "reenable"),
  },
  {
    name: "catalog plan disable",
    path: "/api/admin/catalog/plans/{id}/disable",
    code: "catalog_plan_disabled",
    data: { id: "plan-1", status: "disabled" },
    identity: ["id"],
    expectedStatus: "disabled",
    invoke: () => guardedHandler(transitionCatalogPlan, "/api/admin/catalog/plans/plan-1/disable", { reason: "support" }, { id: "plan-1", status: "active" }, { id: "plan-1", status: "disabled" }, "plan-1", "disable"),
  },
  {
    name: "catalog plan re-enable",
    path: "/api/admin/catalog/plans/{id}/reenable",
    code: "catalog_plan_reenabled",
    data: { id: "plan-1", status: "active" },
    identity: ["id"],
    expectedStatus: "active",
    invoke: () => guardedHandler(transitionCatalogPlan, "/api/admin/catalog/plans/plan-1/reenable", {}, { id: "plan-1", status: "disabled" }, { id: "plan-1", status: "active" }, "plan-1", "reenable"),
  },
  {
    name: "catalog plan feature disable",
    path: "/api/admin/catalog/plans/{id}/features/{featureKey}/disable",
    code: "catalog_plan_feature_disabled",
    data: { plan_id: "plan-1", feature_key: "feature-1", status: "disabled" },
    identity: ["plan_id", "feature_key"],
    expectedStatus: "disabled",
    invoke: () => {
      const before = { plan_id: "plan-1", feature_key: "feature-1", status: "active" };
      const after = { plan_id: "plan-1", feature_key: "feature-1", status: "disabled" };
      const db = new TransitionFixtureDb(before, after, { view: after });
      return transitionCatalogPlanFeature(post("/api/admin/catalog/plans/plan-1/features/feature-1/disable", { reason: "support" }), { DB: db }, ACTOR, "plan-1", "feature-1", "disable", REQUEST_ID);
    },
  },
  {
    name: "catalog plan feature re-enable",
    path: "/api/admin/catalog/plans/{id}/features/{featureKey}/reenable",
    code: "catalog_plan_feature_reenabled",
    data: { plan_id: "plan-1", feature_key: "feature-1", status: "active" },
    identity: ["plan_id", "feature_key"],
    expectedStatus: "active",
    invoke: () => {
      const before = { plan_id: "plan-1", feature_key: "feature-1", status: "disabled" };
      const after = { plan_id: "plan-1", feature_key: "feature-1", status: "active" };
      const db = new TransitionFixtureDb(before, after, { view: after });
      return transitionCatalogPlanFeature(post("/api/admin/catalog/plans/plan-1/features/feature-1/reenable"), { DB: db }, ACTOR, "plan-1", "feature-1", "reenable", REQUEST_ID);
    },
  },
  {
    name: "entitlement disable",
    path: "/api/admin/entitlements/{id}/disable",
    code: "entitlement_disabled",
    data: { id: ENTITLEMENT_ID, status: "disabled", revocation_seq: 2 },
    identity: ["id", "revocation_seq"],
    expectedStatus: "disabled",
    invoke: async () => {
      const db = new MockD1();
      const env = { DB: db };
      const created = await handleMutation(post("/api/admin/entitlements", { project: PROJECT, feature: FEATURE, license_fingerprint: fingerprint }), env, ACTOR, REQUEST_ID);
      const id = (await created.json()).data.id;
      return handleMutation(post(`/api/admin/entitlements/${id}/disable`, { reason: "support" }), env, ACTOR, REQUEST_ID);
    },
  },
  {
    name: "entitlement re-enable",
    path: "/api/admin/entitlements/{id}/reenable",
    code: "entitlement_reenabled",
    data: { id: ENTITLEMENT_ID, status: "active", revocation_seq: 2 },
    identity: ["id", "revocation_seq"],
    expectedStatus: "active",
    invoke: async () => {
      const db = new MockD1();
      const env = { DB: db };
      const created = await handleMutation(post("/api/admin/entitlements", { project: PROJECT, feature: FEATURE, license_fingerprint: fingerprint, status: "disabled" }), env, ACTOR, REQUEST_ID);
      const id = (await created.json()).data.id;
      return handleMutation(post(`/api/admin/entitlements/${id}/reenable`), env, ACTOR, REQUEST_ID);
    },
  },
  {
    name: "entitlement revoke",
    path: "/api/admin/entitlements/{id}/revoke",
    code: "entitlement_revoked",
    data: { id: ENTITLEMENT_ID, status: "revoked", revocation_seq: 2 },
    identity: ["id", "revocation_seq"],
    expectedStatus: "revoked",
    invoke: async () => {
      const db = new MockD1();
      const env = { DB: db };
      const created = await handleMutation(post("/api/admin/entitlements", { project: PROJECT, feature: FEATURE, license_fingerprint: fingerprint }), env, ACTOR, REQUEST_ID);
      const id = (await created.json()).data.id;
      return handleMutation(post(`/api/admin/entitlements/${id}/revoke`, { reason: "support" }), env, ACTOR, REQUEST_ID);
    },
  },
  {
    name: "webhook disable",
    path: "/api/admin/webhooks/{id}/disable",
    code: "webhook_disabled",
    data: { id: "webhook-1", status: "disabled" },
    identity: ["id"],
    expectedStatus: "disabled",
    invoke: () => handleWebhookMutation(post("/api/admin/webhooks/webhook-1/disable", { reason: "support" }), { DB: new TransitionFixtureDb({ id: "webhook-1", status: "active" }, { id: "webhook-1", status: "disabled" }) }, ACTOR, REQUEST_ID),
  },
  {
    name: "webhook re-enable",
    path: "/api/admin/webhooks/{id}/reenable",
    code: "webhook_reenabled",
    data: { id: "webhook-1", status: "active" },
    identity: ["id"],
    expectedStatus: "active",
    invoke: () => handleWebhookMutation(post("/api/admin/webhooks/webhook-1/reenable"), { DB: new TransitionFixtureDb({ id: "webhook-1", status: "disabled" }, { id: "webhook-1", status: "active" }) }, ACTOR, REQUEST_ID),
  },
  {
    name: "webhook delivery redrive",
    path: "/api/admin/webhooks/deliveries/{id}/redrive",
    code: "webhook_delivery_redriven",
    data: { id: 7, status: "pending", next_attempt_at: 10 },
    identity: ["id", "next_attempt_at"],
    expectedStatus: "pending",
    invoke: () => handleWebhookMutation(post("/api/admin/webhooks/deliveries/7/redrive"), { DB: new TransitionFixtureDb({ id: 7, status: "failed" }, { id: 7, status: "pending", next_attempt_at: 10 }) }, ACTOR, REQUEST_ID),
  },
  {
    name: "device revoke",
    path: "/api/admin/entitlements/{id}/devices/{deviceKeyId}/revoke",
    code: "device_revoked",
    data: { id: ENTITLEMENT_ID, status: "active", revocation_seq: 8 },
    identity: ["id", "revocation_seq"],
    invoke: () => invokeDeviceTransition("revoke", "active", 7, 8),
  },
  {
    name: "device disable",
    path: "/api/admin/entitlements/{id}/devices/{deviceKeyId}/disable",
    code: "device_disabled",
    data: { id: ENTITLEMENT_ID, status: "active", revocation_seq: 8 },
    identity: ["id", "revocation_seq"],
    invoke: () => invokeDeviceTransition("disable", "active", 7, 8),
  },
  {
    name: "device re-enable",
    path: "/api/admin/entitlements/{id}/devices/{deviceKeyId}/reenable",
    code: "device_reenabled",
    data: { id: ENTITLEMENT_ID, status: "active", revocation_seq: 8 },
    identity: ["id", "revocation_seq"],
    invoke: () => invokeDeviceTransition("reenable", "disabled", 7, 8),
  },
  {
    name: "release seats",
    path: "/api/admin/entitlements/{id}/release-seats",
    code: "seats_released",
    data: { released: 2, seat_ids: ["seat-a", "seat-z"] },
    releasedMatchesSeatIds: true,
    invalidData: [
      { label: "negative released count", data: { released: -1, seat_ids: [] } },
      { label: "duplicate seat ids", data: { released: 2, seat_ids: ["seat-a", "seat-a"] } },
    ],
    invoke: () => handleReleaseSeats(post(`/api/admin/entitlements/${ENTITLEMENT_ID}/release-seats`, { reason: "support" }), { DB: new TransitionFixtureDb({}, {}, { seats: ["seat-z", "seat-a"] }) }, ACTOR, ENTITLEMENT_ID, REQUEST_ID),
  },
  {
    name: "batch entitlement transition",
    path: "/api/admin/entitlements/batch",
    code: "batch_done",
    data: { results: [{ id: ENTITLEMENT_ID, ok: true, code: "entitlement_disabled" }] },
    invalidData: [
      { label: "empty results", data: { results: [] } },
      { label: "row missing id", data: { results: [{ ok: true, code: "entitlement_disabled" }] } },
      { label: "row missing ok", data: { results: [{ id: ENTITLEMENT_ID, code: "entitlement_disabled" }] } },
      { label: "row missing code", data: { results: [{ id: ENTITLEMENT_ID, ok: true }] } },
    ],
    invoke: async () => {
      const db = new MockD1();
      const env = { DB: db };
      const created = await handleMutation(post("/api/admin/entitlements", { project: PROJECT, feature: FEATURE, license_fingerprint: fingerprint }), env, ACTOR, REQUEST_ID);
      const id = (await created.json()).data.id;
      return handleBatchTransition(post("/api/admin/entitlements/batch", { action: "disable", reason: "support", ids: [id] }), env, ACTOR, REQUEST_ID);
    },
  },
];

const DEVICE_STATE_CASES = [
  { action: "revoke", sourceStatus: "active", status: 200, code: "device_revoked", returnedSeq: 8 },
  { action: "revoke", sourceStatus: "disabled", status: 200, code: "device_revoked", returnedSeq: 8 },
  { action: "revoke", sourceStatus: "revoked", status: 200, code: "device_revoked", returnedSeq: 7 },
  { action: "disable", sourceStatus: "active", status: 200, code: "device_disabled", returnedSeq: 8 },
  { action: "disable", sourceStatus: "disabled", status: 200, code: "device_disabled", returnedSeq: 7 },
  { action: "disable", sourceStatus: "revoked", status: 409, code: "device_is_terminal" },
  { action: "reenable", sourceStatus: "active", status: 200, code: "device_reenabled", returnedSeq: 7 },
  { action: "reenable", sourceStatus: "disabled", status: 200, code: "device_reenabled", returnedSeq: 8 },
  { action: "reenable", sourceStatus: "revoked", status: 409, code: "device_is_terminal" },
];

const ENTITLEMENT_STATE_CASES = [
  { action: "revoke", sourceStatus: "active", status: 200, code: "entitlement_revoked", returnedStatus: "revoked", returnedSeq: 2 },
  { action: "revoke", sourceStatus: "disabled", status: 200, code: "entitlement_revoked", returnedStatus: "revoked", returnedSeq: 2 },
  { action: "revoke", sourceStatus: "revoked", status: 200, code: "entitlement_revoked", returnedStatus: "revoked", returnedSeq: 1 },
  { action: "disable", sourceStatus: "active", status: 200, code: "entitlement_disabled", returnedStatus: "disabled", returnedSeq: 2 },
  { action: "disable", sourceStatus: "disabled", status: 200, code: "entitlement_disabled", returnedStatus: "disabled", returnedSeq: 1 },
  { action: "disable", sourceStatus: "revoked", status: 409, code: "revoked_entitlement_is_terminal" },
  { action: "reenable", sourceStatus: "active", status: 200, code: "entitlement_reenabled", returnedStatus: "active", returnedSeq: 1 },
  { action: "reenable", sourceStatus: "disabled", status: 200, code: "entitlement_reenabled", returnedStatus: "active", returnedSeq: 2 },
  { action: "reenable", sourceStatus: "revoked", status: 409, code: "revoked_entitlement_is_terminal" },
];

function deviceOperationPath(action) {
  return `/api/admin/entitlements/{id}/devices/{deviceKeyId}/${action}`;
}

function entitlementOperationPath(action) {
  return `/api/admin/entitlements/{id}/${action}`;
}

test("transition success schemas fail closed on incomplete or contradictory envelopes", () => {
  for (const contract of TRANSITION_CONTRACTS) {
    const schema = operationSuccessSchema(contract.path);
    const valid = { ok: true, code: contract.code, request_id: REQUEST_ID, data: contract.data };
    assertSchemaMatches(valid, schema, `${contract.name} positive fixture`);
    assertSchemaRejects({ ...valid, data: null }, schema, `${contract.name} null data`);
    assertSchemaRejects({ ...valid, data: {} }, schema, `${contract.name} empty data`);
    const { data: _data, ...withoutData } = valid;
    assertSchemaRejects(withoutData, schema, `${contract.name} missing data`);
    for (const identity of contract.identity ?? []) {
      const incomplete = { ...contract.data };
      delete incomplete[identity];
      assertSchemaRejects({ ...valid, data: incomplete }, schema, `${contract.name} missing ${identity}`);
    }
    for (const invalid of contract.invalidData ?? []) {
      assertSchemaRejects({ ...valid, data: invalid.data }, schema, `${contract.name} ${invalid.label}`);
    }
    if (contract.expectedStatus !== undefined) {
      const wrongStatus = contract.expectedStatus === "active" ? "disabled" : "active";
      assertSchemaRejects({ ...valid, data: { ...contract.data, status: wrongStatus } }, schema, `${contract.name} wrong resulting status`);
    }
  }
});

test("every assembled Worker API 2xx response has a JSON schema that requires data", () => {
  let checked = 0;
  for (const [path, item] of Object.entries(openApiDocument.paths)) {
    if (!path.startsWith("/api/")) continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!["get", "post", "patch", "put", "delete"].includes(method)) continue;
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (!/^2\d\d$/.test(status)) continue;
        assert.ok(response.content !== undefined, `${method.toUpperCase()} ${path} ${status} must declare response content`);
        const jsonContent = response.content?.["application/json"];
        assert.ok(jsonContent !== undefined, `${method.toUpperCase()} ${path} ${status} must declare application/json content`);
        const schema = jsonContent?.schema;
        assert.ok(schema !== undefined, `${method.toUpperCase()} ${path} ${status} must declare an application/json schema`);
        checked += 1;
        assert.equal(schemaRequiresProperty(schema, "data"), true, `${method.toUpperCase()} ${path} ${status} must require data`);
      }
    }
  }
  assert.equal(checked, 63, "the assembled Worker contract currently has 63 JSON 2xx responses; add a schema when adding one");
});

test("compiled device transition state matrix distinguishes changes, no-ops, and terminal conflicts", async () => {
  for (const transition of DEVICE_STATE_CASES) {
    const response = await invokeDeviceTransition(transition.action, transition.sourceStatus, 7, transition.returnedSeq ?? 7);
    assert.equal(response.status, transition.status, `${transition.action} from ${transition.sourceStatus} runtime status`);
    const body = await response.json();
    assert.equal(body.ok, transition.status === 200, `${transition.action} from ${transition.sourceStatus} runtime ok`);
    assert.equal(body.code, transition.code, `${transition.action} from ${transition.sourceStatus} runtime code`);
    if (transition.status === 200) {
      assertEvidence(body.data, { id: ENTITLEMENT_ID, status: "active", revocation_seq: transition.returnedSeq }, `${transition.action} from ${transition.sourceStatus} returned parent evidence`);
    }
    assertSchemaMatches(body, operationResponseSchema(deviceOperationPath(transition.action), String(transition.status)), `${transition.action} from ${transition.sourceStatus} runtime body`);
  }

  assert.ok(operation(deviceOperationPath("revoke")).responses?.["409"], "revoke documents a genuine stale-transition conflict while preserving already-revoked 200 no-op semantics");
  for (const action of ["revoke", "disable", "reenable"]) {
    const success = operation(deviceOperationPath(action)).responses?.["200"];
    assert.match(success?.description ?? "", /authoritative revocation_seq/i, `${action} must describe the returned parent sequence`);
    assert.match(success?.description ?? "", /unchanged/i, `${action} must describe its already-target no-op`);
  }
  for (const action of ["revoke", "disable", "reenable"]) {
    const conflict = operation(deviceOperationPath(action)).responses?.["409"];
    assert.match(conflict?.description ?? "", /concurrent/i, `${action} must document the guarded stale-transition conflict`);
  }
});

test("compiled entitlement transition state matrix distinguishes changes, no-ops, and terminal conflicts", async () => {
  for (const transition of ENTITLEMENT_STATE_CASES) {
    const response = await invokeEntitlementTransition(transition.action, transition.sourceStatus);
    assert.equal(response.status, transition.status, `${transition.action} from ${transition.sourceStatus} runtime status`);
    const body = await response.json();
    assert.equal(body.ok, transition.status === 200, `${transition.action} from ${transition.sourceStatus} runtime ok`);
    assert.equal(body.code, transition.code, `${transition.action} from ${transition.sourceStatus} runtime code`);
    if (transition.status === 200) {
      assertEvidence(body.data, {
        id: ENTITLEMENT_ID,
        status: transition.returnedStatus,
        revocation_seq: transition.returnedSeq,
      }, `${transition.action} from ${transition.sourceStatus} returned entitlement evidence`);
    }
    assertSchemaMatches(body, operationResponseSchema(entitlementOperationPath(transition.action), String(transition.status)), `${transition.action} from ${transition.sourceStatus} runtime body`);
  }

  assert.ok(operation(entitlementOperationPath("revoke")).responses?.["409"], "revoke documents a genuine stale-transition conflict while preserving already-revoked 200 no-op semantics");
  for (const action of ["revoke", "disable", "reenable"]) {
    const success = operation(entitlementOperationPath(action)).responses?.["200"];
    assert.match(success?.description ?? "", /no-op|unchanged/i, `${action} must describe its already-target no-op`);
  }
  for (const action of ["revoke", "disable", "reenable"]) {
    const conflict = operation(entitlementOperationPath(action)).responses?.["409"];
    assert.match(conflict?.description ?? "", /concurrent/i, `${action} must document the guarded stale-transition conflict`);
  }
});

test("compiled entitlement handler maps a guarded CAS loser to the documented stale_transition conflict", async () => {
  const db = new CasLoserFixtureDb(entitlementRecord("active", 7), entitlementRecord("active", 8));
  const response = await handleMutation(
    post(entitlementTransitionPath("disable"), { reason: "support" }),
    { DB: db },
    ACTOR,
    REQUEST_ID,
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assertEvidence(body, { ok: false, code: "stale_transition", request_id: REQUEST_ID }, "CAS loser runtime error");
  assertSchemaMatches(body, operationResponseSchema(entitlementOperationPath("disable"), "409"), "CAS loser runtime body");
});

test("compiled entitlement handler serves the winner cache for a same-key guarded-CAS loser", async () => {
  const winnerBody = {
    ok: true,
    code: "entitlement_disabled",
    request_id: "winner-request",
    data: entitlementRecord("disabled", 8),
  };
  const db = new SameKeyReplayFixtureDb(
    entitlementRecord("active", 7),
    entitlementRecord("disabled", 8),
    JSON.stringify(winnerBody),
  );
  const response = await handleMutation(
    post(entitlementTransitionPath("disable"), { reason: "support" }, { "idempotency-key": "same-key-race" }),
    { DB: db },
    ACTOR,
    REQUEST_ID,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-idempotent-replay"), "1");
  const body = await response.json();
  assertEvidence(body, winnerBody, "same-key race replay body");
  assertSchemaMatches(body, operationSuccessSchema(entitlementOperationPath("disable")), "same-key race replay schema");
});

test("compiled batch transition preserves duplicate input identity and per-row outcome evidence", async () => {
  const db = new MockD1();
  const env = { DB: db };
  const created = await handleMutation(post("/api/admin/entitlements", { project: PROJECT, feature: FEATURE, license_fingerprint: fingerprint }), env, ACTOR, REQUEST_ID);
  const id = (await created.json()).data.id;
  const response = await handleBatchTransition(
    post("/api/admin/entitlements/batch", { action: "disable", reason: "support", ids: [id, id] }),
    env,
    ACTOR,
    REQUEST_ID,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.code, "batch_done");
  assertEvidence(body.data, {
    results: [
      { id, ok: true, code: "entitlement_disabled" },
      { id, ok: true, code: "entitlement_disabled" },
    ],
  }, "duplicate batch runtime data");
  assertSchemaMatches(body, operationSuccessSchema("/api/admin/entitlements/batch"), "duplicate batch runtime body");
});

test("real compiled transition handlers emit their table-driven identity and transition evidence", async () => {
  for (const contract of TRANSITION_CONTRACTS) {
    const response = await contract.invoke();
    assert.equal(response.status, 200, `${contract.name} runtime status`);
    const body = await response.json();
    assert.equal(body.ok, true, `${contract.name} runtime ok`);
    assert.equal(body.code, contract.code, `${contract.name} runtime code`);
    assertEvidence(body.data, contract.data, `${contract.name} runtime data`);
    if (contract.releasedMatchesSeatIds) {
      assert.equal(body.data.released, body.data.seat_ids.length, `${contract.name} released must equal the exact returned seat_ids count`);
      assert.deepEqual(body.data.seat_ids, [...body.data.seat_ids].sort(), `${contract.name} seat_ids must retain runtime sorted order`);
    }
    assertSchemaMatches(body, operationSuccessSchema(contract.path), `${contract.name} runtime body`);
  }
});
