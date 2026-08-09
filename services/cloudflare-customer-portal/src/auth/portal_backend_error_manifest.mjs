// Exact non-2xx backend error allowlists for the portal's credential-bearing proxy routes.
//
// These values are derived from the reviewed backend canonical OpenAPI. The portal's
// backend-proxy contract test recomputes the same per-operation/status matrix from that canonical
// fixture and fails on either a missing or an extra code. Keeping the executable allowlist local
// avoids a deployable-to-deployable import while making an upstream error a fail-closed boundary.

function freezeCodes(codes) {
  return Object.freeze([...codes]);
}

function freezeStatuses(entries) {
  return Object.freeze(
    Object.fromEntries(Object.entries(entries).map(([status, codes]) => [status, freezeCodes(codes)])),
  );
}

export const BACKEND_PROXY_ERROR_MANIFEST = Object.freeze({
  checkout: freezeStatuses({
    "400": ["invalid_request"],
    "401": ["unauthorized", "token_revoked", "token_expired"],
    "403": ["floating_disabled", "forbidden_scope", "no_active_entitlement", "device_proof_required", "device_proof_invalid", "borrowing_disabled"],
    "409": ["pool_exhausted"],
    "500": ["seat_signing_error", "verification_error"],
    "503": ["verification_error", "config_error"],
  }),
  heartbeat: freezeStatuses({
    "400": ["invalid_request"],
    "401": ["unauthorized", "token_revoked", "token_expired"],
    "403": ["no_active_entitlement", "forbidden_scope"],
    "410": ["seat_reclaimed"],
    "500": ["seat_signing_error", "verification_error"],
    "503": ["verification_error", "config_error"],
  }),
  release: freezeStatuses({
    "400": ["invalid_request"],
    "401": ["unauthorized", "token_revoked", "token_expired"],
    "403": ["forbidden_scope"],
    "500": ["verification_error"],
    "503": ["verification_error", "config_error"],
  }),
  download: freezeStatuses({
    "400": ["invalid_request"],
    "401": ["unauthorized", "token_revoked", "token_expired"],
    "403": ["no_active_entitlement", "forbidden_scope", "expired_subscription", "device_proof_required", "device_proof_invalid", "device_limit_exceeded", "trial_device_proof_required", "trial_device_locked"],
    "500": ["lease_signing_error", "verification_error"],
    "503": ["verification_error", "config_error"],
  }),
});

/** @param {unknown} operation @param {number} status @param {unknown} code */
export function isAllowedBackendProxyError(operation, status, code) {
  if (typeof operation !== "string" || typeof code !== "string" || code.length === 0) return false;
  const byStatus = BACKEND_PROXY_ERROR_MANIFEST[operation];
  const allowedCodes = byStatus?.[String(status)];
  return Array.isArray(allowedCodes) && allowedCodes.includes(code);
}
