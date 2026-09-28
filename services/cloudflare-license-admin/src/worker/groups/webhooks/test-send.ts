// POST /api/admin/webhooks/{id}/test: ask the backend's WebhookOperator capability to send one
// signed test event. Only the backend holds WEBHOOK_SIGNING_SECRETS, so this Worker forwards the
// endpoint id and relays nothing but the receiver's status class. The backend result is checked
// field by field and rebuilt, never passed through: anything unexpected becomes 503. A send the
// backend attempted also leaves a webhook_events audit row; a refused send leaves none.
import type { Actor } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { WEBHOOK_TEST_STATUS_CLASSES, type WebhookTestStatusClass } from "@licensecc/cloudflare-runtime/webhooks/webhook_endpoint";
import { requireAdmin } from "../../auth.js";
import type { Env } from "../../env.js";
import { parseJsonBody } from "../../request.js";
import { json } from "../../responses.js";

// The backend entrypoint's RPC surface, typed here because the admin never imports backend code.
type WebhookOperatorRpc = { sendTest(endpointId: string): Promise<unknown> };

// Refusals the backend may return, with the only status each may carry.
const REFUSALS: Readonly<Record<string, number>> = {
  not_found: 404,
  invalid_url: 400,
  webhook_signing_unconfigured: 503,
  temporarily_unavailable: 503,
};
const MAX_RETRY_AFTER_SECONDS = 60;

function respond(requestId: string, code: string, status: number, data?: unknown, headers: Record<string, string> = {}): Response {
  return json({ ok: status >= 200 && status < 300, code, request_id: requestId, data }, status, { "cache-control": "no-store", ...headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStatusClass(value: unknown): value is WebhookTestStatusClass {
  return typeof value === "string" && (WEBHOOK_TEST_STATUS_CLASSES as readonly string[]).includes(value);
}

// The receiver's status class when the backend reports an attempted send, else null.
function sentStatusClass(result: unknown): WebhookTestStatusClass | null {
  if (!isRecord(result)) return null;
  const { ok, status, code, data } = result;
  if (ok === true && status === 200 && code === "webhook_test_sent" && isRecord(data)
    && Object.keys(data).length === 1 && isStatusClass(data.status_class)) {
    return data.status_class;
  }
  return null;
}

function relay(result: unknown, requestId: string): Response {
  const statusClass = sentStatusClass(result);
  if (statusClass !== null) return respond(requestId, "webhook_test_sent", 200, { status_class: statusClass });
  if (!isRecord(result)) return respond(requestId, "temporarily_unavailable", 503);
  const { ok, status, code, data } = result;
  if (ok === false && status === 429 && code === "rate_limited" && isRecord(data)) {
    const retryAfter = data.retry_after;
    if (typeof retryAfter === "number" && Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
      return respond(requestId, "rate_limited", 429, { retry_after: retryAfter }, { "retry-after": String(retryAfter) });
    }
  }
  const refusalStatus = typeof code === "string" && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : undefined;
  if (ok === false && typeof code === "string" && refusalStatus !== undefined && refusalStatus === status) {
    return respond(requestId, code, refusalStatus);
  }
  return respond(requestId, "temporarily_unavailable", 503);
}

export async function sendWebhookTest(request: Request, env: Env, actor: Actor, rawEndpointId: string, requestId: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestId);
  if (adminError !== null) return adminError;
  let endpointId: string;
  try {
    endpointId = decodeURIComponent(rawEndpointId);
  } catch {
    return respond(requestId, "invalid_request", 400);
  }
  // "deliveries" is the reserved delivery sub-collection, never an endpoint id.
  if (endpointId.length === 0 || endpointId.length > 128 || endpointId === "deliveries") {
    return respond(requestId, "invalid_request", 400);
  }
  // The body is read only to enforce the shared size and JSON rules; no field is used.
  const body = await parseJsonBody(request, requestId);
  if (body instanceof Response) return body;
  if (!env.WEBHOOK_OPERATOR) return respond(requestId, "webhook_operator_not_configured", 503);
  let result: unknown;
  try {
    result = await (env.WEBHOOK_OPERATOR as unknown as WebhookOperatorRpc).sendTest(endpointId);
  } catch {
    return respond(requestId, "temporarily_unavailable", 503);
  }
  const statusClass = sentStatusClass(result);
  if (statusClass !== null) await auditTestSend(env, endpointId, statusClass, actor, requestId);
  return relay(result, requestId);
}

// An attempted test send went to a real receiver URL (whatever its status class, network_error
// included), so it is audited in webhook_events like disable/reenable: the actor, the request id
// and the status class as the reason. A test send changes nothing, so the endpoint's current
// status is both prev and next and no guard is needed. The audit is best-effort: the receiver
// call already happened, so a failed audit is logged and the operator still sees the real outcome.
async function auditTestSend(env: Env, endpointId: string, statusClass: WebhookTestStatusClass, actor: Actor, requestId: string): Promise<void> {
  try {
    const endpoint = await env.DB.prepare("SELECT status FROM webhook_endpoints WHERE id = ?").bind(endpointId).first<{ status: string }>();
    if (endpoint === null) throw new Error("webhook endpoint not found");
    await env.DB.prepare(
      `INSERT INTO webhook_events (endpoint_id, event_type, prev_status, next_status, actor, actor_type, source, reason, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?)`,
    ).bind(endpointId, "test_send", endpoint.status, endpoint.status, actor.email || actor.subject, actor.actorType, statusClass, requestId, Math.floor(Date.now() / 1000)).run();
  } catch {
    console.error(JSON.stringify({ event: "webhook.test_send_audit_failed", request_id: requestId, endpoint_id: endpointId }));
  }
}
