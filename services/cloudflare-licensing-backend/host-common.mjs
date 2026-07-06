// host-common.mjs
//
// Shared SECURITY helpers for the off-Cloudflare node:http hosts (local-host/server.mjs and
// supabase-postgres/server.mjs). Running /v1/verify off Cloudflare removes the edge that the
// Worker assumes: the WAF, the per-client rate limiter, and — critically — a TRUSTWORTHY
// `cf-connecting-ip`. Off Cloudflare that header is attacker-supplied, so a client could send
// a random `Cf-Connecting-Ip` per request and land each one in a fresh rate-limit bucket
// (the Worker keys its per-client tier on `cf-connecting-ip`). These helpers close that gap.

// Headers that identify the caller for rate limiting. The host STRIPS any inbound value and
// re-derives `cf-connecting-ip` from a trustworthy source, so a client cannot spoof its IP.
export const CLIENT_IP_HEADERS = ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"];

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]); // NB: 0.0.0.0 is "all interfaces", NOT loopback

export function isLoopback(host) {
  return LOOPBACK.has(String(host));
}

// Strip an IPv4-mapped-IPv6 prefix so 127.0.0.1 and ::ffff:127.0.0.1 key identically.
function normalizeIp(ip) {
  const s = String(ip);
  return s.startsWith("::ffff:") ? s.slice(7) : s;
}

/**
 * The trustworthy client IP for rate limiting. Default: the real socket peer (`remoteAddress`).
 * If `TRUST_PROXY_HEADER` is set (e.g. "x-real-ip" or "x-forwarded-for"), read the RIGHTMOST
 * value of that header — the hop the immediate trusted proxy added. The operator MUST run a
 * reverse proxy that overwrites/appends that header from untrusted clients for this to be safe.
 * @param {import("node:http").IncomingMessage} req
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function clientIpFromRequest(req, env = process.env) {
  const trustHeader = env.TRUST_PROXY_HEADER;
  if (trustHeader) {
    const raw = req.headers?.[String(trustHeader).toLowerCase()];
    const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if (value) {
      const ip = String(value).split(",").map((s) => s.trim()).filter(Boolean).pop();
      if (ip) return normalizeIp(ip);
    }
  }
  return normalizeIp(req.socket?.remoteAddress ?? "unknown");
}

/**
 * Refuse to expose an UNTHROTTLED signing oracle. `/v1/verify` mints signed assertions, so
 * binding to a non-loopback address with no rate limiting is a real risk off Cloudflare.
 * Throws (the host lets it propagate and exits) unless the bind is loopback OR D1 rate
 * limiting is enabled. Loopback is allowed because it is reachable only locally / via a
 * fronting proxy the operator controls.
 * @param {string} host
 * @param {Record<string,string|undefined>} [env]
 */
export function assertSafeBind(host, env = process.env) {
  if (isLoopback(host)) return;
  if (env.D1_RATE_LIMIT_ENABLED === "1") return;
  throw new Error(
    `Refusing to bind ${host} (non-loopback): /v1/verify is an unauthenticated signing oracle ` +
      `and rate limiting is OFF (D1_RATE_LIMIT_ENABLED != "1"; off Cloudflare there is no edge limiter). ` +
      `Either keep HOST=127.0.0.1 (default) behind an authenticating, rate-limiting reverse proxy, ` +
      `OR set D1_RATE_LIMIT_ENABLED=1 (+ the D1_*_RATE_LIMIT_* tiers) and TRUST_PROXY_HEADER and still ` +
      `front it with auth. See the README "Exposing the host safely" note.`,
  );
}
