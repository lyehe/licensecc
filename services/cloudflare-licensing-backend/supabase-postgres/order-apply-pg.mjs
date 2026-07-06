// order-apply-pg.mjs
//
// PostgreSQL runtime port of the Slice-1 order-ingest APPLY path (the D1/SQLite original is
// src/fulfillment/order_ingest.mjs). It mirrors the exactly-once accept->apply pipeline as native
// parameterized `{text, params}` statements and runs the APPLY group inside one transaction via
// `runApplyTransaction()` (postgres.js `pool.begin`), preserving EVERY exactly-once invariant of the
// D1 path verbatim:
//   - accept-then-apply ordering (ACCEPT commits in its own txn before APPLY opens one);
//   - the apply-time monotonic floor on last_applied_order_{epoch,seq} (the count guard IS the floor:
//     a non-advancing floor suppresses the conflict-update / matches no UPDATE rows => empty RETURNING
//     => 'superseded', NOT an error);
//   - fingerprint ownership (the idx_orders_fp_unique index + the Step-2 ownership SELECT — both 1:1);
//   - the in-transaction processed-mark guarded on status='accepted' (a redrive no-ops; the floor
//     independently blocks a second revocation bump).
//
// Convention: the supabase-postgres dir re-ports SQLite-ism SQL rather than importing it, because those
// need translation. THREE new translations the entitlement port never exercised live here:
//   json_object(k,v,...)  -> json_build_object(k,v,...)::text   (PG16 json_object has different arg semantics)
//   seat_checkouts.rowid  -> ctid                               (physical-row id; safe ONLY within one txn)
//   max(0, x)             -> GREATEST(0, x)
// plus the shared ones (unixepoch()->EXTRACT(EPOCH FROM now())::bigint, scalar max(a,b)->GREATEST(a,b),
// excluded->EXCLUDED). DELIBERATE exception to "never import from ../src": ENTITLEMENT_COLUMNS (a plain
// column list), withId and entitlementId (pure, language-agnostic JS) are IMPORTED from the canonical
// module — re-porting entitlementId's id-encoding would risk the exact audit/shape drift this port exists
// to avoid. The point of the port is parity, so the single source of truth wins over rigid self-containment.
//
// Scope: the apply SQL + the transaction runner ONLY. POST /v1/orders (HMAC/nonce/normalization) is the
// unmodified Worker and is NOT wired into the PG server.mjs (a two-route artifact) — see README port rules.
//
// Test bar: order-apply-pg.test.mjs (pure shape + mock-pg transaction, hermetic) and
// order-apply-smoke-real-pg.mjs (real PG16, gated on DATABASE_URL).

import { ENTITLEMENT_COLUMNS, withId, entitlementId } from "../src/entitlements/entitlement_mutation.mjs";

const ORDER_CTX_SOURCE = "sync";
const ORDER_ACTOR_TYPE = "sync";

// $n placeholder builder — one fresh params array per statement (the pg-sql.mjs convention). bind(value)
// appends and returns the next "$N" token, so binds interleave in source order exactly like the D1 `?`s.
function placeholders() {
  const params = [];
  return {
    params,
    bind(value) {
      params.push(value);
      return `$${params.length}`;
    },
  };
}

// FLOOR_PREDICATE_CONFLICT (order_ingest.mjs:179): compares the existing row to EXCLUDED — ZERO bound
// params (the count guard for the upsert path). excluded -> EXCLUDED.
const FLOOR_PREDICATE_CONFLICT =
  "(entitlements.last_applied_order_epoch < EXCLUDED.last_applied_order_epoch) OR " +
  "(entitlements.last_applied_order_epoch = EXCLUDED.last_applied_order_epoch AND entitlements.last_applied_order_seq < EXCLUDED.last_applied_order_seq)";

// FLOOR_PREDICATE_UPDATE (order_ingest.mjs:186): binds THREE values (epoch, epoch, seq) in that order —
// the second epoch is the deliberate equality-branch duplicate.
function floorPredicateUpdate(pb, floor) {
  const epoch1 = pb.bind(floor.epoch);
  const epoch2 = pb.bind(floor.epoch);
  const seq = pb.bind(floor.seq);
  return (
    `((${epoch1} > entitlements.last_applied_order_epoch) OR ` +
    `(${epoch2} = entitlements.last_applied_order_epoch AND ${seq} > entitlements.last_applied_order_seq))`
  );
}

