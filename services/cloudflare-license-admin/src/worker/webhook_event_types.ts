// Validates a webhook endpoint's event_types csv filter against the exact closed set the
// dispatcher can ever emit (WEBHOOK_EVENT_TYPES: the entitlement_events / customer_events CHECK
// constraints in schema.sql, plus the order-ingest intents). Split out of webhooks.ts so this
// validator has its own small module.
//
// One check covers shape and membership, and create and every PATCH run it on the full set. The
// baseline's tr_webhook_event_types_known_insert/_update triggers refuse the same tokens, so a
// stored row never holds a token outside this set.
import { WEBHOOK_EVENT_TYPES } from "@licensecc/cloudflare-runtime/webhooks/event_types";

export { WEBHOOK_EVENT_TYPES };

const ALL_WEBHOOK_EVENT_TYPES = new Set<string>([
  ...WEBHOOK_EVENT_TYPES.entitlement,
  ...WEBHOOK_EVENT_TYPES.customer,
  ...WEBHOOK_EVENT_TYPES.order,
]);

const MAX_WEBHOOK_EVENT_TYPES_SIZE = 1024;

// Distinguishes an unknown event_types TOKEN (-> 400 invalid_event_types + the allowed list) from
// a merely malformed csv (-> 400 invalid_request). Matching stays exact.
export const INVALID_EVENT_TYPES = Symbol("invalid_event_types");

/**
 * event_types is a csv allow-list filter; "" means "all event types". Each entry must be a bare,
 * non-empty token (no comma/newline/NUL/internal whitespace) -- the dispatcher splits on comma and
 * trims -- that WEBHOOK_EVENT_TYPES defines, matched exactly (never a prefix or case-insensitive
 * match). Returns the canonical csv (the trimmed tokens, empty entries dropped), null for a
 * malformed csv, or INVALID_EVENT_TYPES for a well-formed csv naming an unknown token.
 * undefined/null/"" -> "".
 */
export function safeWebhookEventTypes(value: unknown): string | null | typeof INVALID_EVENT_TYPES {
  if (value === undefined || value === "" || value === null) {
    return "";
  }
  if (typeof value !== "string" || value.length > MAX_WEBHOOK_EVENT_TYPES_SIZE) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return null;
  }
  const tokens = value.split(",").map((token) => token.trim()).filter((token) => token.length > 0);
  // Reject a token carrying internal whitespace, so "a b" can never masquerade as one event type.
  if (tokens.some((token) => /\s/.test(token))) {
    return null;
  }
  return tokens.every((token) => ALL_WEBHOOK_EVENT_TYPES.has(token)) ? tokens.join(",") : INVALID_EVENT_TYPES;
}
