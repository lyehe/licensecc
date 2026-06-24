// Shared entitlement-mutation core. Imported by BOTH the licensing-backend Worker
// (order-ingest, Slice 1) and the admin Worker so the two can never drift on how
// an entitlement row + its audit event are written. Worker-safe: no node:/Buffer,
// only Web Crypto + standard globals (btoa/atob/TextEncoder), so it bundles
// identically under wrangler/esbuild and runs raw under `node --test`.
//
// Consumed cross-package via the backend package's `exports` map
// (`@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation`);
// the co-located .d.ts supplies types to the admin's tsc.

/**
 * Stable, URL-safe-base64 id for an entitlement's composite primary key
 * (project, feature, license_fingerprint). Inverse of decodeEntitlementId.
 */
export function entitlementId(project, feature, licenseFingerprint) {
  const raw = JSON.stringify([project, feature, licenseFingerprint]);
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Decode an entitlementId() back to its key, or null if malformed.
 */
export function decodeEntitlementId(id) {
  try {
    const padded = id.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(id.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 3) {
      return null;
    }
    const [project, feature, licenseFingerprint] = parsed;
    if (typeof project !== "string" || typeof feature !== "string" || typeof licenseFingerprint !== "string") {
      return null;
    }
    return { project, feature, license_fingerprint: licenseFingerprint };
  } catch {
    return null;
  }
}

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
  "project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, created_at, updated_at";

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

/**
 * Re-attach the derived `id` to a freshly-read/written entitlement row, stripping
 * the internal-only cache_ttl_seconds column from the public shape.
 */
export function withId(row) {
  const publicRow = { ...row };
  delete publicRow.cache_ttl_seconds;
  return {
    ...publicRow,
    id: entitlementId(row.project, row.feature, row.license_fingerprint),
  };
}

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
    `INSERT OR IGNORE INTO mutation_idempotency (scope, idempotency_key, response_json, created_at)
     SELECT ?, ?,
       json_object(
         'ok', json('true'),
         'code', ?,
         'request_id', ?,
         'data', json_object(
           'project', project,
           'feature', feature,
           'license_fingerprint', license_fingerprint,
           'device_hash', device_hash,
           'status', status,
           'assertion_ttl_seconds', assertion_ttl_seconds,
           'revocation_seq', revocation_seq,
           'valid_from', valid_from,
           'valid_until', valid_until,
           'notes', notes,
           'customer_id', customer_id,
           'license_id', license_id,
           'created_at', created_at,
           'updated_at', updated_at,
           'id', ?
         )
       ),
       ?
     FROM entitlements
     WHERE project = ? AND feature = ? AND license_fingerprint = ?`,
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
       json_object(
         'project', project,
         'feature', feature,
         'license_fingerprint', license_fingerprint,
         'device_hash', device_hash,
         'status', status,
         'assertion_ttl_seconds', assertion_ttl_seconds,
         'cache_ttl_seconds', cache_ttl_seconds,
         'revocation_seq', revocation_seq,
         'valid_from', valid_from,
         'valid_until', valid_until,
         'notes', notes,
         'customer_id', customer_id,
         'license_id', license_id,
         'created_at', created_at,
         'updated_at', updated_at,
         'id', ?
       ),
       ?, ?, ?
     FROM entitlements
     WHERE project = ? AND feature = ? AND license_fingerprint = ?`,
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
) {
  // INVARIANT: the entitlement write, its audit event, and any idempotency record MUST commit atomically.
  // Real Cloudflare D1 always exposes batch(); a missing batch() means a degraded or mocked binding, so we
  // fail closed rather than perform two un-transactioned writes (which could persist a row with no audit
  // event). Do NOT add a non-batch fallback here.
  if (env.DB.batch === undefined) {
    throw new Error("write_failed");
  }
  const statements = [
    writeStatement,
    eventFromCurrentStatement(env, ctx, eventType, key, prev, reason, now),
  ];
  const idempotencyStatement = idempotencyFromCurrentStatement(env, ctx, key, idempotency, now);
  if (idempotencyStatement !== null) {
    statements.push(idempotencyStatement);
  }
  // extraStatements (default []) are committed in the SAME transaction as the
  // entitlement write + audit event. Admin callers never pass any, so their batch
  // is byte-identical to before; the order-ingest apply path passes its in-batch
  // `order_events` processed-mark here so the mutation and the mark are atomic
  // (the exactly-once guarantee). The mark runs AFTER the entitlement write, so the
  // floor's no-op (a stale re-apply) still marks the event processed.
  for (const extra of extraStatements) {
    statements.push(extra);
  }
  const results = await env.DB.batch(statements);
  const saved = batchReturnedRow(results[0]);
  if (saved === null) {
    throw new Error("write_failed");
  }
  return { data: withId(saved), idempotencyRecorded: idempotencyStatement !== null };
}

export async function createEntitlement(
  env,
  input,
  ctx,
  reason = "",
  eventTypeOverride,
  idempotency = null,
) {
  const now = Math.floor(Date.now() / 1000);
  const prev = await findEntitlement(env, input);
  if (prev?.status === "revoked") {
    throw new Error("revoked_terminal");
  }
  const statement = env.DB.prepare(
    `INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(revocation_seq) + 1 FROM entitlement_events WHERE project = ? AND feature = ? AND license_fingerprint = ?), 1), ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project, feature, license_fingerprint) DO UPDATE SET device_hash = excluded.device_hash, status = excluded.status, assertion_ttl_seconds = excluded.assertion_ttl_seconds, cache_ttl_seconds = excluded.cache_ttl_seconds, revocation_seq = max(entitlements.revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events WHERE project = entitlements.project AND feature = entitlements.feature AND license_fingerprint = entitlements.license_fingerprint), entitlements.revocation_seq)) + 1, valid_from = excluded.valid_from, valid_until = excluded.valid_until, notes = excluded.notes, customer_id = excluded.customer_id, license_id = excluded.license_id, updated_at = excluded.updated_at RETURNING ${ENTITLEMENT_COLUMNS}`,
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
  );
  return writeEntitlementWithAudit(
    env,
    input,
    statement,
    ctx,
    eventTypeOverride ?? (prev === null ? "create" : "update"),
    prev,
    reason,
    now,
    idempotency,
  );
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
    `UPDATE entitlements SET device_hash = ?, assertion_ttl_seconds = ?, cache_ttl_seconds = ?, ${REVOCATION_SEQ_BUMP}, valid_from = ?, valid_until = ?, notes = ?, customer_id = ?, license_id = ?, updated_at = ? WHERE project = ? AND feature = ? AND license_fingerprint = ? RETURNING ${ENTITLEMENT_COLUMNS}`,
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
  );
  return writeEntitlementWithAudit(env, key, statement, ctx, "update", prev, "", now, idempotency);
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
    `UPDATE entitlements SET status = ?, ${REVOCATION_SEQ_BUMP}, updated_at = ? WHERE project = ? AND feature = ? AND license_fingerprint = ? RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(status, now, key.project, key.feature, key.license_fingerprint);
  return writeEntitlementWithAudit(env, key, statement, ctx, eventType, prev, reason, now, idempotency);
}

