// Slice 1 order-ingest — the exactly-once accept/apply integration matrix (16 cases).
//
// This suite drives the REAL guarded SQL (the ON CONFLICT...WHERE floor, the
// INSERT...SELECT...WHERE EXISTS cursor/claim, the floor-guarded UPDATEs) against an
// in-memory SQLite built from the shared migrations, wrapped in a D1-like adapter so
// `runExactlyOnce` / `applyOrderEvent` / `buildAcceptBatch` execute byte-for-byte the
// statements the Worker runs. Nothing about the SQL semantics is hand-mocked: every
// assertion is read back out of SQLite after the guarded statement ran.
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via the
// `test:sql` npm script (it passes --experimental-sqlite), NOT the default `test`
// glob (which has no flag).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  handleOrderIngest,
  runExactlyOnce,
  applyOrderEvent,
  buildAcceptBatch,
} from "../../src/fulfillment/order_ingest.mjs";
import { normalizeOrderEvent, deriveFingerprint } from "../../src/fulfillment/order_event.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");

// --- D1-like adapter over node:sqlite ---------------------------------------
//
// Mirrors the Cloudflare D1 surface the order-ingest code uses:
//   prepare(sql) -> { bind(...).first()/all()/run() }
//   batch([stmts]) -> Promise<Array<{ results, meta }>>, transactional + ordered.
// A statement carries (sql, params); the adapter binds positional ? params. RETURNING
// rows surface via .results so the worker's firstBatchRow()/batchReturnedRow() see them.

class PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...values) {
    // D1 bind() returns a NEW bound statement; emulate by cloning so re-binding a
    // shared prepared statement does not leak params across calls.
    const next = new PreparedStatement(this.db, this.sql);
    next.params = values.map(normalizeParam);
    return next;
  }
  async first() {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.params);
    return { results: rows };
  }
  async run() {
    const stmt = this.db.prepare(this.sql);
    // A RETURNING in a run() still executes; use all() so it does not throw.
    stmt.all(...this.params);
    return { success: true };
  }
}

// node:sqlite only binds null/number/bigint/string/Uint8Array. Coerce booleans and
// undefined the way D1 does (undefined is not allowed by D1 either; our SQL never
// binds undefined, but guard defensively).
function normalizeParam(value) {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}

class D1Like {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new PreparedStatement(this.db, sql);
  }
  async batch(statements) {
    // Transactional + ordered, like D1: a throw rolls back the whole batch. Each
    // result is { results: [...] } so RETURNING rows are visible to the worker.
    const out = [];
    this.db.exec("BEGIN");
    try {
      for (const stmt of statements) {
        const prepared = this.db.prepare(stmt.sql);
        const rows = prepared.all(...stmt.params);
        out.push({ results: rows, success: true });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return out;
  }
}

function freshEnv(overrides = {}) {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return { db, env: { DB: new D1Like(db), ...overrides } };
}

// --- order helpers -----------------------------------------------------------

const PROJECT = "DEFAULT";
const FEATURE = "DEFAULT";
const KEY_ID = "k1";
const NOW = 1_700_000_000;

function makeOrder(overrides = {}) {
  const raw = {
    event_id: overrides.event_id ?? `evt_${overrides.seq ?? 1}`,
    subscription_id: overrides.subscription_id ?? "sub_A",
    project: PROJECT,
    feature: FEATURE,
    intent: overrides.intent ?? "subscription.active",
    seq: overrides.seq ?? 1,
    order_epoch: overrides.order_epoch ?? 0,
    current_period_end: overrides.current_period_end ?? NOW + 30 * 86400,
    customer: { id: "cus_order" },
    ...overrides,
  };
  const order = normalizeOrderEvent(raw, NOW);
  assert.equal(order.error, undefined, `order should normalize: ${JSON.stringify(order)}`);
  return order;
}

function digestOf(order) {
  // Mirror the worker's stable digest over the NORMALIZED order (sorted keys).
  return createHash("sha256").update(stableStringify(order)).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

async function fpOf(order) {
  const { fingerprint } = await deriveFingerprint({
    subscription_id: order.subscription_id,
    project: order.project,
    feature: order.feature,
    supplied: order.license_fingerprint,
  });
  return fingerprint;
}

// Submit an order through the post-auth pipeline (Steps 1-5) and return the parsed
// JSON body + status. rawPayload is the canonical normalized order (the worker signs
// raw bytes; the digest is over the normalized order, so we pass JSON of the order).
async function submit(env, order, { now = NOW } = {}) {
  const digest = digestOf(order);
  const rawPayload = JSON.stringify(order);
  const response = await runExactlyOnce(env, order, KEY_ID, digest, rawPayload, now);
  const body = await response.json();
  return { status: response.status, body };
}

// The full signed HTTP path (HMAC, normalization, nonce, then the same SQL pipeline), for
// cases whose body must be refused before it ever becomes a normalized order.
const HMAC_KEY_ID = "order-key";
const HMAC_AUDIENCE = "order-test";
const HMAC_SECRET = new Uint8Array(32).fill(7);

function base64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

async function ingest(env, body, extraEnv = {}) {
  const bodyText = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", HMAC_SECRET, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = new TextEncoder().encode(`POST\n/v1/orders\n${HMAC_AUDIENCE}\n${timestamp}\n${bodyText}`);
  const signature = base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, signed)));
  const request = new Request("https://backend.test/v1/orders", {
    method: "POST",
    headers: { "X-LCC-Key-Id": HMAC_KEY_ID, "X-LCC-Timestamp": timestamp, "X-LCC-Signature": signature },
    body: bodyText,
  });
  const response = await handleOrderIngest(request, {
    ...env,
    ORDER_HMAC_SECRETS: JSON.stringify({ [HMAC_KEY_ID]: base64(HMAC_SECRET) }),
    ORDER_INGEST_AUDIENCE: HMAC_AUDIENCE,
    // A default in-scope signer, so tests that do not care about signer-scope authz keep
    // exercising the rest of the pipeline; SCOPED_TO_A (below) overrides it for the
    // ownership tests, which do care.
    ORDER_SIGNER_SCOPES: JSON.stringify({ [HMAC_KEY_ID]: { project: PROJECT } }),
    ...extraEnv,
  });
  return { status: response.status, body: await response.json() };
}

