// POST /api/admin/webhooks/{id}/test: ask the backend's WebhookOperator capability to send one
// signed test event. Only the backend holds WEBHOOK_SIGNING_SECRETS, so this Worker forwards the
// endpoint id and relays nothing but the receiver's status class. The backend result is checked
// field by field and rebuilt, never passed through: anything unexpected becomes 503.
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

function relay(result: unknown, requestId: string): Response {
  if (!isRecord(result)) return respond(requestId, "temporarily_unavailable", 503);
  const { ok, status, code, data } = result;
  if (ok === true && status === 200 && code === "webhook_test_sent" && isRecord(data)
    && Object.keys(data).length === 1 && isStatusClass(data.status_class)) {
    return respond(requestId, "webhook_test_sent", 200, { status_class: data.status_class });
  }
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
  return relay(result, requestId);
}
