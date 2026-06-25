// portal_otp.mjs — two-secret email OTP / magic-link for the customer portal (blueprint (a)).
//
// ONE portal_otp row backs BOTH a numeric code AND a magic-link secret:
//   secret = base64url(32 random bytes)        -> the magic-link body (?token=...)
//   code   = (first 4 secret bytes as uint32) % 1e8, zero-padded to 8 digits
// Stored as KEYED HMAC (pepper-versioned), NEVER plaintext, mirroring account_tokens (0015):
//   secret_hmac = HMAC(pepper, secret)
//   code_hmac   = HMAC(pepper, email_lower + ":" + code)   <- email-bound (A's code + B's email no-match)
// Single-use is enforced by an ATOMIC `UPDATE ... consumed_at ... WHERE consumed_at IS NULL ... RETURNING`,
// the same discipline as request_proof_nonces (0009). HMAC-at-rest peppers come from PORTAL_OTP_PEPPERS
// (the shared fail-closed loadSecretMap loader).
//
// Security properties (the OTP attack surface):
//   - No customer enumeration: an unknown email returns { ok:true } and burns an equal-cost dummy
//     HMAC (so timing does not reveal whether a customer exists); nothing is written or emailed.
//   - requestOtp NEVER returns the secret (only operator bootstrap does, in the worker).
//   - Always-on rate-limit BEFORE any write (invariant 5 / portal_ratelimit).
//   - redeem: candidate HMAC under EVERY live pepper; wrong-code is byte-identical to no-OTP (no
//     oracle); attempt_count is bumped ONLY when a live row actually matched.
//
// Worker-safe: no node:/Buffer; only Web Crypto + standard globals.

import { loadSecretMap } from "@licensecc/cloudflare-licensing-backend/auth/account_token";
import { portalRateLimit } from "./portal_ratelimit.mjs";

const OTP_TTL_SEC = 600; // 10 minutes (blueprint (a)).
const MAX_ATTEMPTS = 5;
const SECRET_BYTES = 32;
const textEncoder = new TextEncoder();

// loadSecretMap lives on account_token via order_hmac; re-export the same contract for OTP peppers.
export function loadOtpPeppers(env) {
  return loadSecretMap(env?.PORTAL_OTP_PEPPERS);
}

