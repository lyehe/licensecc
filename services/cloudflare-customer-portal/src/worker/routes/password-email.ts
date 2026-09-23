import { sendEmail } from "../../auth/portal_email.mjs";
import { canonicalHttpsOrigin, emailApiOrigin } from "../../auth/portal_destination.mjs";
import { portalRateLimit } from "../../auth/portal_ratelimit.mjs";
import { clientIp, envelope, readJson } from "../support.js";
import { hashPassword, loginEmail, validPassword } from "../password/crypto.js";
import { HEADERS, primary, gate, throttle, signedIn, digest } from "../password/shared.js";
import { passwordInvalidations } from "../password/invalidation.js";
import type { Env, ExecutionContextLike, TopRoute } from "../env.js";

type Action = { purpose: "register" | "reset"; email_lower: string; customer_id: string; credential_hash: string | null };

async function requestLink(request: Request, env: Env, ctx: ExecutionContextLike | undefined, reqId: string, now: number, purpose: Action["purpose"]): Promise<Response> {
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
  // Eligibility, proof storage and delivery run after the response so every
  // address gets the same 202 with the same latency.
  const work = issueLink(env, email, now, purpose);
  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;
  return envelope(reqId, "verification_requested", undefined, 202, HEADERS);
}

async function issueLink(env: Env, email: string, now: number, purpose: Action["purpose"]): Promise<void> {
  try {
    const db = primary(env);
    // Verified contact addresses recover credentials. Accounts created before email
    // verification (empty contact) may recover once, if no other customer owns it.
    const credential = await db.prepare(`SELECT p.customer_id, p.password_hash FROM portal_passwords p JOIN customers c ON c.id = p.customer_id
      WHERE p.email_lower = ? AND c.status = 'active'
        AND (lower(c.email) = p.email_lower OR (c.email = '' AND NOT EXISTS (SELECT 1 FROM customers o WHERE lower(o.email) = p.email_lower)))`)
      .bind(email).first<{ customer_id: string; password_hash: string }>();
    const existing = await db.prepare("SELECT id FROM customers WHERE lower(email) = ? UNION ALL SELECT customer_id AS id FROM portal_passwords WHERE email_lower = ? LIMIT 1").bind(email, email).first();
    // The same response covers unknown, disabled, unverified and already registered addresses.
    if ((purpose === "register" && existing) || (purpose === "reset" && !credential)) return;
    const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const tokenHash = await digest(token);
    await db.prepare("DELETE FROM portal_password_actions WHERE expires_at <= ?").bind(now).run();
    await db.prepare("INSERT INTO portal_password_actions (token_hash, purpose, email_lower, customer_id, credential_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(tokenHash, purpose, email, credential?.customer_id ?? `cust_${crypto.randomUUID()}`, purpose === "reset" ? credential!.password_hash : null, now, now + 900).run();
    const link = `${canonicalHttpsOrigin(env.PORTAL_PUBLIC_ORIGIN)}/password-action#token=${token}`;
    const sent = await sendEmail(env, email, purpose === "register" ? "Verify your Licensecc email" : "Reset your Licensecc password", `${purpose === "register" ? "Verify your email and choose a password" : "Choose a new password"}:\n\n${link}\n\nThis link expires in 15 minutes and can be used once. If you did not request it, ignore this email.`);
    if (!sent.ok && sent.code !== "email_send_indeterminate") {
      await db.prepare("DELETE FROM portal_password_actions WHERE token_hash = ? AND consumed_at IS NULL").bind(tokenHash).run();
    }
  } catch {
    // Background delivery never surfaces account state; the proof simply expires.
  }
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
  const { customer_id: id, email_lower: email } = action;
  const statements = [env.DB.prepare("UPDATE portal_password_actions SET consumed_at = ?, claim = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?").bind(now, claim, tokenHash, now)];
  if (action.purpose === "register") {
    statements.push(env.DB.prepare(`INSERT INTO customers (id, name, email, created_at, updated_at) SELECT ?, 'Personal account', ?, ?, ? WHERE ${claimed} AND NOT EXISTS (SELECT 1 FROM customers WHERE lower(email) = ?) AND NOT EXISTS (SELECT 1 FROM portal_passwords WHERE email_lower = ?)`)
      .bind(id, email, now, now, tokenHash, claim, email, email));
    statements.push(env.DB.prepare(`INSERT INTO portal_passwords (customer_id, email_lower, password_hash, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE ${claimed} AND EXISTS (SELECT 1 FROM customers WHERE id = ? AND status = 'active') RETURNING customer_id`)
      .bind(id, email, passwordHash, now, now, tokenHash, claim, id));
  } else {
    statements.push(env.DB.prepare(`UPDATE portal_passwords SET password_hash = ?, updated_at = ? WHERE customer_id = ? AND email_lower = ? AND password_hash = ? AND ${claimed} AND EXISTS (SELECT 1 FROM customers WHERE id = ? AND status = 'active' AND (lower(email) = ? OR (email = '' AND NOT EXISTS (SELECT 1 FROM customers o WHERE lower(o.email) = ?)))) RETURNING customer_id`)
      .bind(passwordHash, now, id, email, action.credential_hash, tokenHash, claim, id, email, email));
  }
  const writeIndex = statements.length - 1;
  if (action.purpose === "reset") {
    // Redeeming the emailed link proves the mailbox; record it as the contact address.
    statements.push(env.DB.prepare(`UPDATE customers SET email = ?, updated_at = ? WHERE id = ? AND email = '' AND EXISTS (SELECT 1 FROM portal_passwords WHERE customer_id = ? AND password_hash = ?) AND NOT EXISTS (SELECT 1 FROM customers o WHERE lower(o.email) = ?)`)
      .bind(email, now, id, id, passwordHash, email));
  }
  statements.push(...passwordInvalidations(env.DB, id, passwordHash, now, {
    email, revokeAccountTokens: action.purpose === "reset",
  }));
  const results = await env.DB.batch(statements);
  if (!results[writeIndex]?.results.length) return invalid();
  return signedIn(request, env, reqId, id, passwordHash, now);
}

export const PASSWORD_EMAIL_DISPATCH: Record<string, TopRoute> = {
  "POST /portal/v1/auth/password/register": (request, env, ctx, reqId, now) => requestLink(request, env, ctx, reqId, now, "register"),
  "POST /portal/v1/auth/password/reset": (request, env, ctx, reqId, now) => requestLink(request, env, ctx, reqId, now, "reset"),
  "POST /portal/v1/auth/password/complete": (request, env, _ctx, reqId, now) => complete(request, env, reqId, now),
};
