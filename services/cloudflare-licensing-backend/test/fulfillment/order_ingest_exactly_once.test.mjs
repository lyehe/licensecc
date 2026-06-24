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
  const redriven = await submit(env, order5);
  assert.equal(redriven.status, 200);
  assert.equal(redriven.body.code, "applied");
  assert.equal(entRow(db, fp).status, "active");
  assert.equal(entRow(db, fp).last_applied_order_seq, 5);

  // A newer seq 6 applies on top (renew extends the window).
  const order6 = makeOrder({ seq: 6, event_id: "evt_6", intent: "subscription.renewed", current_period_end: NOW + 60 * 86400 });
  const applied6 = await submit(env, order6);
  assert.equal(applied6.body.code, "applied");
  assert.equal(entRow(db, fp).valid_until, NOW + 60 * 86400, "seq6 extended the window");
  assert.equal(entRow(db, fp).last_applied_order_seq, 6);

  // Redrive the OLD seq-5 event again: it is processed now -> cached replay -> the
  // newer (seq 6) state must remain intact (NOT regressed to seq 5's window).
  const redriveOld = await submit(env, order5);
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
  await env.DB.batch(buildAcceptBatch(env, orderN, KEY_ID, digestOf(orderN), JSON.stringify(orderN), NOW));
  await env.DB.batch(buildAcceptBatch(env, orderN1, KEY_ID, digestOf(orderN1), JSON.stringify(orderN1), NOW));
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
