// Customer-portal Worker composition. Route behavior lives in explicit owners under routes.

import { requestId } from "@licensecc/cloudflare-runtime/http/kit";
import { ALL_ROUTES, META_ROUTES, PUBLIC_ROUTES, SESSION_ROUTES } from "./routes.js";
import { HEALTH_DISPATCH, META_DISPATCH } from "./routes/meta.js";
import { AUTH_DISPATCH, authSession } from "./routes/auth.js";
import { SESSION_DISPATCH, resolveOwnedEntitlement } from "./routes/self-service.js";
import { envelope, isCrossSite, constantTimeEqual, decodeEntitlementId, entitlementId } from "./support.js";
import type { Env, ExecutionContextLike, TopRoute } from "./env.js";

export type { Env } from "./env.js";

// Top-level routes are composed in canonical inventory order. Session lookup remains a separate
// boundary so every /api/portal request authenticates before its method/path is inspected.
const TOP_DISPATCH: Record<string, TopRoute> = {
  ...META_DISPATCH,
  ...HEALTH_DISPATCH,
  ...AUTH_DISPATCH,
};

async function handleApiPortal(request: Request, env: Env, reqId: string, now: number, pathname: string): Promise<Response> {
  const session = await authSession(request, env, reqId, now);
  if (session instanceof Response) return session;
  const route = SESSION_DISPATCH[`${request.method} ${pathname}` as keyof typeof SESSION_DISPATCH];
  if (route !== undefined) return await route(request, env, session, reqId, now);
  return envelope(reqId, "not_found", undefined, 404);
}

// Startup guard: dispatch entries and the canonical route inventory must agree in both directions.
{
  const top = new Set([...META_ROUTES, ...PUBLIC_ROUTES].map((r) => `${r.method} ${r.path}`));
  const session = new Set(SESSION_ROUTES.map((r) => `${r.method} ${r.path}`));
  for (const key of Object.keys(TOP_DISPATCH)) {
    if (!top.has(key)) throw new Error(`top-level dispatch entry not in route inventory: ${key}`);
  }
  for (const key of top) {
    if (!(key in TOP_DISPATCH)) throw new Error(`route without top-level dispatch entry: ${key}`);
  }
  for (const key of Object.keys(SESSION_DISPATCH)) {
    if (!session.has(key)) throw new Error(`session dispatch entry not in route inventory: ${key}`);
  }
  for (const key of session) {
    if (!(key in SESSION_DISPATCH)) throw new Error(`route without session dispatch entry: ${key}`);
  }
  if (ALL_ROUTES.length !== 18) throw new Error(`portal route inventory changed: expected 18, got ${ALL_ROUTES.length}`);
}

export const PORTAL_ROUTE_KEYS: readonly string[] = [...Object.keys(TOP_DISPATCH), ...Object.keys(SESSION_DISPATCH)];

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
    const reqId = requestId(request);
    const now = Math.floor(Date.now() / 1000);
    try {
      const url = new URL(request.url);
      const p = url.pathname;
      const route = TOP_DISPATCH[`${request.method} ${p}`];
      if (route !== undefined) return await route(request, env, ctx, reqId, now);
      if (p.startsWith("/api/portal/")) return await handleApiPortal(request, env, reqId, now, p);
      // Preserve the SPA fallback for assets/client routes and the plain 404 without assets.
      if (env.ASSETS !== undefined) return env.ASSETS.fetch(request);
      return new Response("not found", { status: 404 });
    } catch {
      return envelope(reqId, "portal_error", undefined, 500);
    }
  },
};

export const portalInternalsForTests = { isCrossSite, constantTimeEqual, entitlementId, decodeEntitlementId, resolveOwnedEntitlement };
