// Hermetic tests for the PG order-apply port (order-apply-pg.mjs). Two layers, both run with zero
// external deps under `node --test` on any platform (no live Postgres, no pg-mem):
//   LAYER 1  pure SQL-shape/translate assertions over the statement builders;
//   LAYER 2  a mock-pg-client transaction test that drives runApplyTransaction with a fake pool.begin
//            and scripted RETURNING rows, validating the exactly-once branch logic with no DB.
// The real-engine counterpart is order-apply-smoke-real-pg.mjs (gated on DATABASE_URL).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ENTITLEMENT_COLUMNS,
  withId,
} from "../src/entitlements/entitlement_mutation.mjs";
import {
  pgAcceptBatch,
  pgCreateStatement,
  pgPatchStatement,
  pgTransitionStatement,
  pgCapacityStatement,
  pgOrderEventStatement,
  pgReclaimStatement,
  pgProcessedMark,
  pgTerminalMark,
  orderApplyStatementsFor,
  runApplyTransaction,
} from "./order-apply-pg.mjs";

const KEY = { project: "DEFAULT", feature: "DEFAULT", license_fingerprint: "a".repeat(64) };
const FLOOR = { epoch: 2, seq: 5 };
const NOW = 1_000_000;
const FIELDS = {
  device_hash: "",
  status: "active",
  assertion_ttl_seconds: 300,
  valid_from: null,
  valid_until: 2000,
  notes: "",
  customer_id: "cus_a",
  license_id: null,
  pool_size: 3,
  max_active_devices: 1,
  created_at: 100,
};
const ORDER = {
  intent: "subscription.active",
  subscription_id: "sub_a",
  event_id: "evt_1",
  project: "DEFAULT",
  feature: "DEFAULT",
  order_epoch: 2,
  seq: 5,
};

function maxPlaceholder(text) {
  const matches = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  return matches.length === 0 ? 0 : Math.max(...matches);
}

// Every parameterized statement: only $n placeholders (no SQLite `?`), and params are dense ($1..$n).
function assertParameterized(stmt, label) {
  assert.equal(/\?/.test(stmt.text), false, `${label}: must use $n, not ?`);
  assert.equal(stmt.params.length, maxPlaceholder(stmt.text), `${label}: params length === max placeholder`);
}

// No SQLite-ism leaked into any statement.
function assertNoSqliteIsms(stmt, label) {
  for (const forbidden of [" excluded.", "unixepoch(", "json_object(", " rowid", "max(0,"]) {
    assert.equal(stmt.text.includes(forbidden), false, `${label}: must not contain SQLite-ism "${forbidden.trim()}"`);
  }
}

test("LAYER1 mutation statements are parameterized, SQLite-ism-free, and RETURN the entitlement columns", () => {
  const create = pgCreateStatement(KEY, FIELDS, FLOOR, NOW);
  const patch = pgPatchStatement(KEY, { ...FIELDS }, FLOOR, NOW);
  const transition = pgTransitionStatement(KEY, "revoked", FLOOR, NOW);
  const capacity = pgCapacityStatement(KEY, { pool_size: 1 }, FLOOR, NOW);
  for (const [stmt, label] of [[create, "create"], [patch, "patch"], [transition, "transition"], [capacity, "capacity"]]) {
    assertParameterized(stmt, label);
    assertNoSqliteIsms(stmt, label);
    assert.ok(stmt.text.includes("GREATEST("), `${label}: scalar max -> GREATEST`);
    // RETURNING tail is the canonical entitlement column set (single source of truth, lockstep with D1).
    assert.ok(stmt.text.endsWith(`RETURNING ${ENTITLEMENT_COLUMNS}`), `${label}: RETURNING === ENTITLEMENT_COLUMNS`);
  }
});

test("LAYER1 floor guards: create uses the EXCLUDED conflict floor (no bound floor params); update form binds epoch,epoch,seq last", () => {
  const create = pgCreateStatement(KEY, FIELDS, FLOOR, NOW);
  assert.ok(create.text.includes("entitlements.last_applied_order_epoch < EXCLUDED.last_applied_order_epoch"));
  assert.ok(create.text.includes("entitlements.last_applied_order_seq < EXCLUDED.last_applied_order_seq"));
  // The conflict floor reads EXCLUDED — it binds NO floor params (the only floor binds are the INSERT
  // VALUES last_applied_order_{epoch,seq}, positions 16-17, not the WHERE).
  for (const [stmt, label] of [
    [pgPatchStatement(KEY, { ...FIELDS }, FLOOR, NOW), "patch"],
    [pgTransitionStatement(KEY, "disabled", FLOOR, NOW), "transition"],
    [pgCapacityStatement(KEY, { pool_size: 1 }, FLOOR, NOW), "capacity"],
  ]) {
    assert.ok(stmt.text.includes("> entitlements.last_applied_order_epoch"), `${label}: update floor predicate present`);
    assert.deepEqual(stmt.params.slice(-3), [FLOOR.epoch, FLOOR.epoch, FLOOR.seq], `${label}: WHERE floor binds epoch,epoch,seq`);
  }
});