// REVOCATION_SEQ_BUMP (entitlement_mutation.mjs:65): SQLite scalar max(a,b) -> GREATEST(a,b); inner
// aggregate MAX() kept. No bound params (references the entitlements row by table name).
const REVOCATION_SEQ_BUMP =
  "revocation_seq = GREATEST(entitlements.revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events " +
  "WHERE project = entitlements.project AND feature = entitlements.feature " +
  "AND license_fingerprint = entitlements.license_fingerprint), entitlements.revocation_seq)) + 1";

// The insert-path floor (the upsert VALUES revocation_seq): COALESCE((SELECT MAX(revocation_seq)+1 ...),1).
// Binds the three identity columns into the CURRENT statement at this position (matches D1 bind order).
function insertedRevocationSeq(pb, key) {
  const project = pb.bind(key.project);
  const feature = pb.bind(key.feature);
  const fingerprint = pb.bind(key.license_fingerprint);
  return (
    "COALESCE((SELECT MAX(revocation_seq) + 1 FROM entitlement_events " +
    `WHERE project = ${project} AND feature = ${feature} AND license_fingerprint = ${fingerprint}), 1)`
  );
}

// =============================================================================
// Step 3 — atomic ACCEPT (two statements, run in ONE transaction).
// =============================================================================

/** 3a guarded cursor advance + 3b guarded event claim. Both RETURNING rows must be non-null or the
 *  ACCEPT is STALE (mirrors the D1 batch atomicity). Returns [cursorAdvance, eventClaim]. */
export function pgAcceptBatch(order, keyId, digest, rawPayload, now) {
  const a = placeholders();
  const cursorAdvance = {
    text:
      `UPDATE orders SET order_epoch = ${a.bind(order.order_epoch)}, last_seq = ${a.bind(order.seq)}, updated_at = ${a.bind(now)} ` +
      `WHERE subscription_id = ${a.bind(order.subscription_id)} AND project = ${a.bind(order.project)} AND feature = ${a.bind(order.feature)} AND ` +
      `(order_epoch < ${a.bind(order.order_epoch)} OR (order_epoch = ${a.bind(order.order_epoch)} AND last_seq < ${a.bind(order.seq)})) ` +
      `RETURNING last_seq, order_epoch`,
    params: a.params,
  };
  const c = placeholders();
  const eventClaim = {
    text:
      "INSERT INTO order_events (event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, payload_digest, raw_payload, status, result_json, received_at, processed_at) " +
      `SELECT ${c.bind(order.event_id)}, ${c.bind(order.subscription_id)}, ${c.bind(order.project)}, ${c.bind(order.feature)}, ${c.bind(order.order_epoch)}, ${c.bind(order.seq)}, ${c.bind(order.intent)}, ${c.bind(keyId)}, ${c.bind(digest)}, ${c.bind(rawPayload)}, 'accepted', '', ${c.bind(now)}, NULL ` +
      `WHERE EXISTS (SELECT 1 FROM orders WHERE subscription_id = ${c.bind(order.subscription_id)} AND project = ${c.bind(order.project)} AND feature = ${c.bind(order.feature)} AND order_epoch = ${c.bind(order.order_epoch)} AND last_seq = ${c.bind(order.seq)}) ` +
      `RETURNING event_id`,
    params: c.params,
  };
  return [cursorAdvance, eventClaim];
}

// =============================================================================
// Step 4 — floor-guarded entitlement statement builders.
// =============================================================================

/** Floor-guarded CREATE upsert (subscription.active). RETURNING yields the row iff the insert OR a
 *  floor-advancing update landed. Bind order identical to buildCreateStatement. */
