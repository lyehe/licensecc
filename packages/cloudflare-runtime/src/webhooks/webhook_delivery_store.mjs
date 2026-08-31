// Internal D1 persistence for webhook delivery leases. Network delivery stays in webhook.mjs;
// this module owns only the parameterized compare-and-set statements that establish and finalize
// one pending delivery's lease.

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
