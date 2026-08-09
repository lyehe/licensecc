// Shared D1 entitlement-mutation adapter. Imported by BOTH the licensing-backend Worker
// (order-ingest, Slice 1) and the admin Worker so the two can never drift on how
// an entitlement row + its audit event are written. Worker-safe: no node:/Buffer,
// only Web Crypto + standard globals (btoa/atob/TextEncoder), so it bundles
// identically under wrangler/esbuild and runs raw under `node --test`.
//
import {
  entitlementId,
  withId,
  entitlementMatchesInput,
  syncEventType,
} from "@licensecc/licensing-domain/entitlements/contracts";
import { entitlementCurrentJsonSql } from "./entitlement_json.mjs";

export {
  decodeEntitlementId,
  effectiveLicenseMode,
  entitlementId,
  entitlementMatchesInput,
  syncEventType,
  withId,
} from "@licensecc/licensing-domain/entitlements/contracts";

// --- Shared SQL fragments ----------------------------------------------------
// One source of truth for the column lists and invariants the mutators below
// must keep in lockstep, interpolated into SELECT/RETURNING tails so a column or
// the revocation-floor invariant is defined once, not hand-synced across 3-5 sites.

/** The public entitlement column projection, in storage order. Every SELECT and
 *  RETURNING tail in this module renders exactly these columns. Exported so the
 *  order-ingest apply path (Slice 1) can build its OWN floor-guarded entitlement
 *  statements off the same single source of truth without re-coupling the admin
 *  mutators below — keeping the admin write path byte-identical. */
export const ENTITLEMENT_COLUMNS =
  "project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, policy_id, is_trial, trial_expiration_basis, trial_duration_sec, trial_one_per_device, trial_require_device_proof, trial_started_at, trial_device_hash, max_active_devices, lease_seconds, rebind_window_sec, pool_size, heartbeat_grace_sec, max_borrow_sec, allow_overdraft, meter_quota, meter_period_sec, created_at, updated_at";

/** UPDATE assignment that re-derives the revocation_seq floor from the audit log
 *  and bumps it. Security-relevant (monotonic revocation counter) — keep identical
 *  across every mutator. createEntitlement's ON CONFLICT form differs (it qualifies
 *  columns with `entitlements.`) and is intentionally NOT this constant. Exported
 *  for the order-ingest apply path so its floor-guarded UPDATE/upsert reuses the
 *  exact same monotonic bump rather than re-deriving it. */
export const REVOCATION_SEQ_BUMP =
  "revocation_seq = max(revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events WHERE project = entitlements.project AND feature = entitlements.feature AND license_fingerprint = entitlements.license_fingerprint), revocation_seq)) + 1";

/** Default assertion TTL (seconds) applied when an input omits it. Shared by
 *  createEntitlement and entitlementMatchesInput so the sync no-op check cannot
 *  drift from what createEntitlement actually writes. */
const DEFAULT_ASSERTION_TTL_SECONDS = 300;

/** Canonical public column projection (ENTITLEMENT_COLUMNS); the RETURNING tails
 *  in the mutators must list these same columns in this order. */
export function entitlementSelectSql(where) {
  return `SELECT ${ENTITLEMENT_COLUMNS} FROM entitlements ${where}`;
}

export async function findEntitlement(env, key) {
  const row = await env.DB.prepare(entitlementSelectSql("WHERE project = ? AND feature = ? AND license_fingerprint = ? LIMIT 1"))
    .bind(key.project, key.feature, key.license_fingerprint)
    .first();
  return row === null ? null : withId(row);
}

