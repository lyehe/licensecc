// portal_ratelimit.mjs — ALWAYS-ON fixed-window D1 rate limiter for the customer portal auth paths.
//
// Invariant 5: portal auth throttling is dedicated and ALWAYS ON. Unlike the backend verifier's
// checkD1RateLimitTier (which short-circuits when D1_RATE_LIMIT_ENABLED is unset), this limiter
// IGNORES D1_RATE_LIMIT_ENABLED entirely — an unconfigured/dev Worker must STILL throttle the
// login/OTP surface (it is the brute-force / enumeration surface). The counter row lives in the
// shared rate_limit_counters table (migration 0002) under portal-* namespaces, isolated from the
// verifier's verify-v1-* namespaces by the namespace column.
//
// Worker-safe: no node:/Buffer; only standard globals + env.DB (D1).

// Fixed window start (aligns the window so concurrent isolates share one counter row).
function fixedWindowStart(nowSeconds, periodSeconds) {
  return Math.floor(nowSeconds / periodSeconds) * periodSeconds;
}

/**
 * portalRateLimit(env, key, limit, windowSec, now?) -> { limited, count }
 *
 * ALWAYS increments the per-(namespace,key,window) counter and returns whether the post-increment
 * count exceeds `limit`. `key` should already encode the namespace + identity (e.g.
 * "request:email:foo@bar" or "verify:cust:A:ip:1.2.3.4"). The caller MUST throttle BEFORE any write
 * (blueprint (a)): a request that is rate-limited never reaches the OTP/session mutation.
 *
 * Fail-closed: if the counter write throws (DB unavailable), we treat it as limited rather than
 * silently allowing an unthrottled brute-force.
 */
export async function portalRateLimit(env, key, limit, windowSec, now = Math.floor(Date.now() / 1000)) {
  const period = Number.isInteger(windowSec) && windowSec > 0 ? windowSec : 60;
  const max = Number.isInteger(limit) && limit > 0 ? limit : 1;
  const windowStart = fixedWindowStart(now, period);
  const expiresAt = windowStart + period * 2;
  try {
    const row = await env.DB.prepare(
      "INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) " +
        "VALUES ('portal', ?, ?, 1, ?, ?) " +
        "ON CONFLICT(namespace, rate_key, window_start) DO UPDATE SET request_count = request_count + 1, " +
        "expires_at = excluded.expires_at, updated_at = excluded.updated_at RETURNING request_count",
    )
      .bind(key, windowStart, expiresAt, now)
      .first();
    const count = Number(row?.request_count ?? 0);
    // Opportunistic GC of expired counter rows on the first write of a window.
    if (count === 1) {
      try {
        await env.DB.prepare("DELETE FROM rate_limit_counters WHERE namespace = 'portal' AND expires_at < ?").bind(now).run();
      } catch {
        // best-effort GC; never gate the request on cleanup.
      }
    }
    return { limited: count > max, count };
  } catch {
    // Fail closed: a counter we cannot increment means we cannot prove we are under the cap.
    return { limited: true, count: Number.POSITIVE_INFINITY };
  }
}
