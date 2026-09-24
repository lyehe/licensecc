import { mintSession, setSessionCookie, loadSessionPeppers } from "../../auth/portal_session.mjs";
import { portalRateLimit } from "../../auth/portal_ratelimit.mjs";
import { canonicalHttpsOrigin } from "../../auth/portal_destination.mjs";
import { clientIp, envelope } from "../support.js";
import type { Env } from "../env.js";

export const HEADERS = { "cache-control": "no-store" };
export const primary = (env: Env) => env.DB.withSession?.("first-primary") ?? env.DB;
// The one predicate deciding whether a credential (portal_passwords row `p`, joined or correlated to
// its owning `customers` row `c`) may recover by email: its login address matches the customer's own
// verified contact address, or the customer has no contact email yet (never verified -- including an
// admin-invited account) and no OTHER customer has already claimed that address. Shared verbatim by
// the emailed reset lookup (password-email.ts) and the password-settings `recovery_available` flag
// (routes/password.ts) so the two can never silently diverge -- the UI must never promise a recovery
// the server would refuse.
export const RESET_ELIGIBLE_SQL = "(lower(c.email) = p.email_lower OR (c.email = '' AND NOT EXISTS (SELECT 1 FROM customers o WHERE lower(o.email) = p.email_lower)))";
export async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function gate(request: Request, env: Env, reqId: string): Response | null {
  if (env.PORTAL_PASSWORD_ENABLED !== "1") return envelope(reqId, "not_found", undefined, 404, HEADERS);
  const origin = canonicalHttpsOrigin(env.PORTAL_PUBLIC_ORIGIN);
  if (!origin || new URL(request.url).origin !== origin || (request.method === "POST" && request.headers.get("origin") !== origin)) {
    return envelope(reqId, "cross_site_forbidden", undefined, 403, HEADERS);
  }
  if (loadSessionPeppers(env) === null) return envelope(reqId, "config_error", undefined, 503, HEADERS);
  return null;
}
export async function throttle(request: Request, env: Env, email: string, action: string, now: number): Promise<boolean> {
  const ip = await portalRateLimit(env, `password:${action}:ip:${clientIp(request)}`, action === "register" ? 5 : 30, 900, now);
  if (ip.limited) return true;
  const key = await digest(email);
  return (await portalRateLimit(env, `password:${action}:email:${key}`, 10, 900, now)).limited;
}
export async function signedIn(request: Request, env: Env, reqId: string, customerId: string, passwordHash: string, now: number): Promise<Response> {
  const minted = await mintSession(env, { customerId, passwordHash, authMethod: "password", userAgent: request.headers.get("user-agent") ?? "", now });
  if (!minted.ok || !minted.raw) return envelope(reqId, "invalid_credentials", undefined, 401, HEADERS);
  return envelope(reqId, "signed_in", { customer_id: customerId }, 200, { ...HEADERS, "set-cookie": setSessionCookie(minted.raw) });
}
