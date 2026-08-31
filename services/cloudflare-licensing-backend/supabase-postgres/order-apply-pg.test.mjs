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
  entitlementId,
  withId,
} from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import {
  pgAcceptBatch,
  pgCreateStatement,
  pgPatchStatement,
  pgTransitionStatement,
  pgCapacityStatement,
  pgOrderEventStatement,
  pgReclaimStatement,
  pgProcessedMark,
  pgRevokedOrderEventMark,
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

test("LAYER1 terminal-revocation guards block every non-revoke mutation but permit the revoke transition", () => {
  const guarded = [
    [pgCreateStatement(KEY, FIELDS, FLOOR, NOW), "create"],
    [pgPatchStatement(KEY, FIELDS, FLOOR, NOW), "patch"],
    [pgTransitionStatement(KEY, "active", FLOOR, NOW), "non-revoke transition"],
    [pgCapacityStatement(KEY, { pool_size: 1 }, FLOOR, NOW), "capacity"],
  ];
  for (const [statement, label] of guarded) {
    assert.ok(statement.text.includes("entitlements.status <> 'revoked'"), `${label} must preserve terminal revocation`);
  }
  const revoke = pgTransitionStatement(KEY, "revoked", FLOOR, NOW);
  assert.equal(revoke.text.includes("entitlements.status <> 'revoked'"), false, "the terminal revoke itself remains admissible");
});

test("LAYER1b audit and reclaim are parameterized, translated, and bound to the APPLY winner", () => {
  const audit = pgOrderEventStatement(KEY, "create", ORDER, NOW);
  const expectedEntitlementId = entitlementId(KEY.project, KEY.feature, KEY.license_fingerprint);
  assertParameterized(audit, "audit");
  assert.ok(audit.text.includes("json_build_object('project', project,"), "json_object -> json_build_object");
  assert.equal(audit.params[6], expectedEntitlementId, "the seventh bind is the canonical entitlement id");
  assert.ok(
    audit.text.includes("'id', $7::text)::text,"),
    "the polymorphic id input and json_build_object output both have explicit TEXT types",
  );
  assert.equal(audit.text.includes("json_object("), false);
  assert.ok(audit.text.includes("'sync'"), "source literal 'sync' kept");
  assert.ok(audit.text.includes("entitlements.status <> 'revoked'"), "normal audit is suppressed for a revoked loser");
  assert.ok(
    audit.text.includes("last_applied_order_epoch = $14 AND last_applied_order_seq = $15"),
    "audit insert requires this mutation's exact applied floor",
  );
  assert.deepEqual(audit.params.slice(13, 15), [ORDER.order_epoch, ORDER.seq], "audit winner guard binds the current order floor");
  assert.ok(
    audit.text.includes("oe.event_id = $16 AND oe.status = 'accepted'"),
    "audit insert requires this event to still own the accepted state",
  );
  assert.equal(audit.params[15], ORDER.event_id, "audit winner guard binds the current event id");

  const reclaim = pgReclaimStatement(KEY, NOW, 1, FLOOR, ORDER.event_id);
  assertParameterized(reclaim, "reclaim");
  assert.ok(reclaim.text.includes("WHERE ctid IN (SELECT sc.ctid FROM seat_checkouts AS sc"), "rowid -> correlated ctid");
  assert.ok(reclaim.text.includes("LIMIT GREATEST(0, (SELECT COUNT(*)"), "max(0,..) -> GREATEST(0,..)");
  assert.ok(
    reclaim.text.includes("e.status <> 'revoked' AND e.last_applied_order_epoch = $5 AND e.last_applied_order_seq = $6"),
    "reclaim requires the capacity mutation's floor to have won",
  );
  assert.ok(
    reclaim.text.includes("oe.event_id = $7 AND oe.status = 'accepted'"),
    "reclaim requires the current event to still own finalization",
  );
  assert.equal(reclaim.text.includes("rowid"), false);
  assert.equal(reclaim.role, "reclaim");
  assert.deepEqual(reclaim.params, [
    KEY.project, KEY.feature, KEY.license_fingerprint, NOW,
    FLOOR.epoch, FLOOR.seq, ORDER.event_id,
    KEY.project, KEY.feature, KEY.license_fingerprint, NOW, 1,
  ]);
});

test("LAYER1c revoked arbitration durably caches the fixed entitlement_revoked result", () => {
  const mark = pgRevokedOrderEventMark(KEY, ORDER.event_id, "derived", NOW);
  assertParameterized(mark, "revoked-mark");
  assert.equal(mark.role, "revoked_mark");
  assert.ok(mark.text.includes("SET status = 'rejected'"));
  assert.ok(mark.text.includes("AND status = 'accepted'"));
  assert.ok(mark.text.includes("AND status = 'revoked') RETURNING event_id"));
  assert.deepEqual(JSON.parse(mark.params[0]), {
    ok: false,
    code: "entitlement_revoked",
    license_fingerprint: KEY.license_fingerprint,
    fingerprint_origin: "derived",
  });
  const revokeAudit = pgOrderEventStatement(KEY, "revoke", ORDER, NOW, false);
  assert.equal(revokeAudit.text.includes("entitlements.status <> 'revoked'"), false, "the winning revoke still emits its normal audit");
  assert.ok(
    revokeAudit.text.includes("last_applied_order_epoch = $14 AND last_applied_order_seq = $15"),
    "a superseded revoke cannot emit a false revoke audit",
  );
});

test("LAYER1c ACCEPT claims only from an immutable-identity cursor winner", () => {
  const statements = pgAcceptBatch(
    ORDER,
    "k1",
    "digest1",
    "{}",
    NOW,
    KEY.license_fingerprint,
    "derived",
  );
  assert.equal(statements.length, 1, "PostgreSQL winner binding is one data-modifying statement");
  const [accept] = statements;
  assertParameterized(accept, "accept");
  assert.ok(accept.text.startsWith("WITH cursor_winner AS (UPDATE orders AS current_order SET order_epoch ="));
  assert.ok(accept.text.includes("current_order.license_fingerprint = $9"));
  assert.ok(accept.text.includes("current_order.fingerprint_origin = $10"));
  assert.ok(accept.text.includes("current_order.customer_id IS NULL OR $11 IS NULL OR current_order.customer_id = $12"));
  assert.ok(accept.text.includes("current_order.license_id IS NULL OR $13 IS NULL OR current_order.license_id = $14"));
  assert.ok(accept.text.includes("RETURNING current_order.subscription_id, current_order.project, current_order.feature, current_order.license_fingerprint"));
  assert.ok(accept.text.includes("FROM cursor_winner AS winner"), "claim is sourced only from the winning UPDATE row");
  assert.ok(accept.text.includes("'accepted', '',"), "status literal 'accepted', empty result_json");
  assert.ok(accept.text.endsWith("RETURNING event_id, order_epoch, seq AS last_seq"));
  assert.deepEqual(accept.params, [
    ORDER.order_epoch, ORDER.seq, null, null, NOW,
    ORDER.subscription_id, ORDER.project, ORDER.feature, KEY.license_fingerprint, "derived",
    null, null, null, null, ORDER.order_epoch, ORDER.order_epoch, ORDER.seq,
    ORDER.event_id, ORDER.intent, "k1", "digest1", "{}", NOW,
  ]);
});

test("LAYER1d ACCEPT conditionally reserves a project/customer-compatible license before cursor advance", () => {
  const identifiedOrder = { ...ORDER, customer: { id: "cus_a" }, license_id: "lic_a" };
  const [accept] = pgAcceptBatch(
    identifiedOrder,
    "k1",
    "digest1",
    "{}",
    NOW,
    KEY.license_fingerprint,
    "supplied",
  );
  assertParameterized(accept, "accept-with-license");
  assert.ok(accept.text.startsWith("WITH license_winner AS (INSERT INTO licenses"));
  assert.ok(accept.text.includes("WHERE EXISTS (SELECT 1 FROM orders AS reserved_order"));
  assert.ok(accept.text.includes("reserved_order.license_fingerprint = $9 AND reserved_order.fingerprint_origin = $10"));
  assert.ok(accept.text.includes("ON CONFLICT (id) DO UPDATE SET customer_id = COALESCE(licenses.customer_id, EXCLUDED.customer_id)"));
  assert.ok(accept.text.includes("WHERE licenses.project = EXCLUDED.project"));
  assert.ok(accept.text.includes("EXISTS (SELECT 1 FROM license_winner WHERE id = $23)"));
  assert.equal(accept.params[0], "lic_a");
  assert.equal(accept.params[1], "cus_a");
  assert.deepEqual(accept.params.slice(8, 14), [KEY.license_fingerprint, "supplied", "cus_a", "cus_a", "lic_a", "lic_a"]);
  assert.deepEqual(accept.params.slice(22, 28), ["lic_a", ORDER.subscription_id, ORDER.project, ORDER.feature, KEY.license_fingerprint, "supplied"]);
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

test("LAYER1 orderApplyStatementsFor assembles terminal arbitration before the final processed mark", () => {
  const noReclaim = orderApplyStatementsFor("create", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, fields: FIELDS, fingerprintOrigin: "derived", resultJson: "{}" });
  assert.equal(noReclaim.length, 4);
  assert.ok(noReclaim[0].text.startsWith("INSERT INTO entitlements"));
  assert.ok(noReclaim[1].text.startsWith("INSERT INTO entitlement_events"));
  assert.equal(noReclaim[2].role, "revoked_mark");
  assert.ok(noReclaim[3].text.startsWith("UPDATE order_events SET status = 'processed'"));

  const withReclaim = orderApplyStatementsFor("capacity", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, capacity: { pool_size: 1 }, reclaimToPool: 1, fingerprintOrigin: "derived", resultJson: "{}" });
  assert.equal(withReclaim.length, 5);
  assert.equal(withReclaim[2].role, "reclaim");
  assert.deepEqual(withReclaim[2].params.slice(4, 7), [FLOOR.epoch, FLOOR.seq, ORDER.event_id]);
  assert.equal(withReclaim[3].role, "revoked_mark");
  assert.equal(withReclaim[4].role, "mark");

  const revoke = orderApplyStatementsFor("transition", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, status: "revoked", eventType: "revoke", fingerprintOrigin: "derived", resultJson: "{}" });
  assert.equal(revoke.length, 3, "a revoke winner needs no revoked-loser arbitration statement");
  assert.equal(revoke[1].text.includes("entitlements.status <> 'revoked'"), false);
  assert.equal(revoke[2].role, "mark");
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
  const statements = orderApplyStatementsFor("create", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, fields: FIELDS, fingerprintOrigin: "derived", resultJson: "{}" });
  // script: mutation -> [row]; audit -> []; revoked arbitration -> []; processed mark -> winner row
  const pool = mockPool([[ENT_ROW], [], [], [{ event_id: ORDER.event_id }]]);
  const result = await runApplyTransaction(pool, statements);
  assert.equal(result.applied, true);
  assert.equal(result.marked, true);
  assert.equal(result.revoked, false);
  assert.deepEqual(result.data, withId(ENT_ROW));
  assert.deepEqual(result.reclaimedSeats, []);
  assert.equal(pool.calls.length, 4, "all four statements executed in one txn");
  assert.ok(pool.calls[0].text.startsWith("INSERT INTO entitlements"));
  assert.ok(pool.calls[3].text.startsWith("UPDATE order_events SET status = 'processed'"), "processed-mark is LAST");
});

