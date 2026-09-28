// Webhook endpoint rules shared by the admin Worker (which stores endpoints) and the backend (which
// sends to them). Kept out of webhook.mjs, which is near its hotspot line budget.

export const MAX_WEBHOOK_URL_SIZE = 2048;

const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** True for a hostname a webhook may be sent to: no trailing dot, not an IP literal, not
 * single-label, and not a suffix (or, via the leading "." added before comparing, an exact
 * match) reserved for internal networks. */
function publicHostname(host) {
  if (host.endsWith(".")) return false; // a trailing dot would otherwise slip past every check below
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/u.test(host)) return false; // IPv6 / IPv4 literal
  if (!host.includes(".")) return false; // single-label
  return !INTERNAL_HOST_SUFFIXES.some((suffix) => ("." + host).endsWith(suffix));
}

/**
 * The only destination a webhook may be sent to: an absolute https:// URL within the size bound,
 * free of whitespace and control characters, carrying no userinfo, and resolving to a public-looking
 * hostname (no IP literal, single-label name, or internal suffix). The admin Worker applies it when
 * an endpoint is created or edited; the backend applies it again before an operator test send AND
 * before every scheduled delivery, so a row that reached D1 some other way, or that was safe when
 * stored but points at an internal host now, is never fetched.
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
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
  return publicHostname(parsed.hostname) ? parsed.href : null;
}

/**
 * Everything an operator test send reports about the receiver: the class of its HTTP status, or
 * network_error when there was no usable answer within the delivery timeout. The backend produces
 * one of these; the admin Worker relays nothing else.
 */
export const WEBHOOK_TEST_STATUS_CLASSES = Object.freeze(/** @type {const} */ (["2xx", "3xx", "4xx", "5xx", "network_error"]));