export function idempotencyFromCurrentStatement(
  env,
  ctx,
  key,
  idempotency,
  now,
) {
  if (ctx.idempotencyKey === null || idempotency === null) {
    return null;
  }
  return env.DB.prepare(
    // This deliberately has NO conflict handler. A collection-level
    // idempotency key is the final claim in the mutation batch: if another
    // tuple published the key after this request's replay pre-read, the UNIQUE
    // violation aborts and rolls back this write, its side statements, and its
    // audit row together. `INSERT OR IGNORE` would instead let both tuples
    // commit while silently keeping only the first response. The committed
    // response is selected by the next (read-only) batch statement; avoiding
    // INSERT...RETURNING here keeps this exact D1 statement usable by the
    // local Wrangler SQL execution gate too.
    `INSERT INTO mutation_idempotency (scope, idempotency_key, response_json, created_at)
     SELECT ?, ?,
       json_object(
         'ok', json('true'),
         'code', ?,
         'request_id', ?,
         'data', ${entitlementCurrentJsonSql("", "?")}
       ),
       ?
     FROM entitlements
     WHERE project = ? AND feature = ? AND license_fingerprint = ?
       AND changes() = 1`,
  ).bind(
    idempotency.scope,
    ctx.idempotencyKey,
    idempotency.responseCode,
    ctx.requestId,
    entitlementId(key.project, key.feature, key.license_fingerprint),
    now,
    key.project,
    key.feature,
    key.license_fingerprint,
  );
}

function idempotencyResponseFromCurrentStatement(env, ctx, idempotency) {
  if (ctx.idempotencyKey === null || idempotency === null) {
    return null;
  }
  // `changes()` is the strict INSERT's count. A successful claim has exactly
  // one immutable response row; a zero-row claim must not read a pre-existing
  // response as if this mutation had published it.
  return env.DB.prepare(
    "SELECT response_json FROM mutation_idempotency WHERE scope = ? AND idempotency_key = ? AND changes() = 1 LIMIT 1",
  ).bind(idempotency.scope, ctx.idempotencyKey);
}

export function eventFromCurrentStatement(
  env,
  ctx,
  eventType,
  key,
  prev,
  reason,
  now,
) {
  const source = ctx.source === "sync" ? "sync" : "admin";
  return env.DB.prepare(
    `INSERT INTO entitlement_events (project, feature, license_fingerprint, device_hash, event_type, status, revocation_seq, detail, actor, actor_type, source, request_id, ip, prev_json, next_json, reason, idempotency_key, created_at)
     SELECT project, feature, license_fingerprint, device_hash, ?, status, revocation_seq, ?, ?, ?, '${source}', ?, ?, ?,
       ${entitlementCurrentJsonSql("", "?", { includeCacheTtl: true })},
       ?, ?, ?
     FROM entitlements
     WHERE project = ? AND feature = ? AND license_fingerprint = ?
       AND changes() = 1`,
  ).bind(
    eventType,
    reason,
    ctx.actor.email || ctx.actor.subject,
    ctx.actor.actorType,
    ctx.requestId,
    ctx.ip,
    prev === null ? "" : JSON.stringify(prev),
    entitlementId(key.project, key.feature, key.license_fingerprint),
    reason,
    ctx.idempotencyKey,
    now,
    key.project,
    key.feature,
    key.license_fingerprint,
  );
}

export function batchReturnedRow(result) {
  if (typeof result !== "object" || result === null || !("results" in result)) {
    return null;
  }
  const rows = result.results;
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  return rows[0];
}

function idempotencyConflict(error) {
  const message = error instanceof Error ? error.message : String(error);
  // D1 includes the failing table in its SQLite constraint error. Limit this
  // mapping to the replay table so an unrelated integrity failure remains a
  // normal write failure instead of accidentally replaying a stale response.
  return /mutation_idempotency/i.test(message) && /(?:unique|constraint)/i.test(message);
}

function cachedMutationData(result) {
  const row = batchReturnedRow(result);
  if (row === null || typeof row.response_json !== "string") {
    throw new Error("write_failed");
  }
  try {
    const body = JSON.parse(row.response_json);
    if (body === null || typeof body !== "object" || Array.isArray(body) || !("data" in body)) {
      throw new Error("invalid_cached_response");
    }
    return body.data;
  } catch {
    throw new Error("write_failed");
  }
}

