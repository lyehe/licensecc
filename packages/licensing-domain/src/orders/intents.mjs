// Order-ingest intents: the full closed set of subscription/order lifecycle intents the
// order-ingest contract understands (POST /v1/orders). Anything else is invalid_order
// (backend) -- never silently ignored.
//
// Moved out of services/cloudflare-licensing-backend/src/fulfillment/order_event.mjs so a
// different deployable (the admin console's webhook validator) can reference the exact same
// closed set for its "order" event-type source without importing across service boundaries
// (the repo forbids deployable-to-deployable imports; shared code lives in a package).

export const ORDER_INTENTS = Object.freeze([
  "subscription.active",
  "subscription.renewed",
  "subscription.past_due",
  "subscription.paused",
  "subscription.payment_failed",
  "subscription.canceled_at_period_end",
  "subscription.resumed",
  "quantity.changed",
  "fraud.confirmed",
  "chargeback",
]);

// Built from ORDER_INTENTS (never hand-duplicated) so the two can never drift.
export const KNOWN_INTENTS = new Set(ORDER_INTENTS);
