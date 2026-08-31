// order-apply-smoke-real-pg.mjs
//
// Real-PostgreSQL smoke for the order-apply port (order-apply-pg.mjs) — the live-engine counterpart to
// the hermetic order-apply-pg.test.mjs. It drives the REAL, UNMODIFIED orderApplyStatementsFor()/builder
// output through node-postgres against a live Postgres, exercising the constructs pg-mem cannot emulate:
// the atomic ACCEPT winner CTE, ON CONFLICT correlated floor, FLOOR_PREDICATE_UPDATE suppression
// (empty RETURNING == superseded), accepted-event audit guard, json_build_object(...)::text, and the
// floor/event-guarded ctid + GREATEST(0,..) seat-reclaim DELETE.
//
// GATED on DATABASE_URL: with none set this is a CLEAN SKIP (exit 0), so CI/Windows without Docker is not a
// failure. To run:
//   docker run -d --name pg -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=licensecc -p 5433:5432 postgres:16-alpine
//   psql postgresql://postgres:smoke@localhost:5433/licensecc -f schema.pg.sql
//   npm ci
//   DATABASE_URL=postgresql://postgres:smoke@localhost:5433/licensecc node order-apply-smoke-real-pg.mjs
//
// Exit 0 = all assertions passed (or skipped); exit 1 = a failure.

import {
  pgAcceptBatch,
  pgCreateStatement,
  pgPatchStatement,
  pgCapacityStatement,
  pgOrderEventStatement,
  pgReclaimStatement,
  pgProcessedMark,
  orderApplyStatementsFor,
  runApplyTransaction,
} from "./order-apply-pg.mjs";
import { entitlementId } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { closePool, createPool } from "./db-postgres.mjs";

if (!process.env.DATABASE_URL) {
  console.log("SKIP order-apply smoke: set DATABASE_URL (a live Postgres) to run.");
  process.exit(0);
}

const pool = createPool(process.env.DATABASE_URL);
const query = async (text, params = []) => {
  const result = await pool.unsafe(text, params);
  return { rows: Array.from(result), rowCount: result.count };
};

const PROJECT = "DEFAULT";
const FEATURE = "DEFAULT";
const FP = "a".repeat(64);
const SUB = "sub_smoke";
const KEY = { project: PROJECT, feature: FEATURE, license_fingerprint: FP };
const EXPECTED_ENTITLEMENT_ID = entitlementId(PROJECT, FEATURE, FP);
const CUSTOMER_ID = "cus_smoke";
const LICENSE_ID = "lic_smoke";
const FINGERPRINT_ORIGIN = "derived";
const NOW = 1_700_000_000;

const N = (v) => Number(v);
let pass = 0;
let fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log("PASS  " + name + (got !== undefined ? "  => " + JSON.stringify(got) : "")); }
  else { fail++; console.log("FAIL  " + name + "  got " + JSON.stringify(got)); }
};

const ent = async () => (await query("SELECT * FROM entitlements WHERE license_fingerprint=$1", [FP])).rows[0];
const liveSeatCount = async () =>
  N((await query("SELECT COUNT(*)::int n FROM seat_checkouts WHERE license_fingerprint=$1 AND heartbeat_deadline > $2", [FP, NOW])).rows[0].n);
const runApply = (statements) => runApplyTransaction(pool, statements);
const runAccept = (statements) => pool.begin(async (sql) => {
  const results = [];
  for (const statement of statements) {
    const result = await sql.unsafe(statement.text, statement.params);
    results.push({ rows: Array.from(result), rowCount: result.count });
  }
  return results;
});

// Seed an 'accepted' order_event so the in-txn processed-mark has a row to flip.
async function seedAcceptedEvent(eventId, epoch, seq, intent) {
  await query(
    "INSERT INTO order_events (event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, payload_digest, raw_payload, status, result_json, received_at, processed_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,'k','d','{}','accepted','',$8,NULL)",
    [eventId, SUB, PROJECT, FEATURE, epoch, seq, intent, NOW],
  );
}

function order(eventId, epoch, seq, intent, overrides = {}) {
  return { intent, subscription_id: SUB, event_id: eventId, project: PROJECT, feature: FEATURE, order_epoch: epoch, seq, ...overrides };
}