function wireOrder(overrides = {}) {
  return {
    event_id: "evt_wire",
    subscription_id: "sub_A",
    project: PROJECT,
    feature: FEATURE,
    intent: "subscription.active",
    seq: 1,
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    ...overrides,
  };
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

function entRow(db, fingerprint) {
  return db
    .prepare("SELECT * FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ?")
    .get(PROJECT, FEATURE, fingerprint);
}

function orderRow(db, subscriptionId) {
  return db.prepare("SELECT * FROM orders WHERE subscription_id = ? AND project = ? AND feature = ?").get(subscriptionId, PROJECT, FEATURE);
}

function eventRow(db, eventId) {
  return db.prepare("SELECT * FROM order_events WHERE event_id = ?").get(eventId);
}

// =============================================================================
// CASE 1 — fresh apply
// =============================================================================
for (const state of ["active", "retiring"]) {
  test(`protected ${state} capacity failure remains recoverable without processed-order or authority corruption`, async t => {
    const { db, env } = freshEnv(); t.after(() => db.close());
    const rejected = makeOrder({ seq: 1, intent: "quantity.changed", quantity: { max_active_devices: 0 } });
    const fingerprint = await fpOf(rejected);
    db.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('cus_order','Owner',1,1);
      INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,enforcement_mode,max_active_devices,created_at,updated_at)
        VALUES('${PROJECT}','${FEATURE}','${fingerprint}','active','cus_order','device_bound_v1',1,1,1);
      INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,created_at,last_proof_at)
        VALUES('device','cus_order','${PROJECT}','key','synthetic-public',1,1);
      INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,state,generation,revision,hold_until,created_at,updated_at)
        VALUES('binding','${PROJECT}','${FEATURE}','${fingerprint}','device','${state}',2,3,4102444800,1,1);`);
    const authority = () => ["entitlements", "device_bound_bindings", "entitlement_events"]
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = authority();
    for (let retry = 0; retry < 2; retry += 1) {
      const response = await submit(env, rejected, { now: NOW + retry });
      assert.equal(response.status, 503);
      assert.equal(response.body.code, "write_failed");
      assert.equal(eventRow(db, rejected.event_id).status, "accepted");
      assert.deepEqual(authority(), before);
    }
    const permitted = makeOrder({ seq: 2, intent: "quantity.changed", quantity: { max_active_devices: 2 } });
    const applied = await submit(env, permitted, { now: NOW + 2 });
    assert.equal(applied.status, 200); assert.equal(applied.body.code, "applied");
    const row = entRow(db, fingerprint);
    assert.equal(row.enforcement_mode, "device_bound_v1");
    assert.equal(row.customer_id, "cus_order");
    assert.equal(row.max_active_devices, 2);
    assert.equal(row.authority_revision, 1);
    assert.equal(row.last_applied_order_seq, 2);
    assert.deepEqual(authority()[1], before[1]);
    assert.equal(authority()[2].length, 1);
    const committed = authority();
    const replay = await submit(env, permitted, { now: NOW + 3 });
    assert.equal(replay.status, 200); assert.deepEqual(authority(), committed);
    const superseded = await submit(env, rejected, { now: NOW + 4 });
    assert.equal(superseded.status, 200); assert.deepEqual(authority(), committed);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });
}

test("case 1: fresh subscription.active apply (active, clamp, fingerprint, floor seq)", async () => {
  const { db, env } = freshEnv();
  const order = makeOrder({ seq: 5, current_period_end: NOW + 30 * 86400 });
  const fp = await fpOf(order);

  const { status, body } = await submit(env, order);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.code, "applied");
  assert.equal(body.license_fingerprint, fp);

  const row = entRow(db, fp);
  assert.equal(row.status, "active");
  assert.equal(row.valid_until, NOW + 30 * 86400, "valid_until clamps to current_period_end");
  assert.equal(row.last_applied_order_seq, 5, "floor advanced to this event's seq");
  assert.equal(row.last_applied_order_epoch, 0);
  assert.equal(eventRow(db, order.event_id).status, "processed");
  db.close();
});

// =============================================================================
// Protected grants: every order names its customer, and an active order creates or
// refreshes a device_bound_v1 grant owned by that customer.
// =============================================================================
test("an order creates a protected grant owned by its customer", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  const order = makeOrder({ seq: 1, customer: { id: "cus_order" }, quantity: { max_active_devices: 3 } });
  const fp = await fpOf(order);
  const { status, body } = await submit(env, order);
  assert.equal(status, 200);
  assert.equal(body.code, "applied");
  const row = entRow(db, fp);
  assert.equal(row.enforcement_mode, "device_bound_v1");
  assert.equal(row.customer_id, "cus_order");
  assert.equal(row.pool_size, 0);
  assert.equal(row.device_hash, "");
  assert.equal(row.max_active_devices, 3);
  assert.equal(row.status, "active");

  const refresh = makeOrder({ seq: 2, event_id: "evt_refresh", customer: { id: "cus_order" } });
  assert.equal((await submit(env, refresh)).body.code, "applied");
  const refreshed = entRow(db, fp);
  assert.equal(refreshed.enforcement_mode, "device_bound_v1");
  assert.equal(refreshed.customer_id, "cus_order");
  assert.equal(refreshed.pool_size, 0);
  assert.equal(refreshed.max_active_devices, 3, "a refresh without quantity keeps the device limit");
});

test("an order without a customer is refused", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  for (const [label, body] of [
    ["no customer", wireOrder({ event_id: "evt_no_customer" })],
    ["a customer without an id", wireOrder({ event_id: "evt_no_customer_id", customer: { email: "buyer@example.test" } })],
    ["a revocation without a customer", wireOrder({ event_id: "evt_revoke_no_customer", intent: "fraud.confirmed" })],
  ]) {
    const refused = await ingest(env, body);
    assert.equal(refused.status, 400, label);
    assert.equal(refused.body.code, "invalid_order", label);
  }
  assert.equal(countRows(db, "entitlements"), 0);
  assert.equal(countRows(db, "orders"), 0);
  assert.equal(countRows(db, "order_events"), 0);

  // The same signed path applies once the order names its customer.
  const applied = await ingest(env, wireOrder({ event_id: "evt_with_customer", customer: { id: "cus_order" } }));
  assert.equal(applied.status, 200);
  assert.equal(applied.body.code, "applied");
  assert.equal(countRows(db, "entitlements"), 1);
});

test("quantity.pool_size is refused", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  const customer = { id: "cus_order" };
  for (const [label, body] of [
    ["an active order", wireOrder({ event_id: "evt_pool_active", customer, quantity: { pool_size: 5 } })],
    ["a quantity change", wireOrder({ event_id: "evt_pool_change", customer, intent: "quantity.changed", quantity: { pool_size: 5 } })],
    ["a pool beside a device limit", wireOrder({ event_id: "evt_pool_mixed", customer, quantity: { pool_size: 5, max_active_devices: 2 } })],
  ]) {
    const refused = await ingest(env, body);
    assert.equal(refused.status, 400, label);
    assert.equal(refused.body.code, "invalid_order", label);
  }
  assert.equal(countRows(db, "entitlements"), 0);
  assert.equal(countRows(db, "order_events"), 0);
});

// =============================================================================
// CASE 2 — processed replay (identical body, no 2nd revocation_seq bump)
// =============================================================================
test("case 2: processed replay of an identical body does NOT bump revocation_seq again", async () => {
  const { db, env } = freshEnv();
  const order = makeOrder({ seq: 1 });
  const fp = await fpOf(order);

  await submit(env, order);
  const seqAfterFirst = entRow(db, fp).revocation_seq;

  const replay = await submit(env, order); // identical event_id + body
  assert.equal(replay.status, 200);
  assert.equal(entRow(db, fp).revocation_seq, seqAfterFirst, "no second revocation bump on replay");
  // Exactly one accepted+processed event row; replay served from cache.
  assert.equal(eventRow(db, order.event_id).status, "processed");
  db.close();
});

// =============================================================================
// CASE 3 — stale seq -> 200 stale_ignored, entitlement + cursor unchanged
// =============================================================================
test("case 3: a stale (lower) seq is stale_ignored; entitlement + cursor unchanged", async () => {
  const { db, env } = freshEnv();
  const fp = await fpOf(makeOrder({ seq: 5 }));

  await submit(env, makeOrder({ seq: 5, event_id: "evt_5", current_period_end: NOW + 40 * 86400 }));
  const entBefore = entRow(db, fp);
  const cursorBefore = orderRow(db, "sub_A");

  const stale = await submit(env, makeOrder({ seq: 3, event_id: "evt_3", current_period_end: NOW + 10 * 86400 }));
  assert.equal(stale.status, 200);
  assert.equal(stale.body.code, "stale_ignored");

  const entAfter = entRow(db, fp);
  assert.equal(entAfter.valid_until, entBefore.valid_until, "entitlement window unchanged by stale order");
  assert.equal(entAfter.revocation_seq, entBefore.revocation_seq, "no revocation bump on stale");
  assert.equal(orderRow(db, "sub_A").last_seq, cursorBefore.last_seq, "cursor unchanged");
  db.close();
});

// =============================================================================
// CASE 4 — same (epoch,seq), different payload -> 409 seq_conflict
// =============================================================================
test("case 4: same (epoch,seq) with a different payload -> 409 seq_conflict", async () => {
  const { db, env } = freshEnv();
  await submit(env, makeOrder({ seq: 5, event_id: "evt_5a", current_period_end: NOW + 30 * 86400 }));

  // A DIFFERENT event_id (so Step-1 dedup misses) but the SAME (epoch,seq) with a
  // different payload -> the cursor is already at seq 5, the digest differs -> conflict.
  const conflict = await submit(env, makeOrder({ seq: 5, event_id: "evt_5b", current_period_end: NOW + 99 * 86400 }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "seq_conflict");
  assert.equal(eventRow(db, "evt_5b"), undefined, "a losing cursor update cannot leave an accepted event claim");

  const retry = await submit(env, makeOrder({ seq: 5, event_id: "evt_5b", current_period_end: NOW + 99 * 86400 }));
  assert.equal(retry.status, 409);
  assert.equal(retry.body.code, "seq_conflict", "same-floor conflict disposition is deterministic on retry");
  assert.equal(eventRow(db, "evt_5b"), undefined);
  db.close();
});

test("case 4b: concurrent stale payloads sharing event_id elect one durable result", async () => {
  const { db, env } = freshEnv();
  assert.equal((await submit(env, makeOrder({ seq: 5, event_id: "evt_floor" }))).body.code, "applied");
  const candidates = [
    makeOrder({ seq: 4, event_id: "evt_stale_race", current_period_end: NOW + 40 * 86400 }),
    makeOrder({ seq: 4, event_id: "evt_stale_race", current_period_end: NOW + 50 * 86400 }),
  ];
  const outcomes = await Promise.all(candidates.map((candidate) => submit(env, candidate)));
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort((a, b) => a - b), [200, 409]);
  assert.deepEqual(outcomes.map((outcome) => outcome.body.code).sort(), ["event_id_conflict", "stale_ignored"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM order_events WHERE event_id = 'evt_stale_race'").get().c, 1);
  db.close();
});

test("case 4c: concurrent stale event_ids sharing one floor elect one durable result", async () => {
  const { db, env } = freshEnv();
  assert.equal((await submit(env, makeOrder({ seq: 5, event_id: "evt_floor" }))).body.code, "applied");
  const candidates = [
    makeOrder({ seq: 4, event_id: "evt_stale_A", current_period_end: NOW + 40 * 86400 }),
    makeOrder({ seq: 4, event_id: "evt_stale_B", current_period_end: NOW + 50 * 86400 }),
  ];
  const outcomes = await Promise.all(candidates.map((candidate) => submit(env, candidate)));
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort((a, b) => a - b), [200, 409]);
  assert.deepEqual(outcomes.map((outcome) => outcome.body.code).sort(), ["seq_conflict", "stale_ignored"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM order_events WHERE order_epoch = 0 AND seq = 4").get().c, 1);
  db.close();
});

test("case 2c: a stored invalid_order replay preserves HTTP 400", async () => {
  const { db, env } = freshEnv();
  const order = makeOrder({ seq: 1, event_id: "evt_rejected_cache" });
  db.prepare(
    "INSERT INTO order_events (event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, payload_digest, raw_payload, status, result_json, received_at, processed_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rejected', ?, ?, ?)",
  ).run(
    order.event_id, order.subscription_id, order.project, order.feature, order.order_epoch, order.seq,
    order.intent, KEY_ID, digestOf(order), JSON.stringify(order),
    JSON.stringify({ ok: false, code: "invalid_order" }), NOW, NOW,
  );
  const replay = await submit(env, order);
  assert.equal(replay.status, 400);
  assert.equal(replay.body.code, "invalid_order");
  db.close();
});

test("case 2b: concurrent same-event admission never misreports stale_ignored", async () => {
  const { db, env } = freshEnv();
  const order = makeOrder({ seq: 1, event_id: "evt_concurrent" });
  const fp = await fpOf(order);
  const outcomes = await Promise.all([submit(env, order), submit(env, order)]);

  assert.equal(outcomes.every((outcome) => outcome.status === 200), true);
  assert.equal(outcomes.every((outcome) => ["applied", "cached"].includes(outcome.body.code)), true);
  assert.equal(outcomes.some((outcome) => outcome.body.code === "applied"), true);
  assert.equal(outcomes.some((outcome) => outcome.body.code === "stale_ignored"), false);
  assert.equal(entRow(db, fp).revocation_seq, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM order_events WHERE event_id = ?").get(order.event_id).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE request_id = ?").get(order.event_id).c, 1);
  db.close();
});

// =============================================================================
// CASE 5 — same event_id, different payload -> 409 event_id_conflict
// =============================================================================
test("case 5: same event_id with a different payload -> 409 event_id_conflict", async () => {
  const { db, env } = freshEnv();
  const order = makeOrder({ seq: 1, event_id: "evt_dup" });
  await submit(env, order);

  // Reuse the event_id but mutate the payload (different period end -> different digest).
  const tampered = makeOrder({ seq: 1, event_id: "evt_dup", current_period_end: NOW + 99 * 86400 });
  const { status, body } = await submit(env, tampered);
  assert.equal(status, 409);
  assert.equal(body.code, "event_id_conflict");
  db.close();
});

// =============================================================================
// CASE 6 — crash redrive (REGRESSION): accepted row, redrive -> applied; newer seq
// applies; redrive the old -> superseded, newer state intact.
// =============================================================================
test("case 6: crash redrive applies, a newer seq lands, redrive of old is superseded", async () => {
  const { db, env } = freshEnv();
  const order5 = makeOrder({ seq: 5, event_id: "evt_5", current_period_end: NOW + 30 * 86400 });
  const lateRedriveNow = NOW + 40 * 86400;
  const fp = await fpOf(order5);

  // Simulate a CRASH after accept: cursor advanced to seq 5 + an 'accepted' order_events
  // row, but the entitlement mutation never ran (no entitlement row yet).
  const digest5 = digestOf(order5);
  db.prepare("INSERT INTO orders (subscription_id, project, feature, license_fingerprint, last_seq, order_epoch, fingerprint_origin, created_at, updated_at) VALUES (?, ?, ?, ?, 5, 0, 'derived', ?, ?)").run(
    "sub_A", PROJECT, FEATURE, fp, NOW, NOW,
  );
  db.prepare(
    "INSERT INTO order_events (event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, payload_digest, raw_payload, status, result_json, received_at) VALUES (?, ?, ?, ?, 0, 5, ?, ?, ?, ?, 'accepted', '', ?)",
  ).run(order5.event_id, "sub_A", PROJECT, FEATURE, order5.intent, KEY_ID, digest5, JSON.stringify(order5), NOW);
  assert.equal(entRow(db, fp), undefined, "no entitlement before redrive (crashed mid-apply)");

  // Redrive: the same event_id arrives again -> Step-1 sees 'accepted' + matching digest -> redrive -> applies.
  const redriven = await submit(env, order5, { now: lateRedriveNow });
  assert.equal(redriven.status, 200);
  assert.equal(redriven.body.code, "applied");
  assert.equal(entRow(db, fp).status, "active");
  assert.equal(entRow(db, fp).last_applied_order_seq, 5);

  // A newer seq 6 applies on top (renew extends the window).
  const order6 = makeOrder({ seq: 6, event_id: "evt_6", intent: "subscription.renewed", current_period_end: NOW + 60 * 86400 });
  const applied6 = await submit(env, order6, { now: lateRedriveNow });
  assert.equal(applied6.body.code, "applied");
  assert.equal(entRow(db, fp).valid_until, NOW + 60 * 86400, "seq6 extended the window");
  assert.equal(entRow(db, fp).last_applied_order_seq, 6);

  // Redrive the OLD seq-5 event again: it is processed now -> cached replay -> the
  // newer (seq 6) state must remain intact (NOT regressed to seq 5's window).
  const redriveOld = await submit(env, order5, { now: lateRedriveNow });
  assert.equal(redriveOld.status, 200);
  assert.equal(entRow(db, fp).valid_until, NOW + 60 * 86400, "seq6 window survives the seq5 redrive");
  assert.equal(entRow(db, fp).last_applied_order_seq, 6, "floor still at seq6");
  db.close();
});

// =============================================================================
// CASE 7 — double-bump guard: redrive of a processed event does not re-enter the mutator
// =============================================================================
test("case 7: redrive of a PROCESSED event does not re-enter the mutator (no double bump)", async () => {
  const { db, env } = freshEnv();
  const order = makeOrder({ seq: 1, intent: "fraud.confirmed" });
  // Need an existing active entitlement first (fraud revokes it).
  const active = makeOrder({ seq: 1, event_id: "evt_active" });
  const fp = await fpOf(active);
  await submit(env, active);
  const fraud = makeOrder({ seq: 2, event_id: "evt_fraud", intent: "fraud.confirmed" });
  await submit(env, fraud);
  assert.equal(entRow(db, fp).status, "revoked");
  const seqAfterRevoke = entRow(db, fp).revocation_seq;

  // Redrive the processed fraud event many times: status stays revoked, revocation_seq frozen.
  for (let i = 0; i < 3; i += 1) {
    const r = await submit(env, fraud);
    assert.equal(r.status, 200);
  }
  assert.equal(entRow(db, fp).status, "revoked");
  assert.equal(entRow(db, fp).revocation_seq, seqAfterRevoke, "no double bump from processed redrives");
  db.close();
});

test("case 7b: two accepted redrives preserve the winning cache and emit one audit", async () => {
  const { db, env } = freshEnv();
  const order = makeOrder({ seq: 1, event_id: "evt_race" });
  const fp = await fpOf(order);
  db.prepare(
    "INSERT INTO orders (subscription_id, project, feature, license_fingerprint, last_seq, order_epoch, fingerprint_origin, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 'derived', ?, ?)",
  ).run("sub_A", PROJECT, FEATURE, fp, NOW, NOW);
  await env.DB.batch(buildAcceptBatch(env, order, KEY_ID, digestOf(order), JSON.stringify(order), NOW, fp, "derived"));
  assert.equal(eventRow(db, order.event_id).status, "accepted");

  const outcomes = await Promise.all([
    applyOrderEvent(env, order, fp, "derived", NOW, null),
    applyOrderEvent(env, order, fp, "derived", NOW, null),
  ]);

  assert.equal(outcomes.every((outcome) => outcome.status === 200), true);
  assert.equal(outcomes.every((outcome) => ["applied", "cached"].includes(outcome.body.code)), true);
  assert.equal(outcomes.some((outcome) => outcome.body.code === "applied"), true);
  assert.equal(entRow(db, fp).revocation_seq, 1, "the entitlement mutation lands once");
  assert.equal(eventRow(db, order.event_id).status, "processed");
  assert.equal(JSON.parse(eventRow(db, order.event_id).result_json).code, "applied", "the loser never rewrites the winning cache");
  const audits = db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE request_id = ?").get(order.event_id).c;
  assert.equal(audits, 1, "the serialized loser emits no duplicate entitlement audit");
  db.close();
});

// =============================================================================
// CASE 8 — concurrent N/N+1: both accepted; force the older apply to land AFTER the
// newer -> floor no-ops it; the newer valid_until survives.
// =============================================================================
test("case 8: an older apply landing after a newer one is floor-no-op'd (newer survives)", async () => {
  const { db, env } = freshEnv();
  // N and N+1 are BOTH subscription.active with disjoint windows (so either, applied
  // alone, would set the window). Accept both (both advance the durable cursor),
  // then deliberately apply them OUT OF ORDER: the newer (seq 6) lands first, then the
  // older (seq 5) lands LATE. The apply-time floor must no-op the late seq-5 apply.
  const orderN = makeOrder({ seq: 5, event_id: "evt_5", intent: "subscription.active", current_period_end: NOW + 30 * 86400 });
  const orderN1 = makeOrder({ seq: 6, event_id: "evt_6", intent: "subscription.active", current_period_end: NOW + 60 * 86400 });
  const fp = await fpOf(orderN);

  // Seed the orders row (origin/identity) so the guarded cursor-advance has a row to
  // move — exactly what runExactlyOnce's Step-2 upsertIdentity does before the ACCEPT.
  db.prepare(
    "INSERT INTO orders (subscription_id, project, feature, license_fingerprint, last_seq, order_epoch, fingerprint_origin, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 'derived', ?, ?)",
  ).run("sub_A", PROJECT, FEATURE, fp, NOW, NOW);

  // Accept N then N+1 directly through the guarded ACCEPT batch (both produce 'accepted'
  // rows + a durable cursor at seq 6); apply is deferred (the crash/redrive window).
  await env.DB.batch(buildAcceptBatch(env, orderN, KEY_ID, digestOf(orderN), JSON.stringify(orderN), NOW, fp, "derived"));
  await env.DB.batch(buildAcceptBatch(env, orderN1, KEY_ID, digestOf(orderN1), JSON.stringify(orderN1), NOW, fp, "derived"));
  assert.equal(orderRow(db, "sub_A").last_seq, 6, "cursor advanced to the newer seq");
  assert.equal(eventRow(db, "evt_5").status, "accepted", "seq5 accepted");
  assert.equal(eventRow(db, "evt_6").status, "accepted", "seq6 accepted");

  // Apply the NEWER (seq 6) first -> creates the entitlement + sets the floor to seq 6.
  const applied6 = await applyOrderEvent(env, orderN1, fp, "derived", NOW, null);
  assert.equal(applied6.body.code, "applied");
  assert.equal(entRow(db, fp).last_applied_order_seq, 6);
  const windowAt6 = entRow(db, fp).valid_until;
  assert.equal(windowAt6, NOW + 60 * 86400);

  // Now the OLDER seq-5 apply lands LATE: the apply-time floor must no-op it.
  const applied5Late = await applyOrderEvent(env, orderN, fp, "derived", NOW, null);
  assert.equal(applied5Late.body.code, "superseded", "older apply landing late is superseded by the floor");
  assert.equal(entRow(db, fp).valid_until, windowAt6, "newer (seq6) valid_until survives the late seq5 apply");
  assert.equal(entRow(db, fp).last_applied_order_seq, 6, "floor stays at 6");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE request_id = ?").get(orderN.event_id).c,
    0,
    "a superseded mutation emits no false state-change audit",
  );
  db.close();
});

test("case 8b: a late superseded fraud event cannot emit a false revoke audit", async () => {
  const { db, env } = freshEnv();
  const seed = makeOrder({ seq: 1, event_id: "evt_seed" });
  const fp = await fpOf(seed);
  assert.equal((await submit(env, seed)).body.code, "applied");

  const fraud = makeOrder({ seq: 5, event_id: "evt_fraud_late", intent: "fraud.confirmed" });
  const renewed = makeOrder({
    seq: 6,
    event_id: "evt_renew_winner",
    intent: "subscription.renewed",
    current_period_end: NOW + 60 * 86400,
  });
  await env.DB.batch(buildAcceptBatch(env, fraud, KEY_ID, digestOf(fraud), JSON.stringify(fraud), NOW, fp, "derived"));
  await env.DB.batch(buildAcceptBatch(env, renewed, KEY_ID, digestOf(renewed), JSON.stringify(renewed), NOW, fp, "derived"));

  assert.equal((await applyOrderEvent(env, renewed, fp, "derived", NOW)).body.code, "applied");
  assert.equal((await applyOrderEvent(env, fraud, fp, "derived", NOW)).body.code, "superseded");
  assert.equal(entRow(db, fp).status, "active");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE request_id = ? AND event_type = 'revoke'").get(fraud.event_id).c,
    0,
  );
  db.close();
});

// =============================================================================
// CASE 9 — orthogonal axis: seq5 quantity.changed + seq6 renewed both survive
// =============================================================================
test("case 9: a device-limit change and a later renew on disjoint axes both survive", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  const create = makeOrder({ seq: 1, event_id: "evt_1", quantity: { max_active_devices: 10 }, current_period_end: NOW + 30 * 86400 });
  const fp = await fpOf(create);
  assert.equal((await submit(env, create)).body.code, "applied");
  assert.equal(entRow(db, fp).max_active_devices, 10);

  const qty = makeOrder({ seq: 5, event_id: "evt_5", intent: "quantity.changed", quantity: { max_active_devices: 25 } });
  assert.equal((await submit(env, qty)).body.code, "applied");
  assert.equal(entRow(db, fp).max_active_devices, 25, "device-limit change applied");
  const windowAfterQuantity = entRow(db, fp).valid_until;
  assert.equal(windowAfterQuantity, NOW + 30 * 86400, "a device-limit change leaves the window alone");

  const renew = makeOrder({ seq: 6, event_id: "evt_6", intent: "subscription.renewed", current_period_end: NOW + 90 * 86400 });
  assert.equal((await submit(env, renew)).body.code, "applied");
  assert.equal(entRow(db, fp).valid_until, NOW + 90 * 86400, "renew window applied");
  assert.equal(entRow(db, fp).max_active_devices, 25, "the seq5 device limit survives the seq6 renew (disjoint axes)");
  assert.equal(entRow(db, fp).last_applied_order_seq, 6);
});

// =============================================================================
// CASE 10 — seq reset: low seq with no epoch bump is stale_ignored; with an order_epoch
// bump it applies.
// =============================================================================
test("case 10: a seq reset needs an order_epoch bump to apply (else stale_ignored)", async () => {
  const { db, env } = freshEnv();
  const fp = await fpOf(makeOrder({ seq: 100 }));
  await submit(env, makeOrder({ seq: 100, event_id: "evt_100", current_period_end: NOW + 30 * 86400 }));
  assert.equal(entRow(db, fp).last_applied_order_seq, 100);

  // A reset to seq 1 with the SAME epoch -> below the cursor -> stale_ignored.
  const resetNoEpoch = await submit(env, makeOrder({ seq: 1, event_id: "evt_reset_1", intent: "subscription.renewed", current_period_end: NOW + 40 * 86400 }));
  assert.equal(resetNoEpoch.body.code, "stale_ignored");
  assert.equal(entRow(db, fp).last_applied_order_seq, 100, "reset without epoch did not apply");

  // The SAME low seq WITH an order_epoch bump -> lexicographically newer -> applies.
  const resetWithEpoch = await submit(env, makeOrder({ seq: 1, order_epoch: 1, event_id: "evt_reset_2", intent: "subscription.renewed", current_period_end: NOW + 50 * 86400 }));
  assert.equal(resetWithEpoch.body.code, "applied");
  assert.equal(entRow(db, fp).last_applied_order_epoch, 1);
  assert.equal(entRow(db, fp).last_applied_order_seq, 1);
  assert.equal(entRow(db, fp).valid_until, NOW + 50 * 86400);
  db.close();
});

// =============================================================================
// CASE 11 — fingerprint ownership: subB supplying subA's fingerprint -> 409 fingerprint_owned; A untouched.
// =============================================================================
test("case 11: subB supplying subA's fingerprint -> 409 fingerprint_owned, A untouched", async () => {
  const { db, env } = freshEnv();
  const subA = makeOrder({ seq: 1, subscription_id: "sub_A", event_id: "evt_A" });
  const fpA = await fpOf(subA);
  await submit(env, subA);
  const aBefore = entRow(db, fpA);

  // sub_B SUPPLIES sub_A's (derived) fingerprint -> the ownership invariant rejects it.
  const subB = makeOrder({ seq: 1, subscription_id: "sub_B", event_id: "evt_B", license_fingerprint: fpA });
  const { status, body } = await submit(env, subB);
  assert.equal(status, 409);
  assert.equal(body.code, "fingerprint_owned");

  // sub_A's entitlement + order row are completely untouched.
  const aAfter = entRow(db, fpA);
  assert.equal(aAfter.valid_until, aBefore.valid_until);
  assert.equal(aAfter.revocation_seq, aBefore.revocation_seq);
  assert.equal(orderRow(db, "sub_A").subscription_id, "sub_A");
  db.close();
});

// =============================================================================
// CASE 12 — valid_until clamp: a backdated period_end on renew does NOT expire active.
// =============================================================================
test("case 12: a backdated period_end on renew does not regress/expire an active window", async () => {
  const { db, env } = freshEnv();
  const create = makeOrder({ seq: 1, event_id: "evt_1", current_period_end: NOW + 60 * 86400 });
  const fp = await fpOf(create);
  await submit(env, create);
  assert.equal(entRow(db, fp).valid_until, NOW + 60 * 86400);

  // A renew whose period_end is EARLIER but still within grace (not invalid_order).
  const backdated = makeOrder({ seq: 2, event_id: "evt_2", intent: "subscription.renewed", current_period_end: NOW + 5 * 86400 });
  const { body } = await submit(env, backdated);
  assert.equal(body.code, "applied");
  assert.equal(entRow(db, fp).valid_until, NOW + 60 * 86400, "monotone clamp kept the later window");
  assert.equal(entRow(db, fp).status, "active", "still active, not expired");
  db.close();
});

test("case 8c: a losing apply re-reads and caches the winning entitlement snapshot", async () => {
  const { db, env } = freshEnv();
  const older = makeOrder({ seq: 5, event_id: "evt_lagging", current_period_end: NOW + 30 * 86400 });
  const newer = makeOrder({ seq: 6, event_id: "evt_winner", current_period_end: NOW + 60 * 86400 });
  const fp = await fpOf(older);
  db.prepare(
    "INSERT INTO orders (subscription_id, project, feature, license_fingerprint, last_seq, order_epoch, fingerprint_origin, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 'derived', ?, ?)",
  ).run("sub_A", PROJECT, FEATURE, fp, NOW, NOW);
  await env.DB.batch(buildAcceptBatch(env, older, KEY_ID, digestOf(older), JSON.stringify(older), NOW, fp, "derived"));
  await env.DB.batch(buildAcceptBatch(env, newer, KEY_ID, digestOf(newer), JSON.stringify(newer), NOW, fp, "derived"));

  let signalOlderBatch;
  let releaseOlderBatch;
  const olderBatchEntered = new Promise((resolve) => { signalOlderBatch = resolve; });
  const olderBatchRelease = new Promise((resolve) => { releaseOlderBatch = resolve; });
  const realDb = env.DB;
  const laggingEnv = {
    ...env,
    DB: {
      prepare(sql) { return realDb.prepare(sql); },
      async batch(statements) {
        signalOlderBatch();
        await olderBatchRelease;
        return realDb.batch(statements);
      },
    },
  };

  const olderPromise = applyOrderEvent(laggingEnv, older, fp, "derived", NOW);
  await olderBatchEntered;
  const winningOutcome = await applyOrderEvent(env, newer, fp, "derived", NOW);
  assert.equal(winningOutcome.body.code, "applied");
  releaseOlderBatch();
  const losingOutcome = await olderPromise;
  assert.equal(losingOutcome.body.code, "superseded");
  assert.notEqual(losingOutcome.body.entitlement, null, "the pre-batch read was null but the winner now exists");
  assert.equal(losingOutcome.body.entitlement.valid_until, NOW + 60 * 86400);
  const cached = JSON.parse(eventRow(db, older.event_id).result_json);
  assert.equal(cached.entitlement.valid_until, NOW + 60 * 86400);
  db.close();
});

test("case 11b: one subscription cannot switch its immutable fingerprint or origin", async () => {
  const { db, env } = freshEnv();
  const fingerprintA = "a".repeat(64);
  const fingerprintB = "b".repeat(64);
  const first = makeOrder({ seq: 1, event_id: "evt_A", license_fingerprint: fingerprintA });
  assert.equal((await submit(env, first)).body.code, "applied");

  const switched = makeOrder({ seq: 2, event_id: "evt_B", license_fingerprint: fingerprintB });
  const rejected = await submit(env, switched);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, "fingerprint_owned");
  assert.equal(orderRow(db, "sub_A").license_fingerprint, fingerprintA);
  assert.notEqual(entRow(db, fingerprintA), undefined);
  assert.equal(entRow(db, fingerprintB), undefined);
  assert.equal(eventRow(db, switched.event_id), undefined);
  db.close();
});

test("case 11c: concurrent first fingerprints elect one immutable identity", async () => {
  const { db, env } = freshEnv();
  const candidates = [
    makeOrder({ seq: 1, event_id: "evt_A", license_fingerprint: "a".repeat(64) }),
    makeOrder({ seq: 1, event_id: "evt_B", license_fingerprint: "b".repeat(64) }),
  ];
  const outcomes = await Promise.all(candidates.map((candidate) => submit(env, candidate)));
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort((a, b) => a - b), [200, 409]);
  assert.deepEqual(outcomes.map((outcome) => outcome.body.code).sort(), ["applied", "fingerprint_owned"]);
  const identity = orderRow(db, "sub_A");
  assert.equal(["a".repeat(64), "b".repeat(64)].includes(identity.license_fingerprint), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM orders").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM order_events").get().c, 1);
  db.close();
});

test("case 11d: a global license id cannot cross projects", async () => {
  const { db, env } = freshEnv();
  const first = makeOrder({ seq: 1, event_id: "evt_A", license_id: "lic_shared" });
  assert.equal((await submit(env, first)).body.code, "applied");

  const crossProject = makeOrder({
    seq: 1,
    event_id: "evt_B",
    subscription_id: "sub_B",
    project: "OTHER",
    feature: "OTHER",
    license_id: "lic_shared",
  });
  const rejected = await submit(env, crossProject);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, "invalid_order");
  assert.equal(db.prepare("SELECT project FROM licenses WHERE id = 'lic_shared'").get().project, PROJECT);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM orders WHERE subscription_id = 'sub_B'").get().c, 0);
  assert.equal(eventRow(db, crossProject.event_id), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE project = 'OTHER'").get().c, 0);
  db.close();
});

test("case 11e: concurrent cross-project use elects one license identity", async () => {
  const { db, env } = freshEnv();
  const candidates = [
    makeOrder({ seq: 1, event_id: "evt_A", license_id: "lic_race" }),
    makeOrder({
      seq: 1,
      event_id: "evt_B",
      subscription_id: "sub_B",
      project: "OTHER",
      feature: "OTHER",
      license_id: "lic_race",
    }),
  ];
  const outcomes = await Promise.all(candidates.map((candidate) => submit(env, candidate)));
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort((a, b) => a - b), [200, 400]);
  assert.deepEqual(outcomes.map((outcome) => outcome.body.code).sort(), ["applied", "invalid_order"]);
  const license = db.prepare("SELECT project FROM licenses WHERE id = 'lic_race'").get();
  assert.equal([PROJECT, "OTHER"].includes(license.project), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM licenses WHERE id = 'lic_race'").get().c, 1);
  const identities = db.prepare("SELECT COUNT(*) AS c FROM orders").get().c;
  assert.equal(identities >= 1 && identities <= 2, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 1);
  const events = db.prepare("SELECT COUNT(*) AS c FROM order_events").get().c;
  assert.equal(events >= 1 && events <= 2, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM order_events WHERE status = 'rejected'").get().c, events - 1);

  const rejectedIndex = outcomes.findIndex((outcome) => outcome.body.code === "invalid_order");
  const rejectedCandidate = candidates[rejectedIndex];
  const rejectedIdentity = db.prepare(
    "SELECT license_id, last_seq FROM orders WHERE subscription_id = ? AND project = ? AND feature = ?",
  ).get(rejectedCandidate.subscription_id, rejectedCandidate.project, rejectedCandidate.feature);
  if (rejectedIdentity !== undefined) {
    assert.equal(rejectedIdentity.license_id, null, "the losing global reservation never poisons subscription identity");
    assert.equal(rejectedIdentity.last_seq, -1, "the losing global reservation never advances the cursor");
  }
  const cachedRejection = await submit(env, candidates[rejectedIndex]);
  assert.equal(cachedRejection.status, 400, "a repeated global-identity conflict remains invalid_order");
  assert.equal(cachedRejection.body.code, "invalid_order");

  const corrected = makeOrder({
    seq: 1,
    event_id: "evt_corrected_loser",
    subscription_id: rejectedCandidate.subscription_id,
    project: rejectedCandidate.project,
    feature: rejectedCandidate.feature,
    license_id: "lic_corrected",
  });
  assert.equal((await submit(env, corrected)).body.code, "applied", "the loser can retry with a valid license identity");
  db.close();
});

test("case 11f: a subscription cannot silently transfer customer or license identity", async () => {
  const { db, env } = freshEnv();
  const first = makeOrder({
    seq: 1,
    event_id: "evt_identity_A",
    customer: { id: "cus_A" },
    license_id: "lic_A",
  });
  assert.equal((await submit(env, first)).body.code, "applied");

  const customerTransfer = makeOrder({
    seq: 2,
    event_id: "evt_identity_B",
    customer: { id: "cus_B" },
    license_id: "lic_A",
  });
  const rejectedCustomer = await submit(env, customerTransfer);
  assert.equal(rejectedCustomer.status, 400);
  assert.equal(rejectedCustomer.body.code, "invalid_order");

  const licenseTransfer = makeOrder({
    seq: 2,
    event_id: "evt_identity_C",
    customer: { id: "cus_A" },
    license_id: "lic_B",
  });
  const rejectedLicense = await submit(env, licenseTransfer);
  assert.equal(rejectedLicense.status, 400);
  assert.equal(rejectedLicense.body.code, "invalid_order");

  const identity = orderRow(db, "sub_A");
  assert.equal(identity.customer_id, "cus_A");
  assert.equal(identity.license_id, "lic_A");
  assert.equal(entRow(db, identity.license_fingerprint).customer_id, "cus_A");
  assert.equal(entRow(db, identity.license_fingerprint).license_id, "lic_A");
  assert.equal(eventRow(db, customerTransfer.event_id), undefined);
  assert.equal(eventRow(db, licenseTransfer.event_id), undefined);
  db.close();
});

test("case 11g: a failed invalid-order terminal write returns retryable write_failed", async () => {
  const { db, env } = freshEnv();
  const realDb = env.DB;
  let licensePrepareCount = 0;
  env.DB = {
    prepare(sql) {
      if (sql.startsWith("INSERT INTO licenses ")) {
        licensePrepareCount += 1;
        if (licensePrepareCount === 2) return { bind: () => ({ first: async () => null }) };
      }
      if (sql.startsWith("UPDATE order_events SET status = 'rejected'")) {
        return { bind: () => ({ first: async () => { throw new Error("terminal store unavailable"); } }) };
      }
      return realDb.prepare(sql);
    },
    batch(statements) {
      return realDb.batch(statements);
    },
  };

  const order = makeOrder({ seq: 1, event_id: "evt_terminal_failure", license_id: "lic_A" });
  const outcome = await submit(env, order);
  assert.equal(outcome.status, 503);
  assert.equal(outcome.body.code, "write_failed");
  assert.equal(eventRow(db, order.event_id).status, "accepted", "retry remains possible after terminal-store failure");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
  db.close();
});

test("case 11h: an order naming no customer id is refused and cannot open a null identity", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  for (const customer of [undefined, { email: "buyer@example.test" }]) {
    const refused = await ingest(env, wireOrder({ event_id: "evt_null_identity", customer, license_id: "lic_late" }));
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "invalid_order");
  }
  assert.equal(orderRow(db, "sub_A"), undefined, "a refused order leaves no subscription identity to fill later");
  assert.equal(countRows(db, "licenses"), 0);

  const establish = await ingest(env, wireOrder({ event_id: "evt_fill_identity", seq: 2, customer: { id: "cus_late" }, license_id: "lic_late" }));
  assert.equal(establish.body.code, "applied");
  assert.equal(orderRow(db, "sub_A").customer_id, "cus_late");
  assert.equal(orderRow(db, "sub_A").license_id, "lic_late");

  const transfer = await ingest(env, wireOrder({ event_id: "evt_change_identity", seq: 3, customer: { id: "cus_other" }, license_id: "lic_other" }));
  assert.equal(transfer.status, 400);
  assert.equal(transfer.body.code, "invalid_order");
  assert.equal(eventRow(db, "evt_change_identity"), undefined);
  assert.equal(orderRow(db, "sub_A").customer_id, "cus_late");
  assert.equal(orderRow(db, "sub_A").license_id, "lic_late");
});

test("case 11i: a refused customer-less order cannot consume the order floor", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  const refused = await ingest(env, wireOrder({ event_id: "evt_identity_floor", seq: 5 }));
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "invalid_order");
  assert.equal(orderRow(db, "sub_A"), undefined);

  // A lower seq that names its customer is the first admitted order, not a stale one.
  const named = await ingest(env, wireOrder({ event_id: "evt_named_identity", seq: 4, customer: { id: "cus_current" }, license_id: "lic_current" }));
  assert.equal(named.status, 200);
  assert.equal(named.body.code, "applied");
  assert.equal(orderRow(db, "sub_A").last_seq, 4);
  assert.equal(orderRow(db, "sub_A").customer_id, "cus_current");
  assert.equal(orderRow(db, "sub_A").license_id, "lic_current");
});

test("case 11k: a compatible existing same-project license reservation is admitted", async () => {
  const { db, env } = freshEnv();
  db.prepare(
    "INSERT INTO licenses (id, customer_id, project, label, metadata_json, created_at, updated_at) VALUES (?, ?, ?, '', '{}', ?, ?)",
  ).run("lic_existing", "cus_existing", PROJECT, NOW, NOW);
  const order = makeOrder({
    seq: 1,
    event_id: "evt_existing_license",
    customer: { id: "cus_existing" },
    license_id: "lic_existing",
  });
  const outcome = await submit(env, order);
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.code, "applied");
  assert.equal(orderRow(db, "sub_A").license_id, "lic_existing");
  assert.equal(eventRow(db, order.event_id).status, "processed");
  db.close();
});

test("case 11j: concurrent license claims belong only to an admitted event", async () => {
  const { db, env } = freshEnv();
  // The first order fixes the customer; the license is still unset.
  assert.equal((await submit(env, makeOrder({ seq: 1, event_id: "evt_identity_seed" }))).body.code, "applied");
  const candidates = [
    makeOrder({ seq: 2, event_id: "evt_identity_low", license_id: "lic_low" }),
    makeOrder({ seq: 3, event_id: "evt_identity_high", license_id: "lic_high" }),
  ];
  const outcomes = await Promise.all(candidates.map((candidate) => submit(env, candidate)));
  assert.equal(outcomes.filter((outcome) => outcome.body.code === "applied").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.body.code === "invalid_order").length, 1);
  const identity = orderRow(db, "sub_A");
  assert.equal(identity.customer_id, "cus_order");
  const ownerIndex = identity.license_id === "lic_low" ? 0 : 1;
  assert.equal(identity.license_id, ownerIndex === 0 ? "lic_low" : "lic_high");
  assert.equal(outcomes[ownerIndex].body.code, "applied");
  assert.notEqual(eventRow(db, candidates[ownerIndex].event_id), undefined);
  assert.equal(eventRow(db, candidates[1 - ownerIndex].event_id), undefined);
  db.close();
});

test("case 8b: a newer missing-entitlement intent waits for an earlier accepted create", async () => {
  const { db, env } = freshEnv();
  const active = makeOrder({ seq: 1, event_id: "evt_active" });
  const pastDue = makeOrder({ seq: 2, event_id: "evt_past_due", intent: "subscription.past_due" });
  const fp = await fpOf(active);
  db.prepare(
    "INSERT INTO orders (subscription_id, project, feature, license_fingerprint, last_seq, order_epoch, fingerprint_origin, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 'derived', ?, ?)",
  ).run("sub_A", PROJECT, FEATURE, fp, NOW, NOW);
  await env.DB.batch(buildAcceptBatch(env, active, KEY_ID, digestOf(active), JSON.stringify(active), NOW, fp, "derived"));
  await env.DB.batch(buildAcceptBatch(env, pastDue, KEY_ID, digestOf(pastDue), JSON.stringify(pastDue), NOW, fp, "derived"));

  const premature = await applyOrderEvent(env, pastDue, fp, "derived", NOW, null);
  assert.equal(premature.status, 503, "the newer intent remains retryable while its predecessor is pending");
  assert.equal(premature.body.code, "write_failed");
  assert.equal(eventRow(db, pastDue.event_id).status, "accepted");
  assert.equal(entRow(db, fp), undefined);

  const created = await applyOrderEvent(env, active, fp, "derived", NOW, null);
  assert.equal(created.body.code, "applied");
  assert.equal(entRow(db, fp).status, "active");

  const disabled = await applyOrderEvent(env, pastDue, fp, "derived", NOW, active);
  assert.equal(disabled.body.code, "applied");
  assert.equal(entRow(db, fp).status, "disabled");
  assert.equal(entRow(db, fp).last_applied_order_seq, 2);
  assert.equal(eventRow(db, pastDue.event_id).status, "processed");
  assert.notEqual(JSON.parse(eventRow(db, pastDue.event_id).result_json).code, "no_entitlement");
  db.close();
});

// =============================================================================
// CASE 14 — missing/revoked disposition.
// =============================================================================
test("case 14a: modifying a never-activated sub -> 200 no_entitlement, no row", async () => {
  const { db, env } = freshEnv();
  const order = makeOrder({ seq: 1, event_id: "evt_1", intent: "subscription.past_due" });
  const fp = await fpOf(order);
  const { status, body } = await submit(env, order);
  assert.equal(status, 200);
  assert.equal(body.code, "no_entitlement");
  assert.equal(entRow(db, fp), undefined, "no entitlement materialized for a modify on a missing sub");
  assert.equal(eventRow(db, order.event_id).status, "processed");
  db.close();
});

test("case 14b: an order against a revoked entitlement -> 409 entitlement_revoked", async () => {
  const { db, env } = freshEnv();
  const active = makeOrder({ seq: 1, event_id: "evt_active" });
  const fp = await fpOf(active);
  await submit(env, active);
  await submit(env, makeOrder({ seq: 2, event_id: "evt_fraud", intent: "fraud.confirmed" }));
  assert.equal(entRow(db, fp).status, "revoked");

  const afterRevoke = await submit(env, makeOrder({ seq: 3, event_id: "evt_renew", intent: "subscription.renewed", current_period_end: NOW + 90 * 86400 }));
  assert.equal(afterRevoke.status, 409);
  assert.equal(afterRevoke.body.ok, false);
  assert.equal(afterRevoke.body.code, "entitlement_revoked");
  assert.equal(eventRow(db, "evt_renew").status, "rejected");
  assert.equal(entRow(db, fp).status, "revoked", "revoked stays terminal");
  db.close();
});

const TERMINAL_REVOCATION_RACE_CASES = [
  {
    label: "active refresh",
    intent: "subscription.active",
    overrides: { current_period_end: NOW + 90 * 86400, quantity: { max_active_devices: 10 } },
  },
  {
    label: "renewal",
    intent: "subscription.renewed",
    overrides: { current_period_end: NOW + 90 * 86400 },
  },
  {
    label: "period-end cancellation",
    intent: "subscription.canceled_at_period_end",
    overrides: { current_period_end: NOW + 90 * 86400 },
  },
  { label: "resume", intent: "subscription.resumed", overrides: {} },
  { label: "past-due disable", intent: "subscription.past_due", overrides: {} },
  { label: "pause disable", intent: "subscription.paused", overrides: {} },
  { label: "payment-failed disable", intent: "subscription.payment_failed", overrides: {} },
  {
    label: "quantity downgrade",
    intent: "quantity.changed",
    overrides: { quantity: { max_active_devices: 1 } },
  },
];

for (const scenario of TERMINAL_REVOCATION_RACE_CASES) {
  test(`case 14c (${scenario.label}): a concurrent revoke wins before non-terminal apply`, async () => {
    const { db, env } = freshEnv();
    const active = makeOrder({
      seq: 1,
      event_id: `evt_seed_${scenario.intent}`,
      quantity: { max_active_devices: 4 },
    });
    const fp = await fpOf(active);
    assert.equal((await submit(env, active)).body.code, "applied");

    const fraud = makeOrder({ seq: 2, event_id: `evt_fraud_${scenario.intent}`, intent: "fraud.confirmed" });
    const candidate = makeOrder({
      seq: 3,
      event_id: `evt_candidate_${scenario.intent}`,
      intent: scenario.intent,
      ...scenario.overrides,
    });
    await env.DB.batch(buildAcceptBatch(env, fraud, KEY_ID, digestOf(fraud), JSON.stringify(fraud), NOW, fp, "derived"));
    await env.DB.batch(buildAcceptBatch(env, candidate, KEY_ID, digestOf(candidate), JSON.stringify(candidate), NOW, fp, "derived"));
    assert.equal(eventRow(db, fraud.event_id).status, "accepted");
    assert.equal(eventRow(db, candidate.event_id).status, "accepted");

    let signalCandidateBatch;
    let releaseCandidateBatch;
    const candidateBatchEntered = new Promise((resolve) => { signalCandidateBatch = resolve; });
    const candidateBatchRelease = new Promise((resolve) => { releaseCandidateBatch = resolve; });
    const realDb = env.DB;
    const laggingEnv = {
      ...env,
      DB: {
        prepare(sql) { return realDb.prepare(sql); },
        async batch(statements) {
          signalCandidateBatch();
          await candidateBatchRelease;
          return realDb.batch(statements);
        },
      },
    };

    const candidatePromise = applyOrderEvent(laggingEnv, candidate, fp, "derived", NOW);
    await candidateBatchEntered;
    const fraudOutcome = await applyOrderEvent(env, fraud, fp, "derived", NOW);
    assert.equal(fraudOutcome.body.code, "applied");
    const afterFraud = entRow(db, fp);
    assert.equal(afterFraud.status, "revoked");
    releaseCandidateBatch();

    const candidateOutcome = await candidatePromise;
    assert.equal(candidateOutcome.status, 409);
    assert.equal(candidateOutcome.body.ok, false);
    assert.equal(candidateOutcome.body.code, "entitlement_revoked");

    const finalEntitlement = entRow(db, fp);
    for (const field of ["status", "revocation_seq", "last_applied_order_epoch", "last_applied_order_seq", "valid_until", "max_active_devices"]) {
      assert.equal(finalEntitlement[field], afterFraud[field], `${field} remains at the revocation winner`);
    }
    const candidateEvent = eventRow(db, candidate.event_id);
    assert.equal(candidateEvent.status, "rejected");
    assert.equal(JSON.parse(candidateEvent.result_json).code, "entitlement_revoked");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE request_id = ?").get(candidate.event_id).c,
      0,
      "the rejected candidate emits no normal entitlement audit",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE request_id = ?").get(fraud.event_id).c,
      1,
      "the winning revoke emits exactly one audit",
    );

    const cachedRetry = await submit(env, candidate);
    assert.equal(cachedRetry.status, 409);
    assert.equal(cachedRetry.body.code, "entitlement_revoked");
    assert.equal(entRow(db, fp).revocation_seq, afterFraud.revocation_seq, "cached retry never re-enters mutation");
    db.close();
  });
}

// =============================================================================
// CASE 15 — renew carry-forward: an omitted license is not nulled on a renew.
// =============================================================================
test("case 15: a renew names its customer and carries an omitted license forward (not nulled)", async () => {
  const { db, env } = freshEnv();
  const create = makeOrder({
    seq: 1,
    event_id: "evt_1",
    customer: { id: "cus_1", email: "A@Example.com", name: "Acme" },
    license_id: "lic_1",
    current_period_end: NOW + 30 * 86400,
  });
  const fp = await fpOf(create);
  await submit(env, create);
  assert.equal(entRow(db, fp).customer_id, "cus_1");
  assert.equal(entRow(db, fp).license_id, "lic_1");

  // Renew with the customer but NO license -> the license is carried forward, not nulled.
  const renew = makeOrder({ seq: 2, event_id: "evt_2", intent: "subscription.renewed", customer: { id: "cus_1" }, current_period_end: NOW + 90 * 86400 });
  assert.equal((await submit(env, renew)).body.code, "applied");
  assert.equal(entRow(db, fp).customer_id, "cus_1");
  assert.equal(entRow(db, fp).license_id, "lic_1", "license_id carried forward");
  assert.equal(entRow(db, fp).enforcement_mode, "device_bound_v1");

  // The customer email was normalized (trim + lowercase) at upsert time.
  const cust = db.prepare("SELECT email FROM customers WHERE id = 'cus_1'").get();
  assert.equal(cust.email, "a@example.com");
  db.close();
});

// =============================================================================
// CASE 16 — intent coverage: past_due->disabled reversible; resumed->active;
// quantity->device-limit only; fraud->revoked terminal.
// =============================================================================
test("case 16: intent coverage (disable reversible, resume, quantity-only, fraud terminal)", async () => {
  const { db, env } = freshEnv();
  const create = makeOrder({ seq: 1, event_id: "evt_1", quantity: { max_active_devices: 3 }, current_period_end: NOW + 30 * 86400 });
  const fp = await fpOf(create);
  await submit(env, create);
  assert.equal(entRow(db, fp).status, "active");
  const windowAfterCreate = entRow(db, fp).valid_until;

  // past_due -> disabled (reversible)
  await submit(env, makeOrder({ seq: 2, event_id: "evt_2", intent: "subscription.past_due" }));
  assert.equal(entRow(db, fp).status, "disabled");

  // resumed -> active (re-enable)
  await submit(env, makeOrder({ seq: 3, event_id: "evt_3", intent: "subscription.resumed" }));
  assert.equal(entRow(db, fp).status, "active", "resume re-enabled a reversibly-disabled entitlement");

  // quantity.changed -> device limit only (status + window untouched)
  await submit(env, makeOrder({ seq: 4, event_id: "evt_4", intent: "quantity.changed", quantity: { max_active_devices: 9 } }));
  assert.equal(entRow(db, fp).max_active_devices, 9);
  assert.equal(entRow(db, fp).pool_size, 0);
  assert.equal(entRow(db, fp).status, "active");
  assert.equal(entRow(db, fp).valid_until, windowAfterCreate, "quantity change did not touch the window");

  // fraud.confirmed -> revoked (terminal)
  await submit(env, makeOrder({ seq: 5, event_id: "evt_5", intent: "fraud.confirmed" }));
  assert.equal(entRow(db, fp).status, "revoked");

  // resumed AFTER revoke -> terminal -> 409 entitlement_revoked (revoked is irreversible)
  const afterRevoke = await submit(env, makeOrder({ seq: 6, event_id: "evt_6", intent: "subscription.resumed" }));
  assert.equal(afterRevoke.status, 409);
  assert.equal(afterRevoke.body.code, "entitlement_revoked");
  assert.equal(entRow(db, fp).status, "revoked", "revoked stays terminal even after a resume");
  db.close();
});

// =============================================================================
// Withdrawals (disable, revoke and cancel-at-period-end) always apply for the grant's
// own customer. They still name the customer, but no customer status or elapsed period
// refuses them, and they never write the grant's owner or license.
// =============================================================================
const WITHDRAWALS = [
  ["subscription.past_due", "disabled"],
  ["subscription.paused", "disabled"],
  ["subscription.payment_failed", "disabled"],
  ["subscription.canceled_at_period_end", "active"],
  ["fraud.confirmed", "revoked"],
  ["chargeback", "revoked"],
];

for (const [intent, status] of WITHDRAWALS) {
  test(`${intent} applies when its customer is disabled and a device is bound, and keeps the owner`, async (t) => {
    const { db, env } = freshEnv(); t.after(() => db.close());
    const identity = { customer: { id: "cus_order" }, license_id: "lic_order" };
    const active = makeOrder({ seq: 1, event_id: "evt_active", ...identity });
    const fp = await fpOf(active);
    assert.equal((await submit(env, active)).body.code, "applied");
    // A device is bound to the grant and its customer is now disabled.
    db.exec(`INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,created_at,last_proof_at)
        VALUES('device','cus_order','${PROJECT}','key','synthetic-public',1,1);
      INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,state,generation,revision,hold_until,created_at,updated_at)
        VALUES('binding','${PROJECT}','${FEATURE}','${fp}','device','active',1,1,0,1,1);
      UPDATE customers SET status='disabled' WHERE id='cus_order';`);

    const withdrawal = makeOrder({ seq: 2, event_id: "evt_withdrawal", intent, ...identity });
    const outcome = await submit(env, withdrawal);
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.code, "applied");
    const row = entRow(db, fp);
    assert.equal(row.status, status);
    assert.equal(row.customer_id, "cus_order");
    assert.equal(row.license_id, "lic_order");
    assert.equal(row.last_applied_order_seq, 2);
    assert.equal(eventRow(db, withdrawal.event_id).status, "processed");
  });

  test(`${intent} applies even when its period ended long ago`, async (t) => {
    const { db, env } = freshEnv(); t.after(() => db.close());
    const customer = { id: "cus_order" };
    assert.equal((await ingest(env, wireOrder({ event_id: "evt_active", customer }))).body.code, "applied");
    // A chargeback or dunning notice routinely arrives weeks after the period it concerns.
    const periodEnd = Math.floor(Date.now() / 1000) - 60 * 86400;
    const late = await ingest(env, wireOrder({ event_id: "evt_late", seq: 2, intent, current_period_end: periodEnd, customer }));
    assert.equal(late.status, 200);
    assert.equal(late.body.code, "applied");
    assert.equal(db.prepare("SELECT status FROM entitlements").get().status, status);
  });
}

test("an order that grants access with a long-past period end is still refused", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  const customer = { id: "cus_order" };
  assert.equal((await ingest(env, wireOrder({ event_id: "evt_active", customer }))).body.code, "applied");
  const periodEnd = Math.floor(Date.now() / 1000) - 60 * 86400;
  for (const [seq, intent, extra] of [
    [2, "subscription.active", {}],
    [3, "subscription.renewed", {}],
    [4, "subscription.resumed", {}],
    [5, "quantity.changed", { quantity: { max_active_devices: 2 } }],
  ]) {
    const refused = await ingest(env, wireOrder({ event_id: `evt_${intent}`, seq, intent, current_period_end: periodEnd, customer, ...extra }));
    assert.equal(refused.status, 400, intent);
    assert.equal(refused.body.code, "invalid_order", intent);
  }
  assert.equal(countRows(db, "order_events"), 1);
});

test("a withdrawal for a subscription with no grant creates nothing", async () => {
  for (const [intent] of WITHDRAWALS) {
    const { db, env } = freshEnv();
    const order = makeOrder({ seq: 1, event_id: `evt_${intent}`, intent, customer: { id: "cus_order" } });
    const outcome = await submit(env, order);
    assert.equal(outcome.status, 200, intent);
    assert.equal(outcome.body.code, "no_entitlement", intent);
    assert.equal(countRows(db, "entitlements"), 0, intent);
    assert.equal(eventRow(db, order.event_id).status, "processed", intent);
    db.close();
  }
});

// =============================================================================
// Grant ownership: an order may act only on a grant its own customer already owns, or
// create a new one. A grant owned by another customer, or by no one, refuses every
// intent, withdrawals included, and the refused order writes nothing.
// =============================================================================
const FOREIGN_FP = "f".repeat(64);
const SCOPED_TO_A = {
  ORDER_SIGNER_SCOPES: JSON.stringify({ [HMAC_KEY_ID]: { customer_id: "cus_A" } }),
};
const OTHER_INTENTS = [
  ["subscription.renewed", {}],
  ["subscription.resumed", {}],
  ["quantity.changed", { quantity: { max_active_devices: 9 } }],
  ["subscription.past_due", {}],
  ["subscription.paused", {}],
  ["subscription.payment_failed", {}],
  ["subscription.canceled_at_period_end", {}],
  ["fraud.confirmed", {}],
  ["chargeback", {}],
];

// An operator-made grant at FOREIGN_FP, owned by `owner` (NULL for an unowned grant).
function seedGrant(db, owner) {
  db.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('cus_B','B',1,1);
    INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,enforcement_mode,max_active_devices,notes,created_at,updated_at)
      VALUES('${PROJECT}','${FEATURE}','${FOREIGN_FP}','active',${owner === null ? "NULL" : `'${owner}'`},'device_bound_v1',2,'operator grant',1,1);`);
}

