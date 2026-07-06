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

// --- Self-contained validators ----------------------------------------------
// Deliberately defined here (not imported from src/index.ts, whose copies are
// un-exported TypeScript internals) so this module is import-free and bundles
// standalone. Kept consistent IN SPIRIT with the repo's existing safeString /
// safeUnixSeconds / isNonNegativeInteger so order-ingest cannot drift from the
// rest of the backend's notion of a "safe" id or timestamp.

// Mirrors the C++ ABI buffer limits LCC_API_ONLINE_PROJECT_SIZE (127) and
// LCC_API_FEATURE_NAME_SIZE (15); keep in sync with src/index.ts.
const MAX_PROJECT_SIZE = 127;
const MAX_FEATURE_SIZE = 15;
const MAX_ID_SIZE = 255;
const HEX_64 = /^[0-9a-f]{64}$/;

// Grace window (seconds) tolerated past current_period_end before a non-cancel
// intent is rejected as invalid_order. Absorbs provider/clock skew so a renewal
// landing slightly after the old period end is not spuriously refused, while a
// clearly-historical period_end (replayed/forged) is still rejected. Resolved
// ambiguity: the blueprint names GRACE but not a value; 1 day matches the order
// of magnitude of provider webhook retry/redrive windows.
const GRACE_SECONDS = 86400;

// Intents that are allowed to carry a backdated current_period_end (a cancellation
// at/after period end is the WHOLE point of these intents).
const CANCEL_INTENTS = new Set(["subscription.canceled_at_period_end"]);

