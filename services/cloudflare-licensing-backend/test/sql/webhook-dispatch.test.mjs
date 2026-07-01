// Real-SQLite integration for the webhook dispatcher (the cron-drained read-side outbox). Drives the
// EXACT enqueue/deliver functions the Worker's scheduled() runs, against an in-memory SQLite built
// from the shared migrations, wrapped in a D1-like adapter, with fetch mocked. Asserts:
//   - enqueue is EXACTLY-ONCE (run it twice over the same events -> no duplicate deliveries),
//   - the event_types CSV filter selects which endpoints get a delivery,
//   - deliver success (mock -> 200 -> delivered), failure (-> attempts bump + backoff),
//     and max-attempts (-> failed),
//   - a fetch that THROWS/TIMES OUT never escapes the dispatcher,
//   - fail-closed: no usable signing secret -> nothing is delivered (never sent unsigned),
//   - the signature on a real delivery round-trips through verifyWebhookSignature.
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadSecretMap } from "../../src/fulfillment/order_hmac.mjs";
import {
  enqueueWebhooks,
  deliverWebhooks,
  enqueueAndDeliverWebhooks,
  verifyWebhookSignature,
  WEBHOOK_MAX_ATTEMPTS,
} from "../../src/webhooks/webhook.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");

// --- D1-like adapter over node:sqlite (mirrors the order-ingest test's shim) -----------------
class PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...values) {
    const next = new PreparedStatement(this.db, this.sql);
    next.params = values.map(normalizeParam);
    return next;
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    const rows = this.db.prepare(this.sql).all(...this.params);
    return { results: rows };
  }
  async run() {
    this.db.prepare(this.sql).all(...this.params);
    return { success: true };
  }
}

function normalizeParam(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

class D1Like {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new PreparedStatement(this.db, sql);
  }
}

const SECRET_B64 = Buffer.alloc(32, 7).toString("base64");
const SIGNING_ENV = {
  WEBHOOK_SIGNING_SECRETS: JSON.stringify({ k1: SECRET_B64 }),
  WEBHOOK_SIGNING_KEY_ID: "k1",
};

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return db;
}

function addEndpoint(
  db,
  id,
  { url = `https://hook.test/${id}`, eventTypes = "", status = "active", scopeProject = null, scopeCustomer = null } = {},
) {
  db.prepare(
    "INSERT INTO webhook_endpoints (id, url, event_types, status, description, created_at, updated_at, scope_project, scope_customer_id) " +
      "VALUES (?,?,?,?,'',?,?,?,?)",
  ).run(id, url, eventTypes, status, 1000, 1000, scopeProject, scopeCustomer);
}

function addEntitlementEvent(db, eventType, createdAt) {
  db.prepare(
    "INSERT INTO entitlement_events (project, feature, license_fingerprint, event_type, status, revocation_seq, prev_json, next_json, created_at) " +
      "VALUES ('P','F',?,?,?,0,?,?,?)",
  ).run("a".repeat(64), eventType, "active", '{"status":"disabled"}', '{"status":"active"}', createdAt);
}

function addCustomerEvent(db, customerId, eventType, createdAt) {
  // customer_events has an FK to customers(id) and this runtime enforces it, so seed the parent
  // customer row first (name is NOT NULL with no default). The dispatcher only READS customer_events.
  db.prepare(
    "INSERT OR IGNORE INTO customers (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
  ).run(customerId, customerId, createdAt, createdAt);
  db.prepare(
    "INSERT INTO customer_events (customer_id, event_type, prev_status, next_status, created_at) VALUES (?,?,?,?,?)",
  ).run(customerId, eventType, "active", "disabled", createdAt);
}

function addOrderEvent(db, eventId, intent, receivedAt) {
  db.prepare(
    "INSERT INTO order_events (event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, payload_digest, raw_payload, status, result_json, received_at) " +
      "VALUES (?, 'sub_1','P','F',0,1,?,'k1','d','{}','processed',?,?)",
  ).run(eventId, intent, '{"ok":true}', receivedAt);
}

function countDeliveries(db, where = "") {
  return db.prepare(`SELECT COUNT(*) AS c FROM webhook_deliveries ${where}`).get().c;
}

function getDelivery(db, id) {
  return db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(id);
}

// -------------------------------------------------------------------------------------------------

