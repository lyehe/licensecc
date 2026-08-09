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

function freezeDescriptor(descriptor) {
  const frozen = { ...descriptor };
  if (Array.isArray(frozen.enum)) frozen.enum = freezeCodes(frozen.enum);
  return Object.freeze(frozen);
}

function freezeSuccess(fields, codes = []) {
  return Object.freeze({
    codes: freezeCodes(codes),
    fields: Object.freeze(
      Object.fromEntries(Object.entries(fields).map(([name, descriptor]) => [name, freezeDescriptor(descriptor)])),
    ),
  });
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

// Exact 200 success shapes for the portal's credential-bearing proxy operations. Like the error
// manifest above, these values are mechanically cross-checked against the reviewed backend
// canonical OpenAPI by the portal contract test. The backend's current 200 schemas do not expose a
// `code` field, so a present code is rejected rather than trusted. Required fields are copied into
// a fresh output object; forward-compatible backend additions stay non-observable at this boundary.
export const BACKEND_PROXY_SUCCESS_MANIFEST = Object.freeze({
  checkout: freezeSuccess({
    assertion: { type: "string" },
    seat_id: { type: "string" },
    mode: { type: "string", enum: ["live", "borrowed"] },
    server_time: { type: "integer" },
    expires_at: { type: "integer" },
    heartbeat_in: { type: "integer" },
  }),
  heartbeat: freezeSuccess({
    assertion: { type: "string" },
    server_time: { type: "integer" },
    expires_at: { type: "integer" },
    heartbeat_in: { type: "integer" },
  }),
  release: freezeSuccess({
    server_time: { type: "integer" },
  }),
  download: freezeSuccess({
    lic: { type: "string" },
    server_time: { type: "integer" },
    renew_by: { type: "integer" },
    valid_to_epoch: { type: "integer" },
  }),
});

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {object} value @param {string} key */
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function matchesSuccessField(value, descriptor) {
  if (descriptor.type === "string" && typeof value !== "string") return false;
  if (descriptor.type === "integer" && (!Number.isFinite(value) || !Number.isInteger(value))) return false;
  if (Array.isArray(descriptor.enum) && !descriptor.enum.includes(value)) return false;
  return true;
}

/**
 * Validate a canonical 200 success body and copy only its approved fields.
 * @param {unknown} operation @param {unknown} value
 * @returns {{ data: Record<string, unknown>, code?: string } | null}
 */
export function sanitizeBackendProxySuccess(operation, value) {
  if (typeof operation !== "string" || !isRecord(value) || value.ok !== true) return null;
  const manifest = BACKEND_PROXY_SUCCESS_MANIFEST[operation];
  if (manifest === undefined) return null;
  /** @type {string | undefined} */
  let code;
  if (hasOwn(value, "code")) {
    const upstreamCode = value.code;
    if (typeof upstreamCode !== "string" || !manifest.codes.includes(upstreamCode)) return null;
    code = upstreamCode;
  }
  /** @type {Record<string, unknown>} */
  const data = {};
  for (const [name, descriptor] of Object.entries(manifest.fields)) {
    if (!hasOwn(value, name) || !matchesSuccessField(value[name], descriptor)) return null;
    data[name] = value[name];
  }
  return code === undefined ? { data } : { data, code };
}