function finalSnapshotStatement(env, key) {
  // `changes()` is still the event INSERT's change count. This makes the
  // snapshot contingent on a successful audited write, while keeping the
  // returned row in the same transactional batch as any policy/device side
  // statement. Never reread after commit: another request may have changed the
  // row before the caller receives its initial success body.
  return env.DB.prepare(
    `${entitlementSelectSql("WHERE project = ? AND feature = ? AND license_fingerprint = ? AND changes() = 1")}`,
  ).bind(key.project, key.feature, key.license_fingerprint);
}

export async function writeEntitlementWithAudit(
  env,
  key,
  writeStatement,
  ctx,
  eventType,
  prev,
  reason,
  now,
  idempotency,
  extraStatements = [],
  { allowNoWrite = false } = {},
) {
  // INVARIANT: the entitlement write, its audit event, and any idempotency record MUST commit atomically.
  // Real Cloudflare D1 always exposes batch(); a missing batch() means a degraded or mocked binding, so we
  // fail closed rather than perform two un-transactioned writes (which could persist a row with no audit
  // event). Do NOT add a non-batch fallback here.
  if (env.DB.batch === undefined) {
    throw new Error("write_failed");
  }
  const statements = [writeStatement];
  // Extra statements (policy/capacity/trial stamps, device status writes) must run before the audit
  // and idempotency projections so those records describe the final committed state, not only the
  // row returned by the first INSERT/UPDATE. They must themselves carry `changes() = 1` in their
  // WHERE predicate: the first guarded write is the batch claim, so a loser must not make an extra
  // write which could otherwise make the later audit/idempotency INSERTs appear successful.
  for (const extra of extraStatements) {
    statements.push(extra);
  }
  statements.push(eventFromCurrentStatement(env, ctx, eventType, key, prev, reason, now));
  const idempotencyStatement = idempotencyFromCurrentStatement(env, ctx, key, idempotency, now);
  let idempotencyResultIndex = -1;
  let finalSnapshotResultIndex = -1;
  if (idempotencyStatement !== null) {
    statements.push(idempotencyStatement);
    idempotencyResultIndex = statements.length;
    statements.push(idempotencyResponseFromCurrentStatement(env, ctx, idempotency));
  } else if (extraStatements.length > 0) {
    finalSnapshotResultIndex = statements.length;
    statements.push(finalSnapshotStatement(env, key));
  }
  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    if (idempotencyStatement !== null && idempotencyConflict(error)) {
      // The losing transaction was fully rolled back by D1. The admin wrapper
      // rereads the now-authoritative winner cache and returns it as a replay.
      throw new Error("idempotency_conflict");
    }
    throw error;
  }
  const saved = batchReturnedRow(results[0]);
  if (saved === null) {
    if (allowNoWrite) {
      return null;
    }
    throw new Error("write_failed");
  }
  if (idempotencyResultIndex >= 0) {
    // Return the exact payload source that was committed under the replay key.
    // mutationResponse rebuilds the outer envelope in the same field order, so
    // an initial response and a later replay are byte-for-byte stable even if a
    // new mutation commits immediately after this batch.
    return { data: cachedMutationData(results[idempotencyResultIndex]), idempotencyRecorded: true };
  }
  if (finalSnapshotResultIndex >= 0) {
    const finalRow = batchReturnedRow(results[finalSnapshotResultIndex]);
    if (finalRow === null) {
      throw new Error("write_failed");
    }
    return { data: withId(finalRow), idempotencyRecorded: false };
  }
  return { data: withId(saved), idempotencyRecorded: false };
}

async function classifyEntitlementGuardMiss(env, key) {
  const current = await findEntitlement(env, key);
  if (current === null) {
    // The initial read found the row. A later absence is therefore a concurrent
    // change, not the ordinary initial 404 path.
    throw new Error("stale_transition");
  }
  if (current.status === "revoked") {
    throw new Error("revoked_terminal");
  }
  throw new Error("stale_transition");
}