function orderState(db) {
  return ["entitlements", "entitlement_events", "orders", "order_events", "customers", "licenses", "device_bound_bindings"]
    .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

function assertOwnerRefusal(outcome, label) {
  assert.equal(outcome.status, 409, label);
  assert.equal(outcome.body.code, "entitlement_owner_mismatch", label);
}

test("a signer scoped to customer A cannot activate customer B's grant through its fingerprint", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  seedGrant(db, "cus_B");
  const before = orderState(db);
  const takeover = wireOrder({ event_id: "evt_takeover", customer: { id: "cus_A" }, license_fingerprint: FOREIGN_FP });
  assertOwnerRefusal(await ingest(env, takeover, SCOPED_TO_A), "subscription.active");
  assert.deepEqual(orderState(db), before, "the refused order writes nothing");
  assert.equal(entRow(db, FOREIGN_FP).customer_id, "cus_B");
});

test("a signer scoped to customer A cannot revoke or change customer B's grant with any other intent", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  seedGrant(db, "cus_B");
  const before = orderState(db);
  for (const [seq, [intent, extra]] of OTHER_INTENTS.entries()) {
    const order = wireOrder({ event_id: `evt_${intent}`, seq: seq + 1, intent, customer: { id: "cus_A" }, license_fingerprint: FOREIGN_FP, ...extra });
    assertOwnerRefusal(await ingest(env, order, SCOPED_TO_A), intent);
    assert.deepEqual(orderState(db), before, `${intent} writes nothing`);
  }
  assert.equal(entRow(db, FOREIGN_FP).status, "active");
});