test("enqueue is exactly-once across re-runs (the UNIQUE + cursor)", async () => {
  const db = freshDb();
  const env = { DB: new D1Like(db) };
  addEndpoint(db, "ep1");
  addEntitlementEvent(db, "create", 100);
  addEntitlementEvent(db, "update", 101);
  addCustomerEvent(db, "cust_1", "disable", 102);
  addOrderEvent(db, "evt_1", "subscription.active", 103);

  await enqueueWebhooks(env, 200);
  const first = countDeliveries(db);
  assert.equal(first, 4, "one delivery per event for the single all-events endpoint");

  // Re-run over the SAME events: cursor skips them and the UNIQUE makes any overlap a no-op.
  await enqueueWebhooks(env, 201);
  assert.equal(countDeliveries(db), 4, "a second enqueue pass produces NO duplicates");

  // A new event after the cursor enqueues exactly one more.
  addEntitlementEvent(db, "revoke", 104);
  await enqueueWebhooks(env, 202);
  assert.equal(countDeliveries(db), 5, "only the new event is added");
  db.close();
});

test("endpoint scope filters events to the matching tenant dimension (R2.2)", async () => {
  const db = freshDb();
  const env = { DB: new D1Like(db) };
  addEndpoint(db, "global"); // both scope columns null -> every event (back-compat)
  addEndpoint(db, "projP", { scopeProject: "P" }); // only project-P entitlement/order events
  addEndpoint(db, "projX", { scopeProject: "X" }); // project X -> nothing here
  addEndpoint(db, "custC", { scopeCustomer: "cust_1" }); // only customer_events for cust_1

  addEntitlementEvent(db, "create", 100); // project P
  addOrderEvent(db, "evt_1", "subscription.active", 101); // project P
  addCustomerEvent(db, "cust_1", "disable", 102); // customer cust_1

  await enqueueWebhooks(env, 200);

  assert.equal(countDeliveries(db, "WHERE endpoint_id = 'global'"), 3, "global endpoint gets every event");
  assert.equal(
    countDeliveries(db, "WHERE endpoint_id = 'projP'"),
    2,
    "project-scoped endpoint gets the 2 project-P events, not the customer event",
  );
  assert.equal(countDeliveries(db, "WHERE endpoint_id = 'projX'"), 0, "wrong-project endpoint gets nothing");
  assert.equal(
    countDeliveries(db, "WHERE endpoint_id = 'custC'"),
    1,
    "customer-scoped endpoint gets only the matching customer event",
  );
  db.close();
});

test("event_types CSV filter selects which endpoints receive a delivery", async () => {
  const db = freshDb();
  const env = { DB: new D1Like(db) };
  addEndpoint(db, "all", { eventTypes: "" }); // all events
  addEndpoint(db, "creates", { eventTypes: "create" }); // only entitlement 'create'
  addEntitlementEvent(db, "create", 100);
  addEntitlementEvent(db, "update", 101);

  await enqueueWebhooks(env, 200);
  assert.equal(countDeliveries(db, "WHERE endpoint_id = 'all'"), 2, "all-endpoint gets both");
  assert.equal(countDeliveries(db, "WHERE endpoint_id = 'creates'"), 1, "filtered endpoint gets only create");
  const onlyCreate = db.prepare("SELECT event_type FROM webhook_deliveries WHERE endpoint_id = 'creates'").get();
  assert.equal(onlyCreate.event_type, "create");
  db.close();
});

test("deliver success: a 200 marks the row delivered with the status code", async () => {
  const db = freshDb();
  const env = { DB: new D1Like(db), ...SIGNING_ENV };
  addEndpoint(db, "ep1");
  addEntitlementEvent(db, "create", 100);
  await enqueueWebhooks(env, 200);

  const captured = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url, init });
    return new Response("", { status: 200 });
  };
  try {
    await deliverWebhooks(env, 201, () => {});
  } finally {
    globalThis.fetch = orig;
  }

  assert.equal(captured.length, 1, "exactly one POST");
  assert.equal(captured[0].init.method, "POST");
  const row = db.prepare("SELECT * FROM webhook_deliveries").get();
  assert.equal(row.status, "delivered");
  assert.equal(row.last_status, 200);
  assert.equal(row.attempts, 1);
  assert.ok(row.delivered_at >= 201);

  // The delivered request's signature round-trips through the public verifier over the EXACT body.
  const header = captured[0].init.headers["Licensecc-Signature"];
  const secrets = loadSecretMap(SIGNING_ENV.WEBHOOK_SIGNING_SECRETS);
  assert.equal(await verifyWebhookSignature(captured[0].init.body, header, secrets, 201), true);
  // A tampered body must fail.
  assert.equal(await verifyWebhookSignature(captured[0].init.body + "x", header, secrets, 201), false);
  db.close();
});

test("deliver failure: a 500 bumps attempts and schedules a backoff retry (stays pending)", async () => {
  const db = freshDb();
  const env = { DB: new D1Like(db), ...SIGNING_ENV };
  addEndpoint(db, "ep1");
  addEntitlementEvent(db, "create", 100);
  await enqueueWebhooks(env, 200);

  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  try {
    await deliverWebhooks(env, 300, () => {});
  } finally {
    globalThis.fetch = orig;
  }
  const row = db.prepare("SELECT * FROM webhook_deliveries").get();
  assert.equal(row.status, "pending", "still pending for retry");
  assert.equal(row.attempts, 1);
  assert.equal(row.last_status, 500);
  assert.equal(row.next_attempt_at, 300 + 30, "first backoff = 30s after now");
  assert.match(row.last_error, /boom/);
  db.close();
});

