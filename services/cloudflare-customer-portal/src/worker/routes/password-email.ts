import { sendEmail } from "../../auth/portal_email.mjs";
import { canonicalHttpsOrigin, emailApiOrigin } from "../../auth/portal_destination.mjs";
import { portalRateLimit } from "../../auth/portal_ratelimit.mjs";
import { clientIp, envelope, readJson } from "../support.js";
import { hashPassword, loginEmail, validPassword } from "../password/crypto.js";
import { HEADERS, primary, gate, throttle, signedIn } from "../password/shared.js";
import type { Env, TopRoute } from "../env.js";

type Action = { purpose: "register" | "reset"; email_lower: string; customer_id: string; credential_hash: string | null };
const digest = async (value: string): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), v => v.toString(16).padStart(2, "0")).join("");

async function requestLink(request: Request, env: Env, reqId: string, now: number, purpose: Action["purpose"]): Promise<Response> {
  const denied = gate(request, env, reqId);
  if (denied) return denied;
  const body = await readJson(request, reqId);
  if (body instanceof Response) return body;
  const email = loginEmail(body.email);
  if (!email) return envelope(reqId, "invalid_email", undefined, 400, HEADERS);
  if (!env.PORTAL_EMAIL_API_KEY || !env.PORTAL_EMAIL_FROM || !emailApiOrigin(env)) return envelope(reqId, "email_unconfigured", undefined, 503, HEADERS);
  if (await throttle(request, env, email, purpose, now) || (await portalRateLimit(env, `password:mail:${await digest(email)}`, 1, 60, now)).limited) {
    return envelope(reqId, "rate_limited", undefined, 429, HEADERS);
  }
  const db = primary(env);
  const accepted = () => envelope(reqId, "verification_requested", undefined, 202, HEADERS);
  // Only previously verified contact addresses can recover existing credentials.
  const credential = await db.prepare("SELECT p.customer_id, p.password_hash FROM portal_passwords p JOIN customers c ON c.id = p.customer_id WHERE p.email_lower = ? AND lower(c.email) = p.email_lower AND c.status = 'active'")
    .bind(email).first<{ customer_id: string; password_hash: string }>();
  const existing = await db.prepare("SELECT id FROM customers WHERE lower(email) = ? UNION ALL SELECT customer_id AS id FROM portal_passwords WHERE email_lower = ? LIMIT 1").bind(email, email).first();
  // The same response covers unknown, disabled, unverified and already registered addresses.
  if ((purpose === "register" && existing) || (purpose === "reset" && !credential)) return accepted();
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const tokenHash = await digest(token);
  await db.prepare("DELETE FROM portal_password_actions WHERE expires_at <= ?").bind(now).run();
  await db.prepare("INSERT INTO portal_password_actions (token_hash, purpose, email_lower, customer_id, credential_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(tokenHash, purpose, email, credential?.customer_id ?? `cust_${crypto.randomUUID()}`, purpose === "reset" ? credential!.password_hash : null, now, now + 900).run();
  const link = `${canonicalHttpsOrigin(env.PORTAL_PUBLIC_ORIGIN)}/password-action#token=${token}`;
  const sent = await sendEmail(env, email, purpose === "register" ? "Verify your Licensecc email" : "Reset your Licensecc password", `${purpose === "register" ? "Verify your email and choose a password" : "Choose a new password"}:\n\n${link}\n\nThis link expires in 15 minutes and can be used once. If you did not request it, ignore this email.`);
  if (!sent.ok) await db.prepare("DELETE FROM portal_password_actions WHERE token_hash = ? AND consumed_at IS NULL").bind(tokenHash).run();
  return accepted();
}

async function complete(request: Request, env: Env, reqId: string, now: number): Promise<Response> {
  const denied = gate(request, env, reqId);
  if (denied) return denied;
  const body = await readJson(request, reqId);
  if (body instanceof Response) return body;
  const invalid = () => envelope(reqId, "invalid_link", undefined, 400, HEADERS);
  if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) return invalid();
  if (!validPassword(body.password)) return envelope(reqId, "invalid_registration", undefined, 400, HEADERS);
  const tokenHash = await digest(body.token);
  if ((await portalRateLimit(env, `password:complete:ip:${clientIp(request)}`, 10, 900, now)).limited ||
      (await portalRateLimit(env, `password:complete:token:${tokenHash}`, 5, 900, now)).limited) return envelope(reqId, "rate_limited", undefined, 429, HEADERS);
  const action = await primary(env).prepare("SELECT purpose, email_lower, customer_id, credential_hash FROM portal_password_actions WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?").bind(tokenHash, now).first<Action>();
  if (!action) return invalid();
  if (!env.DB.batch) return envelope(reqId, "config_error", undefined, 503, HEADERS);
  const passwordHash = await hashPassword(body.password);
  const claim = crypto.randomUUID();
  const claimed = "EXISTS (SELECT 1 FROM portal_password_actions WHERE token_hash = ? AND claim = ?)";
  const changed = "EXISTS (SELECT 1 FROM portal_passwords WHERE customer_id = ? AND password_hash = ?)";
  const { customer_id: id, email_lower: email } = action;
  const statements = [env.DB.prepare("UPDATE portal_password_actions SET consumed_at = ?, claim = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?").bind(now, claim, tokenHash, now)];
  if (action.purpose === "register") {
    statements.push(env.DB.prepare(`INSERT INTO customers (id, name, email, created_at, updated_at) SELECT ?, 'Personal account', ?, ?, ? WHERE ${claimed} AND NOT EXISTS (SELECT 1 FROM customers WHERE lower(email) = ?) AND NOT EXISTS (SELECT 1 FROM portal_passwords WHERE email_lower = ?)`)
      .bind(id, email, now, now, tokenHash, claim, email, email));
    statements.push(env.DB.prepare(`INSERT INTO portal_passwords (customer_id, email_lower, password_hash, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE ${claimed} AND EXISTS (SELECT 1 FROM customers WHERE id = ? AND status = 'active') RETURNING customer_id`)
      .bind(id, email, passwordHash, now, now, tokenHash, claim, id));
  } else {
    statements.push(env.DB.prepare(`UPDATE portal_passwords SET password_hash = ?, updated_at = ? WHERE customer_id = ? AND email_lower = ? AND password_hash = ? AND ${claimed} AND EXISTS (SELECT 1 FROM customers WHERE id = ? AND status = 'active' AND lower(email) = ?) RETURNING customer_id`)
      .bind(passwordHash, now, id, email, action.credential_hash, tokenHash, claim, id, email));
  }
  const writeIndex = statements.length - 1;
  statements.push(
    env.DB.prepare(`UPDATE portal_sessions SET status = 'revoked' WHERE customer_id = ? AND ${changed}`).bind(id, id, passwordHash),
    env.DB.prepare(`UPDATE portal_otp SET consumed_at = ? WHERE customer_id = ? AND consumed_at IS NULL AND ${changed}`).bind(now, id, id, passwordHash),
    env.DB.prepare(`UPDATE portal_password_actions SET consumed_at = ? WHERE email_lower = ? AND consumed_at IS NULL AND ${changed}`).bind(now, email, id, passwordHash),
  );
  if (action.purpose === "reset") statements.push(env.DB.prepare(`INSERT INTO account_token_revocations (customer_id, revocation_seq, updated_at) SELECT ?, 1, ? WHERE ${changed} ON CONFLICT(customer_id) DO UPDATE SET revocation_seq = account_token_revocations.revocation_seq + 1, updated_at = excluded.updated_at`).bind(id, now, id, passwordHash));
  const results = await env.DB.batch(statements);
  if (!results[writeIndex]?.results.length) return invalid();
  return signedIn(request, env, reqId, id, passwordHash, now);
}

export const PASSWORD_EMAIL_DISPATCH: Record<string, TopRoute> = {
  "POST /portal/v1/auth/password/register": (request, env, _ctx, reqId, now) => requestLink(request, env, reqId, now, "register"),
  "POST /portal/v1/auth/password/reset": (request, env, _ctx, reqId, now) => requestLink(request, env, reqId, now, "reset"),
  "POST /portal/v1/auth/password/complete": (request, env, _ctx, reqId, now) => complete(request, env, reqId, now),
};
