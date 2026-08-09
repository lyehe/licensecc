// Strict parsers for security rollout modes. These values are deliberately exact:
// accepting a typo, a case variant, or whitespace as "off" silently disables a
// security control. Empty/unset preserves the documented legacy defaults.

function parseMode(raw, supported) {
  if (raw === undefined || raw === null || raw === "") {
    return { valid: true, mode: "off" };
  }
  if (typeof raw === "string" && supported.includes(raw)) {
    return { valid: true, mode: raw };
  }
  return { valid: false, mode: "invalid" };
}

/** Parse ACCOUNT_TOKEN_MODE: off | soft | required (empty/unset defaults to off). */
export function parseAccountTokenMode(env) {
  return parseMode(env?.ACCOUNT_TOKEN_MODE, ["off", "soft", "required"]);
}

/** Parse REQUEST_SIGNATURE_MODE: off | soft | required (empty/unset defaults to off). */
export function parseRequestSignatureMode(env) {
  return parseMode(env?.REQUEST_SIGNATURE_MODE, ["off", "soft", "required"]);
}

/** Parse DEVICE_PROOF_MODE: off | required (empty/unset defaults to off). */
export function parseDeviceProofMode(env) {
  return parseMode(env?.DEVICE_PROOF_MODE, ["off", "required"]);
}

/** Parse ORDER_SIGNER_SCOPE_MODE: off | soft | required (empty/unset defaults to off). */
export function parseOrderSignerScopeMode(env) {
  return parseMode(env?.ORDER_SIGNER_SCOPE_MODE, ["off", "soft", "required"]);
}

// Names only: callers may expose these in health/logs without reflecting a raw
// configuration value (which could be sensitive operational context).
export function invalidSecurityModeNames(env) {
  const invalid = [];
  if (!parseAccountTokenMode(env).valid) invalid.push("ACCOUNT_TOKEN_MODE");
  if (!parseRequestSignatureMode(env).valid) invalid.push("REQUEST_SIGNATURE_MODE");
  if (!parseDeviceProofMode(env).valid) invalid.push("DEVICE_PROOF_MODE");
  if (!parseOrderSignerScopeMode(env).valid) invalid.push("ORDER_SIGNER_SCOPE_MODE");
  return invalid;
}
