// Strict parsers for security rollout modes. These values are deliberately exact:
// accepting a typo, a case variant, or whitespace as "off" silently disables a
// security control. Empty/unset preserves the documented off default.

function parseMode(raw, supported) {
  if (raw === undefined || raw === null || raw === "") {
    return { valid: true, mode: "off" };
  }
  if (typeof raw === "string" && supported.includes(raw)) {
    return { valid: true, mode: raw };
  }
  return { valid: false, mode: "invalid" };
}

/** Parse ORDER_SIGNER_SCOPE_MODE: off | soft | required (empty/unset defaults to off). */
export function parseOrderSignerScopeMode(env) {
  return parseMode(env?.ORDER_SIGNER_SCOPE_MODE, ["off", "soft", "required"]);
}

// Names only: callers may expose these in health/logs without reflecting a raw
// configuration value (which could be sensitive operational context).
export function invalidSecurityModeNames(env) {
  const invalid = [];
  if (!parseOrderSignerScopeMode(env).valid) invalid.push("ORDER_SIGNER_SCOPE_MODE");
  return invalid;
}