test("LAYER1b new-SQLite-ism translations: audit json_build_object::text; reclaim ctid + GREATEST(0,..)", () => {
  const audit = pgOrderEventStatement(KEY, "create", ORDER, NOW);
  assertParameterized(audit, "audit");
  assert.ok(audit.text.includes("json_build_object('project', project,"), "json_object -> json_build_object");
  assert.ok(audit.text.includes(")::text,"), "json_build_object cast to ::text (TEXT column contract)");
  assert.equal(audit.text.includes("json_object("), false);
  assert.ok(audit.text.includes("'sync'"), "source literal 'sync' kept");

  const reclaim = pgReclaimStatement(KEY, NOW, 1);
  assertParameterized(reclaim, "reclaim");
  assert.ok(reclaim.text.includes("WHERE ctid IN (SELECT ctid FROM seat_checkouts"), "rowid -> ctid");
  assert.ok(reclaim.text.includes("LIMIT GREATEST(0, (SELECT COUNT(*)"), "max(0,..) -> GREATEST(0,..)");
  assert.equal(reclaim.text.includes("rowid"), false);
  assert.equal(reclaim.role, "reclaim");
  // bind order: project,feature,fp,now, project,feature,fp,now, newPool
  assert.deepEqual(reclaim.params, [KEY.project, KEY.feature, KEY.license_fingerprint, NOW, KEY.project, KEY.feature, KEY.license_fingerprint, NOW, 1]);
});

test("LAYER1c ACCEPT batch: guarded cursor advance + EXISTS-guarded event claim", () => {
  const [cursor, claim] = pgAcceptBatch(ORDER, "k1", "digest1", "{}", NOW);
  assertParameterized(cursor, "cursor");
  assert.ok(cursor.text.startsWith("UPDATE orders SET order_epoch ="));
  assert.ok(cursor.text.endsWith("RETURNING last_seq, order_epoch"));
  assert.deepEqual(cursor.params, [ORDER.order_epoch, ORDER.seq, NOW, ORDER.subscription_id, ORDER.project, ORDER.feature, ORDER.order_epoch, ORDER.order_epoch, ORDER.seq]);

  assertParameterized(claim, "claim");
  assert.ok(claim.text.includes("INSERT INTO order_events"));
  assert.ok(claim.text.includes("'accepted', '',"), "status literal 'accepted', empty result_json");
  assert.ok(claim.text.includes(", NULL WHERE EXISTS (SELECT 1 FROM orders"), "NULL processed_at + EXISTS guard");
  assert.ok(claim.text.endsWith("RETURNING event_id"));
});

test("LAYER1 capacity with no valid columns still advances the floor and bumps revocation_seq", () => {
  const empty = pgCapacityStatement(KEY, {}, FLOOR, NOW);
  assertParameterized(empty, "empty-capacity");
  assert.ok(empty.text.includes("revocation_seq = GREATEST("), "still bumps revocation_seq");
  assert.ok(empty.text.includes("last_applied_order_epoch = $"), "still advances the floor");
});

test("LAYER1 pgTerminalMark only accepts processed|rejected and guards on status='accepted'", () => {
  const ok = pgTerminalMark("evt_1", "rejected", "{}", NOW);
  assertParameterized(ok, "terminal-mark");
  assert.ok(ok.text.includes("SET status = 'rejected'"));
  assert.ok(ok.text.includes("AND status = 'accepted'"), "guards on the accepted state (redrive no-op)");
  assert.equal(ok.params[2], "evt_1", "event_id is the third bind (resultJson, now, eventId)");
  assert.throws(() => pgTerminalMark("evt_1", "deleted", "{}", NOW), /invalid terminal status/);
});