export function pgCreateStatement(key, fields, floor, now) {
  const pb = placeholders();
  const text =
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, pool_size, max_active_devices, last_applied_order_epoch, last_applied_order_seq, created_at, updated_at) " +
    `VALUES (${pb.bind(key.project)}, ${pb.bind(key.feature)}, ${pb.bind(key.license_fingerprint)}, ${pb.bind(fields.device_hash)}, ${pb.bind(fields.status)}, ${pb.bind(fields.assertion_ttl_seconds)}, ${pb.bind(fields.assertion_ttl_seconds)}, ${insertedRevocationSeq(pb, key)}, ${pb.bind(fields.valid_from)}, ${pb.bind(fields.valid_until)}, ${pb.bind(fields.notes)}, ${pb.bind(fields.customer_id)}, ${pb.bind(fields.license_id)}, ${pb.bind(fields.pool_size)}, ${pb.bind(fields.max_active_devices)}, ${pb.bind(floor.epoch)}, ${pb.bind(floor.seq)}, ${pb.bind(fields.created_at)}, ${pb.bind(now)}) ` +
    "ON CONFLICT (project, feature, license_fingerprint) DO UPDATE SET " +
    "device_hash = EXCLUDED.device_hash, status = EXCLUDED.status, assertion_ttl_seconds = EXCLUDED.assertion_ttl_seconds, cache_ttl_seconds = EXCLUDED.cache_ttl_seconds, " +
    `${REVOCATION_SEQ_BUMP}, ` +
    "valid_from = EXCLUDED.valid_from, valid_until = EXCLUDED.valid_until, notes = EXCLUDED.notes, customer_id = EXCLUDED.customer_id, license_id = EXCLUDED.license_id, " +
    "pool_size = EXCLUDED.pool_size, max_active_devices = EXCLUDED.max_active_devices, " +
    "last_applied_order_epoch = EXCLUDED.last_applied_order_epoch, last_applied_order_seq = EXCLUDED.last_applied_order_seq, updated_at = EXCLUDED.updated_at " +
    `WHERE ${FLOOR_PREDICATE_CONFLICT} ` +
    `RETURNING ${ENTITLEMENT_COLUMNS}`;
  return { text, params: pb.params };
}

/** Floor-guarded PATCH (renew / cancel_at_period_end). */
export function pgPatchStatement(key, fields, floor, now) {
  const pb = placeholders();
  const text =
    `UPDATE entitlements SET device_hash = ${pb.bind(fields.device_hash)}, assertion_ttl_seconds = ${pb.bind(fields.assertion_ttl_seconds)}, cache_ttl_seconds = ${pb.bind(fields.assertion_ttl_seconds)}, ${REVOCATION_SEQ_BUMP}, ` +
    `valid_from = ${pb.bind(fields.valid_from)}, valid_until = ${pb.bind(fields.valid_until)}, notes = ${pb.bind(fields.notes)}, customer_id = ${pb.bind(fields.customer_id)}, license_id = ${pb.bind(fields.license_id)}, ` +
    `last_applied_order_epoch = ${pb.bind(floor.epoch)}, last_applied_order_seq = ${pb.bind(floor.seq)}, updated_at = ${pb.bind(now)} ` +
    `WHERE project = ${pb.bind(key.project)} AND feature = ${pb.bind(key.feature)} AND license_fingerprint = ${pb.bind(key.license_fingerprint)} AND ${floorPredicateUpdate(pb, floor)} ` +
    `RETURNING ${ENTITLEMENT_COLUMNS}`;
  return { text, params: pb.params };
}

/** Floor-guarded status TRANSITION (disable / reenable / revoke). */
export function pgTransitionStatement(key, status, floor, now) {
  const pb = placeholders();
  const text =
    `UPDATE entitlements SET status = ${pb.bind(status)}, ${REVOCATION_SEQ_BUMP}, ` +
    `last_applied_order_epoch = ${pb.bind(floor.epoch)}, last_applied_order_seq = ${pb.bind(floor.seq)}, updated_at = ${pb.bind(now)} ` +
    `WHERE project = ${pb.bind(key.project)} AND feature = ${pb.bind(key.feature)} AND license_fingerprint = ${pb.bind(key.license_fingerprint)} AND ${floorPredicateUpdate(pb, floor)} ` +
    `RETURNING ${ENTITLEMENT_COLUMNS}`;
  return { text, params: pb.params };
}

const CAPACITY_COLUMNS = ["max_active_devices", "lease_seconds", "rebind_window_sec", "pool_size", "heartbeat_grace_sec", "max_borrow_sec", "allow_overdraft"];

/** Floor-guarded CAPACITY change (quantity.changed). Writes only the provided non-negative-integer
 *  capacity columns; an empty capacity still advances the floor + bumps revocation_seq (a real order). */
