// Validates a webhook endpoint's event_types csv filter against the exact closed set the
// dispatcher can ever emit (WEBHOOK_EVENT_TYPES: the entitlement_events / customer_events CHECK
// constraints in schema.sql, plus the order-ingest intents). Split out of webhooks.ts, which is
// already near its hotspot line budget, so this validator has its own small module.
//
// Shape and membership are DELIBERATELY separate checks. webhook_endpoints.event_types has no
// database CHECK, and the previous validator only checked shape, so an existing row can already
// hold a token outside today's closed set (a legacy value, or one from before a source's list
// changed). Create has no stored row to compare against, so it always enforces both; patch may
// resend that exact legacy value unchanged (the caller compares it against the stored row and
// only calls webhookEventTypesUnknownTokens when the value is new or changed).
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
 * Shape only: event_types is a csv allow-list filter; "" means "all event types". Each entry must
 * be a bare, non-empty token (no comma/newline/NUL/internal whitespace) -- the dispatcher splits
 * on comma and trims. We re-serialize the trimmed tokens so storage is canonical.
 * undefined/null/"" -> "". A malformed csv -> null. Does NOT check token membership.
 */
export function safeWebhookEventTypesShape(value: unknown): string | null {
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
  return tokens.join(",");
}

/**
 * Every token in an already shape-valid csv that WEBHOOK_EVENT_TYPES does not define. Empty for
 * "" or a csv whose every token is known. Matching stays exact (never a prefix or case-insensitive
 * match).
 */
export function webhookEventTypesUnknownTokens(csv: string): string[] {
  if (csv === "") {
    return [];
  }
  return csv.split(",").filter((token) => !ALL_WEBHOOK_EVENT_TYPES.has(token));
}

/**
 * The full CREATE-time check: shape-valid AND every token known (a brand-new row has no stored
 * value to exempt, so this is always enforced). Returns the canonical csv, null (malformed
 * shape), or INVALID_EVENT_TYPES (shape-valid but carrying an unrecognized token).
 */
export function safeWebhookEventTypes(value: unknown): string | null | typeof INVALID_EVENT_TYPES {
  const shape = safeWebhookEventTypesShape(value);
  if (shape === null) {
    return null;
  }
  return webhookEventTypesUnknownTokens(shape).length > 0 ? INVALID_EVENT_TYPES : shape;
}