test("LAYER2 an empty primary RETURNING is 'superseded' (applied:false) — NOT an error — and the mark still runs", async () => {
  const statements = orderApplyStatementsFor("patch", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, fields: FIELDS, fingerprintOrigin: "derived", resultJson: "{}" });
  const pool = mockPool([[], [], [], [{ event_id: ORDER.event_id }]]); // active floor no-op; revoked arbitration no-ops and processed mark wins
  const result = await runApplyTransaction(pool, statements);
  assert.equal(result.applied, false);
  assert.equal(result.marked, true);
  assert.equal(result.revoked, false);
  assert.equal(result.data, null);
  assert.equal(pool.calls.length, statements.length, "the processed-mark still committed (exactly-once accounted)");
});

test("LAYER2 a capacity downgrade maps the reclaim DELETE's RETURNING seat_ids", async () => {
  const statements = orderApplyStatementsFor("capacity", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, capacity: { pool_size: 1 }, reclaimToPool: 1, fingerprintOrigin: "derived", resultJson: "{}" });
  // order: [mutation, audit, reclaim, revoked arbitration, processed mark]
  const pool = mockPool([[ENT_ROW], [], [{ seat_id: "s_old1" }, { seat_id: "s_old2" }], [], [{ event_id: ORDER.event_id }]]);
  const result = await runApplyTransaction(pool, statements);
  assert.equal(result.applied, true);
  assert.equal(result.marked, true);
  assert.deepEqual(result.reclaimedSeats, ["s_old1", "s_old2"]);
  assert.equal(pool.calls[2].text.includes("DELETE FROM seat_checkouts WHERE ctid IN"), true);
});