const identifiedOrder = (eventId, epoch, seq, intent) => order(eventId, epoch, seq, intent, {
  customer: { id: CUSTOMER_ID },
  license_id: LICENSE_ID,
});

const createFields = {
  device_hash: "", status: "active", assertion_ttl_seconds: 300, valid_from: null, valid_until: NOW + 86400,
  notes: "", customer_id: CUSTOMER_ID, license_id: LICENSE_ID, pool_size: 3, max_active_devices: 1, created_at: NOW,
};

try {
  // Clean (repeatable).
  await query("DELETE FROM seat_checkouts WHERE license_fingerprint=$1", [FP]);
  await query("DELETE FROM entitlement_events WHERE license_fingerprint=$1", [FP]);
  await query("DELETE FROM order_events WHERE subscription_id=$1", [SUB]);
  await query("DELETE FROM order_events WHERE subscription_id LIKE 'sub_accept_guard_%'");
  await query("DELETE FROM entitlements WHERE license_fingerprint=$1", [FP]);
  await query("DELETE FROM orders WHERE subscription_id=$1", [SUB]);
  await query("DELETE FROM orders WHERE subscription_id LIKE 'sub_accept_guard_%'");
  await query("DELETE FROM licenses WHERE id IN ($1,$2,$3,$4)", [LICENSE_ID, "lic_guard_other", "lic_guard_project", "lic_guard_customer"]);
  await query("DELETE FROM customers WHERE id=$1", [CUSTOMER_ID]);

  // Seed customer (FK) + the orders cursor row at epoch 0.
  await query("INSERT INTO customers (id, name, email, metadata_json, created_at, updated_at, status, external_ref) VALUES ($1,'Smoke','s@x.test','{}',$2,$2,'active','') ON CONFLICT (id) DO NOTHING", [CUSTOMER_ID, NOW]);
  await query(
    "INSERT INTO orders (subscription_id, project, feature, license_fingerprint, customer_id, license_id, last_seq, order_epoch, fingerprint_origin, created_at, updated_at) VALUES ($1,$2,$3,$4,NULL,NULL,-1,0,'derived',$5,$5)",
    [SUB, PROJECT, FEATURE, FP, NOW],
  );

  // (1) ACCEPT event @ (1,1): reserve the optional license, fill immutable auxiliaries, advance,
  // and claim the event through one dependency-ordered statement.
  const acc = pgAcceptBatch(
    identifiedOrder("evt_create", 1, 1, "subscription.active"),
    "k", "d", "{}", NOW, FP, FINGERPRINT_ORIGIN,
  );
  const [accepted] = await runAccept(acc);
  check(
    "ACCEPT cursor winner atomically claimed the event",
    accepted.rows.length === 1 && accepted.rows[0].event_id === "evt_create" && N(accepted.rows[0].order_epoch) === 1 && N(accepted.rows[0].last_seq) === 1,
    accepted.rows[0],
  );
  const reservedOrder = (await query(
    "SELECT license_fingerprint, fingerprint_origin, customer_id, license_id, order_epoch, last_seq FROM orders WHERE subscription_id=$1 AND project=$2 AND feature=$3",
    [SUB, PROJECT, FEATURE],
  )).rows[0];
  const reservedLicense = (await query("SELECT project, customer_id FROM licenses WHERE id=$1", [LICENSE_ID])).rows[0];
  check(
    "ACCEPT reserved the compatible license and immutably filled customer/license identity",
    reservedOrder.license_fingerprint === FP && reservedOrder.fingerprint_origin === FINGERPRINT_ORIGIN &&
      reservedOrder.customer_id === CUSTOMER_ID && reservedOrder.license_id === LICENSE_ID &&
      reservedLicense.project === PROJECT && reservedLicense.customer_id === CUSTOMER_ID,
    { order: reservedOrder, license: reservedLicense },
  );

  const [acceptLoser] = await runAccept(pgAcceptBatch(
    identifiedOrder("evt_accept_loser", 1, 1, "subscription.active"),
    "k", "d2", "{}", NOW, FP, FINGERPRINT_ORIGIN,
  ));
  const acceptLoserRows = (await query("SELECT event_id FROM order_events WHERE event_id=$1", ["evt_accept_loser"])).rows;
  check(
    "ACCEPT cursor loser cannot claim an event at the winning floor",
    acceptLoser.rows.length === 0 && acceptLoserRows.length === 0,
    { returning_rows: acceptLoser.rows.length, persisted_events: acceptLoserRows.length },
  );

  // Higher-sequence attempts prove each immutable guard independently; none may advance the cursor,
  // reserve a contradictory license, or claim an event.
  const immutableLosers = [
    pgAcceptBatch(identifiedOrder("evt_guard_fingerprint", 1, 2, "subscription.renew"), "k", "g1", "{}", NOW, "b".repeat(64), FINGERPRINT_ORIGIN),
    pgAcceptBatch(identifiedOrder("evt_guard_origin", 1, 2, "subscription.renew"), "k", "g2", "{}", NOW, FP, "supplied"),
    pgAcceptBatch(order("evt_guard_customer", 1, 2, "subscription.renew", { customer: { id: "cus_other" }, license_id: LICENSE_ID }), "k", "g3", "{}", NOW, FP, FINGERPRINT_ORIGIN),
    pgAcceptBatch(order("evt_guard_license", 1, 2, "subscription.renew", { customer: { id: CUSTOMER_ID }, license_id: "lic_guard_other" }), "k", "g4", "{}", NOW, FP, FINGERPRINT_ORIGIN),
  ];
  const immutableLoserRows = [];
  for (const statements of immutableLosers) immutableLoserRows.push((await runAccept(statements))[0].rows.length);
  const guardedOrder = (await query("SELECT order_epoch, last_seq, customer_id, license_id FROM orders WHERE subscription_id=$1 AND project=$2 AND feature=$3", [SUB, PROJECT, FEATURE])).rows[0];
  const immutableEvents = N((await query("SELECT COUNT(*)::int n FROM order_events WHERE event_id LIKE 'evt_guard_%'")).rows[0].n);
  const contradictoryLicense = (await query("SELECT id FROM licenses WHERE id=$1", ["lic_guard_other"])).rows;
  check(
    "ACCEPT rejects fingerprint/origin/customer/license conflicts without cursor, reservation, or claim mutation",
    immutableLoserRows.every((count) => count === 0) && immutableEvents === 0 && contradictoryLicense.length === 0 &&
      N(guardedOrder.order_epoch) === 1 && N(guardedOrder.last_seq) === 1 &&
      guardedOrder.customer_id === CUSTOMER_ID && guardedOrder.license_id === LICENSE_ID,
    { returning_rows: immutableLoserRows, events: immutableEvents, cursor: [guardedOrder.order_epoch, guardedOrder.last_seq] },
  );

  // A globally keyed license reservation must also reject a different project or explicit customer.
  for (const fixture of [
    { suffix: "project", fingerprint: "c".repeat(64), license: "lic_guard_project", licenseProject: "OTHER", licenseCustomer: null },
    { suffix: "customer", fingerprint: "d".repeat(64), license: "lic_guard_customer", licenseProject: PROJECT, licenseCustomer: "cus_other" },
  ]) {
    const subscription = `sub_accept_guard_${fixture.suffix}`;
    await query(
      "INSERT INTO orders (subscription_id, project, feature, license_fingerprint, customer_id, license_id, last_seq, order_epoch, fingerprint_origin, created_at, updated_at) VALUES ($1,$2,$3,$4,NULL,NULL,-1,0,'derived',$5,$5)",
      [subscription, PROJECT, FEATURE, fixture.fingerprint, NOW],
    );
    await query(
      "INSERT INTO licenses (id, customer_id, project, label, metadata_json, created_at, updated_at) VALUES ($1,$2,$3,'','{}',$4,$4)",
      [fixture.license, fixture.licenseCustomer, fixture.licenseProject, NOW],
    );
    const guardedFixtureOrder = order(`evt_license_${fixture.suffix}`, 1, 1, "subscription.active", {
      subscription_id: subscription,
      customer: { id: CUSTOMER_ID },
      license_id: fixture.license,
    });
    const [reservationLoser] = await runAccept(pgAcceptBatch(
      guardedFixtureOrder, "k", `guard-${fixture.suffix}`, "{}", NOW, fixture.fingerprint, FINGERPRINT_ORIGIN,
    ));
    const unchanged = (await query("SELECT order_epoch, last_seq, customer_id, license_id FROM orders WHERE subscription_id=$1 AND project=$2 AND feature=$3", [subscription, PROJECT, FEATURE])).rows[0];
    check(
      `license reservation rejects conflicting ${fixture.suffix} without advancing or claiming`,
      reservationLoser.rows.length === 0 && N(unchanged.order_epoch) === 0 && N(unchanged.last_seq) === -1 && unchanged.customer_id === null && unchanged.license_id === null,
      { returning_rows: reservationLoser.rows.length, cursor: [unchanged.order_epoch, unchanged.last_seq] },
    );
  }

  // (2) APPLY create @ floor (1,1): entitlement materializes, seq=1, floor=(1,1), event processed.
  const createStmts = [
    pgCreateStatement(KEY, createFields, { epoch: 1, seq: 1 }, NOW),
    pgOrderEventStatement(KEY, "create", order("evt_create", 1, 1, "subscription.active"), NOW),
    pgProcessedMark("evt_create", "{}", NOW),
  ];
  const created = await runApply(createStmts);
  let r = await ent();
  check("create applied: active, seq=1, floor=(1,1)", created.applied && created.marked && r.status === "active" && N(r.revocation_seq) === 1 && N(r.last_applied_order_epoch) === 1 && N(r.last_applied_order_seq) === 1, { applied: created.applied, marked: created.marked, seq: r.revocation_seq, floor: [r.last_applied_order_epoch, r.last_applied_order_seq] });
  const evState = (await query("SELECT status FROM order_events WHERE event_id=$1", ["evt_create"])).rows[0].status;
  check("create event marked processed", evState === "processed", evState);

  const auditCountBefore = N((await query("SELECT COUNT(*)::int n FROM entitlement_events WHERE request_id=$1", ["evt_create"])).rows[0].n);
  const losingAuditStatement = pgOrderEventStatement(KEY, "create", order("evt_create", 1, 1, "subscription.active"), NOW);
  const losingAudit = await query(losingAuditStatement.text, losingAuditStatement.params);
  const auditCountAfter = N((await query("SELECT COUNT(*)::int n FROM entitlement_events WHERE request_id=$1", ["evt_create"])).rows[0].n);
  check(
    "processed event cannot append a second entitlement audit",
    losingAudit.rowCount === 0 && auditCountAfter === auditCountBefore,
    { returning_rows: losingAudit.rowCount, before: auditCountBefore, after: auditCountAfter },
  );

  // (3) STALE patch @ floor (0,9) [epoch 0 < 1]: FLOOR_PREDICATE_UPDATE false -> empty RETURNING = superseded.
  await seedAcceptedEvent("evt_stale", 0, 9, "subscription.renew");
  const stale = await runApply([
    pgPatchStatement(KEY, { ...createFields, valid_until: NOW + 999 }, { epoch: 0, seq: 9 }, NOW),
    pgOrderEventStatement(KEY, "update", order("evt_stale", 0, 9, "subscription.renew"), NOW),
    pgProcessedMark("evt_stale", "{}", NOW),
  ]);
  r = await ent();
  check("stale apply -> superseded (no row), seq UNCHANGED at 1, floor still (1,1)", stale.applied === false && stale.marked && N(r.revocation_seq) === 1 && N(r.last_applied_order_epoch) === 1, { applied: stale.applied, marked: stale.marked, seq: r.revocation_seq });

  // A superseded fraud/revoke intent is especially sensitive: it must be accounted for, but may not
  // publish a revoke audit for the unchanged active entitlement.
  await seedAcceptedEvent("evt_stale_revoke", 0, 10, "fraud.confirmed");
  const staleRevoke = await runApply(orderApplyStatementsFor("transition", {
    key: KEY,
    order: order("evt_stale_revoke", 0, 10, "fraud.confirmed"),
    floor: { epoch: 0, seq: 10 },
    now: NOW,
    status: "revoked",
    eventType: "revoke",
    fingerprintOrigin: FINGERPRINT_ORIGIN,
    resultJson: "{}",
  }));
  const staleRevokeEntitlement = await ent();
  const staleRevokeAuditCount = N((await query(
    "SELECT COUNT(*)::int n FROM entitlement_events WHERE request_id=$1",
    ["evt_stale_revoke"],
  )).rows[0].n);
  check(
    "superseded fraud intent is processed without a false revoke audit",
    staleRevoke.applied === false && staleRevoke.marked === true && staleRevoke.revoked === false &&
      staleRevokeEntitlement.status === "active" && staleRevokeAuditCount === 0,
    { outcome: staleRevoke, status: staleRevokeEntitlement.status, audit_count: staleRevokeAuditCount },
  );

  // (4) FORWARD patch @ floor (3,1): advances -> seq=2, floor=(3,1).
  const [forwardAccepted] = await runAccept(pgAcceptBatch(
    identifiedOrder("evt_fwd", 3, 1, "subscription.renew"),
    "k", "d-fwd", "{}", NOW, FP, FINGERPRINT_ORIGIN,
  ));
  check(
    "matching immutable customer/license identity admits a later cursor event",
    forwardAccepted.rows.length === 1 && forwardAccepted.rows[0].event_id === "evt_fwd",
    forwardAccepted.rows[0],
  );
  const fwd = await runApply([
    pgPatchStatement(KEY, { ...createFields, valid_until: NOW + 172800 }, { epoch: 3, seq: 1 }, NOW),
    pgOrderEventStatement(KEY, "update", order("evt_fwd", 3, 1, "subscription.renew"), NOW),
    pgProcessedMark("evt_fwd", "{}", NOW),
  ]);
  r = await ent();
  check("forward apply -> seq=2, floor=(3,1)", fwd.applied && fwd.marked && N(r.revocation_seq) === 2 && N(r.last_applied_order_epoch) === 3, { applied: fwd.applied, marked: fwd.marked, seq: r.revocation_seq, floor: [r.last_applied_order_epoch, r.last_applied_order_seq] });

  // (5) CAPACITY downgrade @ floor (4,1), pool 3->1, with 3 live seats: reclaim the 2 longest-held.
  for (const [sid, dl] of [["s1", NOW + 100], ["s2", NOW + 200], ["s3", NOW + 300]]) {
    await query(
      "INSERT INTO seat_checkouts (project, feature, license_fingerprint, seat_id, client_instance_id, mode, checked_out_at, heartbeat_deadline) VALUES ($1,$2,$3,$4,'i','live',$5,$6)",
      [PROJECT, FEATURE, FP, sid, NOW - 10, dl],
    );
  }
  const [capacityAccepted] = await runAccept(pgAcceptBatch(
    identifiedOrder("evt_cap", 4, 1, "quantity.changed"),
    "k", "d-cap", "{}", NOW, FP, FINGERPRINT_ORIGIN,
  ));
  check("matching identity admitted the capacity event", capacityAccepted.rows.length === 1, capacityAccepted.rows[0]);
  const cap = await runApply([
    pgCapacityStatement(KEY, { pool_size: 1 }, { epoch: 4, seq: 1 }, NOW),
    pgOrderEventStatement(KEY, "update", order("evt_cap", 4, 1, "quantity.changed"), NOW),
    pgReclaimStatement(KEY, NOW, 1, { epoch: 4, seq: 1 }, "evt_cap"),
    pgProcessedMark("evt_cap", "{}", NOW),
  ]);
  const liveAfter = await liveSeatCount();
  check("capacity downgrade reclaimed 2 longest-held seats; 1 live remains (ctid + GREATEST)", cap.applied && cap.marked && cap.reclaimedSeats.length === 2 && liveAfter === 1, { applied: cap.applied, marked: cap.marked, reclaimed: cap.reclaimedSeats, live: liveAfter });

  // An accepted event that did not win the entitlement floor cannot reclaim. After it is marked,
  // the accepted-state guard independently prevents reclaim even when the requested floor matches.
  await query(
    "INSERT INTO seat_checkouts (project, feature, license_fingerprint, seat_id, client_instance_id, mode, checked_out_at, heartbeat_deadline) VALUES ($1,$2,$3,'s4','i','live',$4,$5)",
    [PROJECT, FEATURE, FP, NOW - 10, NOW + 400],
  );
  await seedAcceptedEvent("evt_reclaim_loser", 9, 1, "quantity.changed");
  const liveBeforeGuardChecks = await liveSeatCount();
  const wrongFloorStatement = pgReclaimStatement(KEY, NOW, 0, { epoch: 9, seq: 1 }, "evt_reclaim_loser");
  const wrongFloor = await query(wrongFloorStatement.text, wrongFloorStatement.params);
  const liveAfterWrongFloor = await liveSeatCount();
  check(
    "capacity reclaim requires the mutation's winning entitlement floor",
    wrongFloor.rowCount === 0 && liveAfterWrongFloor === liveBeforeGuardChecks,
    { returning_rows: wrongFloor.rowCount, before: liveBeforeGuardChecks, after: liveAfterWrongFloor },
  );
  const reclaimLoserMark = pgProcessedMark("evt_reclaim_loser", "{}", NOW);
  await query(reclaimLoserMark.text, reclaimLoserMark.params);
  const processedEventStatement = pgReclaimStatement(KEY, NOW, 0, { epoch: 4, seq: 1 }, "evt_reclaim_loser");
  const processedEventReclaim = await query(processedEventStatement.text, processedEventStatement.params);
  const liveAfterProcessedEvent = await liveSeatCount();
  check(
    "capacity reclaim requires the event to remain accepted",
    processedEventReclaim.rowCount === 0 && liveAfterProcessedEvent === liveBeforeGuardChecks,
    { returning_rows: processedEventReclaim.rowCount, before: liveBeforeGuardChecks, after: liveAfterProcessedEvent },
  );

  // (6) Processed-mark idempotency: re-running the mark on an already-processed event no-ops.
  const remark = await query(pgProcessedMark("evt_create", "{}", NOW).text, pgProcessedMark("evt_create", "{}", NOW).params);
  check("processed-mark on an already-processed event is a no-op (0 rows)", remark.rowCount === 0, { rowCount: remark.rowCount });

  // (7) Audit events landed with json_build_object next_json that parses to the expected shape.
  const audit = (await query("SELECT next_json FROM entitlement_events WHERE license_fingerprint=$1 AND event_type='create' ORDER BY id DESC LIMIT 1", [FP])).rows[0];
  let parsed = null;
  try { parsed = JSON.parse(audit.next_json); } catch { /* parsed stays null */ }
  check(
    "audit next_json resolves the typed id bind and preserves the canonical id",
    parsed !== null && parsed.project === PROJECT && parsed.id === EXPECTED_ENTITLEMENT_ID,
    parsed && { project: parsed.project, id: parsed.id },
  );

  // (8) The transaction runner must roll back a successful primary mutation when any later statement
  // fails. The event remains accepted so a caller can redrive it, and the entitlement floor/body stay
  // byte-for-byte at their pre-transaction values.
  await seedAcceptedEvent("evt_rollback", 5, 1, "subscription.renew");
  const beforeRollback = await ent();
  let rollbackError = null;
  try {
    await runApply([
      pgPatchStatement(KEY, { ...createFields, valid_until: NOW + 259200 }, { epoch: 5, seq: 1 }, NOW),
      { text: "SELECT * FROM __licensecc_order_apply_rollback_probe_missing", params: [] },
      pgProcessedMark("evt_rollback", "{}", NOW),
    ]);
  } catch (error) {
    rollbackError = error;
  }
  const afterRollback = await ent();
  const rollbackEventState = (await query("SELECT status FROM order_events WHERE event_id=$1", ["evt_rollback"])).rows[0].status;
  check(
    "a later SQL error rolls back the entitlement mutation and leaves the event redrivable",
    rollbackError instanceof Error &&
      N(afterRollback.revocation_seq) === N(beforeRollback.revocation_seq) &&
      N(afterRollback.last_applied_order_epoch) === N(beforeRollback.last_applied_order_epoch) &&
      N(afterRollback.last_applied_order_seq) === N(beforeRollback.last_applied_order_seq) &&
      afterRollback.valid_until === beforeRollback.valid_until &&
      rollbackEventState === "accepted",
    {
      error: rollbackError instanceof Error ? rollbackError.message : null,
      floor: [afterRollback.last_applied_order_epoch, afterRollback.last_applied_order_seq],
      status: rollbackEventState,
    },
  );

  // (9) Once a revoke wins, every later non-revoke builder must lose atomically. The accepted
  // candidate is durably rejected with the fixed entitlement_revoked result; normal audit,
  // entitlement mutation, capacity reclaim, and the processed mark all remain suppressed.
  await seedAcceptedEvent("evt_terminal_revoke", 6, 1, "subscription.revoked");
  const revokeOutcome = await runApply(orderApplyStatementsFor("transition", {
    key: KEY,
    order: order("evt_terminal_revoke", 6, 1, "subscription.revoked"),
    floor: { epoch: 6, seq: 1 },
    now: NOW,
    status: "revoked",
    eventType: "revoke",
    fingerprintOrigin: FINGERPRINT_ORIGIN,
    resultJson: "{}",
  }));
  const revokedEntitlement = await ent();
  const revokeAuditCount = N((await query(
    "SELECT COUNT(*)::int n FROM entitlement_events WHERE request_id=$1",
    ["evt_terminal_revoke"],
  )).rows[0].n);
  check(
    "direct revocation wins and retains its normal audit",
    revokeOutcome.applied && revokeOutcome.marked && !revokeOutcome.revoked &&
      revokedEntitlement.status === "revoked" && revokeAuditCount === 1,
    { outcome: revokeOutcome, status: revokedEntitlement.status, audit_count: revokeAuditCount },
  );

  const revokedSnapshot = JSON.stringify(revokedEntitlement);
  const liveSeatsBeforeTerminalLosers = await liveSeatCount();
  const terminalLosers = [
    {
      label: "create conflict",
      kind: "create",
      eventId: "evt_revoked_create",
      epoch: 7,
      intent: "subscription.active",
      args: { fields: { ...createFields, status: "active", valid_until: NOW + 345600, pool_size: 9 }, eventType: "update" },
    },
    {
      label: "patch",
      kind: "patch",
      eventId: "evt_revoked_patch",
      epoch: 8,
      intent: "subscription.renew",
      args: { fields: { ...createFields, valid_until: NOW + 432000 } },
    },
    {
      label: "non-revoke transition",
      kind: "transition",
      eventId: "evt_revoked_transition",
      epoch: 9,
      intent: "subscription.reenabled",
      args: { status: "active", eventType: "reenable" },
    },
    {
      label: "capacity with reclaim",
      kind: "capacity",
      eventId: "evt_revoked_capacity",
      epoch: 10,
      intent: "quantity.changed",
      args: { capacity: { pool_size: 0 }, reclaimToPool: 0 },
    },
  ];
  for (const candidate of terminalLosers) {
    await seedAcceptedEvent(candidate.eventId, candidate.epoch, 1, candidate.intent);
    const candidateOrder = order(candidate.eventId, candidate.epoch, 1, candidate.intent);
    const outcome = await runApply(orderApplyStatementsFor(candidate.kind, {
      key: KEY,
      order: candidateOrder,
      floor: { epoch: candidate.epoch, seq: 1 },
      now: NOW,
      fingerprintOrigin: FINGERPRINT_ORIGIN,
      resultJson: "{}",
      ...candidate.args,
    }));
    const stored = (await query(
      "SELECT status, result_json FROM order_events WHERE event_id=$1",
      [candidate.eventId],
    )).rows[0];
    const result = JSON.parse(stored.result_json);
    const auditCount = N((await query(
      "SELECT COUNT(*)::int n FROM entitlement_events WHERE request_id=$1",
      [candidate.eventId],
    )).rows[0].n);
    const currentSnapshot = JSON.stringify(await ent());
    check(
      `terminal revocation rejects ${candidate.label} without mutation, audit, reclaim, or processed overwrite`,
      outcome.applied === false && outcome.marked === false && outcome.revoked === true &&
        outcome.reclaimedSeats.length === 0 && stored.status === "rejected" &&
        result.ok === false && result.code === "entitlement_revoked" &&
        result.license_fingerprint === FP && result.fingerprint_origin === FINGERPRINT_ORIGIN &&
        auditCount === 0 && currentSnapshot === revokedSnapshot,
      { outcome, event_status: stored.status, result_code: result.code, audit_count: auditCount },
    );
  }
  const liveSeatsAfterTerminalLosers = await liveSeatCount();
  check(
    "terminal revocation prevents capacity reclaim",
    liveSeatsAfterTerminalLosers === liveSeatsBeforeTerminalLosers,
    { before: liveSeatsBeforeTerminalLosers, after: liveSeatsAfterTerminalLosers },
  );

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
} catch (error) {
  fail++;
  console.log("HARNESS ERROR: " + (error instanceof Error ? error.message : String(error)));
} finally {
  await closePool();
}
process.exit(fail > 0 ? 1 : 0);
