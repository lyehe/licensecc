// Operator "Send test event": one signed POST to an ACTIVE endpoint, answered with nothing but the
// receiver's status class. Only the backend holds WEBHOOK_SIGNING_SECRETS, so the admin Worker
// reaches this through the WebhookOperator entrypoint and never sees the secret or the signature.
//
// It reuses the real delivery path rather than a second implementation: the same signing selector
// (webhookSigningConfig), signer (signWebhookBody), 5 s timeout and `redirect: "manual"`. The
// stored URL is re-checked as https first, because a row may have reached D1 without the admin
// Worker's validation. Nothing from the receiver's response (headers, body, error text) is
// returned, so a test send cannot be used to read another service's responses.

import { signWebhookBody, webhookSigningConfig, WEBHOOK_DELIVER_TIMEOUT_MS } from "@licensecc/cloudflare-runtime/webhooks/webhook";
import { safeWebhookUrl } from "@licensecc/cloudflare-runtime/webhooks/webhook_endpoint";

export const WEBHOOK_TEST_RATE_NAMESPACE = "webhook-test";
export const WEBHOOK_TEST_INTERVAL_SECONDS = 60;

// One sliding slot per endpoint in the shared rate_limit_counters table: window_start is fixed at
// 0 and updated_at holds the last accepted send. The conditional upsert claims the slot only when
// that send is at least 60 s old, atomically, so two racing requests cannot both send; a refused
// claim returns no row. expires_at lets the backend's generic counter cleanup drop idle rows.
const CLAIM_TEST_SLOT =
  "INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) " +
  `VALUES ('${WEBHOOK_TEST_RATE_NAMESPACE}', ?, 0, 1, ?, ?) ` +
  "ON CONFLICT(namespace, rate_key, window_start) DO UPDATE SET request_count = request_count + 1, " +
  "expires_at = excluded.expires_at, updated_at = excluded.updated_at " +
  `WHERE rate_limit_counters.updated_at <= excluded.updated_at - ${WEBHOOK_TEST_INTERVAL_SECONDS} RETURNING request_count`;
const LAST_TEST_SEND =
  `SELECT updated_at FROM rate_limit_counters WHERE namespace = '${WEBHOOK_TEST_RATE_NAMESPACE}' AND rate_key = ? AND window_start = 0`;

/** @typedef {import("@licensecc/cloudflare-runtime/webhooks/webhook_endpoint").WebhookTestStatusClass} WebhookTestStatusClass */

/**
 * The status class of a receiver answer. With `redirect: "manual"` a runtime may surface a
 * redirect either as the 3xx itself (workerd, undici) or as an opaque status-0 response.
 *
 * @param {{ status?: unknown, type?: unknown }} response
 * @returns {WebhookTestStatusClass}
 */
function statusClassOf(response) {
  if (response?.type === "opaqueredirect") return "3xx";
  const status = response?.status;
  if (typeof status !== "number" || !Number.isInteger(status)) return "network_error";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "network_error";
}

/**
 * @param {string} url
 * @param {string} body
 * @param {string} signature
 * @param {typeof fetch} send
 * @returns {Promise<WebhookTestStatusClass>}
 */
async function postTestEvent(url, body, signature, send) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_DELIVER_TIMEOUT_MS);
  try {
    const response = await send(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Licensecc-Signature": signature,
        // Receivers deduplicate on (source, id); a test uses its own source and a fresh id so it
        // can never collide with, or be mistaken for, a real delivery.
        "Licensecc-Webhook-Id": `test-${crypto.randomUUID()}`,
        "Licensecc-Event-Source": "test",
      },
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    const statusClass = statusClassOf(response);
    try {
      await response?.body?.cancel();
    } catch {
      // The answer is already classified; the unread body is only released here.
    }
    return statusClass;
  } catch {
    return "network_error";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one signed test event to an active endpoint.
 *
 * @param {{ DB: { prepare(sql: string): any }, WEBHOOK_SIGNING_SECRETS?: string, WEBHOOK_SIGNING_KEY_ID?: string }} env
 * @param {unknown} endpointId
 * @param {{ now?: number, fetch?: typeof fetch }} [options]
 * @returns {Promise<{ ok: true, status: 200, code: "webhook_test_sent", data: { status_class: WebhookTestStatusClass } }
 *   | { ok: false, status: number, code: string, data?: { retry_after: number } }>}
 */
export async function sendWebhookTestEvent(env, endpointId, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const send = options.fetch ?? globalThis.fetch;
  if (typeof endpointId !== "string" || endpointId.length === 0 || endpointId.length > 128) {
    return { ok: false, status: 404, code: "not_found" };
  }
  try {
    const endpoint = await env.DB.prepare("SELECT id, url FROM webhook_endpoints WHERE id = ? AND status = 'active' LIMIT 1")
      .bind(endpointId)
      .first();
    if (endpoint === null || endpoint === undefined) return { ok: false, status: 404, code: "not_found" };
    const url = safeWebhookUrl(endpoint.url);
    if (url === null) return { ok: false, status: 400, code: "invalid_url" };
    const signing = webhookSigningConfig(env);
    if ("error" in signing) return { ok: false, status: 503, code: "webhook_signing_unconfigured" };

    const claimed = await env.DB.prepare(CLAIM_TEST_SLOT).bind(endpointId, now + WEBHOOK_TEST_INTERVAL_SECONDS, now).first();
    if (claimed === null || claimed === undefined) {
      const last = await env.DB.prepare(LAST_TEST_SEND).bind(endpointId).first();
      const elapsed = now - Number(last?.updated_at ?? now);
      const retryAfter = Math.min(WEBHOOK_TEST_INTERVAL_SECONDS, Math.max(1, WEBHOOK_TEST_INTERVAL_SECONDS - elapsed));
      return { ok: false, status: 429, code: "rate_limited", data: { retry_after: retryAfter } };
    }

    const body = JSON.stringify({ type: "test", endpoint_id: endpoint.id, sent_at: now });
    const signature = await signWebhookBody(signing.secretsMap, signing.keyId, body, now);
    const statusClass = await postTestEvent(url, body, signature, send);
    return { ok: true, status: 200, code: "webhook_test_sent", data: { status_class: statusClass } };
  } catch {
    return { ok: false, status: 503, code: "temporarily_unavailable" };
  }
}