test("a grant with no owner refuses every order", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  seedGrant(db, null);
  const before = orderState(db);
  for (const [seq, [intent, extra]] of [["subscription.active", {}], ...OTHER_INTENTS].entries()) {
    const order = wireOrder({ event_id: `evt_${intent}`, seq: seq + 1, intent, customer: { id: "cus_A" }, license_fingerprint: FOREIGN_FP, ...extra });
    assertOwnerRefusal(await ingest(env, order), intent);
  }
  assert.deepEqual(orderState(db), before);
  assert.equal(entRow(db, FOREIGN_FP).customer_id, null);
});

test("after an admin reassigns a grant, orders naming the old customer are refused instead of moving it back", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  const active = makeOrder({ seq: 1, event_id: "evt_active" });
  const fp = await fpOf(active);
  assert.equal((await submit(env, active)).body.code, "applied");
  // An operator moves the grant to cus_moved, and a device is then bound to it.
  db.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('cus_moved','Moved',1,1);
    UPDATE entitlements SET customer_id='cus_moved' WHERE license_fingerprint='${fp}';
    INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,created_at,last_proof_at)
      VALUES('device','cus_moved','${PROJECT}','key','synthetic-public',1,1);
    INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,state,generation,revision,hold_until,created_at,updated_at)
      VALUES('binding','${PROJECT}','${FEATURE}','${fp}','device','active',1,1,0,1,1);`);
  const before = orderState(db);

  const renewal = makeOrder({ seq: 2, event_id: "evt_renewal", intent: "subscription.renewed", current_period_end: NOW + 90 * 86400 });
  assertOwnerRefusal(await submit(env, renewal), "renewal");
  assert.deepEqual(orderState(db), before, "a refused renewal writes nothing and is not a retryable 503");
  for (const [seq, intent] of [[3, "subscription.active"], [4, "fraud.confirmed"], [5, "subscription.canceled_at_period_end"]]) {
    assertOwnerRefusal(await submit(env, makeOrder({ seq, event_id: `evt_${intent}`, intent })), intent);
  }
  assert.deepEqual(orderState(db), before);
  assert.equal(entRow(db, fp).customer_id, "cus_moved");
  assert.equal(orderRow(db, "sub_A").last_seq, 1, "a refused order does not consume the floor");
});

test("an accepted order redriven after an admin reassignment is refused without touching the grant", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  const active = makeOrder({ seq: 1, event_id: "evt_active" });
  const fp = await fpOf(active);
  assert.equal((await submit(env, active)).body.code, "applied");
  const renewal = makeOrder({ seq: 2, event_id: "evt_renewal", intent: "subscription.renewed", current_period_end: NOW + 90 * 86400 });
  await env.DB.batch(buildAcceptBatch(env, renewal, KEY_ID, digestOf(renewal), JSON.stringify(renewal), NOW, fp, "derived"));
  db.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('cus_moved','Moved',1,1);
    UPDATE entitlements SET customer_id='cus_moved' WHERE license_fingerprint='${fp}';`);
  const grant = entRow(db, fp);

  const outcome = await submit(env, renewal);
  assertOwnerRefusal(outcome, "redriven renewal");
  assert.deepEqual(entRow(db, fp), grant);
  assert.equal(eventRow(db, renewal.event_id).status, "rejected");
  assert.equal(JSON.parse(eventRow(db, renewal.event_id).result_json).code, "entitlement_owner_mismatch");
  assertOwnerRefusal(await submit(env, renewal), "cached retry");
});

