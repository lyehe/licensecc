import { RECENT_SIGN_IN_SEC } from "../../auth/portal_session.mjs";
import type { Env } from "../env.js";
import type { Identity } from "./providers.js";

// Connecting a provider adds a lasting way in, so it needs a recent sign-in (RECENT_SIGN_IN_SEC,
// any sign-in method): a stolen or borrowed older session cannot add its holder's own Google or
// GitHub account. The routes ask before they record a link flow or exchange a provider code, so an
// old session gets its own answer and nothing else.
export async function recentSignIn(env: Env, sessionId: string, now: number): Promise<boolean> {
  const db = env.DB.withSession?.("first-primary") ?? env.DB;
  const row = await db.prepare("SELECT 1 AS recent FROM portal_sessions WHERE id = ? AND created_at >= ?")
    .bind(sessionId, now - RECENT_SIGN_IN_SEC).first<{ recent: number }>();
  return row !== null;
}

// Explicit linking always revalidates the initiating session, including its age, in the same write
// statement. Registration is an atomic D1 batch: a raced provider/email conflict rolls back the customer.
export async function identityCustomer(env: Env, identity: Identity, linkSessionId: string | null, now: number): Promise<string> {
  const db = env.DB.withSession?.("first-primary") ?? env.DB;
  const existing = await db.prepare(
    "SELECT i.customer_id, c.status FROM portal_identities i JOIN customers c ON c.id = i.customer_id WHERE i.provider = ? AND i.subject = ?",
  ).bind(identity.provider, identity.subject).first<{ customer_id: string; status: string }>();
  if (linkSessionId) {
    const session = await db.prepare(
      "SELECT s.customer_id FROM portal_sessions s JOIN customers c ON c.id = s.customer_id WHERE s.id = ? AND s.status = 'active' AND s.expires_at > ? AND c.status = 'active'",
    ).bind(linkSessionId, now).first<{ customer_id: string }>();
    if (!session || (existing && existing.customer_id !== session.customer_id)) throw new Error("link_failed");
    if (existing) return session.customer_id;
    const linked = await env.DB.prepare(
      "INSERT INTO portal_identities (provider, subject, customer_id, email, created_at) " +
      "SELECT ?, ?, s.customer_id, ?, ? FROM portal_sessions s JOIN customers c ON c.id = s.customer_id " +
      "WHERE s.id = ? AND s.status = 'active' AND s.expires_at > ? AND s.created_at >= ? AND c.status = 'active' RETURNING customer_id",
    ).bind(identity.provider, identity.subject, identity.email, now, linkSessionId, now, now - RECENT_SIGN_IN_SEC).first<{ customer_id: string }>();
    if (!linked) throw new Error("link_failed");
    return linked.customer_id;
  }
  if (existing) {
    // The provider just proved this identity, so naming the suspension discloses nothing new.
    if (existing.status !== "active") throw new Error("account_suspended");
    return existing.customer_id;
  }
  if (await db.prepare("SELECT id FROM customers WHERE lower(email) = ? UNION ALL SELECT customer_id FROM portal_passwords WHERE email_lower = ? LIMIT 1")
    .bind(identity.email, identity.email).first()) throw new Error("account_link_required");
  if (!env.DB.batch) throw new Error("registration_unavailable");
  const customerId = `cust_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO customers (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(customerId, identity.name || identity.email, identity.email, now, now),
    env.DB.prepare("INSERT INTO portal_identities (provider, subject, customer_id, email, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(identity.provider, identity.subject, customerId, identity.email, now),
  ]);
  return customerId;
}
