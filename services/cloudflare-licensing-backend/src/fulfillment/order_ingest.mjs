// Slice 1 order-ingest HTTP core (POST /v1/orders) — the exactly-once accept/apply
// flow. Worker-safe: no node:/Buffer, only Web Crypto (crypto.subtle) + standard
// globals; bundles identically under wrangler/esbuild and runs raw under
// `node --test` (the integration test drives these functions against real SQLite).
//
// This module wires the PURE order-event modeling (order_event.mjs) and HMAC verify
// (order_hmac.mjs) into the durable, monotone, atomic accept→apply pipeline. The two
// structural hardenings from the blueprint are realized HERE:
//   1. apply-time monotonic floor (last_applied_order_{epoch,seq}) + in-batch
//      order_events processed-mark (exactly-once; kills accept-vs-apply race,
//      revocation_seq double-bump, seat-reclaim RMW loss);
//   2. fingerprint ownership invariant (a fingerprint belongs to exactly one
//      subscription) — the Step-2 409 fingerprint_owned guard.
//
// The apply path builds its OWN floor-guarded entitlement statements off the shared
// ENTITLEMENT_COLUMNS / REVOCATION_SEQ_BUMP (single source of truth) so the admin
// mutators (createEntitlement/patchEntitlement/transitionEntitlement/
// setEntitlementCapacity) stay byte-identical — admin's 43 tests must not move.
//
// Design: docs/superpowers/plans/2026-06-24-slice1-order-ingest-blueprint.md

import {
  normalizeOrderEventForReplay,
  orderPeriodIsAcceptable,
  deriveFingerprint,
  clampValidUntil,
  mapIntentToMutation,
} from "./order_event.mjs";
import { verifyOrderHmac } from "./order_hmac.mjs";
import {
  buildOrderCursorAdvance,
  buildOrderLicenseReservation,
  establishOrderIdentity,
  materializeOrderAuxiliaryIdentities,
  orderIdentityConflictsAfterFailedAccept,
} from "./order_identity_store.mjs";
import {
  buildRevokedOrderEventMark,
  claimStaleOrderOutcome,
  loadTerminalOrderOutcome,
  resultBody,
  terminalizeDefensiveNoEntitlement,
  terminalizeInvalidOrderEvent,
  terminalizeMissingEntitlementOrderEvent,
  terminalizeRevokedOrderEvent,
} from "./order_result_store.mjs";
import { parseOrderSignerScopeMode } from "../security_modes.mjs";
import {
  ENTITLEMENT_COLUMNS,
  REVOCATION_SEQ_BUMP,
  findEntitlement,
  withId,
  entitlementId,
} from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
// 16 KiB raw-body ceiling (blueprint MAX_ORDER_BODY_BYTES). Enforced over the exact
// stream bytes before any decoding; never re-stringify a parsed object.
export const MAX_ORDER_BODY_BYTES = 16384;
const DEFAULT_ASSERTION_TTL_SECONDS = 300;
// Default seat capacity (pool_size) used when materializing a fresh entitlement from
// a subscription.active order that carries a quantity. createEntitlement does NOT own
// the capacity columns (they default in the schema), so a create with quantity sets
// pool_size on the INSERT path explicitly below.
// --- small helpers (self-contained; Worker-safe) -----------------------------
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const textEncoder = new TextEncoder();

function bytesToHex(bytes) {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** SHA-256 hex over exact bytes. */
async function sha256BytesHex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

/** SHA-256 hex of a string (used for the normalized payload digest). */
async function sha256Hex(text) {
  return sha256BytesHex(textEncoder.encode(text));
}

async function cancelBody(body) {
  try {
    await body.cancel();
  } catch {
    // The rejection is already determined; cancellation is a resource cleanup only.
  }
}

/**
 * Read one bounded order body as original bytes. Content-Length is an inexpensive
 * early rejection when truthful, but the stream count is authoritative so a missing
 * or lying value can never force an unbounded read. On actual overflow the reader is
 * cancelled before returning.
 *
 * @param {Request} request
 * @returns {Promise<{ ok: true, bytes: Uint8Array } | { ok: false, code: "payload_too_large" | "invalid_order" }>}
 */
async function readOrderBodyBytes(request) {
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isInteger(contentLength) && contentLength > MAX_ORDER_BODY_BYTES) {
    if (request.body !== null) await cancelBody(request.body);
    return { ok: false, code: "payload_too_large" };
  }
  if (request.body === null) {
    return { ok: true, bytes: new Uint8Array(0) };
  }

  let reader;
  try {
    reader = request.body.getReader();
  } catch {
    return { ok: false, code: "invalid_order" };
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > MAX_ORDER_BODY_BYTES) {
        await cancelBody(reader);
        return { ok: false, code: "payload_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    await cancelBody(reader);
    return { ok: false, code: "invalid_order" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** @returns {{ ok: true, text: string } | { ok: false }} */
function decodeOrderUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false };
  }
}

/** Stable digest over the NORMALIZED order (NOT the ts-bearing signed bytes), so two
 *  re-sends of the same logical event with different timestamps collide on event_id
 *  WITHOUT being flagged as a payload conflict. Canonical JSON: sorted keys. */
async function payloadDigest(order) {
  return sha256Hex(stableStringify(order));
}

/** Deterministic JSON: object keys sorted recursively. Arrays keep order. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${parts.join(",")}}`;
}

// --- ORDER_INGEST_MODE gate --------------------------------------------------

/** required (default) | soft (observe-only, never mutates) | off (dev-only 404). */
function ingestMode(env) {
  const raw = env?.ORDER_INGEST_MODE;
  if (raw === "off" || raw === "soft" || raw === "required") {
    return raw;
  }
  return "required";
}

// --- ORDER_SIGNER_SCOPE gate (audit R2.1) ------------------------------------
// Bind each order-HMAC key-id to an allowed project/customer so ONE shared signing key can no longer
// create/revoke ANY customer's entitlements. Staged off (default, back-compat) -> soft (log the
// violation, still process) -> required (deny out-of-scope). ORDER_SIGNER_SCOPES is a JSON map
// { "<keyId>": { "project"?: "<p>", "customer_id"?: "<c>" } }; a keyId absent from the map is
// out-of-scope in required mode (fail-closed: every signer must declare its scope).

/** off (default) | soft | required. */
function signerScopeMode(env) {
  const parsed = parseOrderSignerScopeMode(env);
  return parsed.valid ? parsed.mode : null;
}

/** Parse ORDER_SIGNER_SCOPES; null when unset/blank/malformed. */
function loadSignerScopes(env) {
  const raw = env?.ORDER_SIGNER_SCOPES;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const scopes = Object.create(null);
    for (const keyId of Object.keys(parsed)) {
      const value = parsed[keyId];
      if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
      const fields = Object.keys(value);
      if (fields.length === 0 || fields.some((field) => field !== "project" && field !== "customer_id")) return null;
      const scope = Object.create(null);
      for (const field of ["project", "customer_id"]) {
        if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
        if (typeof value[field] !== "string" || value[field].length === 0) return null;
        scope[field] = value[field];
      }
      scopes[keyId] = scope;
    }
    return scopes;
  } catch {
    return null;
  }
}