test("an owner change between the read and the write refuses the order atomically", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  const active = makeOrder({ seq: 1, event_id: "evt_active" });
  const fp = await fpOf(active);
  assert.equal((await submit(env, active)).body.code, "applied");
  for (const [seq, intent] of [[2, "subscription.renewed"], [3, "subscription.active"], [4, "quantity.changed"], [5, "fraud.confirmed"]]) {
    db.exec(`UPDATE entitlements SET customer_id='cus_order' WHERE license_fingerprint='${fp}'`);
    const order = makeOrder({ seq, event_id: `evt_race_${intent}`, intent, ...(intent === "quantity.changed" ? { quantity: { max_active_devices: 7 } } : {}) });
    await env.DB.batch(buildAcceptBatch(env, order, KEY_ID, digestOf(order), JSON.stringify(order), NOW, fp, "derived"));
    const realDb = env.DB;
    const racingEnv = {
      ...env,
      DB: {
        prepare(sql) { return realDb.prepare(sql); },
        async batch(statements) {
          // The operator reassigns the grant after the apply read it, before its batch runs.
          db.exec(`UPDATE entitlements SET customer_id='cus_moved' WHERE license_fingerprint='${fp}'`);
          return realDb.batch(statements);
        },
      },
    };
    const grant = { ...entRow(db, fp), customer_id: "cus_moved" };
    const outcome = await applyOrderEvent(racingEnv, order, fp, "derived", NOW);
    assertOwnerRefusal(outcome, intent);
    const after = entRow(db, fp);
    assert.equal(after.customer_id, "cus_moved", intent);
    for (const field of ["status", "revocation_seq", "valid_until", "max_active_devices", "last_applied_order_seq"]) {
      assert.equal(after[field], grant[field], `${intent} ${field}`);
    }
    assert.equal(eventRow(db, order.event_id).status, "rejected", intent);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE request_id = ?").get(order.event_id).c, 0, intent);
  }
});

