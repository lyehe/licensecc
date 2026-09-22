import { mintSession, setSessionCookie, loadSessionPeppers } from "../../auth/portal_session.mjs";
import { portalRateLimit } from "../../auth/portal_ratelimit.mjs";
import { canonicalHttpsOrigin } from "../../auth/portal_destination.mjs";
import { clientIp, envelope } from "../support.js";
import type { Env } from "../env.js";

export const HEADERS = { "cache-control": "no-store" };
export const primary = (env: Env) => env.DB.withSession?.("first-primary") ?? env.DB;
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
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email)));
  const key = Array.from(hash, (v) => v.toString(16).padStart(2, "0")).join("");
  return (await portalRateLimit(env, `password:${action}:email:${key}`, 10, 900, now)).limited;
}
export async function signedIn(request: Request, env: Env, reqId: string, customerId: string, passwordHash: string, now: number): Promise<Response> {
  const minted = await mintSession(env, { customerId, passwordHash, authMethod: "password", userAgent: request.headers.get("user-agent") ?? "", now });
  if (!minted.ok || !minted.raw) return envelope(reqId, "invalid_credentials", undefined, 401, HEADERS);
  return envelope(reqId, "signed_in", { customer_id: customerId }, 200, { ...HEADERS, "set-cookie": setSessionCookie(minted.raw) });
}
