// WEBHOOK_EVENT_TYPES: the exact closed set of event_type tokens the webhook dispatcher's three
// audit-table sources (entitlement_events, customer_events, order_events -- see webhook.mjs's
// WEBHOOK_EVENT_SOURCES) can ever emit. This is the full allow-list an endpoint's event_types csv
// filter may reference; the admin console's create/patch validators reject any other token with
// invalid_event_types.
//
// Deliberately its own module, not added to webhook.mjs (already near its hotspot line budget),
// so admin validation and the schema-parity test can import this list without growing that file.
//
// entitlement mirrors the entitlement_events.event_type CHECK constraint (schema.sql); customer
// mirrors the customer_events.event_type CHECK constraint (schema.sql); order mirrors the
// order-ingest intents (ORDER_INTENTS) -- the SAME closed set order_event.mjs validates a
// POST /v1/orders body's `intent` field against. A dedicated test parses schema.sql and asserts
// the entitlement/customer lists below stay equal to their CHECK constraints, so they cannot drift.
import { ORDER_INTENTS } from "@licensecc/licensing-domain/orders/intents";

export const WEBHOOK_EVENT_TYPES = Object.freeze({
  entitlement: Object.freeze(["create", "update", "disable", "reenable", "revoke", "upsert", "revoked-override"]),
  // "disable"/"reenable" also appear in `entitlement` above: customer_events and entitlement_events
  // both emit those exact event_type tokens, so a webhook filter on "disable" (or "reenable") alone
  // matches events from EITHER source -- there is no way to scope it to just one.
  customer: Object.freeze(["disable", "reenable"]),
  order: Object.freeze([...ORDER_INTENTS]),
});