export function pgCapacityStatement(key, capacity, floor, now) {
  const pb = placeholders();
  const assignments = [];
  for (const column of CAPACITY_COLUMNS) {
    const value = capacity?.[column];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      assignments.push(`${column} = ${pb.bind(value)}`);
    }
  }
  const setClause = [
    ...assignments,
    REVOCATION_SEQ_BUMP,
    `last_applied_order_epoch = ${pb.bind(floor.epoch)}`,
    `last_applied_order_seq = ${pb.bind(floor.seq)}`,
    `updated_at = ${pb.bind(now)}`,
  ].join(", ");
  const text =
    `UPDATE entitlements SET ${setClause} ` +
    `WHERE project = ${pb.bind(key.project)} AND feature = ${pb.bind(key.feature)} AND license_fingerprint = ${pb.bind(key.license_fingerprint)} AND ${floorPredicateUpdate(pb, floor)} ` +
    `RETURNING ${ENTITLEMENT_COLUMNS}`;
  return { text, params: pb.params };
}

// =============================================================================
// Step 4 — audit event, seat reclaim, processed-mark, terminal marks.
// =============================================================================

/** Order-ingest audit event — reads the POST-mutation row in the same txn (on a floor no-op it reads
 *  the unchanged row = correct 'superseded' audit). json_object(...) -> json_build_object(...)::text. */
export function pgOrderEventStatement(key, eventType, order, now) {
  const pb = placeholders();
  const text =
    "INSERT INTO entitlement_events (project, feature, license_fingerprint, device_hash, event_type, status, revocation_seq, detail, actor, actor_type, source, request_id, ip, prev_json, next_json, reason, idempotency_key, created_at) " +
    `SELECT project, feature, license_fingerprint, device_hash, ${pb.bind(eventType)}, status, revocation_seq, ${pb.bind(`order:${order.intent}`)}, ${pb.bind(`order:${order.subscription_id}`)}, ${pb.bind(ORDER_ACTOR_TYPE)}, '${ORDER_CTX_SOURCE}', ${pb.bind(order.event_id)}, ${pb.bind("")}, '', ` +
    `json_build_object('project', project, 'feature', feature, 'license_fingerprint', license_fingerprint, 'status', status, 'revocation_seq', revocation_seq, 'valid_from', valid_from, 'valid_until', valid_until, 'pool_size', pool_size, 'id', ${pb.bind(entitlementId(key.project, key.feature, key.license_fingerprint))})::text, ` +
    `${pb.bind(`order:${order.intent}`)}, ${pb.bind(order.event_id)}, ${pb.bind(now)} ` +
    `FROM entitlements WHERE project = ${pb.bind(key.project)} AND feature = ${pb.bind(key.feature)} AND license_fingerprint = ${pb.bind(key.license_fingerprint)}`;
  return { text, params: pb.params };
}

/** Seat reclaim (quantity downgrade): evict the longest-held LIVE seats down to the new pool, in the
 *  SAME txn. rowid -> ctid (safe: SELECT-ctid and DELETE-by-ctid run in one transaction, no intervening
 *  UPDATE to seat_checkouts); max(0, x) -> GREATEST(0, x). Tagged role:'reclaim' so the runner reads its
 *  RETURNING seat_ids. */
export function pgReclaimStatement(key, now, newPool) {
  const pb = placeholders();
  const text =
    "DELETE FROM seat_checkouts WHERE ctid IN (" +
    `SELECT ctid FROM seat_checkouts WHERE project = ${pb.bind(key.project)} AND feature = ${pb.bind(key.feature)} AND license_fingerprint = ${pb.bind(key.license_fingerprint)} AND heartbeat_deadline > ${pb.bind(now)} ` +
    "ORDER BY heartbeat_deadline DESC LIMIT GREATEST(0, " +
    `(SELECT COUNT(*) FROM seat_checkouts WHERE project = ${pb.bind(key.project)} AND feature = ${pb.bind(key.feature)} AND license_fingerprint = ${pb.bind(key.license_fingerprint)} AND heartbeat_deadline > ${pb.bind(now)}) - ${pb.bind(newPool)}` +
    ")) RETURNING seat_id";
  return { text, params: pb.params, role: "reclaim" };
}

/** In-batch processed-mark (status='accepted' guard makes a redrive a no-op). Runs LAST in the txn. */
export function pgProcessedMark(eventId, resultJson, now) {
  const pb = placeholders();
  const text =
    `UPDATE order_events SET status = 'processed', result_json = ${pb.bind(resultJson)}, processed_at = ${pb.bind(now)} ` +
    `WHERE event_id = ${pb.bind(eventId)} AND status = 'accepted' RETURNING event_id`;
  return { text, params: pb.params };
}

