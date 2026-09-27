import assert from "node:assert/strict";
import test from "node:test";
import { WEBHOOK_EVENT_TYPES } from "@licensecc/cloudflare-runtime/webhooks/event_types";
import { authed, baseEnv, worker } from "./fixtures.mjs";
import { assertRouteGroup, assertRouteGroupRejectsUnauthenticated } from "./route-group-assertions.mjs";

test("webhook routes have direct owners and reject anonymous access", async () => {
  assertRouteGroup("webhooks", 8);
  await assertRouteGroupRejectsUnauthenticated("webhooks");
});

// An unknown event_types token can never match a real event, so create/patch reject it up front
// (400 invalid_event_types + the allowed list) before ever touching D1 -- proven here with a DB
// stub that throws if touched, the same guard-rail pattern customers.test.mjs uses for its own
// pre-D1 validation rejections.
function untouchableDb() {
  return {
    prepare() { throw new Error("D1 must not be touched"); },
    batch() { throw new Error("D1 must not be touched"); },
  };
}

test("creating a webhook with an unknown event_types token returns 400 invalid_event_types with the allowed list, before touching D1", async () => {
  const env = baseEnv(untouchableDb());
  const response = await worker.fetch(
    authed("/api/admin/webhooks", {
      method: "POST",
      headers: { "idempotency-key": "webhook-create-invalid-event-types" },
      body: JSON.stringify({ url: "https://hooks.example.com/lcc", event_types: "not_a_real_event_type" }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "invalid_event_types");
  assert.deepEqual(body.data?.allowed, WEBHOOK_EVENT_TYPES);
});

// A PATCH must read the existing row before it can tell whether a submitted event_types value is
// NEW/CHANGED (validate it) or an unchanged resend of whatever is already stored (never validate
// it -- webhook_endpoints.event_types has no database CHECK, so an existing row can already hold
// a legacy token). This tiny D1 double models exactly that one row, applying an UPDATE ... SET
// clause generically by column name so it works for any subset of patched fields.
function applyAssignments(row, sql, values) {
  const setClause = /SET\s+(.+?)\s+WHERE/is.exec(sql)[1];
  const columns = setClause.split(",").map((assignment) => assignment.trim().split("=")[0].trim());
  const updated = { ...row };
  columns.forEach((column, index) => { updated[column] = values[index]; });
  return updated;
}

class WebhookRowStatement {
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
    if (this.sql.includes("mutation_idempotency")) {
      return null;
    }
    if (this.sql.startsWith("SELECT") && this.sql.includes("FROM webhook_endpoints")) {
      return this.db.row.id === this.values[0] ? { ...this.db.row } : null;
    }
    if (this.sql.startsWith("UPDATE webhook_endpoints")) {
      this.db.row = applyAssignments(this.db.row, this.sql, this.values);
      return { ...this.db.row };
    }
    throw new Error(`unexpected first SQL: ${this.sql}`);
  }

  async run() {
    return { meta: { changes: 1 } };
  }
}

class WebhookRowDb {
  constructor(row) {
    this.row = { ...row };
  }

  prepare(sql) {
    return new WebhookRowStatement(this, sql);
  }
}

function legacyWebhookRow(overrides = {}) {
  return {
    id: "wh_legacy",
    url: "https://hooks.example.com/legacy",
    // A token no current source (entitlement/customer/order) defines -- exactly what a row
    // predating today's closed set, or one written before a source's list changed, can hold.
    event_types: "legacy_unknown_type",
    status: "active",
    description: "",
    scope_project: null,
    scope_customer_id: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    ...overrides,
  };
}

test("PATCHing only the URL of a legacy-event_types endpoint succeeds without touching event_types", async () => {
  const env = baseEnv(new WebhookRowDb(legacyWebhookRow()));
  const response = await worker.fetch(
    authed("/api/admin/webhooks/wh_legacy", {
      method: "PATCH",
      headers: { "idempotency-key": "webhook-patch-legacy-url-only" },
      body: JSON.stringify({ url: "https://hooks.example.com/updated" }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, "webhook_patched");
  assert.equal(body.data.url, "https://hooks.example.com/updated");
  // event_types was never sent, so the stored legacy value is untouched.
  assert.equal(body.data.event_types, "legacy_unknown_type");
});

test("PATCHing with the endpoint's own unchanged legacy event_types resent succeeds", async () => {
  const env = baseEnv(new WebhookRowDb(legacyWebhookRow()));
  const response = await worker.fetch(
    authed("/api/admin/webhooks/wh_legacy", {
      method: "PATCH",
      headers: { "idempotency-key": "webhook-patch-legacy-resend" },
      body: JSON.stringify({ event_types: "legacy_unknown_type" }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, "webhook_patched");
  assert.equal(body.data.event_types, "legacy_unknown_type");
});

test("PATCHing to CHANGE event_types away from a legacy value still enforces the known set", async () => {
  const env = baseEnv(new WebhookRowDb(legacyWebhookRow()));
  const response = await worker.fetch(
    authed("/api/admin/webhooks/wh_legacy", {
      method: "PATCH",
      headers: { "idempotency-key": "webhook-patch-legacy-change" },
      body: JSON.stringify({ event_types: "legacy_unknown_type,also_bogus" }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "invalid_event_types");
  assert.deepEqual(body.data?.allowed, WEBHOOK_EVENT_TYPES);
});
