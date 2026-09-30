// Pure, Worker-safe order-event modeling for Slice 1 order-ingest (POST /v1/orders).
// No node:/Buffer; only Web Crypto (crypto.subtle) + standard globals (TextEncoder).
// Bundles identically under wrangler/esbuild and runs raw under `node --test`.
//
// This file is intentionally side-effect-free: it validates a parsed request body
// into an OrderEvent, derives a period-independent license fingerprint, clamps the
// monotone valid_until, and maps an intent to a PURE mutation descriptor. It NEVER
// touches the DB -- the Stage-4 HTTP handler turns these descriptors into the shared
// entitlement mutators (createEntitlement / patchEntitlement / transitionEntitlement /
// setEntitlementCapacity) inside the atomic accept/apply batch.
//
// Design: docs/superpowers/plans/2026-06-24-slice1-order-ingest-blueprint.md

// KNOWN_INTENTS is shared with the admin console's webhook event-types validator (a different
// deployable), so it lives in the licensing-domain package -- imported here, never duplicated.
import { KNOWN_INTENTS } from "@licensecc/licensing-domain/orders/intents";
import { DISABLE_INTENTS, REVOKE_INTENTS } from "./order_mutation.mjs";

export { clampValidUntil, mapIntentToMutation } from "./order_mutation.mjs";

// --- Self-contained validators ----------------------------------------------
// Deliberately defined here so order ingest states its own rules for a "safe" id or
// timestamp: a bounded, single-line, separator-free string id and a non-negative
// safe-integer Unix-seconds value.

// Mirrors the C++ ABI buffer limits LCC_API_ONLINE_PROJECT_SIZE (127) and
// LCC_API_FEATURE_NAME_SIZE (15) in include/licensecc/datatypes.h; keep in sync.
const MAX_PROJECT_SIZE = 127;
const MAX_FEATURE_SIZE = 15;
const MAX_ID_SIZE = 255;
const HEX_64 = /^[0-9a-f]{64}$/;
const ORDER_FIELDS = new Set([
  "event_id", "subscription_id", "project", "feature", "intent", "seq", "order_epoch",
  "license_fingerprint", "current_period_end", "occurred_at", "license_id", "quantity", "customer",
]);
const QUANTITY_FIELDS = new Set(["max_active_devices"]);
const CUSTOMER_FIELDS = new Set(["id", "external_ref", "name", "email"]);

// Grace window (seconds) tolerated past current_period_end before an intent that
// grants access is rejected as invalid_order. Absorbs provider/clock skew so a renewal
// landing slightly after the old period end is not spuriously refused, while a
// clearly-historical period_end (replayed/forged) is still rejected. Resolved
// ambiguity: the blueprint names GRACE but not a value; 1 day matches the order
// of magnitude of provider webhook retry/redrive windows.
const GRACE_SECONDS = 86400;

// Withdrawals may carry a backdated current_period_end. A cancellation at/after period
// end is the whole point of that intent, and a disable or revoke never reads the period
// end: a chargeback or dunning notice routinely arrives after the period it concerns,
// and a withdrawal must always apply.
const PERIOD_EXEMPT_INTENTS = new Set([
  "subscription.canceled_at_period_end",
  ...DISABLE_INTENTS,
  ...REVOKE_INTENTS,
]);

/**
 * A bounded, single-line, separator-free string id: 1..maxLength characters with no
 * CR, LF, "=" or NUL, the INI/HTTP-injection bytes that could escape a signed line.
 * Returns the string or null.
 */
export function safeString(value, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("=") || value.includes("\0")) {
    return null;
  }
  return value;
}

/**
 * A Unix-seconds timestamp: a non-negative safe integer, or null.
 */
export function safeUnixSeconds(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return value;
}

/**
 * True iff value is a finite, non-negative integer. Matches the shared mutators'
 * isNonNegativeInteger so quantity/seq/epoch validation cannot drift.
 */
export function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function hasOnlyFields(value, allowed) {
  return Object.keys(value).every((field) => allowed.has(field));
}

/** A 64-char lowercase-hex string (sha256 fingerprint), or null. */
function safeHex64(value) {
  return typeof value === "string" && HEX_64.test(value) ? value : null;
}

// --- normalizeOrderEvent -----------------------------------------------------

export function orderPeriodIsAcceptable(order, now) {
  if (safeUnixSeconds(now) === null || typeof order !== "object" || order === null) return false;
  return !(
    order.current_period_end !== undefined &&
    !PERIOD_EXEMPT_INTENTS.has(order.intent) &&
    order.current_period_end <= now - GRACE_SECONDS
  );
}

