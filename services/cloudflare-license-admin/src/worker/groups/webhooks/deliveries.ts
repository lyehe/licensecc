// The admin view of webhook_deliveries, the backend's cron-drained outbox: the list, operator
// redrive, and the cancellation an endpoint PATCH batches with its own UPDATE.
//
// An event is delivered only under the endpoint URL and scope in effect when it was queued. So a
// PATCH that moves either cancels the endpoint's deliveries still pending (a first try or a backoff
// retry) or failed (an operator could redrive those), and redrive refuses a canceled delivery. The
// backend's delivery pass also re-checks the scope before every send.
import type { Actor, D1PreparedStatementLike, MutationContext } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { clientIp } from "@licensecc/cloudflare-runtime/http/kit";
import { WEBHOOK_ENDPOINT_CHANGED } from "@licensecc/cloudflare-runtime/webhooks/webhook_endpoint";
import type { Env } from "../../env.js";
import { INVALID_IDEMPOTENCY_KEY, mutationResponse, readIdempotencyKey } from "../../idempotency.js";
import { boundedCursor } from "../../query.js";
import { envelope } from "../../responses.js";

export const WEBHOOK_DELIVERY_COLUMNS =
  "id, endpoint_id, event_source, event_id, event_type, status, attempts, last_status, last_error, next_attempt_at, created_at, delivered_at";
const WEBHOOK_DELIVERY_STATUSES: readonly string[] = ["pending", "delivered", "failed", "canceled"];

/** The endpoint fields that decide where and for whom a queued delivery would be sent. */
export type WebhookDestinationChange = Partial<Record<"url" | "scope_kind" | "scope_project" | "scope_customer_id", string | null>>;

/**
 * The statement that cancels an endpoint's queued deliveries when a PATCH moves its destination,
 * or null when the PATCH names none of those fields. It runs in the PATCH's batch BEFORE the
 * endpoint UPDATE and compares the stored row with the new values itself (`IS NOT`, so NULL scope
 * values compare too), so a concurrent PATCH can never make it judge a stale pre-read, and a PATCH
 * that resends the stored values cancels nothing.
 */
export function cancelQueuedDeliveries(env: Env, endpointId: string, change: WebhookDestinationChange): D1PreparedStatementLike | null {
  const fields = (["url", "scope_kind", "scope_project", "scope_customer_id"] as const).filter((field) => change[field] !== undefined);
  if (fields.length === 0) return null;
  return env.DB.prepare(
    `UPDATE webhook_deliveries SET status = 'canceled', last_error = ?
     WHERE endpoint_id = ? AND status IN ('pending', 'failed')
       AND EXISTS (SELECT 1 FROM webhook_endpoints WHERE id = ? AND (${fields.map((field) => `${field} IS NOT ?`).join(" OR ")}))`,
  ).bind(WEBHOOK_ENDPOINT_CHANGED, endpointId, endpointId, ...fields.map((field) => change[field]));
}

// Delivery status view: filter by status / endpoint_id, cursor-paginated. Read-only; the
// payload_json body is deliberately NOT selected (operators see metadata, not the full body).
export async function listWebhookDeliveries(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const filters: string[] = [];
  const values: unknown[] = [];
  const status = url.searchParams.get("status");
  if (status !== null && WEBHOOK_DELIVERY_STATUSES.includes(status)) {
    filters.push("status = ?");
    values.push(status);
  } else if (status !== null && status !== "") {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const endpointId = url.searchParams.get("endpoint_id");
  if (endpointId !== null && endpointId !== "") {
    if (endpointId.length > 128) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    filters.push("endpoint_id = ?");
    values.push(endpointId);
  }
  const pagination = boundedCursor(url);
  if (pagination === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const { limit, cursor } = pagination;
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  values.push(limit + 1, cursor);
  const rows = await env.DB.prepare(
    `SELECT ${WEBHOOK_DELIVERY_COLUMNS} FROM webhook_deliveries ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).bind(...values).all();
  return envelope(requestIdValue, "webhook_deliveries_listed", {
    items: rows.results.slice(0, limit),
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

// Redrive: reset a 'failed' delivery back to 'pending' with next_attempt_at = now so the next
// cron tick re-attempts it. A guarded UPDATE (status = 'failed' in the WHERE) makes this safe
// and idempotent: a delivery already pending/delivered is a 409, never silently re-queued, and a
// canceled one has its own 409 because its endpoint's address or scope has changed since.
export async function redriveWebhookDelivery(request: Request, env: Env, actor: Actor, deliveryId: number, requestIdValue: string): Promise<Response> {
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, "webhook_delivery_redriven", async () => {
    const existing = await env.DB.prepare(
      `SELECT ${WEBHOOK_DELIVERY_COLUMNS} FROM webhook_deliveries WHERE id = ? LIMIT 1`,
    ).bind(deliveryId).first<{ status: string }>();
    if (existing === null) {
      return envelope(requestIdValue, "not_found", undefined, 404);
    }
    if (existing.status === "canceled") {
      return envelope(requestIdValue, "webhook_delivery_canceled", { status: existing.status }, 409);
    }
    if (existing.status !== "failed") {
      return envelope(requestIdValue, "webhook_delivery_not_failed", { status: existing.status }, 409);
    }
    const now = Math.floor(Date.now() / 1000);
    let row: Record<string, unknown> | null;
    try {
      row = await env.DB.prepare(
        `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, last_error = '', next_attempt_at = ?
         WHERE id = ? AND status = 'failed' RETURNING ${WEBHOOK_DELIVERY_COLUMNS}`,
      ).bind(now, deliveryId).first<Record<string, unknown>>();
    } catch {
      return envelope(requestIdValue, "mutation_failed", undefined, 500);
    }
    if (row === null) {
      // Lost the guarded race — status changed between the pre-read and the UPDATE.
      return envelope(requestIdValue, "webhook_delivery_not_failed", undefined, 409);
    }
    return { data: row, idempotencyRecorded: false };
  });
}