async function classifyEntitlementTransitionGuardMiss(env, key, targetStatus, eventType) {
  const current = await findEntitlement(env, key);
  if (current === null) {
    throw new Error("stale_transition");
  }
  if (current.status === targetStatus) {
    // A concurrent request already reached the same target. It is a no-op from the
    // caller's perspective, but it did not write a second seq/audit/idempotency row.
    return { data: current, idempotencyRecorded: false };
  }
  if (current.status === "revoked" && eventType !== "revoke") {
    throw new Error("revoked_terminal");
  }
  throw new Error("stale_transition");
}

async function classifyDeviceTransitionGuardMiss(env, key, deviceKeyId, targetStatus) {
  const current = await findEntitlement(env, key);
  if (current === null) {
    throw new Error("stale_transition");
  }
  const device = await env.DB.prepare(
    "SELECT status FROM entitlement_devices WHERE project = ? AND feature = ? AND license_fingerprint = ? AND device_key_id = ? LIMIT 1",
  )
    .bind(key.project, key.feature, key.license_fingerprint, deviceKeyId)
    .first();
  if (device === null) {
    // Like a deleted parent, this device existed at the initial read and was
    // removed by a concurrent writer before the guarded batch could claim it.
    throw new Error("stale_transition");
  }
  if (device.status === targetStatus) {
    return { data: current, idempotencyRecorded: false };
  }
  if (device.status === "revoked" && targetStatus !== "revoked") {
    throw new Error("device_revoked_terminal");
  }
  throw new Error("stale_transition");
}