/** Terminal disposition mark for the descriptor.kind==='none' branches (never reach a mutator): a
 *  standalone statement run with pool.unsafe (NOT in the apply txn), mirroring D1's `.run()`. status is
 *  a controlled literal ('processed' for no_entitlement => 200, 'rejected' for revoked => 409 on replay). */
export function pgTerminalMark(eventId, terminalStatus, resultJson, now) {
  if (terminalStatus !== "processed" && terminalStatus !== "rejected") {
    throw new Error(`invalid terminal status: ${terminalStatus}`);
  }
  const pb = placeholders();
  const text =
    `UPDATE order_events SET status = '${terminalStatus}', result_json = ${pb.bind(resultJson)}, processed_at = ${pb.bind(now)} ` +
    `WHERE event_id = ${pb.bind(eventId)} AND status = 'accepted'`;
  return { text, params: pb.params };
}

// =============================================================================
// Dispatcher (shape-test convenience) + the transaction runner.
// =============================================================================

/** Assemble the ordered APPLY statement list for a descriptor kind, matching the D1 batch composition
 *  [writeStatement, auditEvent, (reclaim?), processedMark]. 'accept' returns the two-statement ACCEPT
 *  group. Used by the shape test and as the canonical assembly the smoke drives. */
export function orderApplyStatementsFor(kind, args) {
  if (kind === "accept") {
    return pgAcceptBatch(args.order, args.keyId, args.digest, args.rawPayload, args.now);
  }
  const { key, order, floor, now } = args;
  let write;
  let eventType;
  if (kind === "create") {
    write = pgCreateStatement(key, args.fields, floor, now);
    eventType = args.eventType ?? "create";
  } else if (kind === "patch") {
    write = pgPatchStatement(key, args.fields, floor, now);
    eventType = "update";
  } else if (kind === "transition") {
    write = pgTransitionStatement(key, args.status, floor, now);
    eventType = args.eventType ?? "revoke";
  } else if (kind === "capacity") {
    write = pgCapacityStatement(key, args.capacity, floor, now);
    eventType = "update";
  } else {
    throw new Error(`unknown apply kind: ${kind}`);
  }
  const auditEvent = pgOrderEventStatement(key, eventType, order, now);
  const statements = [write, auditEvent];
  if (kind === "capacity" && typeof args.reclaimToPool === "number") {
    statements.push(pgReclaimStatement(key, now, args.reclaimToPool));
  }
  statements.push(pgProcessedMark(order.event_id, args.resultJson ?? "", now));
  return statements;
}

/**
 * Run the ordered APPLY statements as ONE atomic transaction (postgres.js `pool.begin`: implicit BEGIN
 * on entry, COMMIT on return, ROLLBACK on throw — same mechanism entitlement-pg.mjs's runMutation uses).
 *
 * UNLIKE runMutation, this returns the PRIMARY (statement[0]) RETURNING ROW, not result.count, because
 * order-apply branches on whether the floor advanced. A guard-suppressed conflict-update / no-match UPDATE
 * yields an EMPTY RETURNING which is the valid 'superseded' outcome (applied:false) — NEVER read
 * result.count here (pg-mem miscounts a suppressed conflict-update as 1; real PG reports it correctly, but
 * row-presence is the portable, correct signal). Any genuine DB error propagates (rollback => fail-closed
 * write_failed at the caller); an empty primary RETURNING is a normal return value, never a throw.
 *
 * @returns {Promise<{applied: boolean, data: object|null, reclaimedSeats: string[]}>}
 */
export async function runApplyTransaction(pool, statements) {
  return pool.begin(async (sql) => {
    let mutated = null;
    let reclaimedSeats = [];
    for (let i = 0; i < statements.length; ++i) {
      const { text, params, role } = statements[i];
      const result = await sql.unsafe(text, params);
      const rows = Array.from(result);
      if (i === 0) {
        mutated = rows.length > 0 ? rows[0] : null;
      } else if (role === "reclaim") {
        reclaimedSeats = rows.map((row) => row.seat_id);
      }
    }
    return { applied: mutated !== null, data: mutated === null ? null : withId(mutated), reclaimedSeats };
  });
}