test("deliver max-attempts: the row terminates as failed after MAX_ATTEMPTS", async () => {
  const db = freshDb();
  const env = { DB: new D1Like(db), ...SIGNING_ENV };
  addEndpoint(db, "ep1");
  addEntitlementEvent(db, "create", 100);
  await enqueueWebhooks(env, 200);
  const id = db.prepare("SELECT id FROM webhook_deliveries").get().id;

  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 503 });
  try {
    // Drive enough ticks to exhaust the budget; each tick we must reset next_attempt_at <= now since
    // the deliver query only picks DUE rows. Use an ever-increasing `now`.
    let now = 300;
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS + 2; i += 1) {
      // Make the row due regardless of the last backoff.
      db.prepare("UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE status = 'pending'").run();
      await deliverWebhooks(env, now, () => {});
      now += 100000;
    }
  } finally {
    globalThis.fetch = orig;
  }
  const row = getDelivery(db, id);
  assert.equal(row.status, "failed", "terminal after MAX_ATTEMPTS");
  assert.equal(row.attempts, WEBHOOK_MAX_ATTEMPTS);
  assert.equal(row.last_status, 503);
  db.close();
});

test("a fetch that throws/times out never escapes the dispatcher (recorded as a retry)", async () => {
  const db = freshDb();
  const env = { DB: new D1Like(db), ...SIGNING_ENV };
  addEndpoint(db, "ep1");
  addEntitlementEvent(db, "create", 100);

  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down / aborted");
  };
  try {
    // enqueueAndDeliverWebhooks is the scheduled() entry point — it must resolve, never reject.
    await assert.doesNotReject(enqueueAndDeliverWebhooks(env, 400, () => {}));
  } finally {
    globalThis.fetch = orig;
  }
  const row = db.prepare("SELECT * FROM webhook_deliveries").get();
  assert.equal(row.status, "pending", "a thrown fetch is a retryable failure, not a crash");
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /network down|aborted/);
  db.close();
});

test("fail-closed: with no usable signing secret nothing is delivered (never sent unsigned)", async () => {
  const db = freshDb();
  // No WEBHOOK_SIGNING_SECRETS in env at all.
  const env = { DB: new D1Like(db) };
  addEndpoint(db, "ep1");
  addEntitlementEvent(db, "create", 100);
  await enqueueWebhooks(env, 200);

  let fetchCalled = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("", { status: 200 });
  };
  const logs = [];
  try {
    await deliverWebhooks(env, 201, (sev, ev) => logs.push(ev));
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(fetchCalled, false, "no request is sent without a usable signing secret");
  const row = db.prepare("SELECT * FROM webhook_deliveries").get();
  assert.equal(row.status, "pending", "the delivery waits for a properly-configured tick");
  assert.ok(logs.includes("webhook.signing_unconfigured"), "the skip is logged");

  // A configured secrets map but a key id that is not present is also fail-closed.
  const env2 = { DB: new D1Like(db), WEBHOOK_SIGNING_SECRETS: SIGNING_ENV.WEBHOOK_SIGNING_SECRETS, WEBHOOK_SIGNING_KEY_ID: "missing" };
  const logs2 = [];
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("", { status: 200 });
  };
  try {
    await deliverWebhooks(env2, 202, (sev, ev) => logs2.push(ev));
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(fetchCalled, false, "missing active key id is also fail-closed");
  assert.ok(logs2.includes("webhook.signing_key_missing"));
  db.close();
});

test("order_events cursor on rowid enqueues each order exactly once", async () => {
  const db = freshDb();
  const env = { DB: new D1Like(db) };
  addEndpoint(db, "ep1");
  addOrderEvent(db, "evt_a", "subscription.created", 100);
  addOrderEvent(db, "evt_b", "subscription.updated", 101);
  await enqueueWebhooks(env, 200);
  assert.equal(countDeliveries(db), 2);
  // Re-run: the rowid cursor advanced, so no duplicates.
  await enqueueWebhooks(env, 201);
  assert.equal(countDeliveries(db), 2, "order events are not re-enqueued");
  // The order payload carries the external event_id and the parsed result.
  const row = db.prepare("SELECT payload_json FROM webhook_deliveries ORDER BY id ASC").get();
  const payload = JSON.parse(row.payload_json);
  assert.equal(payload.source, "order");
  assert.equal(payload.data.order_event_id, "evt_a");
  assert.deepEqual(payload.data.result, { ok: true });
  db.close();
});