/** null when in-scope, else a short reason string. `scopes` is the parsed map (non-null). */
function signerScopeViolation(scopes, keyId, order) {
  if (!Object.prototype.hasOwnProperty.call(scopes, keyId)) {
    return "no scope entry for signer key-id";
  }
  const scope = scopes[keyId];
  if (scope === null || typeof scope !== "object") {
    return "no scope entry for signer key-id";
  }
  if (typeof scope.project === "string" && scope.project.length > 0 && order.project !== scope.project) {
    return "order project is outside the signer's scope";
  }
  const orderCustomer = order.customer?.id ?? null;
  if (typeof scope.customer_id === "string" && scope.customer_id.length > 0 && orderCustomer !== scope.customer_id) {
    return "order customer is outside the signer's scope";
  }
  return null;
}

// --- nonce spend (Step 0, runs LAST, fail-closed) ----------------------------

/**
 * Spend one authenticated signed-attempt nonce. The existing `(key_id,event_id)` table remains
 * rollout-compatible by storing a bounded `signed_timestamp:raw_body_digest` attempt
 * identity in its legacy `event_id` column. An exact signed retry is rejected as a replay, while a
 * later freshly signed retry of the same logical event reaches the exactly-once cache/redrive path.
 * A DB error fails closed. TTL = 2*maxSkew so the row outlives the accepted skew window.
 */
async function spendOrderNonce(env, keyId, requestNonceId, signedTimestamp, now, maxSkewSeconds) {
  const expiresAt = now + maxSkewSeconds * 2;
  try {
    const row = await env.DB.prepare(
      "INSERT INTO order_ingest_nonces (key_id, event_id, timestamp, consumed_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key_id, event_id) DO NOTHING RETURNING event_id",
    )
      .bind(keyId, requestNonceId, signedTimestamp, now, expiresAt)
      .first();
    if (row === null) {
      return "replayed";
    }
    try {
      await env.DB.prepare("DELETE FROM order_ingest_nonces WHERE expires_at < ?").bind(now).run();
    } catch {
      // cleanup is best-effort; never turn a fresh nonce into a denial
    }
    return "fresh";
  } catch {
    return "error";
  }
}

function clampMaxSkew(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return 300;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 300;
  }
  return Math.min(parsed, 3600);
}

// --- response builders -------------------------------------------------------

// =============================================================================
// Step 4 entitlement statement builders (floor-guarded; reuse the shared SQL).
// =============================================================================
//
// These mirror the admin mutators' bodies EXACTLY for the mutated columns, and add
// the monotonic floor:
//   - create (upsert): ON CONFLICT DO UPDATE SET <cols>, last_applied_order_epoch=
//       excluded.*, last_applied_order_seq=excluded.* WHERE (floor strictly advances)
//   - update-shaped (patch/transition/capacity): the floor goes in the WHERE of the
//       UPDATE so a stale (epoch,seq) is a no-op.
// A no-op (floor rejects) returns no RETURNING row; the caller treats that as
// 'superseded' (still marks the event processed, never bumps revocation_seq).

const FLOOR_PREDICATE_CONFLICT =
  "(entitlements.last_applied_order_epoch < excluded.last_applied_order_epoch) OR " +
  "(entitlements.last_applied_order_epoch = excluded.last_applied_order_epoch AND entitlements.last_applied_order_seq < excluded.last_applied_order_seq)";

// Used in the WHERE of an UPDATE: the incoming (epoch,seq) must strictly advance the
// row's stored floor or the UPDATE matches no rows (a stale re-apply no-op). It has
// THREE `?` placeholders (epoch, epoch, seq) — bind them in that order.
const FLOOR_PREDICATE_UPDATE =
  "((? > entitlements.last_applied_order_epoch) OR " +
  "(? = entitlements.last_applied_order_epoch AND ? > entitlements.last_applied_order_seq))";

/**
 * Floor-guarded CREATE upsert for subscription.active. Mirrors createEntitlement's
 * INSERT...ON CONFLICT body columns, adds the floor columns + floor predicate, and
 * also writes pool_size/max_active_devices when the order carries quantity (so a
 * create with a seat pool materializes capacity in one shot). RETURNING yields the
 * row iff the insert OR a floor-advancing update landed.
 */
