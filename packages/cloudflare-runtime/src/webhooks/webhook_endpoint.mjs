// Webhook endpoint rules shared by the admin Worker (which stores endpoints) and the backend (which
// sends to them): the destination URL rule, the scope rule and the reason a delivery is canceled
// when its endpoint moves. Kept out of webhook.mjs, which is at its hotspot line budget.

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

/**
 * The reason recorded on a delivery canceled because its endpoint's URL or scope changed after it
 * was queued: an event is delivered only under the destination in effect when it was queued. The
 * admin Worker writes it when a PATCH moves the destination; the backend writes it when its delivery
 * pass finds the event outside the endpoint's current scope.
 */
export const WEBHOOK_ENDPOINT_CHANGED = "endpoint_changed";

/**
 * Per-tenant scope filter, decided by the endpoint's explicit scope_kind. 'global' (operator-wide)
 * receives every event; 'project' ONLY entitlement/order events whose `project` is scope_project;
 * 'customer' ONLY customer events whose `customer_id` is scope_customer_id (entitlement_events carry
 * no customer_id, so not that customer's entitlement changes). Any other kind, or a scoped kind
 * without its value, receives nothing: an endpoint is never global by omission.
 *
 * @param {{ scope_kind?: unknown, scope_project?: unknown, scope_customer_id?: unknown }} endpoint
 * @param {string} source the event source: entitlement, customer or order
 * @param {{ project?: unknown, customer_id?: unknown }} event the event's project / customer_id
 */
export function endpointScopeMatches(endpoint, source, event) {
  const scopeProject = endpoint.scope_project;
  const scopeCustomer = endpoint.scope_customer_id;
  switch (endpoint.scope_kind) {
    case "global":
      return true;
    case "project":
      return source !== "customer" && typeof scopeProject === "string" && scopeProject !== "" && event.project === scopeProject;
    case "customer":
      return source === "customer" && typeof scopeCustomer === "string" && scopeCustomer !== "" && event.customer_id === scopeCustomer;
    default:
      return false;
  }
}

/**
 * The same rule for a queued delivery, read from the payload the dispatcher built when it queued
 * the event (its `data` carries the project or customer_id) against the endpoint's CURRENT scope
 * columns joined onto the delivery row. A payload that does not parse matches only a global scope.
 *
 * @param {{ event_source: string, payload_json: unknown, scope_kind?: unknown, scope_project?: unknown, scope_customer_id?: unknown }} delivery
 */
export function deliveryWithinEndpointScope(delivery) {
  let data = {};
  try {
    const parsed = JSON.parse(String(delivery.payload_json));
    if (parsed !== null && typeof parsed.data === "object" && parsed.data !== null) data = parsed.data;
  } catch {
    // An unreadable payload names no project or customer.
  }
  return endpointScopeMatches(delivery, delivery.event_source, data);
}
