// Durable order-event result helpers. This module owns result-envelope parsing and
// accepted->terminal transitions that must be decided atomically against current D1
// state. It intentionally has no route or cross-service dependencies.

const OK_CODES = new Set(["applied", "superseded", "no_entitlement", "stale_ignored", "observed", "cached"]);

export function resultBody(code, extra) {
  return { ok: OK_CODES.has(code), code, ...extra };
}

export function parseStoredOrderResult(value) {
  if (typeof value !== "string" || value.length === 0) {
    return resultBody("cached", {});
  }
  const parsed = JSON.parse(value);
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    typeof parsed.ok !== "boolean" || typeof parsed.code !== "string"
  ) {
    throw new Error("invalid_stored_order_result");
  }
  return parsed;
}

export async function loadTerminalOrderOutcome(env, eventId) {
  let row;
  try {
    row = await env.DB.prepare(
      "SELECT status, result_json FROM order_events WHERE event_id = ? LIMIT 1",
    ).bind(eventId).first();
  } catch {
    return { status: 503, body: resultBody("write_failed", {}) };
  }
  if (row === null || !["processed", "superseded", "rejected"].includes(row.status)) {
    return { status: 503, body: resultBody("write_failed", {}) };
  }
  let body;
  try {
    body = parseStoredOrderResult(row.result_json);
  } catch {
    return { status: 503, body: resultBody("write_failed", {}) };
  }
  const status = row.status === "rejected" ? (body.code === "invalid_order" ? 400 : 409) : 200;
  return { status, body };
}

export async function claimStaleOrderOutcome(env, order, digest, now) {
  const body = resultBody("stale_ignored", {});
  let claimed;
  try {
    claimed = await env.DB.prepare(
      "INSERT INTO order_events (event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, payload_digest, raw_payload, status, result_json, received_at, processed_at) " +
        "SELECT ?, ?, ?, ?, ?, ?, ?, '', ?, '', 'superseded', ?, ?, ? " +
        "WHERE NOT EXISTS (SELECT 1 FROM order_events WHERE subscription_id = ? AND project = ? AND feature = ? AND order_epoch = ? AND seq = ?) " +
        "ON CONFLICT(event_id) DO NOTHING RETURNING event_id",
    ).bind(
      order.event_id, order.subscription_id, order.project, order.feature,
      order.order_epoch, order.seq, order.intent, digest, JSON.stringify(body), now, now,
      order.subscription_id, order.project, order.feature, order.order_epoch, order.seq,
    ).first();
  } catch {
    return { status: 503, body: resultBody("write_failed", {}), claimed: false };
  }
  if (claimed !== null) return { status: 200, body, claimed: true };

  let existing;
  try {
    existing = await env.DB.prepare(
      "SELECT status, payload_digest FROM order_events WHERE event_id = ? LIMIT 1",
    ).bind(order.event_id).first();
  } catch {
    return { status: 503, body: resultBody("write_failed", {}), claimed: false };
  }
  if (existing !== null) {
    if (existing.payload_digest !== digest) {
      return { status: 409, body: resultBody("event_id_conflict", {}), claimed: false };
    }
    if (existing.status === "accepted") {
      return { status: 503, body: resultBody("write_failed", {}), claimed: false };
    }
    return { ...(await loadTerminalOrderOutcome(env, order.event_id)), claimed: false };
  }

  let floor;
  try {
    floor = await env.DB.prepare(
      "SELECT payload_digest FROM order_events WHERE subscription_id = ? AND project = ? AND feature = ? AND order_epoch = ? AND seq = ? LIMIT 1",
    ).bind(order.subscription_id, order.project, order.feature, order.order_epoch, order.seq).first();
  } catch {
    return { status: 503, body: resultBody("write_failed", {}), claimed: false };
  }
  if (floor !== null && floor.payload_digest !== digest) {
    return { status: 409, body: resultBody("seq_conflict", {}), claimed: false };
  }
  return { status: 503, body: resultBody("write_failed", {}), claimed: false };
}

export async function terminalizeInvalidOrderEvent(env, eventId, now) {
  const body = resultBody("invalid_order", {});
  const marked = await env.DB.prepare(
    "UPDATE order_events SET status = 'rejected', result_json = ?, processed_at = ? " +
      "WHERE event_id = ? AND status = 'accepted' RETURNING event_id",
  ).bind(JSON.stringify(body), now, eventId).first();
  return marked === null ? loadTerminalOrderOutcome(env, eventId) : { status: 400, body };
}

export function buildRevokedOrderEventMark(env, order, key, fingerprintOrigin, now) {
  const body = resultBody("entitlement_revoked", {
    license_fingerprint: key.license_fingerprint,
    fingerprint_origin: fingerprintOrigin,
  });
  const statement = env.DB.prepare(
    "UPDATE order_events SET status = 'rejected', result_json = ?, processed_at = ? " +
      "WHERE event_id = ? AND status = 'accepted' " +
      "AND EXISTS (SELECT 1 FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ? AND status = 'revoked') " +
      "RETURNING event_id",
  ).bind(
    JSON.stringify(body),
    now,
    order.event_id,
    key.project,
    key.feature,
    key.license_fingerprint,
  );
  return { body, statement };
}

export async function terminalizeRevokedOrderEvent(env, order, key, fingerprintOrigin, now) {
  const { body, statement } = buildRevokedOrderEventMark(env, order, key, fingerprintOrigin, now);
  const marked = await statement.first();
  return marked === null ? loadTerminalOrderOutcome(env, order.event_id) : { status: 409, body };
}

export async function terminalizeMissingEntitlementOrderEvent(env, order, key, fingerprintOrigin, now) {
  const body = resultBody("no_entitlement", {
    license_fingerprint: key.license_fingerprint,
    fingerprint_origin: fingerprintOrigin,
  });
  const marked = await env.DB.prepare(
    "UPDATE order_events SET status = 'processed', result_json = ?, processed_at = ? " +
      "WHERE event_id = ? AND status = 'accepted' " +
      "AND NOT EXISTS (SELECT 1 FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ?) " +
      "AND NOT EXISTS (" +
      "SELECT 1 FROM order_events AS earlier WHERE earlier.subscription_id = ? AND earlier.project = ? AND earlier.feature = ? " +
      "AND earlier.event_id <> ? AND earlier.status = 'accepted' " +
      "AND (earlier.order_epoch < ? OR (earlier.order_epoch = ? AND earlier.seq < ?))" +
      ") RETURNING event_id",
  ).bind(
    JSON.stringify(body),
    now,
    order.event_id,
    key.project,
    key.feature,
    key.license_fingerprint,
    order.subscription_id,
    order.project,
    order.feature,
    order.event_id,
    order.order_epoch,
    order.order_epoch,
    order.seq,
  ).first();
  return marked === null ? loadTerminalOrderOutcome(env, order.event_id) : { status: 200, body };
}

export async function terminalizeDefensiveNoEntitlement(env, order, key, fingerprintOrigin, now) {
  const body = resultBody("no_entitlement", {
    license_fingerprint: key.license_fingerprint,
    fingerprint_origin: fingerprintOrigin,
  });
  const marked = await env.DB.prepare(
    "UPDATE order_events SET status = 'processed', result_json = ?, processed_at = ? " +
      "WHERE event_id = ? AND status = 'accepted' RETURNING event_id",
  ).bind(JSON.stringify(body), now, order.event_id).first();
  return marked === null ? loadTerminalOrderOutcome(env, order.event_id) : { status: 200, body };
}