test("a same-customer order on its own grant still works and never changes the owner", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  seedGrant(db, "cus_A");
  const identity = { customer: { id: "cus_A" }, license_fingerprint: FOREIGN_FP };
  for (const [seq, intent, status] of [
    [1, "subscription.active", "active"],
    [2, "subscription.renewed", "active"],
    [3, "subscription.past_due", "disabled"],
    [4, "subscription.resumed", "active"],
    [5, "fraud.confirmed", "revoked"],
  ]) {
    const outcome = await ingest(env, wireOrder({ event_id: `evt_${intent}`, seq, intent, ...identity }), SCOPED_TO_A);
    assert.equal(outcome.status, 200, intent);
    assert.equal(outcome.body.code, "applied", intent);
    const row = entRow(db, FOREIGN_FP);
    assert.equal(row.status, status, intent);
    assert.equal(row.customer_id, "cus_A", intent);
    assert.equal(row.enforcement_mode, "device_bound_v1", intent);
  }
});

// =============================================================================
// A grant no order has applied yet (an operator-made grant) sits below every order on
// the apply floor, so the first order at (epoch 0, seq 0) applies; and an audit row is
// written only when the order's entitlement write actually lands.
// =============================================================================
async function operatorGrantAndOrder(db, env, order) {
  const fp = await fpOf(order);
  db.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('cus_order','Owner',1,1);
    INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,enforcement_mode,max_active_devices,notes,created_at,updated_at)
      VALUES('${PROJECT}','${FEATURE}','${fp}','active','cus_order','device_bound_v1',2,'operator grant',1,1);`);
  return fp;
}

function auditRows(db, eventId) {
  return db.prepare("SELECT event_type, status FROM entitlement_events WHERE request_id = ?").all(eventId)
    .map(({ event_type, status }) => ({ event_type, status }));
}

for (const [intent, status] of WITHDRAWALS) {
  test(`a first ${intent} at seq 0 applies to the owner's operator-made grant with one audit row`, async (t) => {
    const { db, env } = freshEnv(); t.after(() => db.close());
    const order = makeOrder({ seq: 0, event_id: "evt_first", intent });
    const fp = await operatorGrantAndOrder(db, env, order);
    const outcome = await submit(env, order);
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.code, "applied");
    const row = entRow(db, fp);
    assert.equal(row.status, status);
    assert.equal(row.customer_id, "cus_order");
    assert.equal(row.last_applied_order_epoch, 0);
    assert.equal(row.last_applied_order_seq, 0);
    const audits = auditRows(db, order.event_id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].status, status);
  });
}

