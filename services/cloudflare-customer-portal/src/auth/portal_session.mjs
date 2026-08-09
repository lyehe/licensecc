// portal_session.mjs — opaque, DB-backed customer sessions (blueprint (a), invariant 8).
//
// No JWT for the customer session: revocation needs a server row, so the session is an OPAQUE
// `lccp_<base64url(32)>` cookie whose KEYED HMAC is the only thing stored (session_hmac, never the
// plaintext — mirrors account_tokens / portal_otp). The session is HttpOnly + Secure + SameSite=Lax,
// so the browser never reads it from JS and it does not ride a cross-site request body.
//
// resolveSession uses env.DB.withSession?.("first-primary") (a strong, read-your-write read when D1
// Sessions are available) and JOINs customers (active) so a just-revoked session OR a disabled
// customer is denied immediately, not served from a stale replica.
//
// Worker-safe: no node:/Buffer; only Web Crypto + standard globals.

import { loadSecretMap } from "@licensecc/cloudflare-runtime/auth/secret_map";

/** @typedef {import("../worker/env.js").Env} PortalEnv */
/** @typedef {{ [key: string]: Uint8Array }} PepperMap */
/** @typedef {{ customerId?: string, userAgent?: string, now?: number }} MintSessionOptions */
/** @typedef {{ id?: string, customer_id?: string, status?: string, expires_at: number }} SessionRow */

const SESSION_PREFIX = "lccp_";
const SESSION_BYTES = 32;
const SESSION_TTL_SEC = 86400; // 24h cookie Max-Age.
const COOKIE_NAME = "lccp_session";
const textEncoder = new TextEncoder();

/** @param {PortalEnv | null | undefined} env */
export function loadSessionPeppers(env) {
  return loadSecretMap(env?.PORTAL_SESSION_PEPPERS);
}

