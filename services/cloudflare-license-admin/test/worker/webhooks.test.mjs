import assert from "node:assert/strict";
import test from "node:test";
import { WEBHOOK_EVENT_TYPES } from "@licensecc/cloudflare-runtime/webhooks/event_types";
import { authed, baseEnv, worker } from "./fixtures.mjs";
import { assertRouteGroup, assertRouteGroupRejectsUnauthenticated } from "./route-group-assertions.mjs";

test("webhook routes have direct owners and reject anonymous access", async () => {
  assertRouteGroup("webhooks", 9);
  await assertRouteGroupRejectsUnauthenticated("webhooks");
});

// An unknown event_types token can never match a real event, and a body without an explicit scope
// names no audience, so create refuses both up front before ever touching D1 -- proven here with a
// DB stub that throws if touched, the same guard-rail pattern customers.test.mjs uses for its own
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
      body: JSON.stringify({ url: "https://hooks.example.com/lcc", scope_kind: "global", event_types: "not_a_real_event_type" }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "invalid_event_types");
  assert.deepEqual(body.data?.allowed, WEBHOOK_EVENT_TYPES);
});

test("a webhook without scope_kind is refused", async () => {
  const env = baseEnv(untouchableDb());
  const bodies = [
    { url: "https://hooks.example.com/lcc" },
    { url: "https://hooks.example.com/lcc", scope_project: "DEFAULT" },
    { url: "https://hooks.example.com/lcc", scope_customer_id: "cus_1" },
    { url: "https://hooks.example.com/lcc", scope_kind: "" },
    { url: "https://hooks.example.com/lcc", scope_kind: null },
    { url: "https://hooks.example.com/lcc", scope_kind: "all" },
  ];
  for (const [index, payload] of bodies.entries()) {
    const response = await worker.fetch(
      authed("/api/admin/webhooks", {
        method: "POST",
        headers: { "idempotency-key": `webhook-create-no-scope-${index}` },
        body: JSON.stringify(payload),
      }),
      env,
    );
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal((await response.json()).code, "invalid_request", JSON.stringify(payload));
  }
});

// A PATCH reads the stored row and checks the whole row it would leave behind, so this tiny D1
// double models exactly that one row, applying an UPDATE ... SET clause generically by column name
// so it works for any subset of patched fields, and counting the writes it receives.
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
      this.db.updates += 1;
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
    this.updates = 0;
  }

  prepare(sql) {
    return new WebhookRowStatement(this, sql);
  }
}

function storedWebhookRow(overrides = {}) {
  return {
    id: "wh_retired",
    url: "https://hooks.example.com/retired",
    // A token the dispatcher does not emit. The baseline's triggers refuse such a row, so this
    // models a stored value the current event-type list no longer covers.
    event_types: "retired_event_type",
    status: "active",
    description: "",
    scope_kind: "global",
    scope_project: null,
    scope_customer_id: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    ...overrides,
  };
}

test("patching a webhook keeps rejecting an unknown event token even when unchanged", async () => {
  const patches = {
    "resent unchanged": { event_types: "retired_event_type" },
    "left out": { url: "https://hooks.example.com/updated" },
    changed: { event_types: "retired_event_type,also_bogus" },
    "a new unknown token": { event_types: "create,also_bogus" },
  };
  for (const [label, patch] of Object.entries(patches)) {
    const db = new WebhookRowDb(storedWebhookRow());
    const response = await worker.fetch(
      authed("/api/admin/webhooks/wh_retired", {
        method: "PATCH",
        headers: { "idempotency-key": `webhook-patch-unknown-${label.replaceAll(" ", "-")}` },
        body: JSON.stringify(patch),
      }),
      baseEnv(db),
    );
    assert.equal(response.status, 400, label);
    const body = await response.json();
    assert.equal(body.code, "invalid_event_types", label);
    assert.deepEqual(body.data?.allowed, WEBHOOK_EVENT_TYPES, label);
    assert.equal(db.updates, 0, `${label}: nothing is written`);
    assert.equal(db.row.url, "https://hooks.example.com/retired", label);
  }
});

test("patching a webhook to known event types replaces an unknown stored token", async () => {
  const db = new WebhookRowDb(storedWebhookRow());
  const response = await worker.fetch(
    authed("/api/admin/webhooks/wh_retired", {
      method: "PATCH",
      headers: { "idempotency-key": "webhook-patch-known-event-types" },
      body: JSON.stringify({ event_types: "create,subscription.active" }),
    }),
    baseEnv(db),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, "webhook_patched");
  assert.equal(body.data.event_types, "create,subscription.active");
});

test("patching a webhook checks the full resulting scope", async () => {
  const projectRow = storedWebhookRow({ event_types: "create", scope_kind: "project", scope_project: "DEFAULT" });
  const refused = {
    "a kind whose value is missing": { scope_kind: "customer" },
    "a kind with the other value still stored": { scope_kind: "customer", scope_customer_id: "cus_1" },
    "global with a project still stored": { scope_kind: "global" },
    "a cleared project value": { scope_project: "" },
    "an unknown kind": { scope_kind: "all" },
    "a null kind": { scope_kind: null },
  };
  for (const [label, patch] of Object.entries(refused)) {
    const db = new WebhookRowDb(projectRow);
    const response = await worker.fetch(
      authed("/api/admin/webhooks/wh_retired", {
        method: "PATCH",
        headers: { "idempotency-key": `webhook-patch-scope-${label.replaceAll(" ", "-")}` },
        body: JSON.stringify(patch),
      }),
      baseEnv(db),
    );
    assert.equal(response.status, 400, label);
    assert.equal((await response.json()).code, "invalid_request", label);
    assert.equal(db.updates, 0, `${label}: nothing is written`);
  }

  const db = new WebhookRowDb(projectRow);
  const moved = await worker.fetch(
    authed("/api/admin/webhooks/wh_retired", {
      method: "PATCH",
      headers: { "idempotency-key": "webhook-patch-scope-moved" },
      body: JSON.stringify({ scope_kind: "customer", scope_project: "", scope_customer_id: "cus_1" }),
    }),
    baseEnv(db),
  );
  assert.equal(moved.status, 200);
  const body = await moved.json();
  assert.equal(body.data.scope_kind, "customer");
  assert.equal(body.data.scope_project, null);
  assert.equal(body.data.scope_customer_id, "cus_1");
});
