import type { D1DatabaseLike, D1PreparedStatement } from "../env.js";

type InvalidationOptions = { email?: string };

// Append to the credential-write batch; never execute these statements separately.
// The fresh salted hash guards every invalidation against failed or raced writes.
export function passwordInvalidations(
  db: D1DatabaseLike, customerId: string, passwordHash: string, now: number,
  { email }: InvalidationOptions = {},
): D1PreparedStatement[] {
  const changed = "EXISTS (SELECT 1 FROM portal_passwords WHERE customer_id = ? AND password_hash = ?)";
  const statements = [
    db.prepare(`UPDATE portal_sessions SET status = 'revoked' WHERE customer_id = ? AND ${changed}`).bind(customerId, customerId, passwordHash),
    db.prepare(`UPDATE portal_otp SET consumed_at = ? WHERE customer_id = ? AND consumed_at IS NULL AND ${changed}`).bind(now, customerId, customerId, passwordHash),
  ];
  if (email !== undefined) statements.push(
    db.prepare(`UPDATE portal_password_actions SET consumed_at = ? WHERE email_lower = ? AND consumed_at IS NULL AND ${changed}`).bind(now, email, customerId, passwordHash),
  );
  return statements;
}