/**
 * Validate a parsed request body into an OrderEvent, or return { error: "<code>" }.
 *
 * Shape (blueprint):
 *   OrderEvent { event_id, subscription_id, order_epoch?=0, seq, intent, project,
 *     feature?, license_fingerprint?, current_period_end?,
 *     quantity?{max_active_devices},
 *     customer{id,external_ref?,name?,email?}, license_id?, occurred_at? }
 *
 * Rules:
 *   - event_id / subscription_id / project are required safeString ids.
 *   - feature defaults to project when omitted (every project has a default feature
 *     equal to the project name); when present it must be a safeString.
 *   - seq is a required non-negative integer; order_epoch defaults to 0.
 *   - license_fingerprint, when present, must be 64-hex.
 *   - current_period_end / occurred_at, when present, are safe unix seconds.
 *   - quantity.max_active_devices, when quantity is present, is a non-negative int.
 *   - customer.id is required on every intent, withdrawals included.
 *   - unknown intent -> invalid_order.
 *   - current_period_end <= now - GRACE for an intent that grants access -> invalid_order
 *     (a backdated period end can never expire/deny an active customer here).
 */
function normalizeOrderEventInternal(parsedBody, now, enforceHistoricalPeriodEnd) {
  if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
    return { error: "invalid_order" };
  }
  if (!hasOnlyFields(parsedBody, ORDER_FIELDS)) return { error: "invalid_order" };
  if (safeUnixSeconds(now) === null) {
    return { error: "invalid_order" };
  }

  const event_id = safeString(parsedBody.event_id, MAX_ID_SIZE);
  if (event_id === null) {
    return { error: "invalid_order" };
  }
  const subscription_id = safeString(parsedBody.subscription_id, MAX_ID_SIZE);
  if (subscription_id === null) {
    return { error: "invalid_order" };
  }
  const project = safeString(parsedBody.project, MAX_PROJECT_SIZE);
  if (project === null) {
    return { error: "invalid_order" };
  }

  // feature defaults to project when omitted; otherwise must be a bounded safe id.
  let feature;
  if (parsedBody.feature === undefined || parsedBody.feature === null) {
    feature = project.length <= MAX_FEATURE_SIZE ? project : null;
  } else {
    feature = safeString(parsedBody.feature, MAX_FEATURE_SIZE);
  }
  if (feature === null) {
    return { error: "invalid_order" };
  }

  const intent = typeof parsedBody.intent === "string" ? parsedBody.intent : null;
  if (intent === null || !KNOWN_INTENTS.has(intent)) {
    return { error: "invalid_order" };
  }

  if (!isNonNegativeInteger(parsedBody.seq)) {
    return { error: "invalid_order" };
  }
  const seq = parsedBody.seq;

  let order_epoch = 0;
  if (parsedBody.order_epoch !== undefined && parsedBody.order_epoch !== null) {
    if (!isNonNegativeInteger(parsedBody.order_epoch)) {
      return { error: "invalid_order" };
    }
    order_epoch = parsedBody.order_epoch;
  }

  // Optional license_fingerprint (supplied path). When present it MUST be 64-hex.
  /** @type {string | null | undefined} */
  let license_fingerprint = undefined;
  if (parsedBody.license_fingerprint !== undefined && parsedBody.license_fingerprint !== null) {
    license_fingerprint = safeHex64(parsedBody.license_fingerprint);
    if (license_fingerprint === null) {
      return { error: "invalid_order" };
    }
  }

  // Optional times.
  /** @type {number | null | undefined} */
  let current_period_end = undefined;
  if (parsedBody.current_period_end !== undefined && parsedBody.current_period_end !== null) {
    current_period_end = safeUnixSeconds(parsedBody.current_period_end);
    if (current_period_end === null) {
      return { error: "invalid_order" };
    }
  }
  /** @type {number | null | undefined} */
  let occurred_at = undefined;
  if (parsedBody.occurred_at !== undefined && parsedBody.occurred_at !== null) {
    occurred_at = safeUnixSeconds(parsedBody.occurred_at);
    if (occurred_at === null) {
      return { error: "invalid_order" };
    }
  }

  // Optional license_id (a bounded id, not a fingerprint).
  /** @type {string | null | undefined} */
  let license_id = undefined;
  if (parsedBody.license_id !== undefined && parsedBody.license_id !== null) {
    license_id = safeString(parsedBody.license_id, MAX_ID_SIZE);
    if (license_id === null) {
      return { error: "invalid_order" };
    }
  }

  // Optional quantity { max_active_devices } -- a non-negative int. A pool size is not
  // an order field: every order grant is a protected, device-bound grant.
  /** @type {{max_active_devices: number} | undefined} */
  let quantity = undefined;
  if (parsedBody.quantity !== undefined && parsedBody.quantity !== null) {
    const q = parsedBody.quantity;
    if (typeof q !== "object" || Array.isArray(q) || !hasOnlyFields(q, QUANTITY_FIELDS)) {
      return { error: "invalid_order" };
    }
    if (!isNonNegativeInteger(q.max_active_devices)) return { error: "invalid_order" };
    quantity = { max_active_devices: q.max_active_devices };
  }
  if (intent === "quantity.changed" && quantity === undefined) return { error: "invalid_order" };

  // Required customer { id, external_ref?, name?, email? } on every intent: a grant always
  // has an owner, and a withdrawal names the same customer as the subscription it ends.
  // ids are bounded safe strings; name/email are looser (not embedded into any signed
  // line) but bounded.
  const c = parsedBody.customer;
  if (typeof c !== "object" || c === null || Array.isArray(c) || !hasOnlyFields(c, CUSTOMER_FIELDS)) {
    return { error: "invalid_order" };
  }
  const customerId = safeString(c.id, MAX_ID_SIZE);
  if (customerId === null) return { error: "invalid_order" };
  /** @type {{id: string, external_ref?: string, name?: string, email?: string}} */
  const customer = { id: customerId };
  if (c.external_ref !== undefined && c.external_ref !== null) {
    const ref = safeString(c.external_ref, MAX_ID_SIZE);
    if (ref === null) {
      return { error: "invalid_order" };
    }
    customer.external_ref = ref;
  }
  if (c.name !== undefined && c.name !== null) {
    if (typeof c.name !== "string" || c.name.length > MAX_ID_SIZE) {
      return { error: "invalid_order" };
    }
    customer.name = c.name;
  }
  if (c.email !== undefined && c.email !== null) {
    if (typeof c.email !== "string" || c.email.length > MAX_ID_SIZE) {
      return { error: "invalid_order" };
    }
    customer.email = c.email;
  }

  // A backdated period end may not deny/expire an active customer. Reject a clearly
  // historical period_end for an intent that grants access; withdrawals are exempt
  // (see PERIOD_EXEMPT_INTENTS).
  if (enforceHistoricalPeriodEnd && !orderPeriodIsAcceptable({ current_period_end, intent }, now)) {
    return { error: "invalid_order" };
  }

  const order = {
    event_id,
    subscription_id,
    order_epoch,
    seq,
    intent,
    project,
    feature,
  };
  if (license_fingerprint !== undefined) order.license_fingerprint = license_fingerprint;
  if (current_period_end !== undefined) order.current_period_end = current_period_end;
  if (quantity !== undefined) order.quantity = quantity;
  order.customer = customer;
  if (license_id !== undefined) order.license_id = license_id;
  if (occurred_at !== undefined) order.occurred_at = occurred_at;
  return order;
}