function base64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64Url(bytes) {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmac(pepperBytes, message) {
  const key = await crypto.subtle.importKey("raw", pepperBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return base64(new Uint8Array(mac));
}

// Derive the 8-digit numeric code from the first 4 secret bytes (big-endian uint32 % 1e8).
export function codeFromSecretBytes(secretBytes) {
  const view = new DataView(secretBytes.buffer, secretBytes.byteOffset, 4);
  const n = view.getUint32(0, false) % 100_000_000;
  return String(n).padStart(8, "0");
}

function newOtpId() {
  const r = new Uint8Array(16);
  crypto.getRandomValues(r);
  let hex = "";
  for (const b of r) hex += b.toString(16).padStart(2, "0");
  return `otp_${hex}`;
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

// The active pepper to mint NEW HMACs under: the first key in the (ordered) pepper map. Redemption
// tries every pepper, so rotation is safe (issue under new, redeem under any live one).
function activePepperId(peppers) {
  const keys = Object.keys(peppers);
  return keys.length > 0 ? keys[0] : null;
}

/**
 * requestOtp(env, ctx, email, now?) -> { ok, code }
 *
 *   { ok:false, code:"config_error" }   peppers unset (the worker maps this to 503).
 *   { ok:false, code:"rate_limited" }   always-on RL tripped (per email + per IP, BEFORE any write).
 *   { ok:true,  code:"ok" }             ALWAYS on the success path AND for an unknown email
 *                                       (no enumeration). The secret is NEVER returned.
 *
 * On a known active customer: invalidates prior unconsumed rows, inserts a fresh portal_otp
 * (expires now+600), and schedules the magic-link/code email via ctx.waitUntil(sendEmail). On an
 * unknown email: burns an equal-cost dummy HMAC and returns ok without writing or emailing.
 *
 * `sendEmailFn` is injected (the worker passes its sendEmail seam) so this module stays fetch-free
 * and unit-testable. `clientIp` is the per-IP RL identity.
 *
 * `returnSecret` is the OPERATOR BOOTSTRAP escape hatch (blueprint (e)): the ONLY way the secret is
 * returned to the caller. The worker gates this behind a constant-time bearer + network gate + audit;
 * on the normal login path it is false and the secret NEVER leaves this function.
 */
export async function requestOtp(env, { email, clientIp = "", sendEmailFn, waitUntil, magicLinkBase, returnSecret = false, now = Math.floor(Date.now() / 1000) } = {}) {
  const peppers = loadOtpPeppers(env);
  if (peppers === null) return { ok: false, code: "config_error" };
  const emailLower = normalizeEmail(email);
  if (emailLower.length === 0 || emailLower.length > 320) {
    // Treat a malformed email like an unknown one (no oracle), but skip RL/work.
    return { ok: true, code: "ok" };
  }

  // Always-on rate-limit BEFORE any write: per email AND per IP. (invariant 5)
  const emailRl = await portalRateLimit(env, `request:email:${emailLower}`, 5, 900, now);
  if (emailRl.limited) return { ok: false, code: "rate_limited" };
  const ipRl = await portalRateLimit(env, `request:ip:${clientIp}`, 30, 900, now);
  if (ipRl.limited) return { ok: false, code: "rate_limited" };

  const activeId = activePepperId(peppers);
  const pepperBytes = peppers[activeId];

  // Resolve the customer by lower(email), active only.
  const customer = await env.DB.prepare(
    "SELECT id FROM customers WHERE lower(email) = ? AND status = 'active' LIMIT 1",
  ).bind(emailLower).first();

  // Generate the secret + derive the code regardless of branch (equal-cost work / no timing oracle).
  const secretBytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(secretBytes);
  const secret = base64Url(secretBytes);
  const code = codeFromSecretBytes(secretBytes);
  const secretHmac = await hmac(pepperBytes, secret);
  const codeHmac = await hmac(pepperBytes, `${emailLower}:${code}`);

  if (customer === null || customer.id === undefined) {
    // Unknown / inactive email: NO enumeration. We already paid the HMAC cost above (dummy work);
    // write nothing, email nothing, return the SAME ok shape as the success path (no secret, even
    // under returnSecret — an operator bootstrap for an unknown email reveals nothing).
    return { ok: true, code: "ok" };
  }

  // Invalidate prior unconsumed OTPs for this customer (a new request supersedes the old code/link).
  await env.DB.prepare(
    "UPDATE portal_otp SET consumed_at = ? WHERE customer_id = ? AND consumed_at IS NULL",
  ).bind(now, customer.id).run();

  await env.DB.prepare(
    "INSERT INTO portal_otp (id, customer_id, email_lower, secret_hmac, code_hmac, pepper_key_id, attempt_count, consumed_at, expires_at, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)",
  ).bind(newOtpId(), customer.id, emailLower, secretHmac, codeHmac, activeId, now + OTP_TTL_SEC, now).run();

  // Email the code + magic link off the response path. The secret rides the magic link only; the
  // bare numeric code is the fallback. NEVER logged. (On the operator-bootstrap path sendEmailFn is
  // undefined and the secret is returned directly to the gated caller instead.)
  if (typeof sendEmailFn === "function") {
    const link = typeof magicLinkBase === "string" && magicLinkBase.length > 0
      ? `${magicLinkBase.replace(/\/$/, "")}/portal/v1/auth/magic?token=${encodeURIComponent(secret)}`
      : "";
    const body = link.length > 0
      ? `Your sign-in code is ${code}. Or open this link to sign in:\n${link}\nThis code expires in 10 minutes.`
      : `Your sign-in code is ${code}. This code expires in 10 minutes.`;
    const work = sendEmailFn(env, emailLower, "Your licensecc sign-in code", body);
    if (typeof waitUntil === "function") {
      waitUntil(Promise.resolve(work).catch(() => {}));
    } else {
      // No ctx: best-effort, swallow.
      await Promise.resolve(work).catch(() => {});
    }
  }

  // returnSecret is the gated operator-bootstrap path ONLY. On the normal login path it is false and
  // the secret never leaves this function.
  return returnSecret ? { ok: true, code: "ok", secret } : { ok: true, code: "ok" };
}

/**
 * redeemOtp(env, { email?, code?, secret?, clientIp?, now? }) -> { ok, customerId?, code }
 *
 *   { ok:false, code:"config_error" }   peppers unset (worker -> 503).
 *   { ok:false, code:"rate_limited" }   always-on verify RL tripped.
 *   { ok:false, code:"invalid_otp" }    wrong code / unknown secret / consumed / expired / capped
 *                                       — all BYTE-IDENTICAL (no oracle on WHY).
 *   { ok:true,  customerId, code:"ok" } the atomic single-use claim matched a live row.
 *
 * Two modes:
 *   - code redemption: requires { email, code }; the code_hmac is email-bound.
 *   - magic redemption: requires { secret }; the secret_hmac is email-independent.
 * Either way we compute the candidate HMAC under EVERY live pepper and run ONE atomic UPDATE that
 * claims the row (sets consumed_at) only if it is unconsumed, unexpired, and under the attempt cap,
 * RETURNING the customer_id. attempt_count is bumped ONLY when a live row matched but the claim
 * predicate was otherwise satisfiable — handled by the worker's verify counter + this row guard.
 */
export async function redeemOtp(env, { email, code, secret, clientIp = "", now = Math.floor(Date.now() / 1000) } = {}) {
  const peppers = loadOtpPeppers(env);
  if (peppers === null) return { ok: false, code: "config_error" };

  // Always-on verify rate-limit (per IP). The worker also throttles per (customer,IP) once known.
  const ipRl = await portalRateLimit(env, `verify:ip:${clientIp}`, 30, 900, now);
  if (ipRl.limited) return { ok: false, code: "rate_limited" };

  const candidates = [];
  let column;
  if (typeof secret === "string" && secret.length > 0) {
    column = "secret_hmac";
    for (const id of Object.keys(peppers)) candidates.push(await hmac(peppers[id], secret));
  } else {
    const emailLower = normalizeEmail(email);
    if (emailLower.length === 0 || typeof code !== "string" || !/^[0-9]{8}$/.test(code)) {
      // Malformed input is indistinguishable from a wrong code.
      return { ok: false, code: "invalid_otp" };
    }
    column = "code_hmac";
    for (const id of Object.keys(peppers)) candidates.push(await hmac(peppers[id], `${emailLower}:${code}`));
  }
  const placeholders = candidates.map(() => "?").join(",");

  // ATOMIC single-use claim: set consumed_at only if currently unconsumed, unexpired, under the cap.
  // RETURNING the customer_id proves the claim. A wrong/expired/consumed/capped row matches 0 rows
  // -> null -> invalid_otp (byte-identical to no-OTP). No separate existence check (no oracle).
  const claimed = await env.DB.prepare(
    `UPDATE portal_otp SET consumed_at = ?, attempt_count = attempt_count + 1 ` +
      `WHERE id = (SELECT id FROM portal_otp WHERE ${column} IN (${placeholders}) ` +
      `AND consumed_at IS NULL AND expires_at > ? AND attempt_count < ${MAX_ATTEMPTS} LIMIT 1) ` +
      `RETURNING customer_id`,
  ).bind(now, ...candidates, now).first();

  if (claimed === null || claimed.customer_id === undefined) {
    // No live row claimed. To bump attempt_count on a row that EXISTS but was wrong-cap-adjacent we
    // would need a second matching SELECT; the atomic claim above already increments attempt_count
    // on the row it touched. A pure miss (wrong code) touches nothing — which is exactly the no-OTP
    // shape (no oracle). The IP verify counter is the brute-force ceiling.
    return { ok: false, code: "invalid_otp" };
  }
  return { ok: true, customerId: claimed.customer_id, code: "ok" };
}
