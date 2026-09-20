import { hashPassword, loginEmail, validPassword } from "@licensecc/cloudflare-runtime/auth/password";
import type { Actor } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Env } from "../../env.js";
import { requireAdmin } from "../../auth.js";
import { idempotentReplay, INVALID_IDEMPOTENCY_KEY, readIdempotencyKey } from "../../idempotency.js";
import { parseJsonBody } from "../../request.js";
import { envelope, json } from "../../responses.js";

export async function createPortalUser(request: Request, env: Env, actor: Actor, rid: string): Promise<Response> {
  const denied = requireAdmin(actor, rid);
  if (denied) return denied;
  const key = readIdempotencyKey(request);
  if (!key || key === INVALID_IDEMPOTENCY_KEY) return envelope(rid, "invalid_idempotency_key", undefined, 400);
  const input = await parseJsonBody(request, rid);
  if (input instanceof Response) return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return envelope(rid, "invalid_request", undefined, 400);
  const body = input as Record<string, unknown>;
  const email = loginEmail(body.email);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!email || !name || name.length > 128 || Array.from(name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || !validPassword(body.password)) return envelope(rid, "invalid_request", undefined, 400);
  const scope = `POST:/api/admin/customers:${actor.subject}`;
  const replay = await idempotentReplay(env, scope, key);
  if (replay) return replay;
  const existingEmail = () => env.DB.prepare("SELECT id FROM customers WHERE lower(email) = ? UNION ALL SELECT customer_id AS id FROM portal_passwords WHERE email_lower = ? LIMIT 1").bind(email, email).first();
  if (await existingEmail()) return envelope(rid, "email_in_use", undefined, 409);
  if (!env.DB.batch) return envelope(rid, "mutation_failed", undefined, 500);
  const passwordHash = await hashPassword(body.password);
  const now = Math.floor(Date.now() / 1000);
  const id = `cust_${crypto.randomUUID()}`;
  const data = { id, name, email: "", login_email: email, status: "active", external_ref: "", created_at: now, updated_at: now };
  const response = { ok: true, code: "customer_created", request_id: rid, data };
  try {
    await env.DB.batch([
      // Login email is unverified: never populate the fulfillment/OTP address.
      env.DB.prepare("INSERT INTO customers (id,name,email,metadata_json,created_at,updated_at) SELECT ?,?,'',?,?,? WHERE NOT EXISTS (SELECT 1 FROM customers WHERE lower(email)=?)")
        .bind(id, name, JSON.stringify({ created_by: actor.subject, created_request_id: rid, source: "admin" }), now, now, email),
      env.DB.prepare("INSERT INTO portal_passwords (customer_id,email_lower,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)").bind(id, email, passwordHash, now, now),
      // A raced same-key claim rolls back the entire batch. Cache only public data.
      env.DB.prepare("INSERT INTO mutation_idempotency (scope,idempotency_key,response_json,created_at) VALUES (?,?,?,?)").bind(scope, key, JSON.stringify(response), now),
    ]);
  } catch {
    const raced = await idempotentReplay(env, scope, key);
    if (raced) return raced;
    if (await existingEmail()) return envelope(rid, "email_in_use", undefined, 409);
    return envelope(rid, "mutation_failed", undefined, 500);
  }
  return json(response, 200, { "cache-control": "no-store" });
}