test("a first subscription.active at seq 0 refreshes the same customer's operator-made grant", async (t) => {
  const { db, env } = freshEnv(); t.after(() => db.close());
  const order = makeOrder({ seq: 0, event_id: "evt_first", quantity: { max_active_devices: 4 }, license_id: "lic_order" });
  const fp = await operatorGrantAndOrder(db, env, order);
  db.exec(`UPDATE entitlements SET status='disabled' WHERE license_fingerprint='${fp}'`);
  const outcome = await submit(env, order);
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.code, "applied");
  const row = entRow(db, fp);
  assert.equal(row.status, "active", "the order's state wins over the operator's");
  assert.equal(row.valid_until, NOW + 30 * 86400);
  assert.equal(row.max_active_devices, 4);
  assert.equal(row.license_id, "lic_order");
  assert.equal(row.customer_id, "cus_order", "the owner is unchanged");
  assert.equal(row.notes, "operator grant", "the operator's notes are kept");
  assert.equal(row.enforcement_mode, "device_bound_v1");
  assert.equal(row.last_applied_order_seq, 0);
  assert.deepEqual(auditRows(db, order.event_id), [{ event_type: "update", status: "active" }]);

  const renewal = makeOrder({ seq: 1, event_id: "evt_renewal", intent: "subscription.renewed", current_period_end: NOW + 60 * 86400 });
  assert.equal((await submit(env, renewal)).body.code, "applied");
  assert.equal(entRow(db, fp).valid_until, NOW + 60 * 86400);
});

