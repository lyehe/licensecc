import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import type { Actor } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { constantTimeEqual } from "@licensecc/cloudflare-runtime/http/kit";
import { envelope } from "./responses.js";
import type { Env } from "./env.js";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function envFlag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function splitCsv(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => item !== ""));
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  const match = authorization === null ? null : /^Bearer (.+)$/.exec(authorization);
  return match?.[1] ?? null;
}

function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(url);
  if (cached !== undefined) return cached;
  const jwks = createRemoteJWKSet(new URL(url));
  jwksCache.set(url, jwks);
  return jwks;
}

function roleForEmail(email: string, env: Env): "reader" | "admin" | null {
  const normalized = email.toLowerCase();
  if (splitCsv(env.ADMIN_ACCESS_ADMIN_EMAILS).has(normalized)) return "admin";
  if (splitCsv(env.ADMIN_ACCESS_READER_EMAILS).has(normalized)) return "reader";
  return null;
}

export async function authenticate(request: Request, env: Env, requestIdValue: string): Promise<Actor | Response> {
  if (envFlag(env.ADMIN_DEV_BEARER_ENABLED)) {
    if (env.ENVIRONMENT !== "development") return envelope(requestIdValue, "dev_bearer_forbidden_in_environment", undefined, 500);
    const token = bearerToken(request);
    if (env.ADMIN_DEV_BEARER !== undefined && token !== null && await constantTimeEqual(token, env.ADMIN_DEV_BEARER)) {
      return { subject: "dev", email: "dev.local", role: "admin", actorType: "dev" };
    }
  }
  if (!env.ADMIN_ACCESS_ISSUER || !env.ADMIN_ACCESS_AUDIENCE) return envelope(requestIdValue, "admin_auth_not_configured", undefined, 401);
  const token = request.headers.get("cf-access-jwt-assertion");
  if (token === null || token === "") return envelope(requestIdValue, "missing_access_jwt", undefined, 401);
  let payload: JWTPayload;
  try {
    const jwksUrl = env.ADMIN_ACCESS_JWKS_URL || `${env.ADMIN_ACCESS_ISSUER.replace(/\/$/, "")}/cdn-cgi/access/certs`;
    payload = (await jwtVerify(token, jwksFor(jwksUrl), { issuer: env.ADMIN_ACCESS_ISSUER, audience: env.ADMIN_ACCESS_AUDIENCE })).payload;
  } catch {
    return envelope(requestIdValue, "invalid_access_jwt", undefined, 403);
  }
  const email = typeof payload.email === "string" ? payload.email : "";
  const subject = typeof payload.sub === "string" ? payload.sub : email;
  const role = roleForEmail(email, env);
  return email === "" || subject === "" || role === null
    ? envelope(requestIdValue, "admin_role_denied", undefined, 403)
    : { subject, email, role, actorType: "access" };
}

export async function authenticateSync(request: Request, env: Env, requestIdValue: string): Promise<Actor | Response> {
  if (env.SYNC_API_TOKEN === undefined || env.SYNC_API_TOKEN === "") return envelope(requestIdValue, "sync_auth_not_configured", undefined, 401);
  const token = bearerToken(request);
  if (token === null || !await constantTimeEqual(token, env.SYNC_API_TOKEN)) return envelope(requestIdValue, "invalid_sync_token", undefined, 403);
  return { subject: "sync", email: "sync", role: "admin", actorType: "sync" };
}

export function requireAdmin(actor: Actor, requestIdValue: string): Response | null {
  return actor.role === "admin" ? null : envelope(requestIdValue, "admin_role_required", undefined, 403);
}
