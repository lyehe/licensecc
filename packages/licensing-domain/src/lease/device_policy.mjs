// Pure policy used by the protected lease implementation. Dates are UTC
// seconds; local monotonic durations are milliseconds, never wall-clock time.
export const DEVICE_LEASE_SECONDS = 86400;
export const DEVICE_ACCEPTANCE_ALLOWANCE = 120;

function safe(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_integer");
  return value;
}

export function deviceLeaseWindow(issuedAt, entitlementUntil) {
  safe(issuedAt);
  if (entitlementUntil !== null) safe(entitlementUntil);
  const duration = Math.min(DEVICE_LEASE_SECONDS, entitlementUntil === null ? DEVICE_LEASE_SECONDS : entitlementUntil - issuedAt);
  const expiresAt = safe(issuedAt + duration);
  // There must be a strictly positive interval on either side of renew-after.
  if (expiresAt - issuedAt < 2) throw new Error("entitlement_expired");
  return { issuedAt, renewAfter: issuedAt + Math.floor((expiresAt - issuedAt) / 2), expiresAt,
    acceptUntil: safe(expiresAt + DEVICE_ACCEPTANCE_ALLOWANCE) };
}

export function bindingOccupiesSlot(state, holdUntil, now) {
  safe(holdUntil); safe(now);
  if (!["active", "retiring", "released"].includes(state)) throw new Error("invalid_binding_state");
  return state === "active" || (state === "retiring" && holdUntil > now);
}

export function deviceLeaseEffectiveTime(issuedAt, originalSendMs, currentMs) {
  safe(issuedAt);
  if (!Number.isFinite(originalSendMs) || !Number.isFinite(currentMs) || originalSendMs < 0 || currentMs < originalSendMs || currentMs > Number.MAX_SAFE_INTEGER) throw new Error("clock_continuity_lost");
  // Full elapsed time deliberately includes the complete network/signing delay.
  // Never replace originalSendMs with receipt time or a later retry's send time.
  return safe(issuedAt + Math.ceil((currentMs - originalSendMs) / 1000));
}

export function assertDeviceLeaseAnchor(claims, operationId, issuedForCurrentProcess) {
  if (issuedForCurrentProcess !== true || typeof operationId !== "string" || operationId.length === 0 || claims["operation-id"] !== operationId) throw new Error("fresh_renewal_required");
}
