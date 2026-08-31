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

function liveSeats(db, fingerprint, now = NOW) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM seat_checkouts WHERE license_fingerprint = ? AND heartbeat_deadline > ?")
    .get(fingerprint, now).c;
}

function seedSeats(db, fingerprint, count, { now = NOW, deadline = NOW + 100000 } = {}) {
  for (let i = 0; i < count; i += 1) {
    db.prepare(
      "INSERT INTO seat_checkouts (project, feature, license_fingerprint, seat_id, client_instance_id, mode, checked_out_at, heartbeat_deadline) VALUES (?, ?, ?, ?, ?, 'live', ?, ?)",
    ).run(PROJECT, FEATURE, fingerprint, `seat_${i}`, `inst_${i}`, now, deadline + i);
  }
}

// =============================================================================
// CASE 1 — fresh apply
// =============================================================================
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
test("case 9: a quantity change and a later renew on disjoint axes both survive", async () => {
  const { db, env } = freshEnv();
  const create = makeOrder({ seq: 1, event_id: "evt_1", intent: "subscription.active", quantity: { pool_size: 10 }, current_period_end: NOW + 30 * 86400 });
  const fp = await fpOf(create);
  await submit(env, create);
  assert.equal(entRow(db, fp).pool_size, 10);

  const qty = makeOrder({ seq: 5, event_id: "evt_5", intent: "quantity.changed", quantity: { pool_size: 25 } });
  await submit(env, qty);
  assert.equal(entRow(db, fp).pool_size, 25, "quantity change applied");

  const renew = makeOrder({ seq: 6, event_id: "evt_6", intent: "subscription.renewed", current_period_end: NOW + 90 * 86400 });
  await submit(env, renew);
  assert.equal(entRow(db, fp).valid_until, NOW + 90 * 86400, "renew window applied");
  assert.equal(entRow(db, fp).pool_size, 25, "the seq5 pool_size survives the seq6 renew (disjoint axes)");
  db.close();
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

// =============================================================================
// CASE 13 — seat reclaim: downgrade 50->5 with 50 live seats -> 45 evicted + usage_events('reclaim')
// =============================================================================
test("case 13: a 50->5 downgrade with 50 live seats evicts 45 in-batch + logs reclaim", async () => {
  const { db, env } = freshEnv();
  const create = makeOrder({ seq: 1, event_id: "evt_1", quantity: { pool_size: 50 }, current_period_end: NOW + 30 * 86400 });
  const fp = await fpOf(create);
  await submit(env, create);
  assert.equal(entRow(db, fp).pool_size, 50);
  seedSeats(db, fp, 50);
  assert.equal(liveSeats(db, fp), 50);

  // Downgrade to 5. The prior applied event (seq 1) had pool_size 50 -> diff 45.
  const downgrade = makeOrder({ seq: 2, event_id: "evt_2", intent: "quantity.changed", quantity: { pool_size: 5 } });
  const { body } = await submit(env, downgrade);
  assert.equal(body.code, "applied");
  assert.equal(entRow(db, fp).pool_size, 5);
  assert.equal(liveSeats(db, fp), 5, "exactly 45 live seats evicted to fit the new pool");

  const reclaims = db.prepare("SELECT COUNT(*) AS c FROM usage_events WHERE license_fingerprint = ? AND event_type = 'reclaim'").get(fp).c;
  assert.equal(reclaims, 45, "45 reclaim usage_events recorded");
  db.close();
});

test("case 13b: a downgrade with FEWER live seats than the prior pool never over-evicts below the new pool", async () => {
  const { db, env } = freshEnv();
  const create = makeOrder({ seq: 1, event_id: "evt_1", quantity: { pool_size: 50 }, current_period_end: NOW + 30 * 86400 });
  const fp = await fpOf(create);
  await submit(env, create);
  // Only 8 live seats exist (well below the prior pool of 50).
  seedSeats(db, fp, 8);
  assert.equal(liveSeats(db, fp), 8);

  // Downgrade 50 -> 5. The prior-payload diff is 45, but only 8 are live -> we must
  // evict exactly 3 (8 - 5), leaving the new pool of 5 intact (NOT all 8).
  const downgrade = makeOrder({ seq: 2, event_id: "evt_2", intent: "quantity.changed", quantity: { pool_size: 5 } });
  await submit(env, downgrade);
  assert.equal(liveSeats(db, fp), 5, "evicted only down to the new pool, never below it");
  const reclaims = db.prepare("SELECT COUNT(*) AS c FROM usage_events WHERE license_fingerprint = ? AND event_type = 'reclaim'").get(fp).c;
  assert.equal(reclaims, 3, "exactly 3 reclaim events");
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

test("case 11h: a later explicit identity fills null once and then remains immutable", async () => {
  const { db, env } = freshEnv();
  const first = makeOrder({ seq: 1, event_id: "evt_null_identity" });
  assert.equal((await submit(env, first)).body.code, "applied");
  assert.equal(orderRow(db, "sub_A").customer_id, null);
  assert.equal(orderRow(db, "sub_A").license_id, null);

  const establish = makeOrder({
    seq: 2,
    event_id: "evt_fill_identity",
    customer: { id: "cus_late" },
    license_id: "lic_late",
  });
  assert.equal((await submit(env, establish)).body.code, "applied");
  assert.equal(orderRow(db, "sub_A").customer_id, "cus_late");
  assert.equal(orderRow(db, "sub_A").license_id, "lic_late");

  const transfer = makeOrder({
    seq: 3,
    event_id: "evt_change_identity",
    customer: { id: "cus_other" },
    license_id: "lic_other",
  });
  const rejected = await submit(env, transfer);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, "invalid_order");
  assert.equal(eventRow(db, transfer.event_id), undefined);
  assert.equal(orderRow(db, "sub_A").customer_id, "cus_late");
  assert.equal(orderRow(db, "sub_A").license_id, "lic_late");
  db.close();
});

test("case 11i: a stale event cannot claim a previously-null auxiliary identity", async () => {
  const { db, env } = freshEnv();
  const first = makeOrder({ seq: 5, event_id: "evt_identity_floor" });
  assert.equal((await submit(env, first)).body.code, "applied");

  const stale = makeOrder({
    seq: 4,
    event_id: "evt_stale_identity",
    customer: { id: "cus_stale" },
    license_id: "lic_stale",
  });
  const staleResult = await submit(env, stale);
  assert.equal(staleResult.status, 200);
  assert.equal(staleResult.body.code, "stale_ignored");
  assert.equal(orderRow(db, "sub_A").customer_id, null);
  assert.equal(orderRow(db, "sub_A").license_id, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM licenses WHERE id = 'lic_stale'").get().c, 0);

  const current = makeOrder({
    seq: 6,
    event_id: "evt_current_identity",
    customer: { id: "cus_current" },
    license_id: "lic_current",
  });
  assert.equal((await submit(env, current)).body.code, "applied");
  assert.equal(orderRow(db, "sub_A").customer_id, "cus_current");
  assert.equal(orderRow(db, "sub_A").license_id, "lic_current");
  db.close();
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

test("case 11j: concurrent identity claims belong only to an admitted event", async () => {
  const { db, env } = freshEnv();
  assert.equal((await submit(env, makeOrder({ seq: 1, event_id: "evt_identity_seed" }))).body.code, "applied");
  const candidates = [
    makeOrder({ seq: 2, event_id: "evt_identity_low", customer: { id: "cus_low" }, license_id: "lic_low" }),
    makeOrder({ seq: 3, event_id: "evt_identity_high", customer: { id: "cus_high" }, license_id: "lic_high" }),
  ];
  const outcomes = await Promise.all(candidates.map((candidate) => submit(env, candidate)));
  assert.equal(outcomes.filter((outcome) => outcome.body.code === "applied").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.body.code === "invalid_order").length, 1);
  const identity = orderRow(db, "sub_A");
  const ownerIndex = identity.customer_id === "cus_low" ? 0 : 1;
  assert.equal(identity.license_id, ownerIndex === 0 ? "lic_low" : "lic_high");
  assert.equal(outcomes[ownerIndex].body.code, "applied");
  assert.notEqual(eventRow(db, candidates[ownerIndex].event_id), undefined);
  assert.equal(eventRow(db, candidates[1 - ownerIndex].event_id), undefined);
  db.close();
});

test("case 13d: an intervening order without quantity cannot hide a later downgrade reclaim", async () => {
  const { db, env } = freshEnv();
  const create = makeOrder({ seq: 1, event_id: "evt_1", quantity: { pool_size: 50 } });
  const fp = await fpOf(create);
  await submit(env, create);
  seedSeats(db, fp, 50);

  const renew = makeOrder({ seq: 2, event_id: "evt_2", intent: "subscription.renewed" });
  const renewed = await submit(env, renew);
  assert.equal(renewed.body.code, "applied");
  assert.equal(entRow(db, fp).pool_size, 50);

  const downgrade = makeOrder({ seq: 3, event_id: "evt_3", intent: "quantity.changed", quantity: { pool_size: 5 } });
  const applied = await submit(env, downgrade);
  assert.equal(applied.body.code, "applied");
  assert.equal(entRow(db, fp).pool_size, 5);
  assert.equal(liveSeats(db, fp), 5);
  const reclaims = db.prepare("SELECT COUNT(*) AS c FROM usage_events WHERE license_fingerprint = ? AND event_type = 'reclaim'").get(fp).c;
  assert.equal(reclaims, 45, "the live pool, not an unrelated prior payload, drives reclaim");
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

test("case 13c: a stale accepted capacity event cannot reclaim seats below a newer floor", async () => {
  const { db, env } = freshEnv();
  const create = makeOrder({ seq: 1, event_id: "evt_1", quantity: { pool_size: 50 } });
  const fp = await fpOf(create);
  await submit(env, create);
  seedSeats(db, fp, 50);

  const downgrade5 = makeOrder({ seq: 5, event_id: "evt_5", intent: "quantity.changed", quantity: { pool_size: 5 } });
  const downgrade20 = makeOrder({ seq: 6, event_id: "evt_6", intent: "quantity.changed", quantity: { pool_size: 20 } });
  await env.DB.batch(buildAcceptBatch(env, downgrade5, KEY_ID, digestOf(downgrade5), JSON.stringify(downgrade5), NOW, fp, "derived"));
  await env.DB.batch(buildAcceptBatch(env, downgrade20, KEY_ID, digestOf(downgrade20), JSON.stringify(downgrade20), NOW, fp, "derived"));

  const newer = await applyOrderEvent(env, downgrade20, fp, "derived", NOW, create);
  assert.equal(newer.body.code, "applied");
  assert.equal(entRow(db, fp).pool_size, 20);
  assert.equal(liveSeats(db, fp), 20);

  const stale = await applyOrderEvent(env, downgrade5, fp, "derived", NOW, create);
  assert.equal(stale.body.code, "superseded");
  assert.equal(entRow(db, fp).pool_size, 20);
  assert.equal(entRow(db, fp).last_applied_order_seq, 6);
  assert.equal(liveSeats(db, fp), 20, "the stale event cannot reclaim to its lower target");
  const reclaims = db.prepare("SELECT COUNT(*) AS c FROM usage_events WHERE license_fingerprint = ? AND event_type = 'reclaim'").get(fp).c;
  assert.equal(reclaims, 30, "only the winning 50->20 downgrade emits reclaim analytics");
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
    overrides: { current_period_end: NOW + 90 * 86400, quantity: { pool_size: 10 } },
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
    overrides: { quantity: { pool_size: 1 } },
  },
];

for (const scenario of TERMINAL_REVOCATION_RACE_CASES) {
  test(`case 14c (${scenario.label}): a concurrent revoke wins before non-terminal apply`, async () => {
    const { db, env } = freshEnv();
    const active = makeOrder({
      seq: 1,
      event_id: `evt_seed_${scenario.intent}`,
      quantity: { pool_size: 4 },
    });
    const fp = await fpOf(active);
    assert.equal((await submit(env, active)).body.code, "applied");
    seedSeats(db, fp, 4);

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
    for (const field of ["status", "revocation_seq", "last_applied_order_epoch", "last_applied_order_seq", "valid_until", "pool_size"]) {
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
    assert.equal(liveSeats(db, fp), 4, "terminal arbitration cannot reclaim seats");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM usage_events WHERE license_fingerprint = ? AND event_type = 'reclaim'").get(fp).c,
      0,
      "terminal arbitration emits no reclaim analytics",
    );

    const cachedRetry = await submit(env, candidate);
    assert.equal(cachedRetry.status, 409);
    assert.equal(cachedRetry.body.code, "entitlement_revoked");
    assert.equal(entRow(db, fp).revocation_seq, afterFraud.revocation_seq, "cached retry never re-enters mutation");
    db.close();
  });
}

// =============================================================================
// CASE 15 — renew carry-forward: customer/license not nulled on a renew omitting them.
// =============================================================================
test("case 15: a renew omitting customer/license carries the prior values forward (not nulled)", async () => {
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

  // Renew with NO customer/license fields -> they must be carried forward, not nulled.
  const renew = makeOrder({ seq: 2, event_id: "evt_2", intent: "subscription.renewed", current_period_end: NOW + 90 * 86400 });
  await submit(env, renew);
  assert.equal(entRow(db, fp).customer_id, "cus_1", "customer_id carried forward");
  assert.equal(entRow(db, fp).license_id, "lic_1", "license_id carried forward");

  // The customer email was normalized (trim + lowercase) at upsert time.
  const cust = db.prepare("SELECT email FROM customers WHERE id = 'cus_1'").get();
  assert.equal(cust.email, "a@example.com");
  db.close();
});

// =============================================================================
// CASE 16 — intent coverage: past_due->disabled reversible; resumed->active;
// quantity->capacity-only; fraud->revoked terminal.
// =============================================================================
test("case 16: intent coverage (disable reversible, resume, quantity-only, fraud terminal)", async () => {
  const { db, env } = freshEnv();
  const create = makeOrder({ seq: 1, event_id: "evt_1", quantity: { pool_size: 3 }, current_period_end: NOW + 30 * 86400 });
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

  // quantity.changed -> capacity only (status + window untouched)
  await submit(env, makeOrder({ seq: 4, event_id: "evt_4", intent: "quantity.changed", quantity: { pool_size: 9 } }));
  assert.equal(entRow(db, fp).pool_size, 9);
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
