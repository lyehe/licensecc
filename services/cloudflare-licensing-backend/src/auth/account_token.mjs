// Account-token crypto + resolution for Slice 2 (per-customer credentials + isolation).
// Worker-safe: no node:/Buffer; only Web Crypto + standard globals. Runs raw under node --test.
//
// Tokens are opaque `lcca_<base64url(32 random bytes)>`. The server stores ONLY a keyed HMAC
// (HMAC-SHA256 under a versioned pepper), never the plaintext, never sha256(token+pepper). The
// `token_prefix` is display-only and is NEVER a SQL selector. Auth is a SELECT on the unique
// `token_hmac` column (a keyed MAC of the secret) — timing-safe, no fetch-by-prefix-then-=== hazard.
//
// Reuses the verified fail-closed loader/decoder from order_hmac.mjs (same pepper-map shape).
//
// Design: docs/superpowers/plans/2026-06-24-slice2-account-token-blueprint.md (+ Round-2 corrections).

import { loadSecretMap } from "../fulfillment/order_hmac.mjs";

const TOKEN_PREFIX = "lcca_";
const PREFIX_DISPLAY_LEN = 12;
const TOKEN_BYTES = 32;            // 256-bit body
const textEncoder = new TextEncoder();

// F4: per-customer process-local non-decreasing revocation floor. A within-isolate optimization
// that rejects a replica-stale 'active' row once THIS isolate has seen a higher seq. It does NOT
// cover cold isolates — the authoritative emergency-revoke guard is the strong read below.
const revocationFloor = new Map();

function base64FromBytes(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64UrlFromBytes(bytes) {
  return base64FromBytes(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Generate a fresh opaque token. Returns { raw, token_prefix } — token_prefix is display only. */
export function generateAccountToken() {
  const random = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(random);
  const raw = TOKEN_PREFIX + base64UrlFromBytes(random);
  return { raw, token_prefix: raw.slice(0, PREFIX_DISPLAY_LEN) };
}

/** Keyed HMAC-SHA256 of the raw token bytes under a pepper. Returns base64. */
export async function hashToken(pepperBytes, rawTokenBytes) {
  const key = await crypto.subtle.importKey("raw", pepperBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, rawTokenBytes);
  return base64FromBytes(new Uint8Array(mac));
}

/** Load the pepper map (same fail-closed contract as ORDER_HMAC_SECRETS). null = no usable peppers. */
export function loadPepperMap(env) {
  return loadSecretMap(env?.ACCOUNT_TOKEN_PEPPERS);
}

/**
 * Resolve a presented raw token to its active account_token row, or a failure code.
 *   { ok:true, token } | { ok:false, code }
 * codes: config_error (no usable peppers -> 503), unauthorized (no/!lcca_/no-match -> 401),
 *        token_revoked (status!=active OR seq-floor regressed -> 401), token_expired (-> 401).
 * The pepper_key_id of the presented token is unknown, so we compute the candidate HMAC under
 * EVERY live pepper and match the unique token_hmac. F4: strong (first-primary) read when D1
 * Sessions are available so emergency revoke is read-your-write; falls back to a plain read.
 */
export async function resolveAccountToken(env, rawToken, now) {
  const peppers = loadPepperMap(env);
  if (peppers === null) return { ok: false, code: "config_error" };
  if (typeof rawToken !== "string" || !rawToken.startsWith(TOKEN_PREFIX) || rawToken.length <= TOKEN_PREFIX.length) {
    return { ok: false, code: "unauthorized" };
  }
  const rawBytes = textEncoder.encode(rawToken);
  const candidates = [];
  for (const id of Object.keys(peppers)) candidates.push(await hashToken(peppers[id], rawBytes));
  const placeholders = candidates.map(() => "?").join(",");

  // F4 strong read: prefer the primary so a just-revoked token is never served from a stale replica.
  const reader = typeof env.DB.withSession === "function" ? env.DB.withSession("first-primary") : env.DB;
  const row = await reader.prepare(
    `SELECT t.id, t.customer_id, t.scopes_json, t.status, t.expires_at, t.pepper_key_id, t.last_used_at,
            COALESCE(r.revocation_seq, 0) AS revocation_seq
       FROM account_tokens t
       JOIN customers c ON c.id = t.customer_id AND c.status = 'active'
       LEFT JOIN account_token_revocations r ON r.customer_id = t.customer_id
      WHERE t.token_hmac IN (${placeholders}) LIMIT 1`,
  ).bind(...candidates).first();

  if (row === null) return { ok: false, code: "unauthorized" };
  if (row.status !== "active") return { ok: false, code: "token_revoked" };
  if (row.expires_at <= now) return { ok: false, code: "token_expired" };

  const seen = revocationFloor.get(row.customer_id) ?? 0;
  if (row.revocation_seq < seen) return { ok: false, code: "token_revoked" };
  if (row.revocation_seq > seen) revocationFloor.set(row.customer_id, row.revocation_seq);

  return { ok: true, token: row };
}

/**
 * F5 FAIL-CLOSED scope check. Grants only on an explicit `allow_all:true`, or — per axis — a `"*"`
 * wildcard or a non-empty array that includes the value. An absent/empty/non-matching axis DENIES.
 * Malformed scopes_json denies. `{}` is therefore NOT a master credential.
 */
export function tokenAllows(scopesJson, project, feature, operation) {
  let s;
  try { s = JSON.parse(scopesJson); } catch { return false; }
  if (typeof s !== "object" || s === null) return false;
  if (s.allow_all === true) return true;
  const axisAllows = (axis, value) => axis === "*" || (Array.isArray(axis) && axis.includes(value));
  return axisAllows(s.projects, project) && axisAllows(s.features, feature) && axisAllows(s.operations, operation);
}

/**
 * F8: throttled best-effort last_used_at write + a forensic signal. Never gates auth, never throws.
 * Pass `waitUntil` (ctx.waitUntil) to keep it off the response path on hot endpoints (heartbeat).
 */
export function touchLastUsed(env, token, now, throttleSec, waitUntil) {
  if (now - (token.last_used_at ?? 0) < throttleSec) return;
  const work = (async () => {
    try {
      await env.DB.prepare(
        "UPDATE account_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)",
      ).bind(now, token.id, now - throttleSec).run();
    } catch {
      // best-effort; last_used_at never gates auth.
    }
  })();
  if (typeof waitUntil === "function") waitUntil(work);
}

// Exposed for tests (process-local floor reset between cases).
export function _resetRevocationFloorForTests() {
  revocationFloor.clear();
}