test("LAYER2 a losing redrive reports marked:false and no reclaimed seats", async () => {
  const statements = orderApplyStatementsFor("capacity", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, capacity: { pool_size: 1 }, reclaimToPool: 1, fingerprintOrigin: "derived", resultJson: "{}" });
  // The SQL winner guards make mutation/audit/reclaim empty; an already-processed mark is empty too.
  const pool = mockPool([[], [], [], [], []]);
  const result = await runApplyTransaction(pool, statements);
  assert.deepEqual(result, { applied: false, marked: false, revoked: false, data: null, reclaimedSeats: [] });
  assert.equal(pool.calls.length, 5, "all guarded statements execute atomically and no-op");
});

test("LAYER2 a non-revoke mutation loser is atomically rejected as entitlement_revoked", async () => {
  const statements = orderApplyStatementsFor("capacity", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, capacity: { pool_size: 0 }, reclaimToPool: 0, fingerprintOrigin: "derived", resultJson: "{}" });
  const pool = mockPool([[], [], [], [{ event_id: ORDER.event_id }], []]);
  const result = await runApplyTransaction(pool, statements);
  assert.deepEqual(result, { applied: false, marked: false, revoked: true, data: null, reclaimedSeats: [] });
  assert.equal(pool.calls[1].text.includes("entitlements.status <> 'revoked'"), true, "normal audit is suppressed");
  assert.equal(pool.calls[2].text.includes("e.status <> 'revoked'"), true, "seat reclaim is suppressed");
  assert.ok(pool.calls[3].text.includes("SET status = 'rejected'"), "revoked arbitration runs before the final processed mark");
});

test("LAYER2 a DB error on the mutation rejects (rollback) and propagates", async () => {
  const statements = orderApplyStatementsFor("transition", { key: KEY, order: ORDER, floor: FLOOR, now: NOW, status: "revoked", eventType: "revoke", fingerprintOrigin: "derived", resultJson: "{}" });
  const pool = mockPool([new Error("deadlock detected")]);
  await assert.rejects(() => runApplyTransaction(pool, statements), /deadlock detected/);
  assert.equal(pool.calls.length, 1, "rolled back after the failing primary; no further statements");
});