/** @param {Uint8Array} bytes */
function base64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** @param {Uint8Array} bytes */
function base64Url(bytes) {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** @param {Uint8Array} pepperBytes @param {string} message */
async function hmac(pepperBytes, message) {
  const copy = new Uint8Array(pepperBytes.byteLength);
  copy.set(pepperBytes);
  const key = await crypto.subtle.importKey("raw", copy.buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return base64(new Uint8Array(mac));
}

/** @param {PepperMap} peppers */
function activePepperId(peppers) {
  const keys = Object.keys(peppers);
  const activeId = keys[0];
  return activeId === undefined ? null : activeId;
}

function newSessionId() {
  const r = new Uint8Array(16);
  crypto.getRandomValues(r);
  let hex = "";
  for (const b of r) hex += b.toString(16).padStart(2, "0");
  return `psess_${hex}`;
}

/**
 * mintSession(env, { customerId, userAgent?, now? }) -> { ok, raw?, code }
 *
 *   { ok:false, code:"config_error" }   session peppers unset.
 *   { ok:true,  raw, code:"ok" }        the opaque cookie value to Set-Cookie (returned ONCE; only
 *                                       its HMAC is persisted — the plaintext is never stored).
 *
 * The caller binds the cookie via setSessionCookie(raw). raw is the ONLY copy of the session token
 * and never lands in the DB or a log.
 */
/** @param {PortalEnv} env @param {MintSessionOptions} [options] */
export async function mintSession(env, { customerId, userAgent = "", now = Math.floor(Date.now() / 1000) } = {}) {
  const peppers = loadSessionPeppers(env);
  if (peppers === null) return { ok: false, code: "config_error" };
  const activeId = activePepperId(peppers);
  // Preserve the pre-typecheck behavior for a malformed empty map. The
  // configuration contract guarantees a string id and Uint8Array value.
  const pepperBytes = /** @type {Uint8Array} */ (peppers[/** @type {string} */ (activeId)]);
  const random = new Uint8Array(SESSION_BYTES);
  crypto.getRandomValues(random);
  const raw = SESSION_PREFIX + base64Url(random);
  const sessionHmac = await hmac(pepperBytes, raw);
  await env.DB.prepare(
    "INSERT INTO portal_sessions (id, customer_id, session_hmac, pepper_key_id, account_token_id, status, user_agent, created_at, last_used_at, expires_at) " +
      "VALUES (?, ?, ?, ?, NULL, 'active', ?, ?, ?, ?)",
  ).bind(newSessionId(), customerId, sessionHmac, activeId, userAgent.slice(0, 256), now, now, now + SESSION_TTL_SEC).run();
  return { ok: true, raw, code: "ok" };
}

/**
 * resolveSession(env, raw, now?) -> { ok, session?, code }
 *
 *   { ok:false, code:"config_error" }     session peppers unset (worker -> 503).
 *   { ok:false, code:"unauthorized" }     no/!lccp_/no-match/revoked/expired/disabled-customer.
 *   { ok:true,  session, code:"ok" }      a live session JOINed to an active customer. session
 *                                         carries { id, customer_id }.
 *
 * Strong read: prefers env.DB.withSession("first-primary") so a just-revoked session is never served
 * from a stale replica. customer_id here is the ONLY trusted source of the caller's identity — every
 * /api/portal handler binds it (invariant 2).
 */
/** @param {PortalEnv} env @param {unknown} raw @param {number} [now] */
export async function resolveSession(env, raw, now = Math.floor(Date.now() / 1000)) {
  const peppers = loadSessionPeppers(env);
  if (peppers === null) return { ok: false, code: "config_error" };
  if (typeof raw !== "string" || !raw.startsWith(SESSION_PREFIX) || raw.length <= SESSION_PREFIX.length) {
    return { ok: false, code: "unauthorized" };
  }
  const candidates = [];
  for (const id of Object.keys(peppers)) {
    const pepperBytes = /** @type {Uint8Array} */ (peppers[id]);
    candidates.push(await hmac(pepperBytes, raw));
  }
  const placeholders = candidates.map(() => "?").join(",");

  const reader = typeof env.DB.withSession === "function" ? env.DB.withSession("first-primary") : env.DB;
  /** @type {SessionRow | null} */
  const row = await reader.prepare(
    `SELECT s.id, s.customer_id, s.status, s.expires_at ` +
      `FROM portal_sessions s ` +
      `JOIN customers c ON c.id = s.customer_id AND c.status = 'active' ` +
      `WHERE s.session_hmac IN (${placeholders}) LIMIT 1`,
  ).bind(...candidates).first();

  if (row === null || row.id === undefined) return { ok: false, code: "unauthorized" };
  if (row.status !== "active") return { ok: false, code: "unauthorized" };
  if (row.expires_at <= now) return { ok: false, code: "unauthorized" };
  return { ok: true, session: { id: row.id, customer_id: row.customer_id }, code: "ok" };
}

/**
 * revokeSession(env, sessionId, customerId) — logout. Sets status='revoked' for THIS session (bound
 * to its customer_id so a forged session id cannot revoke a foreign row). The worker ALSO bumps
 * account_token_revocations.revocation_seq (invariant 9) to kill any in-flight 120s account token.
 */
/** @param {PortalEnv} env @param {string} sessionId @param {string} customerId */
export async function revokeSession(env, sessionId, customerId) {
  await env.DB.prepare(
    "UPDATE portal_sessions SET status = 'revoked' WHERE id = ? AND customer_id = ? AND status = 'active'",
  ).bind(sessionId, customerId).run();
}

/** revokeAllForCustomer(env, customerId) — log out everywhere (every active session for a customer). */
/** @param {PortalEnv} env @param {string} customerId */
export async function revokeAllForCustomer(env, customerId) {
  await env.DB.prepare(
    "UPDATE portal_sessions SET status = 'revoked' WHERE customer_id = ? AND status = 'active'",
  ).bind(customerId).run();
}

/** Parse the opaque session token out of the Cookie header, or null. */
/** @param {Request} request */
export function cookieFromRequest(request) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** The Set-Cookie value that binds an opaque session (HttpOnly; Secure; SameSite=Lax). */
/** @param {string} raw */
export function setSessionCookie(raw) {
  return `${COOKIE_NAME}=${raw}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`;
}

/** The Set-Cookie value that clears the session cookie (logout). */
export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export const _internals = { COOKIE_NAME, SESSION_PREFIX, SESSION_TTL_SEC };