export function entitlementMatchesInput(row, input) {
  return row.device_hash === (input.device_hash ?? "") &&
    row.status === (input.status ?? "active") &&
    row.assertion_ttl_seconds === (input.assertion_ttl_seconds ?? DEFAULT_ASSERTION_TTL_SECONDS) &&
    row.valid_from === (input.valid_from ?? null) &&
    row.valid_until === (input.valid_until ?? null) &&
    row.notes === (input.notes ?? "") &&
    row.customer_id === (input.customer_id ?? null) &&
    row.license_id === (input.license_id ?? null);
}

export function syncEventType(prev, targetStatus) {
  if (targetStatus === "revoked") {
    return "revoke";
  }
  if (prev === null) {
    return targetStatus === "disabled" ? "disable" : "create";
  }
  if (prev.status !== targetStatus) {
    return targetStatus === "disabled" ? "disable" : "reenable";
  }
  return "update";
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

// The seat/device capacity columns this module is allowed to write. Deliberately
// disjoint from createEntitlement's INSERT...ON CONFLICT column set: those are
// owned by the lease/seat subsystem and must not be clobbered on an admin upsert.
// setEntitlementCapacity is the single chokepoint for quantity changes (Slice 1
// order-ingest) so capacity can be moved without touching the entitlement body.
const CAPACITY_COLUMNS = new Set([
  "max_active_devices",
  "lease_seconds",
  "rebind_window_sec",
  "pool_size",
  "heartbeat_grace_sec",
  "max_borrow_sec",
  "allow_overdraft",
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
    `UPDATE entitlements SET ${setClause} WHERE project = ? AND feature = ? AND license_fingerprint = ? RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(
    ...values,
    now,
    key.project,
    key.feature,
    key.license_fingerprint,
  );
  return writeEntitlementWithAudit(env, key, statement, ctx, "update", prev, "", now, idempotency);
}