function buildCreateStatement(env, key, fields, order, floor, now) {
  return env.DB.prepare(
    `INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, pool_size, max_active_devices, last_applied_order_epoch, last_applied_order_seq, created_at, updated_at) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(revocation_seq) + 1 FROM entitlement_events WHERE project = ? AND feature = ? AND license_fingerprint = ?), 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
      `ON CONFLICT(project, feature, license_fingerprint) DO UPDATE SET ` +
      `device_hash = excluded.device_hash, status = excluded.status, assertion_ttl_seconds = excluded.assertion_ttl_seconds, cache_ttl_seconds = excluded.cache_ttl_seconds, ` +
      `revocation_seq = max(entitlements.revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events WHERE project = entitlements.project AND feature = entitlements.feature AND license_fingerprint = entitlements.license_fingerprint), entitlements.revocation_seq)) + 1, ` +
      `valid_from = excluded.valid_from, valid_until = excluded.valid_until, notes = excluded.notes, customer_id = excluded.customer_id, license_id = excluded.license_id, ` +
      `pool_size = excluded.pool_size, max_active_devices = excluded.max_active_devices, ` +
      `last_applied_order_epoch = excluded.last_applied_order_epoch, last_applied_order_seq = excluded.last_applied_order_seq, updated_at = excluded.updated_at ` +
      `WHERE (${FLOOR_PREDICATE_CONFLICT}) AND entitlements.status <> 'revoked' ` +
      `RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(
    key.project,
    key.feature,
    key.license_fingerprint,
    fields.device_hash,
    fields.status,
    fields.assertion_ttl_seconds,
    fields.assertion_ttl_seconds,
    key.project,
    key.feature,
    key.license_fingerprint,
    fields.valid_from,
    fields.valid_until,
    fields.notes,
    fields.customer_id,
    fields.license_id,
    fields.pool_size,
    fields.max_active_devices,
    floor.epoch,
    floor.seq,
    fields.created_at,
    now,
  );
}

/**
 * Floor-guarded PATCH (renew / cancel_at_period_end). Updates the entitlement body
 * (valid window + carry-forward customer/license), bumps revocation_seq, advances
 * the floor, all under the floor predicate in the WHERE.
 */