// The full closed set of intents the order-ingest contract understands. Anything
// else is invalid_order (never silently ignored).
const KNOWN_INTENTS = new Set([
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

/**
 * A bounded, single-line, separator-free string id (matches src/index.ts safeString
 * in spirit: rejects the INI/HTTP-injection bytes that could escape a signed line).
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
 * A non-negative, safe integer unix-seconds timestamp, or null. Matches
 * src/index.ts safeUnixSeconds.
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

/** A 64-char lowercase-hex string (sha256 fingerprint), or null. */
function safeHex64(value) {
  return typeof value === "string" && HEX_64.test(value) ? value : null;
}

// --- normalizeOrderEvent -----------------------------------------------------

/**
 * Validate a parsed request body into an OrderEvent, or return { error: "<code>" }.
 *
 * Shape (blueprint):
 *   OrderEvent { event_id, subscription_id, order_epoch?=0, seq, intent, project,
 *     feature?, license_fingerprint?, current_period_end?,
 *     quantity?{pool_size?,max_active_devices?},
 *     customer?{id?,external_ref?,name?,email?}, license_id?, occurred_at? }
 *
 * Rules:
 *   - event_id / subscription_id / project are required safeString ids.
 *   - feature defaults to project when omitted (every project has a default feature
 *     equal to the project name); when present it must be a safeString.
 *   - seq is a required non-negative integer; order_epoch defaults to 0.
 *   - license_fingerprint, when present, must be 64-hex.
 *   - current_period_end / occurred_at, when present, are safe unix seconds.
 *   - quantity pool_size / max_active_devices, when present, are non-negative ints.
 *   - unknown intent -> invalid_order.
 *   - current_period_end <= now - GRACE for a non-cancel intent -> invalid_order
 *     (a backdated period end can never expire/deny an active customer here).
 */
export function normalizeOrderEvent(parsedBody, now) {
  if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
    return { error: "invalid_order" };
  }
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
  let license_fingerprint = undefined;
  if (parsedBody.license_fingerprint !== undefined && parsedBody.license_fingerprint !== null) {
    license_fingerprint = safeHex64(parsedBody.license_fingerprint);
    if (license_fingerprint === null) {
      return { error: "invalid_order" };
    }
  }

  // Optional times.
  let current_period_end = undefined;
  if (parsedBody.current_period_end !== undefined && parsedBody.current_period_end !== null) {
    current_period_end = safeUnixSeconds(parsedBody.current_period_end);
    if (current_period_end === null) {
      return { error: "invalid_order" };
    }
  }
  let occurred_at = undefined;
  if (parsedBody.occurred_at !== undefined && parsedBody.occurred_at !== null) {
    occurred_at = safeUnixSeconds(parsedBody.occurred_at);
    if (occurred_at === null) {
      return { error: "invalid_order" };
    }
  }

  // Optional license_id (a bounded id, not a fingerprint).
  let license_id = undefined;
  if (parsedBody.license_id !== undefined && parsedBody.license_id !== null) {
    license_id = safeString(parsedBody.license_id, MAX_ID_SIZE);
    if (license_id === null) {
      return { error: "invalid_order" };
    }
  }

  // Optional quantity { pool_size?, max_active_devices? } -- non-negative ints.
  let quantity = undefined;
  if (parsedBody.quantity !== undefined && parsedBody.quantity !== null) {
    const q = parsedBody.quantity;
    if (typeof q !== "object" || Array.isArray(q)) {
      return { error: "invalid_order" };
    }
    const out = {};
    if (q.pool_size !== undefined && q.pool_size !== null) {
      if (!isNonNegativeInteger(q.pool_size)) {
        return { error: "invalid_order" };
      }
      out.pool_size = q.pool_size;
    }
    if (q.max_active_devices !== undefined && q.max_active_devices !== null) {
      if (!isNonNegativeInteger(q.max_active_devices)) {
        return { error: "invalid_order" };
      }
      out.max_active_devices = q.max_active_devices;
    }
    quantity = out;
  }

  // Optional customer { id?, external_ref?, name?, email? }. ids are bounded safe
  // strings; name/email are looser (not embedded into any signed line) but bounded.
  let customer = undefined;
  if (parsedBody.customer !== undefined && parsedBody.customer !== null) {
    const c = parsedBody.customer;
    if (typeof c !== "object" || Array.isArray(c)) {
      return { error: "invalid_order" };
    }
    const out = {};
    if (c.id !== undefined && c.id !== null) {
      const id = safeString(c.id, MAX_ID_SIZE);
      if (id === null) {
        return { error: "invalid_order" };
      }
      out.id = id;
    }
    if (c.external_ref !== undefined && c.external_ref !== null) {
      const ref = safeString(c.external_ref, MAX_ID_SIZE);
      if (ref === null) {
        return { error: "invalid_order" };
      }
      out.external_ref = ref;
    }
    if (c.name !== undefined && c.name !== null) {
      if (typeof c.name !== "string" || c.name.length > MAX_ID_SIZE) {
        return { error: "invalid_order" };
      }
      out.name = c.name;
    }
    if (c.email !== undefined && c.email !== null) {
      if (typeof c.email !== "string" || c.email.length > MAX_ID_SIZE) {
        return { error: "invalid_order" };
      }
      out.email = c.email;
    }
    customer = out;
  }

  // A backdated period end may not deny/expire an active customer. Reject a clearly
  // historical period_end for non-cancel intents; cancellations are exempt (their
  // whole purpose is to wind down at/after a past period end).
  if (
    current_period_end !== undefined &&
    !CANCEL_INTENTS.has(intent) &&
    current_period_end <= now - GRACE_SECONDS
  ) {
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
  if (customer !== undefined) order.customer = customer;
  if (license_id !== undefined) order.license_id = license_id;
  if (occurred_at !== undefined) order.occurred_at = occurred_at;
  return order;
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

// --- clampValidUntil ---------------------------------------------------------

/**
 * Monotone-forward valid_until clamp: max(currentPeriodEnd ?? 0, prevValidUntil ?? 0).
 * A stale/backdated current_period_end can never regress an already-granted window.
 */
export function clampValidUntil(currentPeriodEnd, prevValidUntil) {
  const a = typeof currentPeriodEnd === "number" ? currentPeriodEnd : 0;
  const b = typeof prevValidUntil === "number" ? prevValidUntil : 0;
  return a >= b ? a : b;
}

// --- mapIntentToMutation -----------------------------------------------------

// Reversible "soft disable" intents (a payment problem the customer can fix).
const DISABLE_INTENTS = new Set([
  "subscription.past_due",
  "subscription.paused",
  "subscription.payment_failed",
]);
// Terminal revoke intents (fraud) -- the ONLY path that revokes.
const REVOKE_INTENTS = new Set(["fraud.confirmed", "chargeback"]);

/**
 * Map a normalized OrderEvent to a PURE mutation descriptor (no DB access). The
 * Stage-4 handler turns the descriptor into a shared-mutator call inside the atomic
 * accept/apply batch.
 *
 *   prev             = the current entitlement row (or null if none exists yet)
 *   priorAppliedEvent = the previously-applied OrderEvent for this subscription
 *                       (or null) -- used to compute a quantity downgrade diff from
 *                       the prior payload, never from live state (crash-redrive safe).
 *
 * Descriptor shape:
 *   {
 *     kind: 'create'|'patch'|'transition'|'capacity'|'reclaim'|'none',
 *     status?, valid_until?, valid_from?, capacity?, eventType?,
 *     terminal?: 'no_entitlement'|'revoked',
 *     reclaim?: { from, to },
 *   }
 *
 * Invariants enforced here:
 *   - createEntitlement is reserved STRICTLY for subscription.active.
 *   - modify-intents on a missing prev -> { kind:'none', terminal:'no_entitlement' }.
 *   - a revoked prev (terminal) -> { kind:'none', terminal:'revoked' }.
 *   - cancel never creates.
 *   - valid_until is the monotone clamp; valid_from < valid_until is asserted by
 *     surfacing valid_from only when it is strictly less than the clamped valid_until.
 */
export function mapIntentToMutation(order, prev, priorAppliedEvent) {
  const intent = order.intent;
  const prevRevoked = prev !== null && prev !== undefined && prev.status === "revoked";

  // A revoked entitlement is terminal for EVERY intent except a fresh revoke (which
  // is idempotent). No modify/create/capacity may touch it.
  if (prevRevoked && !REVOKE_INTENTS.has(intent)) {
    return { kind: "none", terminal: "revoked" };
  }

  const prevValidUntil = prev && typeof prev.valid_until === "number" ? prev.valid_until : 0;
  const clampedValidUntil = clampValidUntil(order.current_period_end, prevValidUntil);

  // valid_from < valid_until rule: only surface a valid_from when it is strictly
  // before the clamped valid_until (a zero/absent clamp means "non-expiring").
  function withWindow(descriptor) {
    if (clampedValidUntil > 0) {
      descriptor.valid_until = clampedValidUntil;
      const validFrom = prev && typeof prev.valid_from === "number" ? prev.valid_from : 0;
      if (validFrom < clampedValidUntil) {
        descriptor.valid_from = validFrom;
      }
    } else {
      // Non-expiring (no finite period end and no prior window): leave open-ended.
      descriptor.valid_until = null;
    }
    return descriptor;
  }

  switch (intent) {
    case "subscription.active":
      // The ONLY creator. Materializes (or refreshes) an active entitlement.
      return withWindow({ kind: "create", status: "active", eventType: "create" });

    case "subscription.renewed": {
      // patchEntitlement (missing -> null). Carry-forward customer_id/license_id is
      // the handler's job (omitted fields keep prev values); here we only assert the
      // forward clamp + active status.
      if (prev === null || prev === undefined) {
        return { kind: "none", terminal: "no_entitlement" };
      }
      return withWindow({ kind: "patch", status: "active", eventType: "update" });
    }

    case "subscription.canceled_at_period_end": {
      // Keep active until period end; NEVER create. valid_until clamps to the
      // (monotone) period end so access winds down exactly when the period ends.
      if (prev === null || prev === undefined) {
        return { kind: "none", terminal: "no_entitlement" };
      }
      return withWindow({ kind: "patch", status: "active", eventType: "update" });
    }

    case "subscription.resumed": {
      // Re-enable a reversibly-disabled entitlement.
      if (prev === null || prev === undefined) {
        return { kind: "none", terminal: "no_entitlement" };
      }
      return { kind: "transition", status: "active", eventType: "reenable" };
    }

    case "quantity.changed": {
      // Capacity change on an existing entitlement (never creates). A downgrade
      // (new pool_size below the prior applied pool_size) also emits a reclaim
      // descriptor; the diff is computed against the PRIOR APPLIED EVENT's payload,
      // not live seat state, so crash-redrive cannot lose or double-apply it.
      if (prev === null || prev === undefined) {
        return { kind: "none", terminal: "no_entitlement" };
      }
      const capacity = order.quantity ?? {};
      const newPool = capacity.pool_size;
      const priorPool =
        priorAppliedEvent &&
        priorAppliedEvent.quantity &&
        typeof priorAppliedEvent.quantity.pool_size === "number"
          ? priorAppliedEvent.quantity.pool_size
          : undefined;
      const descriptor = { kind: "capacity", capacity, eventType: "update" };
      if (
        typeof newPool === "number" &&
        typeof priorPool === "number" &&
        newPool < priorPool
      ) {
        descriptor.reclaim = { from: priorPool, to: newPool };
      }
      return descriptor;
    }

    default:
      break;
  }

  if (DISABLE_INTENTS.has(intent)) {
    // Reversible soft-disable. Missing prev -> never materialize access.
    if (prev === null || prev === undefined) {
      return { kind: "none", terminal: "no_entitlement" };
    }
    return { kind: "transition", status: "disabled", eventType: "disable" };
  }

  if (REVOKE_INTENTS.has(intent)) {
    // Terminal revoke -- the ONLY revoke path. Missing prev -> nothing to revoke.
    if (prev === null || prev === undefined) {
      return { kind: "none", terminal: "no_entitlement" };
    }
    return { kind: "transition", status: "revoked", eventType: "revoke", terminal: "revoked" };
  }

  // Unreachable for normalized input (normalizeOrderEvent rejects unknown intents).
  return { kind: "none", terminal: "no_entitlement" };
}
