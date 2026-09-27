// Validates a webhook endpoint's event_types csv filter against the exact closed set the
// dispatcher can ever emit (WEBHOOK_EVENT_TYPES: the entitlement_events / customer_events CHECK
// constraints in schema.sql, plus the order-ingest intents). Split out of webhooks.ts, which is
// already near its hotspot line budget, so this validator has its own small module.
import { WEBHOOK_EVENT_TYPES } from "@licensecc/cloudflare-runtime/webhooks/event_types";

export { WEBHOOK_EVENT_TYPES };

const ALL_WEBHOOK_EVENT_TYPES = new Set<string>([
  ...WEBHOOK_EVENT_TYPES.entitlement,
  ...WEBHOOK_EVENT_TYPES.customer,
  ...WEBHOOK_EVENT_TYPES.order,
]);

const MAX_WEBHOOK_EVENT_TYPES_SIZE = 1024;

// Distinguishes an unknown event_types TOKEN (-> 400 invalid_event_types + the allowed list) from
// a merely malformed csv (-> 400 invalid_request, the existing behavior). Matching stays exact.
export const INVALID_EVENT_TYPES = Symbol("invalid_event_types");

/**
 * event_types is a csv allow-list filter; "" means "all event types". Each entry must be a bare,
 * non-empty token (no comma/newline/NUL/internal whitespace) drawn from WEBHOOK_EVENT_TYPES --
 * a token outside that set can never match a real event. undefined/null/"" -> "" (all). A
 * malformed csv -> null. An otherwise well-formed csv with an unrecognized token ->
 * INVALID_EVENT_TYPES. We re-serialize the trimmed tokens so storage is canonical.
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
  // Reject a token carrying a stray comma-equivalent or whitespace (split already removed
  // commas; guard internal whitespace so "a b" can never masquerade as one event type).
  for (const token of tokens) {
    if (/\s/.test(token)) {
      return null;
    }
  }
  for (const token of tokens) {
    if (!ALL_WEBHOOK_EVENT_TYPES.has(token)) {
      return INVALID_EVENT_TYPES;
    }
  }
  return tokens.join(",");
}
