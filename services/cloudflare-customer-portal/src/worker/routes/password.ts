import { authSession } from "./auth.js";
import { envelope, readJson } from "../support.js";
import { hashPassword, loginEmail, validPassword, verifyPassword } from "../password/crypto.js";
import { HEADERS, primary, gate, throttle, signedIn } from "../password/shared.js";
import { passwordInvalidations } from "../password/invalidation.js";
import { PASSWORD_EMAIL_DISPATCH } from "./password-email.js";
import type { Env, TopRoute } from "../env.js";
type Credential = { customer_id: string; email_lower: string; password_hash: string };

async function login(request: Request, env: Env, reqId: string, now: number): Promise<Response> {
  const denied = gate(request, env, reqId);
  if (denied) return denied;
  const body = await readJson(request, reqId);
  if (body instanceof Response) return body;
  const email = loginEmail(body.email);
  if (!email || !validPassword(body.password)) return envelope(reqId, "invalid_credentials", undefined, 401, HEADERS);
  if (await throttle(request, env, email, "login", now)) return envelope(reqId, "rate_limited", undefined, 429, HEADERS);
  const credential = await primary(env).prepare("SELECT p.customer_id, p.password_hash, p.email_lower FROM portal_passwords p JOIN customers c ON c.id = p.customer_id AND c.status = 'active' WHERE p.email_lower = ?")
    .bind(email).first<Credential>();
  const verified = await verifyPassword(body.password, credential?.password_hash ?? null);
  if (!verified || !credential) return envelope(reqId, "invalid_credentials", undefined, 401, HEADERS);
  return signedIn(request, env, reqId, credential.customer_id, credential.password_hash, now);
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
  const results = await env.DB.batch([
    write,
    ...passwordInvalidations(env.DB, session.customer_id, passwordHash, now, { revokeAccountTokens: true }),
  ]);
  if (!results[0]?.results.length) return envelope(reqId, "password_change_conflict", undefined, 409, HEADERS);
  return signedIn(request, env, reqId, session.customer_id, passwordHash, now);
}

export const PASSWORD_DISPATCH: Record<string, TopRoute> = {
  ...PASSWORD_EMAIL_DISPATCH,
  "POST /portal/v1/auth/password/login": (request, env, _ctx, reqId, now) => login(request, env, reqId, now),
  "GET /portal/v1/auth/password": (request, env, _ctx, reqId, now) => settings(request, env, reqId, now),
  "POST /portal/v1/auth/password": (request, env, _ctx, reqId, now) => settings(request, env, reqId, now),
};
