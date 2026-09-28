// Internal D1 persistence for webhook delivery leases. Network delivery stays in webhook.mjs; this
// module owns the parameterized compare-and-set statements that establish and finalize one pending
// delivery's lease, plus recording and logging a delivery refused before it was ever fetched (its
// stored URL no longer passes safeWebhookUrl).

import { safeErrorType } from "../http/kit.mjs";

export const WEBHOOK_CLAIM_TTL_SECONDS = 60;
const BACKOFF_SCHEDULE_SECONDS = [30, 120, 600, 3600, 21600];

export function nextBackoff(attempts) {
  const index = Number.isInteger(attempts) && attempts > 0 ? attempts - 1 : 0;
  return BACKOFF_SCHEDULE_SECONDS[Math.min(index, BACKOFF_SCHEDULE_SECONDS.length - 1)];
}

export function readWebhookClock(clock, notBefore) {
  try {
    const value = clock();
    return Number.isSafeInteger(value) && value >= notBefore ? value : notBefore;
  } catch {
    return notBefore;
  }
}

export async function claimPendingWebhookDelivery(db, deliveryId, dueAt, claimUntil) {
  const row = await db.prepare(
    "UPDATE webhook_deliveries SET next_attempt_at = ? " +
      "WHERE id = ? AND status = 'pending' AND next_attempt_at <= ? RETURNING id",
  )
    .bind(claimUntil, deliveryId, dueAt)
    .first();
  return row !== null && row !== undefined;
}

export async function persistWebhookDeliveryOutcome(db, outcome) {
  let statement;
  if (outcome.ok) {
    statement = db.prepare(
      "UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_status = ?, " +
        "last_error = '', delivered_at = ? " +
        "WHERE id = ? AND status = 'pending' AND next_attempt_at = ? RETURNING id",
    ).bind(outcome.statusCode, outcome.now, outcome.deliveryId, outcome.claimUntil);
  } else if (outcome.terminal) {
    statement = db.prepare(
      "UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_status = ?, last_error = ? " +
        "WHERE id = ? AND status = 'pending' AND next_attempt_at = ? RETURNING id",
    ).bind(outcome.attempts, outcome.statusCode, outcome.errorText, outcome.deliveryId, outcome.claimUntil);
  } else {
    statement = db.prepare(
      "UPDATE webhook_deliveries SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ? " +
        "WHERE id = ? AND status = 'pending' AND next_attempt_at = ? RETURNING id",
    ).bind(
      outcome.attempts,
      outcome.statusCode,
      outcome.errorText,
      outcome.retryAt,
      outcome.deliveryId,
      outcome.claimUntil,
    );
  }
  const row = await statement.first();
  return row !== null && row !== undefined;
}

/** Record a delivery whose stored URL no longer passes safeWebhookUrl as failed, without fetching.
 * Never throws: a persistence failure here is logged and swallowed (mirroring deliverOne's own
 * best-effort outcome write) so it can never stop a later row in the same tick from being tried. */
export async function refuseUnsafeWebhookDelivery(db, delivery, now, claimUntil, logEvent) {
  const deliveryId = Number(delivery.id);
  const attempts = Number(delivery.attempts) + 1;
  let persisted;
  try {
    persisted = await persistWebhookDeliveryOutcome(db, {
      deliveryId, claimUntil, now, ok: false, statusCode: 0,
      errorText: "invalid_url", attempts, terminal: true, retryAt: null,
    });
  } catch (error) {
    try {
      logEvent?.("error", "webhook.deliver_error", { source: "persistence", delivery_id: deliveryId, error_type: safeErrorType(error) });
    } catch {
      // A throwing logger must never escape this best-effort recording path.
    }
    return;
  }
  if (persisted) {
    try {
      logEvent?.("warn", "webhook.delivery_failed", {
        delivery_id: deliveryId, endpoint_id: delivery.endpoint_id, attempts, last_status: 0, reason: "invalid_url",
      });
    } catch {
      // Same: a throwing logger must never escape.
    }
  }
}
