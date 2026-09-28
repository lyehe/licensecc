// Webhook endpoint rules shared by the admin Worker (which stores endpoints) and the backend (which
// sends to them). Kept out of webhook.mjs, which is near its hotspot line budget.

export const MAX_WEBHOOK_URL_SIZE = 2048;

/**
 * The only destination a webhook may be sent to: an absolute https:// URL within the size bound,
 * free of whitespace and control characters. The admin Worker applies it when an endpoint is
 * created or edited; the backend applies it again before an operator test send, so a row that
 * reached D1 some other way is never sent to plaintext http or another scheme.
 *
 * @param {unknown} value
 * @returns {string | null} the normalized href, or null when the value is not a safe webhook URL
 */
export function safeWebhookUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_WEBHOOK_URL_SIZE) return null;
  if (value.includes("\0") || /\s/.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" ? parsed.href : null;
}

/**
 * Everything an operator test send reports about the receiver: the class of its HTTP status, or
 * network_error when there was no usable answer within the delivery timeout. The backend produces
 * one of these; the admin Worker relays nothing else.
 */
export const WEBHOOK_TEST_STATUS_CLASSES = Object.freeze(/** @type {const} */ (["2xx", "3xx", "4xx", "5xx", "network_error"]));