test("an owner change racing a seq-0 order on an operator-made grant leaves no audit row", async (t) => {
  for (const intent of ["subscription.active", "subscription.renewed", "quantity.changed", "fraud.confirmed", "chargeback"]) {
    const { db, env } = freshEnv(); t.after(() => db.close());
    const order = makeOrder({ seq: 0, event_id: "evt_race", intent, ...(intent === "quantity.changed" ? { quantity: { max_active_devices: 7 } } : {}) });
    const fp = await operatorGrantAndOrder(db, env, order);
    db.prepare(
      "INSERT INTO orders (subscription_id, project, feature, license_fingerprint, customer_id, last_seq, order_epoch, fingerprint_origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'cus_order', -1, 0, 'derived', ?, ?)",
    ).run("sub_A", PROJECT, FEATURE, fp, NOW, NOW);
    await env.DB.batch(buildAcceptBatch(env, order, KEY_ID, digestOf(order), JSON.stringify(order), NOW, fp, "derived"));
    const realDb = env.DB;
    const racingEnv = {
      ...env,
      DB: {
        prepare(sql) { return realDb.prepare(sql); },
        async batch(statements) {
          db.exec(`INSERT OR IGNORE INTO customers(id,name,created_at,updated_at) VALUES('cus_moved','Moved',1,1);
            UPDATE entitlements SET customer_id='cus_moved' WHERE license_fingerprint='${fp}';`);
          return realDb.batch(statements);
        },
      },
    };
    const grant = { ...entRow(db, fp), customer_id: "cus_moved" };
    assertOwnerRefusal(await applyOrderEvent(racingEnv, order, fp, "derived", NOW), intent);
    assert.deepEqual(auditRows(db, order.event_id), [], `${intent} writes no audit or webhook row`);
    const after = entRow(db, fp);
    for (const field of ["customer_id", "status", "revocation_seq", "valid_until", "max_active_devices", "last_applied_order_seq"]) {
      assert.equal(after[field], grant[field], `${intent} ${field}`);
    }
    assert.equal(eventRow(db, order.event_id).status, "rejected", intent);
  }
});
