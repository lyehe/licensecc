import type { Env } from "../env.js";
import type { Identity } from "./providers.js";

// Explicit linking always revalidates the initiating session in the same write statement.
// Registration is an atomic D1 batch: a raced provider/email conflict rolls back the customer.
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
      "WHERE s.id = ? AND s.status = 'active' AND s.expires_at > ? AND c.status = 'active' RETURNING customer_id",
    ).bind(identity.provider, identity.subject, identity.email, now, linkSessionId, now).first<{ customer_id: string }>();
    if (!linked) throw new Error("link_failed");
    return linked.customer_id;
  }
  if (existing) {
    if (existing.status !== "active") throw new Error("sign_in_failed");
    return existing.customer_id;
  }
  if (await db.prepare("SELECT id FROM customers WHERE lower(email) = ? LIMIT 1").bind(identity.email).first()) {
    throw new Error("account_link_required");
  }
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