/** Normalize a new order and enforce the historical-period safety gate. */
export function normalizeOrderEvent(parsedBody, now) {
  return normalizeOrderEventInternal(parsedBody, now, true);
}

/**
 * Normalize authenticated wire data before durable event-id lookup. Callers must apply
 * `orderPeriodIsAcceptable` on an event-id miss; matching cached/accepted rows may redrive after
 * the grace window because their payload was already durably accepted.
 */
export function normalizeOrderEventForReplay(parsedBody, now) {
  return normalizeOrderEventInternal(parsedBody, now, false);
}

// --- deriveFingerprint -------------------------------------------------------

function bytesToHex(bytes) {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Derive the license fingerprint for an order, period-independent (stable across
 * renewals: never folds current_period_end / seq / epoch into the hash).
 *
 *   supplied present (64-hex) -> { fingerprint: supplied, origin: 'supplied' }
 *   else                      -> { fingerprint: hex(sha256(`${subscription_id}:${project}:${feature}`)),
 *                                  origin: 'derived' }
 */
export async function deriveFingerprint({ subscription_id, project, feature, supplied }) {
  const validSupplied = safeHex64(supplied);
  if (validSupplied !== null) {
    return { fingerprint: validSupplied, origin: "supplied" };
  }
  const material = `${subscription_id}:${project}:${feature}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return { fingerprint: bytesToHex(new Uint8Array(digest)), origin: "derived" };
}
