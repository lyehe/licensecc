// Pure order-event mutation mapping. Kept separate from wire-shape validation so each
// module stays reviewable while remaining Worker-safe and side-effect-free.

// Reversible "soft disable" intents (a payment problem the customer can fix).
const DISABLE_INTENTS = new Set([
  "subscription.past_due",
  "subscription.paused",
  "subscription.payment_failed",
]);

// Terminal revoke intents (fraud) -- the ONLY path that revokes.
const REVOKE_INTENTS = new Set(["fraud.confirmed", "chargeback"]);

/**
 * Monotone-forward valid_until clamp: max(currentPeriodEnd ?? 0, prevValidUntil ?? 0).
 * A stale/backdated current_period_end can never regress an already-granted window.
 */
export function clampValidUntil(currentPeriodEnd, prevValidUntil) {
  const a = typeof currentPeriodEnd === "number" ? currentPeriodEnd : 0;
  const b = typeof prevValidUntil === "number" ? prevValidUntil : 0;
  return a >= b ? a : b;
}

/**
 * Map a normalized OrderEvent to a PURE mutation descriptor (no DB access). The
 * Stage-4 handler turns the descriptor into a shared-mutator call inside the atomic
 * accept/apply batch.
 *
 *   prev = the current entitlement row (or null if none exists yet). Capacity
 *          downgrade reclaim is derived from this authoritative live row; the
 *          caller's floor guard makes a stale or duplicate redrive reclaim-inert.
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
export function mapIntentToMutation(order, prev) {
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
      // (new pool_size below the authoritative current entitlement pool_size) also
      // emits a reclaim descriptor. The apply batch conditions deletion on this
      // event winning the entitlement floor and accepted->processed transition, so
      // stale and duplicate redrives cannot lose or double-apply the reclaim.
      if (prev === null || prev === undefined) {
        return { kind: "none", terminal: "no_entitlement" };
      }
      const capacity = order.quantity ?? {};
      const newPool = capacity.pool_size;
      const priorPool = typeof prev.pool_size === "number" ? prev.pool_size : undefined;
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