function buildPatchStatement(env, key, fields, floor, now) {
  return env.DB.prepare(
    `UPDATE entitlements SET device_hash = ?, assertion_ttl_seconds = ?, cache_ttl_seconds = ?, ${REVOCATION_SEQ_BUMP}, ` +
      `valid_from = ?, valid_until = ?, notes = ?, customer_id = ?, license_id = ?, ` +
      `last_applied_order_epoch = ?, last_applied_order_seq = ?, updated_at = ? ` +
      `WHERE project = ? AND feature = ? AND license_fingerprint = ? AND entitlements.status <> 'revoked' AND ${FLOOR_PREDICATE_UPDATE} ` +
      `RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(
    fields.device_hash,
    fields.assertion_ttl_seconds,
    fields.assertion_ttl_seconds,
    fields.valid_from,
    fields.valid_until,
    fields.notes,
    fields.customer_id,
    fields.license_id,
    floor.epoch,
    floor.seq,
    now,
    key.project,
    key.feature,
    key.license_fingerprint,
    floor.epoch,
    floor.epoch,
    floor.seq,
  );
}

/**
 * Floor-guarded status TRANSITION (disable / reenable / revoke). Only status +
 * revocation_seq + floor move; the body is untouched.
 */
function buildTransitionStatement(env, key, status, floor, now) {
  const terminalGuard = status === "revoked" ? "" : "AND entitlements.status <> 'revoked' ";
  return env.DB.prepare(
    `UPDATE entitlements SET status = ?, ${REVOCATION_SEQ_BUMP}, ` +
      `last_applied_order_epoch = ?, last_applied_order_seq = ?, updated_at = ? ` +
      `WHERE project = ? AND feature = ? AND license_fingerprint = ? ${terminalGuard}AND ${FLOOR_PREDICATE_UPDATE} ` +
      `RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(
    status,
    floor.epoch,
    floor.seq,
    now,
    key.project,
    key.feature,
    key.license_fingerprint,
    floor.epoch,
    floor.epoch,
    floor.seq,
  );
}

/**
 * Floor-guarded CAPACITY change (quantity.changed). Writes only the provided
 * non-negative-integer capacity columns + revocation_seq + floor.
 */
function buildCapacityStatement(env, key, capacity, floor, now) {
  const assignments = [];
  const values = [];
  const allowed = ["max_active_devices", "lease_seconds", "rebind_window_sec", "pool_size", "heartbeat_grace_sec", "max_borrow_sec", "allow_overdraft"];
  for (const column of allowed) {
    const value = capacity?.[column];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      assignments.push(`${column} = ?`);
      values.push(value);
    }
  }
  // If nothing valid to change, still advance the floor + bump revocation_seq so the
  // event is exactly-once accounted (it is a real, accepted order). updated_at moves.
  const setClause = [
    ...assignments,
    REVOCATION_SEQ_BUMP,
    "last_applied_order_epoch = ?",
    "last_applied_order_seq = ?",
    "updated_at = ?",
  ].join(", ");
  return env.DB.prepare(
    `UPDATE entitlements SET ${setClause} ` +
      `WHERE project = ? AND feature = ? AND license_fingerprint = ? AND entitlements.status <> 'revoked' AND ${FLOOR_PREDICATE_UPDATE} ` +
      `RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(
    ...values,
    floor.epoch,
    floor.seq,
    now,
    key.project,
    key.feature,
    key.license_fingerprint,
    floor.epoch,
    floor.epoch,
    floor.seq,
  );
}

// --- audit-event + processed-mark statements (in the SAME batch) -------------

const ORDER_CTX_SOURCE = "sync";
const ORDER_ACTOR_TYPE = "sync";

/**
 * The order-ingest audit event (mirrors eventFromCurrentStatement, but reads the row
 * state AFTER the mutation has been queued — D1 batch runs statements in order so the
 * event captures the post-mutation row. The applied-floor equality suppresses audits
 * for superseded mutations, preventing false state-change webhooks. source='sync',
 * actor_type='sync'.
 */
function buildOrderEventStatement(env, key, eventType, order, now, requireNonRevoked) {
  const terminalGuard = requireNonRevoked ? "AND entitlements.status <> 'revoked' " : "";
  return env.DB.prepare(
    `INSERT INTO entitlement_events (project, feature, license_fingerprint, device_hash, event_type, status, revocation_seq, detail, actor, actor_type, source, request_id, ip, prev_json, next_json, reason, idempotency_key, created_at) ` +
      `SELECT project, feature, license_fingerprint, device_hash, ?, status, revocation_seq, ?, ?, ?, '${ORDER_CTX_SOURCE}', ?, ?, '', ` +
      `json_object('project', project, 'feature', feature, 'license_fingerprint', license_fingerprint, 'status', status, 'revocation_seq', revocation_seq, 'valid_from', valid_from, 'valid_until', valid_until, 'pool_size', pool_size, 'id', ?), ` +
      `?, ?, ? ` +
      `FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ? ${terminalGuard}` +
      `AND last_applied_order_epoch = ? AND last_applied_order_seq = ? ` +
      `AND EXISTS (SELECT 1 FROM order_events AS oe WHERE oe.event_id = ? AND oe.status = 'accepted')`,
  ).bind(
    eventType,
    `order:${order.intent}`,
    `order:${order.subscription_id}`,
    ORDER_ACTOR_TYPE,
    order.event_id,
    "",
    entitlementId(key.project, key.feature, key.license_fingerprint),
    `order:${order.intent}`,
    order.event_id,
    now,
    key.project,
    key.feature,
    key.license_fingerprint,
    order.order_epoch,
    order.seq,
    order.event_id,
  );
}

/**
 * In-batch order_events processed-mark for the entitlement-mutating intents. Guards on
 * status='accepted' so it only transitions a freshly-claimed event — a redrive of an
 * already-processed event is a no-op here (and, with the floor + Step-1 dedup, the
 * double-bump guard never re-enters the mutator). The terminal no_entitlement / revoked
 * dispositions mark the event directly (they never reach a mutator) and are not routed
 * through here.
 */
function buildProcessedMarkStatement(env, eventId, resultJson, now) {
  return env.DB.prepare(
    "UPDATE order_events SET status = 'processed', result_json = ?, processed_at = ? WHERE event_id = ? AND status = 'accepted' RETURNING event_id",
  ).bind(resultJson, now, eventId);
}

// =============================================================================
// Step 3 — atomic ACCEPT (one env.DB.batch).
// =============================================================================

/**
 * Build the ACCEPT batch: 3a guarded cursor advance on orders(order_epoch,last_seq)
 * + 3b guarded event claim (insert order_events 'accepted' only if 3a won). Returns
 * the two prepared statements; the caller runs them in ONE env.DB.batch.
 */
export function buildAcceptBatch(env, order, keyId, digest, rawPayload, now, fingerprint, fingerprintOrigin) {
  const reservation = buildOrderLicenseReservation(env, order, now, fingerprint, fingerprintOrigin);
  const cursorAdvance = buildOrderCursorAdvance(env, order, now, fingerprint, fingerprintOrigin, reservation !== null);

  const eventClaim = env.DB.prepare(
    "INSERT INTO order_events (event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, payload_digest, raw_payload, status, result_json, received_at, processed_at) " +
      "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', '', ?, NULL " +
      "WHERE changes() = 1 " +
      "AND EXISTS (SELECT 1 FROM orders WHERE subscription_id = ? AND project = ? AND feature = ? " +
      "AND license_fingerprint = ? AND fingerprint_origin = ? AND order_epoch = ? AND last_seq = ?) " +
      "RETURNING event_id",
  ).bind(
    order.event_id,
    order.subscription_id,
    order.project,
    order.feature,
    order.order_epoch,
    order.seq,
    order.intent,
    keyId,
    digest,
    rawPayload,
    now,
    order.subscription_id,
    order.project,
    order.feature,
    fingerprint,
    fingerprintOrigin,
    order.order_epoch,
    order.seq,
  );

  return reservation === null ? [cursorAdvance, eventClaim] : [reservation, cursorAdvance, eventClaim];
}

// =============================================================================
// Step 4 — APPLY (floor-guarded mutation + in-batch processed-mark).
// =============================================================================

function firstBatchRow(result) {
  if (typeof result !== "object" || result === null || !("results" in result)) {
    return null;
  }
  const rows = result.results;
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  return rows[0];
}

/**
 * Apply an accepted order event: map intent→mutation, build the floor-guarded
 * entitlement statement, and commit it together with the order_events processed-mark
 * (and any seat-reclaim) in one atomic D1 batch.
 *
 * Returns the response object for the response matrix:
 *   { status, body } where body.code ∈
 *     applied | superseded | no_entitlement | entitlement_revoked | write_failed.
 *
 */
export async function applyOrderEvent(env, order, fingerprint, fingerprintOrigin, now) {
  const key = { project: order.project, feature: order.feature, license_fingerprint: fingerprint };
  const prev = await findEntitlement(env, key);
  const descriptor = mapIntentToMutation(order, prev);
  const floor = { epoch: order.order_epoch, seq: order.seq };

  // Terminal dispositions that never touch the entitlement: mark the event and cache.
  if (descriptor.kind === "none") {
    if (descriptor.terminal === "revoked") {
      return terminalizeRevokedOrderEvent(env, order, key, fingerprintOrigin, now);
    }
    // no_entitlement: a modify-intent on a missing/never-activated subscription. This
    // terminalization is conditional in one statement: an earlier accepted event might
    // still create the entitlement, and a concurrent apply might create it after our
    // advisory pre-read. In either case leave this event accepted and make the sender
    // retry, so the newer intent is never permanently discarded.
    return terminalizeMissingEntitlementOrderEvent(env, order, key, fingerprintOrigin, now);
  }

  // Build the mutation statement (floor-guarded) for the descriptor kind.
  let writeStatement;
  let eventType;
  if (descriptor.kind === "create") {
    eventType = prev === null ? "create" : "update";
    const fields = createFields(order, prev, descriptor, now);
    writeStatement = buildCreateStatement(env, key, fields, order, floor, now);
  } else if (descriptor.kind === "patch") {
    eventType = "update";
    const fields = patchFields(order, prev, descriptor);
    writeStatement = buildPatchStatement(env, key, fields, floor, now);
  } else if (descriptor.kind === "transition") {
    eventType = descriptor.eventType === "revoke" ? "revoke" : descriptor.eventType === "disable" ? "disable" : "reenable";
    writeStatement = buildTransitionStatement(env, key, descriptor.status, floor, now);
  } else if (descriptor.kind === "capacity") {
    eventType = "update";
    writeStatement = buildCapacityStatement(env, key, descriptor.capacity, floor, now);
  } else {
    // Defensive: unknown descriptor kind -> treat as no-op no_entitlement.
    return terminalizeDefensiveNoEntitlement(env, order, key, fingerprintOrigin, now);
  }

  // Seat reclaim (quantity downgrade): in the SAME batch, evict the longest-held live
  // seats down to the NEW pool and log a 'reclaim'. The descriptor's authoritative
  // pre-mutation entitlement diff only DECIDES that a downgrade happened; the
  // eviction COUNT is computed from LIVE seats minus the new pool so we never evict
  // below the new ceiling even if fewer than `from` seats are actually live (the
  // blueprint's `LIMIT (live_seats - pool_size)`). A negative diff clamps to 0.
  const reclaimStatements = [];
  if (descriptor.kind === "capacity" && descriptor.reclaim) {
    const newPool = descriptor.reclaim.to;
    reclaimStatements.push(
      env.DB.prepare(
        "DELETE FROM seat_checkouts WHERE rowid IN (" +
          "SELECT sc.rowid FROM seat_checkouts AS sc WHERE sc.project = ? AND sc.feature = ? AND sc.license_fingerprint = ? AND sc.heartbeat_deadline > ? " +
          "AND EXISTS (SELECT 1 FROM entitlements AS e WHERE e.project = sc.project AND e.feature = sc.feature " +
          "AND e.license_fingerprint = sc.license_fingerprint AND e.status <> 'revoked' " +
          "AND e.last_applied_order_epoch = ? AND e.last_applied_order_seq = ?) " +
          "AND EXISTS (SELECT 1 FROM order_events AS oe WHERE oe.event_id = ? AND oe.status = 'accepted') " +
          "ORDER BY heartbeat_deadline DESC LIMIT max(0, " +
          "(SELECT COUNT(*) FROM seat_checkouts WHERE project = ? AND feature = ? AND license_fingerprint = ? AND heartbeat_deadline > ?) - ?" +
          ")) RETURNING seat_id",
      ).bind(
        order.project,
        order.feature,
        fingerprint,
        now,
        floor.epoch,
        floor.seq,
        order.event_id,
        order.project,
        order.feature,
        fingerprint,
        now,
        newPool,
      ),
    );
  }

  // The processed-mark commits in the SAME batch as the mutation (atomic exactly-once).
  // Whether the floor advanced (applied) or no-op'd (superseded) is known only from the
  // mutation's RETURNING row after the batch lands, so seed a truthful neutral cache
  // result. If the process dies before finalization, a retry can safely return `cached`
  // without falsely claiming that a floor-rejected mutation applied.
  const appliedBody = resultBody("applied", {
    license_fingerprint: fingerprint,
    fingerprint_origin: fingerprintOrigin,
  });
  const cachedBody = resultBody("cached", {
    license_fingerprint: fingerprint,
    fingerprint_origin: fingerprintOrigin,
  });
  const markStatement = buildProcessedMarkStatement(env, order.event_id, JSON.stringify(cachedBody), now);
  const requireNonRevoked = descriptor.kind !== "transition" || descriptor.status !== "revoked";
  const revokedMark = requireNonRevoked
    ? buildRevokedOrderEventMark(env, order, key, fingerprintOrigin, now)
    : null;
  const extraStatements = [...reclaimStatements];
  const reclaimResultIndex = reclaimStatements.length === 0 ? null : 2;
  if (revokedMark !== null) extraStatements.push(revokedMark.statement);
  extraStatements.push(markStatement);

  let result;
  try {
    result = await writeEntitlementWithAuditFloor(
      env, key, writeStatement, eventType, prev, order, now, extraStatements,
      { requireNonRevoked, reclaimResultIndex },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "write_failed") {
      return { status: 503, body: resultBody("write_failed", {}) };
    }
    throw error;
  }

  // Two fresh-signature deliveries can both observe `accepted` before their D1 batches
  // serialize. Only the batch that transitions accepted->processed owns finalization and
  // analytics. A losing batch must return the winner's terminal cache; overwriting it with
  // `superseded` would corrupt the durable idempotency result.
  if (!result.marked) {
    return loadTerminalOrderOutcome(env, order.event_id);
  }

  // result.data is the post-mutation row when the floor advanced; null when the floor
  // no-op'd (superseded — a newer event already applied).
  if (result.applied) {
    // Reclaim usage_events ('reclaim') are best-effort analytics, emitted AFTER the
    // atomic batch lands (a missed analytics row must never fail the apply).
    if (descriptor.kind === "capacity" && descriptor.reclaim && Array.isArray(result.reclaimedSeats)) {
      for (const seat of result.reclaimedSeats) {
        try {
          await env.DB.prepare(
            "INSERT INTO usage_events (project, feature, license_fingerprint, event_type, seat_id, device_key_id, reason, ts) VALUES (?, ?, ?, 'reclaim', ?, NULL, 'quantity_downgrade', ?)",
          ).bind(order.project, order.feature, fingerprint, seat, now).run();
        } catch {
          // best-effort analytics
        }
      }
    }
    const body = { ...appliedBody, entitlement: result.data };
    // Finalize the cached result_json with the entitlement snapshot.
    await env.DB.prepare("UPDATE order_events SET result_json = ? WHERE event_id = ? AND status = 'processed'")
      .bind(JSON.stringify(body), order.event_id)
      .run();
    return { status: 200, body };
  }

  // Floor no-op: a newer (epoch,seq) already applied. The event is marked processed
  // (exactly-once accounted), code='superseded', no revocation bump occurred. Echo
  // the current (newer) entitlement state if present.
  let current;
  try {
    const winningEntitlement = await findEntitlement(env, key);
    current = winningEntitlement ? withId(winningEntitlement) : null;
  } catch {
    return { status: 503, body: resultBody("write_failed", {}) };
  }
  const supersededBody = resultBody("superseded", {
    license_fingerprint: fingerprint,
    fingerprint_origin: fingerprintOrigin,
    entitlement: current,
  });
  await env.DB.prepare("UPDATE order_events SET result_json = ? WHERE event_id = ? AND status = 'processed'")
    .bind(JSON.stringify(supersededBody), order.event_id)
    .run();
  return { status: 200, body: supersededBody };
}

/**
 * Run the floor-guarded mutation + extras in one batch, then report whether the
 * mutation actually landed (RETURNING row present) plus any reclaimed seats. We can
 * A floor no-op (empty RETURNING) is a valid `superseded` outcome here, not write_failed.
 */
async function writeEntitlementWithAuditFloor(
  env, key, writeStatement, eventType, prev, order, now, extraStatements,
  { requireNonRevoked, reclaimResultIndex },
) {
  if (env.DB.batch === undefined) {
    throw new Error("write_failed");
  }
  // Audit event reads post-mutation row; processed-mark + reclaim are in extras.
  const eventStatement = buildOrderEventStatement(env, key, eventType, order, now, requireNonRevoked);
  const statements = [writeStatement, eventStatement, ...extraStatements];
  const results = await env.DB.batch(statements);
  const mutated = firstBatchRow(results[0]);
  const marked = firstBatchRow(results[statements.length - 1]) !== null;
  // The reclaim DELETE (if any) has an explicit absolute batch index; terminal-state
  // arbitration may insert another statement before the final processed mark.
  let reclaimedSeats = [];
  if (reclaimResultIndex !== null) {
    const reclaimResult = results[reclaimResultIndex];
    if (reclaimResult && typeof reclaimResult === "object" && "results" in reclaimResult && Array.isArray(reclaimResult.results)) {
      reclaimedSeats = reclaimResult.results.map((r) => r.seat_id);
    }
  }
  if (mutated === null) {
    // Floor no-op: a newer event already applied. The processed-mark still committed
    // (the event row was 'accepted'), so the event is exactly-once accounted.
    return { applied: false, marked, data: prev ? withId(prev) : null, reclaimedSeats };
  }
  return { applied: true, marked, data: withId(mutated), reclaimedSeats };
}

// --- field assembly for create / patch ---------------------------------------

/** Assemble the INSERT/upsert fields for subscription.active. */
function createFields(order, prev, descriptor, now) {
  const validUntil = descriptor.valid_until === undefined ? null : descriptor.valid_until;
  let validFrom = null;
  if (descriptor.valid_from !== undefined) {
    validFrom = descriptor.valid_from;
  } else if (prev && typeof prev.valid_from === "number") {
    validFrom = prev.valid_from;
  }
  // valid_from < valid_until invariant: never surface a valid_from >= valid_until.
  if (validFrom !== null && validUntil !== null && validFrom >= validUntil) {
    validFrom = null;
  }
  const quantity = order.quantity ?? {};
  return {
    device_hash: prev?.device_hash ?? "",
    status: "active",
    assertion_ttl_seconds: prev?.assertion_ttl_seconds ?? DEFAULT_ASSERTION_TTL_SECONDS,
    valid_from: validFrom,
    valid_until: validUntil,
    notes: prev?.notes ?? "",
    customer_id: order.customer?.id ?? prev?.customer_id ?? null,
    license_id: order.license_id ?? prev?.license_id ?? null,
    pool_size: typeof quantity.pool_size === "number" ? quantity.pool_size : prev?.pool_size ?? 0,
    max_active_devices: typeof quantity.max_active_devices === "number" ? quantity.max_active_devices : prev?.max_active_devices ?? 1,
    created_at: prev?.created_at ?? now,
  };
}

/** Assemble the UPDATE fields for renew / cancel_at_period_end (carry-forward). */
function patchFields(order, prev, descriptor) {
  const validUntil = descriptor.valid_until === undefined ? prev.valid_until : descriptor.valid_until;
  let validFrom = descriptor.valid_from !== undefined ? descriptor.valid_from : prev.valid_from;
  if (validFrom !== null && validUntil !== null && validFrom >= validUntil) {
    // Keep the prior valid_from only if still consistent; otherwise open-start.
    validFrom = null;
  }
  return {
    device_hash: prev.device_hash,
    assertion_ttl_seconds: prev.assertion_ttl_seconds,
    valid_from: validFrom,
    valid_until: validUntil,
    notes: prev.notes,
    // carry-forward: omitted customer/license keep the prev values (never null them).
    customer_id: order.customer?.id ?? prev.customer_id,
    license_id: order.license_id ?? prev.license_id,
  };
}

// =============================================================================
// handleOrderIngest — the full Step 0-5 flow.
// =============================================================================

export async function handleOrderIngest(request, env) {
  const mode = ingestMode(env);
  const scopeMode = signerScopeMode(env);

  // An unknown non-empty scope mode must never silently disable signer authz.
  // Resolve it before body/HMAC work so a deployment typo has no side effects.
  if (scopeMode === null) {
    return jsonResponse({ ok: false, code: "config_error" }, 503);
  }

  // Step 0a — mode gate. off => the endpoint does not exist (dev-only).
  if (mode === "off") {
    return jsonResponse({ ok: false, code: "not_found" }, 404);
  }

  // Step 0b/c — read the raw body ONCE (never .text()/.json()); the byte ceiling
  // is enforced against actual stream bytes, including a missing or lying header.
  const rawBody = await readOrderBodyBytes(request);
  if (!rawBody.ok) {
    return jsonResponse({ ok: false, code: rawBody.code }, rawBody.code === "payload_too_large" ? 413 : 400);
  }

  // Step 0d — HMAC verify over the EXACT raw bytes.
  const hmac = await verifyOrderHmac(request, env, rawBody.bytes);
  if (!hmac.ok) {
    if (hmac.code === "config_error") {
      // No usable key map / audience: fail-closed config error (503, not a 401 — the
      // operator misconfigured the Worker, the caller is not at fault).
      return jsonResponse({ ok: false, code: "config_error" }, 503);
    }
    if (hmac.code === "unknown_key_id") {
      return jsonResponse({ ok: false, code: "unknown_key_id" }, 401);
    }
    if (hmac.code === "stale_timestamp") {
      return jsonResponse({ ok: false, code: "stale_timestamp" }, 401);
    }
    return jsonResponse({ ok: false, code: "bad_signature" }, 401);
  }

  // Step 0e — decode as fatal UTF-8, then parse + normalize. Signature verification
  // intentionally precedes decoding so a replacement-character re-encoding can never
  // authenticate malformed wire bytes.
  const decoded = decodeOrderUtf8(rawBody.bytes);
  if (!decoded.ok) {
    return jsonResponse({ ok: false, code: "invalid_order" }, 400);
  }
  const bodyText = decoded.text;
  let parsedBody;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ ok: false, code: "invalid_order" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const order = normalizeOrderEventForReplay(parsedBody, now);
  if (order.error) {
    return jsonResponse({ ok: false, code: "invalid_order" }, 400);
  }

  // Step 0e2 — signer-scope authz (audit R2.1). Orthogonal to the ingest mode: a signer that is not
  // allowed to write this project/customer is denied even in ingest-soft (it is an authz failure, not
  // a mutation). Runs before the ingest-soft observe-return so violations are surfaced there too.
  if (scopeMode !== "off") {
    const scopes = loadSignerScopes(env);
    if (scopes === null) {
      // Enforcement requested but no usable scope map => operator misconfig, fail-closed 503.
      return jsonResponse({ ok: false, code: "config_error" }, 503);
    }
    const violation = signerScopeViolation(scopes, hmac.keyId, order);
    if (violation !== null) {
      if (scopeMode === "required") {
        return jsonResponse({ ok: false, code: "signer_scope_forbidden" }, 403);
      }
      console.warn(JSON.stringify({ event: "order.signer_scope_violation", severity: "warn", mode: "soft", code: "scope_violation" }));
    }
  }

  // soft mode: observe-only. Verify + normalize + new-event period policy succeeded, but NEVER
  // mutate AND never spend the replay nonce. Spending it here (before this return) would burn the
  // signed-attempt identity: after the operator flipped soft->required, the first real delivery of
  // that event could be rejected as 'replayed' and never applied. Soft mode does not query durable
  // replay state, so it must apply the same historical-period gate a new required-mode event faces;
  // otherwise an observation can claim an event is acceptable when enforcement will reject it.
  if (mode === "soft") {
    if (!orderPeriodIsAcceptable(order, now)) {
      return jsonResponse({ ok: false, code: "invalid_order" }, 400);
    }
    return jsonResponse({ ok: true, code: "observed", license_fingerprint: null }, 200);
  }

  const digest = await payloadDigest(order);

  // Step 0f — spend the exact signed-request identity LAST (after verify+skew), required mode
  // only. The timestamp is part of the verified HMAC framing; the digest is over the exact raw
  // signed body bytes. The separate normalized payload digest above remains the logical-event
  // idempotency identity, so harmless JSON reserialization cannot create an event-id conflict.
  const maxSkew = clampMaxSkew(env?.ORDER_MAX_SKEW_SECONDS);
  const rawBodyDigest = await sha256BytesHex(rawBody.bytes);
  const requestNonceId = `${hmac.timestamp}:${rawBodyDigest}`;
  const nonceState = await spendOrderNonce(env, hmac.keyId, requestNonceId, Number(hmac.timestamp), now, maxSkew);
  if (nonceState === "replayed") {
    return jsonResponse({ ok: false, code: "replayed" }, 401);
  }
  if (nonceState === "error") {
    return jsonResponse({ ok: false, code: "write_failed" }, 503);
  }

  return runExactlyOnce(env, order, hmac.keyId, digest, bodyText, now);
}

/**
 * Steps 1-5 of the exactly-once flow (called after auth+normalize+request replay guard). Split out
 * so the integration test can drive the post-auth pipeline directly against SQLite.
 */
export async function runExactlyOnce(env, order, keyId, digest, rawPayload, now) {
  // --- Step 1 — replay dedup on event_id ---
  let existing;
  try {
    existing = await env.DB.prepare(
      "SELECT status, result_json, payload_digest FROM order_events WHERE event_id = ? LIMIT 1",
    )
      .bind(order.event_id)
      .first();
  } catch {
    return jsonResponse({ ok: false, code: "write_failed" }, 503);
  }
  if (existing !== null) {
    if (existing.payload_digest !== digest) {
      // Same event_id, different normalized payload -> a forgery/bug. Never serve it.
      return jsonResponse({ ok: false, code: "event_id_conflict" }, 409);
    }
    if (existing.status === "accepted") {
      // A crashed accept: fall through to Step 5 redrive (re-run Step 4).
      return redrive(env, order, digest, now);
    }
    // processed / superseded / rejected with a matching digest -> cached replay.
    // The helper preserves the original terminal status contract, including the
    // 400 used for a durably rejected invalid_order.
    const cached = await loadTerminalOrderOutcome(env, order.event_id);
    return jsonResponse(cached.body, cached.status);
  }

  // The historical-period gate protects only a brand-new event. A matching accepted or terminal
  // event above was already durably admitted and must remain recoverable/cacheable after the
  // provider retry window, otherwise a crash can become a permanent processing wedge.
  if (!orderPeriodIsAcceptable(order, now)) {
    return jsonResponse({ ok: false, code: "invalid_order" }, 400);
  }

  // --- Step 2 — identity + ownership ---
  let fingerprint;
  let fingerprintOrigin;
  try {
    const derived = await deriveFingerprint({
      subscription_id: order.subscription_id,
      project: order.project,
      feature: order.feature,
      supplied: order.license_fingerprint,
    });
    fingerprint = derived.fingerprint;
    fingerprintOrigin = derived.origin;
  } catch {
    return jsonResponse({ ok: false, code: "invalid_order" }, 400);
  }

  // Ownership gate: a fingerprint belongs to exactly ONE subscription.
  try {
    const owner = await env.DB.prepare(
      "SELECT subscription_id FROM orders WHERE project = ? AND feature = ? AND license_fingerprint = ? LIMIT 1",
    )
      .bind(order.project, order.feature, fingerprint)
      .first();
    if (owner !== null && owner.subscription_id !== order.subscription_id) {
      return jsonResponse({ ok: false, code: "fingerprint_owned" }, 409);
    }
  } catch {
    return jsonResponse({ ok: false, code: "write_failed" }, 503);
  }

  let identity;
  try {
    identity = await establishOrderIdentity(env, order, fingerprint, fingerprintOrigin, now);
  } catch {
    return jsonResponse({ ok: false, code: "write_failed" }, 503);
  }
  if (!identity.ok) return jsonResponse({ ok: false, code: identity.code }, identity.status);

  // --- Step 3 — atomic ACCEPT ---
  if (env.DB.batch === undefined) {
    return jsonResponse({ ok: false, code: "write_failed" }, 503);
  }
  let acceptResults;
  try {
    acceptResults = await env.DB.batch(buildAcceptBatch(
      env, order, keyId, digest, rawPayload, now, fingerprint, fingerprintOrigin,
    ));
  } catch {
    return jsonResponse({ ok: false, code: "write_failed" }, 503);
  }
  const cursorIndex = order.license_id ? 1 : 0;
  const cursorRow = firstBatchRow(acceptResults[cursorIndex]);
  const claimRow = firstBatchRow(acceptResults[cursorIndex + 1]);

  if (cursorRow === null || claimRow === null) {
    return failedAcceptDisposition(env, order, digest, now);
  }

  // --- Step 4 — APPLY ---
  return applyAccepted(env, order, fingerprint, fingerprintOrigin, now);
}

async function failedAcceptDisposition(env, order, digest, now) {
  let existing;
  try {
    existing = await env.DB.prepare(
      "SELECT status, result_json, payload_digest FROM order_events WHERE event_id = ? LIMIT 1",
    ).bind(order.event_id).first();
  } catch {
    return jsonResponse({ ok: false, code: "write_failed" }, 503);
  }
  if (existing === null) {
    try {
      if (await orderIdentityConflictsAfterFailedAccept(env, order)) {
        return jsonResponse({ ok: false, code: "invalid_order" }, 400);
      }
    } catch {
      return jsonResponse({ ok: false, code: "write_failed" }, 503);
    }
    return staleDisposition(env, order, digest, now);
  }
  if (existing.payload_digest !== digest) {
    return jsonResponse({ ok: false, code: "event_id_conflict" }, 409);
  }
  if (existing.status === "accepted") {
    return redrive(env, order, digest, now);
  }
  const cached = await loadTerminalOrderOutcome(env, order.event_id);
  return jsonResponse(cached.body, cached.status);
}

/** Disambiguate a stale ACCEPT: a prior event at this (epoch,seq) with a DIFFERENT
 *  digest -> 409 seq_conflict; otherwise insert a 'superseded' row caching
 *  200 stale_ignored (and emit the observable warn + metric). */
async function staleDisposition(env, order, digest, now) {
  const outcome = await claimStaleOrderOutcome(env, order, digest, now);
  if (outcome.claimed) console.warn(JSON.stringify({
    event: "order.stale_ignored", severity: "warn", order_epoch: order.order_epoch,
    seq: order.seq, intent: order.intent,
  }));
  return jsonResponse(outcome.body, outcome.status);
}

/** Step 4 driver: run the floor-guarded apply and surface the response. */
async function applyAccepted(env, order, fingerprint, fingerprintOrigin, now) {
  let auxiliary;
  try {
    auxiliary = await materializeOrderAuxiliaryIdentities(env, order, now);
  } catch {
    return jsonResponse({ ok: false, code: "write_failed" }, 503);
  }
  if (!auxiliary.ok) {
    let rejected;
    try {
      rejected = await terminalizeInvalidOrderEvent(env, order.event_id, now);
    } catch {
      return jsonResponse({ ok: false, code: "write_failed" }, 503);
    }
    return jsonResponse(rejected.body, rejected.status);
  }
  let outcome;
  try {
    outcome = await applyOrderEvent(env, order, fingerprint, fingerprintOrigin, now);
  } catch {
    return jsonResponse({ ok: false, code: "write_failed" }, 503);
  }
  return jsonResponse(outcome.body, outcome.status);
}

/** Step 5 — crash redrive: an 'accepted' row whose Step-4 mutation+mark never
 *  committed. Re-run Step 4; the floor decides apply-or-supersede. The processed-mark
 *  guard (status='accepted') makes a redrive of an ALREADY-processed event a no-op
 *  (the double-bump guard never re-enters the mutator). */
async function redrive(env, order, digest, now) {
  // Recompute fingerprint deterministically (period-independent) from the order.
  let fingerprint;
  let fingerprintOrigin;
  try {
    const derived = await deriveFingerprint({
      subscription_id: order.subscription_id,
      project: order.project,
      feature: order.feature,
      supplied: order.license_fingerprint,
    });
    fingerprint = derived.fingerprint;
    fingerprintOrigin = derived.origin;
  } catch {
    return jsonResponse({ ok: false, code: "invalid_order" }, 400);
  }
  return applyAccepted(env, order, fingerprint, fingerprintOrigin, now);
}
