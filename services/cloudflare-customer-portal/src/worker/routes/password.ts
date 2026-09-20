import { mintSession, setSessionCookie, loadSessionPeppers } from "../../auth/portal_session.mjs";
import { portalRateLimit } from "../../auth/portal_ratelimit.mjs";
import { canonicalHttpsOrigin } from "../../auth/portal_destination.mjs";
import { authSession } from "./auth.js";
import { clientIp, envelope, readJson } from "../support.js";
import { hashPassword, loginEmail, validPassword, verifyPassword } from "../password/crypto.js";
import type { Env, TopRoute } from "../env.js";

const HEADERS = { "cache-control": "no-store" };
type Credential = { customer_id: string; email_lower: string; password_hash: string };
const primary = (env: Env) => env.DB.withSession?.("first-primary") ?? env.DB;
function gate(request: Request, env: Env, reqId: string): Response | null {
  if (env.PORTAL_PASSWORD_ENABLED !== "1") return envelope(reqId, "not_found", undefined, 404, HEADERS);
  const origin = canonicalHttpsOrigin(env.PORTAL_PUBLIC_ORIGIN);
  if (!origin || new URL(request.url).origin !== origin || (request.method === "POST" && request.headers.get("origin") !== origin)) {
    return envelope(reqId, "cross_site_forbidden", undefined, 403, HEADERS);
  }
  if (loadSessionPeppers(env) === null) return envelope(reqId, "config_error", undefined, 503, HEADERS);
  return null;
}
async function throttle(request: Request, env: Env, email: string, action: string, now: number): Promise<boolean> {
  const ip = await portalRateLimit(env, `password:${action}:ip:${clientIp(request)}`, action === "register" ? 5 : 30, 900, now);
  if (ip.limited) return true;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email)));
  const key = Array.from(hash, (v) => v.toString(16).padStart(2, "0")).join("");
  return (await portalRateLimit(env, `password:${action}:email:${key}`, 10, 900, now)).limited;
}
async function signedIn(request: Request, env: Env, reqId: string, customerId: string, passwordHash: string, now: number): Promise<Response> {
  const minted = await mintSession(env, { customerId, passwordHash, authMethod: "password", userAgent: request.headers.get("user-agent") ?? "", now });
  if (!minted.ok || !minted.raw) return envelope(reqId, "invalid_credentials", undefined, 401, HEADERS);
  return envelope(reqId, "signed_in", { customer_id: customerId }, 200, { ...HEADERS, "set-cookie": setSessionCookie(minted.raw) });
}
async function enter(request: Request, env: Env, reqId: string, now: number, register: boolean): Promise<Response> {
  const denied = gate(request, env, reqId);
  if (denied) return denied;
  const body = await readJson(request, reqId);
  if (body instanceof Response) return body;
  const email = loginEmail(body.email);
  if (!email || !validPassword(body.password)) return envelope(reqId, register ? "invalid_registration" : "invalid_credentials", undefined, register ? 400 : 401, HEADERS);
  if (await throttle(request, env, email, register ? "register" : "login", now)) return envelope(reqId, "rate_limited", undefined, 429, HEADERS);
  const db = primary(env);
  if (!register) {
    const credential = await db.prepare("SELECT p.customer_id, p.password_hash, p.email_lower FROM portal_passwords p JOIN customers c ON c.id = p.customer_id AND c.status = 'active' WHERE p.email_lower = ?")
      .bind(email).first<Credential>();
    const verified = await verifyPassword(body.password, credential?.password_hash ?? null);
    if (!verified || !credential) return envelope(reqId, "invalid_credentials", undefined, 401, HEADERS);
    return signedIn(request, env, reqId, credential.customer_id, credential.password_hash, now);
  }
  const passwordHash = await hashPassword(body.password);
  const existing = await db.prepare("SELECT id FROM customers WHERE lower(email) = ? UNION ALL SELECT customer_id AS id FROM portal_passwords WHERE email_lower = ? LIMIT 1").bind(email, email).first();
  if (existing) return envelope(reqId, "registration_unavailable", undefined, 409, HEADERS);
  if (!env.DB.batch) return envelope(reqId, "config_error", undefined, 503, HEADERS);
  const customerId = `cust_${crypto.randomUUID()}`;
  try {
    await env.DB.batch([
      // An unverified login email must not become an OTP/recovery or license-fulfillment address.
      env.DB.prepare("INSERT INTO customers (id, name, email, created_at, updated_at) SELECT ?, 'Personal account', '', ?, ? WHERE NOT EXISTS (SELECT 1 FROM customers WHERE lower(email) = ?)").bind(customerId, now, now, email),
      env.DB.prepare("INSERT INTO portal_passwords (customer_id, email_lower, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(customerId, email, passwordHash, now, now),
    ]);
  } catch { return envelope(reqId, "registration_unavailable", undefined, 409, HEADERS); }
  return signedIn(request, env, reqId, customerId, passwordHash, now);
}

async function settings(request: Request, env: Env, reqId: string, now: number): Promise<Response> {
  const denied = gate(request, env, reqId);
  if (denied) return denied;
  const session = await authSession(request, env, reqId, now);
  if (session instanceof Response) return session;
  const db = primary(env);
  const row = await db.prepare("SELECT c.email, s.auth_method, s.created_at FROM portal_sessions s JOIN customers c ON c.id = s.customer_id WHERE s.id = ? AND s.status = 'active' AND s.expires_at > ? AND c.status = 'active'")
    .bind(session.id, now).first<{ email: string; auth_method: string; created_at: number }>();
  if (!row) return envelope(reqId, "unauthorized", undefined, 401, HEADERS);
  const credential = await db.prepare("SELECT customer_id, email_lower, password_hash FROM portal_passwords WHERE customer_id = ?").bind(session.customer_id).first<Credential>();
  const recentVerifiedSignIn = (row.auth_method === "oauth" || row.auth_method === "otp") && row.created_at >= now - 600;
  if (request.method === "GET") return envelope(reqId, "password_settings", {
    has_password: Boolean(credential), email: credential?.email_lower ?? row.email, can_reset: recentVerifiedSignIn,
    email_verified: Boolean(row.email && row.email.toLowerCase() === credential?.email_lower),
  }, 200, HEADERS);
  const body = await readJson(request, reqId);
  if (body instanceof Response) return body;
  if (!validPassword(body.password)) return envelope(reqId, "invalid_registration", undefined, 400, HEADERS);
  const email = credential?.email_lower ?? loginEmail(row.email);
  if (!email) return envelope(reqId, "verified_sign_in_required", undefined, 403, HEADERS);
  if (await throttle(request, env, email, "change", now)) return envelope(reqId, "rate_limited", undefined, 429, HEADERS);
  if (!recentVerifiedSignIn) {
    if (!credential) return envelope(reqId, "verified_sign_in_required", undefined, 403, HEADERS);
    if (!validPassword(body.current_password) || !await verifyPassword(body.current_password, credential.password_hash)) return envelope(reqId, "invalid_credentials", undefined, 401, HEADERS);
  }
  if (!env.DB.batch) return envelope(reqId, "config_error", undefined, 503, HEADERS);
  const passwordHash = await hashPassword(body.password);
  const sessionGuard = "EXISTS (SELECT 1 FROM portal_sessions s JOIN customers c ON c.id = s.customer_id WHERE s.id = ? AND s.customer_id = ? AND s.status = 'active' AND s.expires_at > ? AND c.status = 'active')";
  const write = credential
    ? env.DB.prepare(`UPDATE portal_passwords SET password_hash = ?, updated_at = ? WHERE customer_id = ? AND password_hash = ? AND ${sessionGuard} RETURNING customer_id`).bind(passwordHash, now, session.customer_id, credential.password_hash, session.id, session.customer_id, now)
    : env.DB.prepare(`INSERT INTO portal_passwords (customer_id, email_lower, password_hash, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE ${sessionGuard} ON CONFLICT DO NOTHING RETURNING customer_id`).bind(session.customer_id, email, passwordHash, now, now, session.id, session.customer_id, now);
  // The random salted hash identifies this successful CAS, so failed/raced writes revoke nothing.
  const changed = "EXISTS (SELECT 1 FROM portal_passwords WHERE customer_id = ? AND password_hash = ?)";
  const results = await env.DB.batch([
    write,
    env.DB.prepare(`UPDATE portal_sessions SET status = 'revoked' WHERE customer_id = ? AND ${changed}`).bind(session.customer_id, session.customer_id, passwordHash),
    env.DB.prepare(`UPDATE portal_otp SET consumed_at = ? WHERE customer_id = ? AND consumed_at IS NULL AND ${changed}`).bind(now, session.customer_id, session.customer_id, passwordHash),
    env.DB.prepare(`INSERT INTO account_token_revocations (customer_id, revocation_seq, updated_at) SELECT ?, 1, ? WHERE ${changed} ON CONFLICT(customer_id) DO UPDATE SET revocation_seq = account_token_revocations.revocation_seq + 1, updated_at = excluded.updated_at`).bind(session.customer_id, now, session.customer_id, passwordHash),
  ]);
  if (!results[0]?.results.length) return envelope(reqId, "password_change_conflict", undefined, 409, HEADERS);
  return signedIn(request, env, reqId, session.customer_id, passwordHash, now);
}

export const PASSWORD_DISPATCH: Record<string, TopRoute> = {
  "POST /portal/v1/auth/password/register": (request, env, _ctx, reqId, now) => enter(request, env, reqId, now, true),
  "POST /portal/v1/auth/password/login": (request, env, _ctx, reqId, now) => enter(request, env, reqId, now, false),
  "GET /portal/v1/auth/password": (request, env, _ctx, reqId, now) => settings(request, env, reqId, now),
  "POST /portal/v1/auth/password": (request, env, _ctx, reqId, now) => settings(request, env, reqId, now),
};