export async function createEntitlement(
  env,
  input,
  ctx,
  reason = "",
  eventTypeOverride,
  idempotency = null,
  extraStatements = [],
) {
  const now = Math.floor(Date.now() / 1000);
  const prev = await findEntitlement(env, input);
  if (prev?.status === "revoked") {
    throw new Error("revoked_terminal");
  }
  const statement = env.DB.prepare(
    // The conflict-update is an optimistic CAS against the row this invocation
    // observed.  A concurrent writer must not be overwritten merely because it
    // landed between findEntitlement() and this batch.  When the observation was
    // "missing", a concurrent insert instead returns no row (never an implicit
    // update of an unknown newer entitlement).
    `INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(revocation_seq) + 1 FROM entitlement_events WHERE project = ? AND feature = ? AND license_fingerprint = ?), 1), ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project, feature, license_fingerprint) DO UPDATE SET device_hash = excluded.device_hash, status = excluded.status, assertion_ttl_seconds = excluded.assertion_ttl_seconds, cache_ttl_seconds = excluded.cache_ttl_seconds, revocation_seq = max(entitlements.revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events WHERE project = entitlements.project AND feature = entitlements.feature AND license_fingerprint = entitlements.license_fingerprint), entitlements.revocation_seq)) + 1, valid_from = excluded.valid_from, valid_until = excluded.valid_until, notes = excluded.notes, customer_id = excluded.customer_id, license_id = excluded.license_id, updated_at = excluded.updated_at WHERE ? IS NOT NULL AND entitlements.status = ? AND entitlements.revocation_seq = ? RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(
    input.project,
    input.feature,
    input.license_fingerprint,
    input.device_hash ?? "",
    input.status ?? "active",
    input.assertion_ttl_seconds ?? DEFAULT_ASSERTION_TTL_SECONDS,
    input.assertion_ttl_seconds ?? DEFAULT_ASSERTION_TTL_SECONDS,
    input.project,
    input.feature,
    input.license_fingerprint,
    input.valid_from ?? null,
    input.valid_until ?? null,
    input.notes ?? "",
    input.customer_id ?? null,
    input.license_id ?? null,
    prev?.created_at ?? now,
    now,
    prev === null ? null : 1,
    prev?.status ?? "",
    prev?.revocation_seq ?? -1,
  );
  const result = await writeEntitlementWithAudit(
    env,
    input,
    statement,
    ctx,
    eventTypeOverride ?? (prev === null ? "create" : "update"),
    prev,
    reason,
    now,
    idempotency,
    // Optional extra statements committed in the SAME atomic batch as the INSERT (e.g. the policy
    // capacity/trial/provenance stamp). Default [] keeps every existing caller byte-identical.
    extraStatements,
    { allowNoWrite: true },
  );
  if (result !== null) {
    return result;
  }
  return classifyEntitlementGuardMiss(env, input);
}

export async function patchEntitlement(env, key, patch, ctx, idempotency) {
  const prev = await findEntitlement(env, key);
  if (prev === null) {
    return null;
  }
  if (prev.status === "revoked") {
    throw new Error("revoked_terminal");
  }
  const assertionTtl = patch.assertion_ttl_seconds ?? prev.assertion_ttl_seconds;
  const validFrom = patch.valid_from !== undefined ? patch.valid_from : prev.valid_from;
  const validUntil = patch.valid_until !== undefined ? patch.valid_until : prev.valid_until;
  if (validFrom !== null && validUntil !== null && validFrom >= validUntil) {
    throw new Error("invalid_patch");
  }
  const now = Math.floor(Date.now() / 1000);
  const statement = env.DB.prepare(
    `UPDATE entitlements SET device_hash = ?, assertion_ttl_seconds = ?, cache_ttl_seconds = ?, ${REVOCATION_SEQ_BUMP}, valid_from = ?, valid_until = ?, notes = ?, customer_id = ?, license_id = ?, updated_at = ? WHERE project = ? AND feature = ? AND license_fingerprint = ? AND status = ? AND revocation_seq = ? RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(
    patch.device_hash ?? prev.device_hash,
    assertionTtl,
    assertionTtl,
    validFrom,
    validUntil,
    patch.notes ?? prev.notes,
    patch.customer_id !== undefined ? patch.customer_id : prev.customer_id,
    patch.license_id !== undefined ? patch.license_id : prev.license_id,
    now,
    key.project,
    key.feature,
    key.license_fingerprint,
    prev.status,
    prev.revocation_seq,
  );
  const result = await writeEntitlementWithAudit(env, key, statement, ctx, "update", prev, "", now, idempotency, [], { allowNoWrite: true });
  if (result !== null) {
    return result;
  }
  return classifyEntitlementGuardMiss(env, key);
}

export async function transitionEntitlement(env, key, status, eventType, reason, ctx, idempotency) {
  const prev = await findEntitlement(env, key);
  if (prev === null) {
    return null;
  }
  if (prev.status === "revoked" && eventType !== "revoke") {
    throw new Error("revoked_terminal");
  }
  if (prev.status === status) {
    return { data: prev, idempotencyRecorded: false };
  }
  const now = Math.floor(Date.now() / 1000);
  const statement = env.DB.prepare(
    `UPDATE entitlements SET status = ?, ${REVOCATION_SEQ_BUMP}, updated_at = ? WHERE project = ? AND feature = ? AND license_fingerprint = ? AND status = ? AND revocation_seq = ? RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(status, now, key.project, key.feature, key.license_fingerprint, prev.status, prev.revocation_seq);
  const result = await writeEntitlementWithAudit(env, key, statement, ctx, eventType, prev, reason, now, idempotency, [], { allowNoWrite: true });
  if (result !== null) {
    return result;
  }
  return classifyEntitlementTransitionGuardMiss(env, key, status, eventType);
}

// List the registered device keys for an entitlement (relay-resistance devices, table
// entitlement_devices). Read-only; newest-touched first. Mirrors the CLI `device-list`.
export async function listEntitlementDevices(env, key) {
  const result = await env.DB.prepare(
    "SELECT project, feature, license_fingerprint, device_key_id, status, created_at, updated_at, last_seen_at, notes FROM entitlement_devices WHERE project = ? AND feature = ? AND license_fingerprint = ? ORDER BY updated_at DESC LIMIT 200",
  )
    .bind(key.project, key.feature, key.license_fingerprint)
    .all();
  return Array.isArray(result?.results) ? result.results : [];
}

function shortDeviceKeyId(deviceKeyId) {
  if (deviceKeyId.startsWith("sha256:") && deviceKeyId.length >= 15) {
    return `sha256:${deviceKeyId.slice(7, 15)}...`;
  }
  return deviceKeyId.length > 12 ? `${deviceKeyId.slice(0, 12)}...` : deviceKeyId;
}

// Transition ONE device key of an entitlement (revoke/disable/reenable) — the admin-console equivalent
// of the CLI `device-revoke`/`device-disable`. Atomic (D1 batch, via writeEntitlementWithAudit): the
// device status UPDATE, the entitlement revocation_seq bump (so cached online assertions are
// invalidated on the next check), and the audit event all commit together. Mirrors the CLI exactly:
// the audit row uses the constraint-safe event_type 'update' with a `device-<action> <keyId>: <reason>`
// detail (entitlement_events.event_type has no device-specific value). Returns null when the
// ENTITLEMENT does not exist; throws 'device_not_found' when the entitlement exists but the device key
// does not, and 'device_revoked_terminal' when trying to move a revoked device to a non-revoked status.
export async function transitionEntitlementDevice(env, key, deviceKeyId, deviceStatus, reason, ctx, idempotency) {
  const prev = await findEntitlement(env, key);
  if (prev === null) {
    return null;
  }
  const device = await env.DB.prepare(
    "SELECT status FROM entitlement_devices WHERE project = ? AND feature = ? AND license_fingerprint = ? AND device_key_id = ? LIMIT 1",
  )
    .bind(key.project, key.feature, key.license_fingerprint, deviceKeyId)
    .first();
  if (device === null) {
    throw new Error("device_not_found");
  }
  if (device.status === "revoked" && deviceStatus !== "revoked") {
    throw new Error("device_revoked_terminal");
  }
  if (device.status === deviceStatus) {
    // Idempotent no-op: no status change, so no revocation_seq bump and no audit event.
    return { data: prev, idempotencyRecorded: false };
  }
  const now = Math.floor(Date.now() / 1000);
  const action = deviceStatus === "revoked" ? "device-revoke" : deviceStatus === "disabled" ? "device-disable" : "device-reenable";
  const detail = `${action} ${shortDeviceKeyId(deviceKeyId)}${reason === "" ? "" : `: ${reason}`}`;
  // The entitlement write is a pure revocation_seq bump (status unchanged); RETURNING feeds the
  // audit event's SELECT and the response row. The device UPDATE rides in the SAME atomic batch.
  // Both rows are compared with the exact observation made above. The parent claim also requires
  // the observed device status, and the device write inherits that claim through changes() = 1.
  // D1 batch statements are sequential and transactional, so no other write can enter between
  // these two guarded statements; a loser executes no parent/device/event/idempotency write.
  const writeStatement = env.DB.prepare(
    `UPDATE entitlements SET ${REVOCATION_SEQ_BUMP}, updated_at = ? WHERE project = ? AND feature = ? AND license_fingerprint = ? AND status = ? AND revocation_seq = ? AND EXISTS (SELECT 1 FROM entitlement_devices WHERE project = ? AND feature = ? AND license_fingerprint = ? AND device_key_id = ? AND status = ?) RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(now, key.project, key.feature, key.license_fingerprint, prev.status, prev.revocation_seq, key.project, key.feature, key.license_fingerprint, deviceKeyId, device.status);
  const deviceStatement = env.DB.prepare(
    "UPDATE entitlement_devices SET status = ?, updated_at = ? WHERE project = ? AND feature = ? AND license_fingerprint = ? AND device_key_id = ? AND status = ? AND changes() = 1",
  ).bind(deviceStatus, now, key.project, key.feature, key.license_fingerprint, deviceKeyId, device.status);
  const result = await writeEntitlementWithAudit(env, key, writeStatement, ctx, "update", prev, detail, now, idempotency, [deviceStatement], { allowNoWrite: true });
  if (result !== null) {
    return result;
  }
  return classifyDeviceTransitionGuardMiss(env, key, deviceKeyId, deviceStatus);
}

export async function syncEntitlement(env, input, reason, ctx, idempotency) {
  const key = {
    project: input.project,
    feature: input.feature,
    license_fingerprint: input.license_fingerprint,
  };
  const prev = await findEntitlement(env, key);
  if (prev !== null && entitlementMatchesInput(prev, input)) {
    return { data: prev, idempotencyRecorded: false };
  }
  const targetStatus = input.status ?? "active";
  if (prev?.status === "revoked" && targetStatus === "revoked") {
    return { data: prev, idempotencyRecorded: false };
  }
  return createEntitlement(env, input, ctx, reason, syncEventType(prev, targetStatus), idempotency);
}

// The seat/device capacity + metering-quota columns this module is allowed to write.
// Deliberately disjoint from createEntitlement's INSERT...ON CONFLICT column set: those
// are owned by the lease/seat subsystem and must not be clobbered on an admin upsert.
// setEntitlementCapacity is the single chokepoint for quantity changes (Slice 1
// order-ingest) so capacity can be moved without touching the entitlement body.
// meter_quota / meter_period_sec (audit R6.3) live here so a per-period consumption
// quota is CONFIGURABLE through the supported capacity path (order-ingest / admin),
// not just via raw SQL; both are non-negative integers (meterUsage treats a 0/absent
// period_sec as the 30d default), so isNonNegativeInteger validates them unchanged.
const CAPACITY_COLUMNS = new Set([
  "max_active_devices",
  "lease_seconds",
  "rebind_window_sec",
  "pool_size",
  "heartbeat_grace_sec",
  "max_borrow_sec",
  "allow_overdraft",
  "meter_quota",
  "meter_period_sec",
]);

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Update ONLY the seat/device capacity columns provided in `capacity` on an
 * EXISTING entitlement, preserving every other column (including the entitlement
 * body that createEntitlement owns). Bumps revocation_seq and writes an audit row
 * atomically. Returns null if the entitlement does not exist; throws
 * "revoked_terminal" if it is revoked. Unknown keys and keys whose value is not a
 * finite non-negative integer are ignored.
 */
export async function setEntitlementCapacity(env, key, capacity, ctx, idempotency = null) {
  const prev = await findEntitlement(env, key);
  if (prev === null) {
    return null;
  }
  if (prev.status === "revoked") {
    throw new Error("revoked_terminal");
  }
  const assignments = [];
  const values = [];
  const source = capacity ?? {};
  for (const column of CAPACITY_COLUMNS) {
    const value = source[column];
    if (value === undefined) {
      continue;
    }
    if (!isNonNegativeInteger(value)) {
      continue;
    }
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (assignments.length === 0) {
    // Nothing valid to change; surface the current row without writing an audit event.
    return { data: prev, idempotencyRecorded: false };
  }
  const now = Math.floor(Date.now() / 1000);
  const setClause = [
    ...assignments,
    REVOCATION_SEQ_BUMP,
    "updated_at = ?",
  ].join(", ");
  const statement = env.DB.prepare(
    `UPDATE entitlements SET ${setClause} WHERE project = ? AND feature = ? AND license_fingerprint = ? AND status = ? AND revocation_seq = ? RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(
    ...values,
    now,
    key.project,
    key.feature,
    key.license_fingerprint,
    prev.status,
    prev.revocation_seq,
  );
  const result = await writeEntitlementWithAudit(env, key, statement, ctx, "update", prev, "", now, idempotency, [], { allowNoWrite: true });
  if (result !== null) {
    return result;
  }
  return classifyEntitlementGuardMiss(env, key);
}