test("LAYER1 orderApplyStatementsFor assembles [write, audit, (reclaim), mark] in D1 batch order", () => {
  const noReclaim = orderApplyStatementsFor("create", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, fields: FIELDS, resultJson: "{}" });
  assert.equal(noReclaim.length, 3);
  assert.ok(noReclaim[0].text.startsWith("INSERT INTO entitlements"));
  assert.ok(noReclaim[1].text.startsWith("INSERT INTO entitlement_events"));
  assert.ok(noReclaim[2].text.startsWith("UPDATE order_events SET status = 'processed'"));

  const withReclaim = orderApplyStatementsFor("capacity", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, capacity: { pool_size: 1 }, reclaimToPool: 1, resultJson: "{}" });
  assert.equal(withReclaim.length, 4);
  assert.equal(withReclaim[2].role, "reclaim");
  assert.ok(withReclaim[3].text.startsWith("UPDATE order_events SET status = 'processed'"));
});

// --- LAYER 2: mock-pg-client transaction logic ------------------------------------------------
// A fake pool whose begin(cb) runs cb(sql) once; sql.unsafe(text, params) records the call and returns
// the scripted rows for that call index (an Error throws -> rolls back the begin).
function mockPool(script) {
  const calls = [];
  return {
    calls,
    async begin(cb) {
      const sql = {
        async unsafe(text, params) {
          const idx = calls.length;
          calls.push({ text, params });
          const scripted = script[idx];
          if (scripted instanceof Error) {
            throw scripted;
          }
          return scripted ?? [];
        },
      };
      return cb(sql);
    },
  };
}

const ENT_ROW = {
  project: "DEFAULT", feature: "DEFAULT", license_fingerprint: "a".repeat(64), device_hash: "",
  status: "active", assertion_ttl_seconds: 300, cache_ttl_seconds: 300, revocation_seq: 4,
  valid_from: null, valid_until: 2000, notes: "", customer_id: "cus_a", license_id: null,
  created_at: 100, updated_at: NOW,
};

test("LAYER2 a floor-advancing apply returns applied:true with withId(row); statements run in order; mark is last", async () => {
  const statements = orderApplyStatementsFor("create", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, fields: FIELDS, resultJson: "{}" });
  // script: mutation -> [row]; audit -> []; mark -> []
  const pool = mockPool([[ENT_ROW], [], []]);
  const result = await runApplyTransaction(pool, statements);
  assert.equal(result.applied, true);
  assert.deepEqual(result.data, withId(ENT_ROW));
  assert.deepEqual(result.reclaimedSeats, []);
  assert.equal(pool.calls.length, 3, "all three statements executed in one txn");
  assert.ok(pool.calls[0].text.startsWith("INSERT INTO entitlements"));
  assert.ok(pool.calls[2].text.startsWith("UPDATE order_events SET status = 'processed'"), "processed-mark is LAST");
});

test("LAYER2 an empty primary RETURNING is 'superseded' (applied:false) — NOT an error — and the mark still runs", async () => {
  const statements = orderApplyStatementsFor("patch", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, fields: FIELDS, resultJson: "{}" });
  const pool = mockPool([[], [], []]); // floor no-op: mutation returns no row
  const result = await runApplyTransaction(pool, statements);
  assert.equal(result.applied, false);
  assert.equal(result.data, null);
  assert.equal(pool.calls.length, statements.length, "the processed-mark still committed (exactly-once accounted)");
});

test("LAYER2 a capacity downgrade maps the reclaim DELETE's RETURNING seat_ids", async () => {
  const statements = orderApplyStatementsFor("capacity", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, capacity: { pool_size: 1 }, reclaimToPool: 1, resultJson: "{}" });
  // order: [mutation, audit, reclaim, mark]
  const pool = mockPool([[ENT_ROW], [], [{ seat_id: "s_old1" }, { seat_id: "s_old2" }], []]);
  const result = await runApplyTransaction(pool, statements);
  assert.equal(result.applied, true);
  assert.deepEqual(result.reclaimedSeats, ["s_old1", "s_old2"]);
  assert.equal(pool.calls[2].text.includes("DELETE FROM seat_checkouts WHERE ctid IN"), true);
});

test("LAYER2 a DB error on the mutation rejects (rollback) and propagates", async () => {
  const statements = orderApplyStatementsFor("transition", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, status: "revoked", eventType: "revoke", resultJson: "{}" });
  const pool = mockPool([new Error("deadlock detected")]);
  await assert.rejects(() => runApplyTransaction(pool, statements), /deadlock detected/);
  assert.equal(pool.calls.length, 1, "rolled back after the failing primary; no further statements");
});
