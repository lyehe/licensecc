// Strict outbound-destination policy for portal credentials and backend requests.
//
// A configured endpoint is deliberately an origin, not a URL prefix: accepting a path, userinfo,
// query, or fragment would make a typo/configuration value capable of changing a credential-bearing
// request target. There is intentionally no HTTP local-development exception. Tests and the tracked
// example use HTTPS, so development must use an HTTPS local endpoint when it overrides a destination.

const DEFAULT_EMAIL_API_ORIGIN = "https://api.resend.com";
const MAX_DESTINATION_LENGTH = 2048;

/**
 * Return the exact canonical HTTPS origin for an origin-only configuration value, otherwise null.
 * A single terminal slash is accepted because URL serialisation adds it to a bare origin; all other
 * non-canonical spellings, paths, credentials, queries, fragments, and non-HTTPS schemes are denied.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function canonicalHttpsOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DESTINATION_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin === "null" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  const origin = parsed.origin;
  return value === origin || value === `${origin}/` ? origin : null;
}

/** @param {{ BACKEND_ORIGIN?: unknown } | null | undefined} env */
export function backendOrigin(env) {
  return canonicalHttpsOrigin(env?.BACKEND_ORIGIN);
}

/** @param {{ PORTAL_EMAIL_API_BASE?: unknown } | null | undefined} env */
export function emailApiOrigin(env) {
  const configured = env?.PORTAL_EMAIL_API_BASE;
  if (configured === undefined || configured === "") return canonicalHttpsOrigin(DEFAULT_EMAIL_API_ORIGIN);
  return canonicalHttpsOrigin(configured);
}
