// Per-endpoint account-token authentication + isolation gate (Slice 2, Stage 3).
//
// Replaces the four shared LEASE_ISSUE_BEARER bearer checks on the 6 scoped paths
// (/v1/activate, /v1/renew, /v1/checkout, /v1/heartbeat, /v1/release, /v1/admin/report)
// with a real per-customer credential whose customer_id is bound into the MUTATING SQL
// (see issuance_sql.mjs). This module owns the *authn + mode* decision; the *isolation*
// teeth live in the SQL ownership EXISTS.
//
// Modes (ACCOUNT_TOKEN_MODE, runtime default 'off'; mirrors REQUEST_SIGNATURE_MODE — production
// MUST set 'required'):
//   off:      legacy LEASE_ISSUE_BEARER (constant-time compare) + shadow-eval logging
//             (resolveAccountToken is run and logged, never enforced).
//   soft:     account token REQUIRED (bearer NOT accepted). The mutation EXISTS allows a
//             NULL-owner entitlement (logged account.isolation_mismatch) but a POPULATED
//             mismatch still DENIES (B's row never matches A's customer_id).
//   required: account token REQUIRED; the EXISTS binds e.customer_id=? only (NULL/mismatch
//             denied).
//
// Codes: missing/unknown/revoked/expired -> 401; scope miss -> 403 forbidden_scope;
//        config_error (no usable peppers) -> 503 (terminal-deny; NEVER bearer-fallback in
//        soft/required). The raw token / Authorization header is NEVER logged (L10).
//
// Design: docs/superpowers/plans/2026-06-24-slice2-account-token-blueprint.md (Round-2 F1-F6).

import { resolveAccountToken, tokenAllows, touchLastUsed } from "./account_token.mjs";

const DEFAULT_LAST_USED_THROTTLE_SEC = 300;

/**
 * Resolve ACCOUNT_TOKEN_MODE. The runtime fallback is 'off' (legacy bearer + shadow-eval),
 * mirroring REQUEST_SIGNATURE_MODE: an unconfigured/dev Worker must NOT silently 401 legacy
 * callers that have no account token yet. Production MUST set 'required' (see wrangler.example.toml);
 * the safe cutover is off -> soft (observe) -> required.
 */
export function accountTokenMode(env) {
  const raw = env?.ACCOUNT_TOKEN_MODE;
  if (raw === "off" || raw === "soft" || raw === "required") return raw;
  return "off";
}

function lastUsedThrottleSec(env) {
  const n = Number(env?.ACCOUNT_TOKEN_LAST_USED_THROTTLE_SEC);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LAST_USED_THROTTLE_SEC;
}

/** Read the raw bearer token from the Authorization header, or null. NEVER logged. */
export function readBearer(request) {
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const raw = auth.slice("Bearer ".length);
  return raw.length > 0 ? raw : null;
}

/**
 * Constant-time string equality via Web Crypto (HMAC over each side under a random one-time
 * key, then crypto.subtle.timingSafeEqual on the MACs when available, else a length-safe
 * digest compare). Used for the legacy off-mode bearer compare (L9) so a raw `!==` cannot
 * leak via timing.
 */
export async function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const macA = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(a)));
  const macB = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(b)));
  // Both MACs are 32 bytes regardless of input length, so the compare itself is length-uniform.
  let diff = 0;
  for (let i = 0; i < macA.length; i += 1) diff |= macA[i] ^ macB[i];
  return diff === 0;
}

// HTTP code -> { status } mapping for resolver/scope failures. Kept here so the handler stays
// thin and every scoped path returns the SAME shapes.
function denyResponseFor(code) {
  if (code === "config_error") return { status: 503, code: "config_error" };
  if (code === "forbidden_scope") return { status: 403, code: "forbidden_scope" };
  // unauthorized / token_revoked / token_expired all surface as 401 (no oracle on WHY beyond the code).
  return { status: 401, code };
}

/**
 * The shared per-endpoint gate. Returns one of:
 *   { ok:true, mode, customerId, token }                 -- token path (soft/required)
 *   { ok:true, mode:'off', customerId:null, token:null } -- legacy bearer path (off)
 *   { ok:false, status, code }                           -- denied (caller json()s it)
 *
 * `operation` is one of activate/renew/checkout/heartbeat/release/report (mapped to the
 * scopes axis). `ctx` (optional) provides waitUntil for the off-response-path last_used write.
 */
export async function accountAuth(request, env, operation, project, feature, now, ctx) {
  const mode = accountTokenMode(env);

  if (mode === "off") {
    // Legacy bearer gate (constant-time). When LEASE_ISSUE_BEARER is unset/empty the path is open
    // (back-compat dev default), matching the prior behavior of the 4 inline gates.
    const configured = env.LEASE_ISSUE_BEARER;
    if (configured !== undefined && configured !== "") {
      const raw = readBearer(request);
      const okBearer = raw !== null && (await constantTimeEqual(raw, configured));
      if (!okBearer) return { ok: false, status: 401, code: "unauthorized" };
    }
    // Shadow-eval: run the resolver and log pass/nomatch WITHOUT affecting the response, so an
    // operator can confirm token-presence coverage before flipping off -> soft. Never logs the token.
    await shadowEvalAccountToken(request, env, project, feature, now);
    return { ok: true, mode: "off", customerId: null, token: null };
  }

  // soft / required: an account token is REQUIRED; the legacy bearer is NOT accepted.
  const raw = readBearer(request);
  const resolved = await resolveAccountToken(env, raw, now);
  if (!resolved.ok) {
    const d = denyResponseFor(resolved.code);
    return { ok: false, status: d.status, code: d.code };
  }
  const token = resolved.token;
  if (!tokenAllows(token.scopes_json, project, feature, operation)) {
    const d = denyResponseFor("forbidden_scope");
    return { ok: false, status: d.status, code: d.code };
  }
  // Forensic last_used touch (throttled, off the response path when ctx.waitUntil is available).
  // Never gates auth, never throws.
  touchLastUsed(env, token, now, lastUsedThrottleSec(env), ctx && ctx.waitUntil ? ctx.waitUntil.bind(ctx) : undefined);
  return { ok: true, mode, customerId: token.customer_id, token };
}

/**
 * off-mode shadow evaluation: resolve the presented token (if any) and emit a non-enforcing
 * signal so the off -> soft cutover gate (zero account.shadow_nomatch for active callers) can be
 * measured. NEVER logs the raw token or Authorization header (L10); logs only customer_id + tuple.
 */
export async function shadowEvalAccountToken(request, env, project, feature, now) {
  const raw = readBearer(request);
  try {
    const resolved = await resolveAccountToken(env, raw, now);
    if (resolved.ok) {
      logShadow("account.shadow_pass", { customer_id: resolved.token.customer_id, project, feature });
    } else {
      logShadow("account.shadow_nomatch", { code: resolved.code, project, feature });
    }
  } catch {
    // shadow-eval is observational; a failure here must never affect the (off) response.
  }
}

// A minimal structured logger so this module stays free of index.ts imports (avoids a cycle).
function logShadow(event, fields) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event, ...fields }));
}
