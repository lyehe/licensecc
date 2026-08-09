import { json, requestId } from "@licensecc/cloudflare-runtime/http/kit";
import type { Env, ExecutionContextLike } from "./env.js";
import { scheduled as scheduledMaintenance } from "./maintenance/index.js";
import { invalidSecurityModeNames, logEvent } from "./observability/index.js";
import { handleEmergencyRoute } from "./routes/emergency.js";
import { handleLeaseIssue } from "./routes/leases.js";
import { handleOpenApi, handleDocs, handleHealth } from "./routes/meta.js";
import { handleMeter } from "./routes/metering.js";
import { handleOrders } from "./routes/orders.js";
import { handleUsageReport } from "./routes/reports.js";
import { handleSeatCheckout, handleSeatHeartbeat, handleSeatRelease } from "./routes/seats.js";
import { handleVerify } from "./routes/verify.js";
import { META_ROUTES, CLIENT_ROUTES, SCOPED_ROUTES } from "./routes.js";

type RouteHandler = (request: Request, env: Env, ctx?: ExecutionContextLike) => Promise<Response> | Response;

// Dispatch table built from the canonical route inventory (src/routes.ts). Each thunk preserves the
// exact wiring the old if/else chain used. Emergency break-glass is NOT in this table — it is a
// PREFIX gate in fetch() so it can never collide with a literal route. The doc/meta thunks must stay
// env-free: the crosscheck test calls them with an empty env.
const DISPATCH: Record<string, RouteHandler> = {
  "GET /openapi.json": () => handleOpenApi(),
  "GET /docs": () => handleDocs(),
  "GET /health": (request, env) => handleHealth(request, env),
  "POST /v1/verify": (request, env) => handleVerify(request, env),
  "POST /v1/orders": (request, env) => handleOrders(request, env),
  "POST /v1/activate": (request, env, ctx) => handleLeaseIssue(request, env, "activate", ctx),
  "POST /v1/renew": (request, env, ctx) => handleLeaseIssue(request, env, "renew", ctx),
  "POST /v1/checkout": (request, env, ctx) => handleSeatCheckout(request, env, ctx),
  "POST /v1/heartbeat": (request, env, ctx) => handleSeatHeartbeat(request, env, ctx),
  "POST /v1/release": (request, env, ctx) => handleSeatRelease(request, env, ctx),
  "POST /v1/meter": (request, env, ctx) => handleMeter(request, env, ctx),
  "GET /v1/admin/report": (request, env, ctx) => handleUsageReport(request, env, ctx),
};

// Startup guard: the dispatch table and the inventory must agree exactly, in both directions.
{
  const inventory = new Set([...META_ROUTES, ...CLIENT_ROUTES, ...SCOPED_ROUTES].map((route) => `${route.method} ${route.path}`));
  for (const key of Object.keys(DISPATCH)) {
    if (!inventory.has(key)) throw new Error(`dispatch entry not in route inventory: ${key}`);
  }
  for (const key of inventory) {
    if (!(key in DISPATCH)) throw new Error(`route without dispatch entry: ${key}`);
  }
}

// Exposed for the OpenAPI crosscheck test: the literal routes this Worker actually serves.
export const BACKEND_ROUTE_KEYS: readonly string[] = Object.keys(DISPATCH);

export const scheduled = scheduledMaintenance;

const app = {
  async fetch(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
    try {
      const url = new URL(request.url);
      const route = DISPATCH[`${request.method} ${url.pathname}`];
      // Meta documentation is static and must remain inspectable when a deployment has
      // invalid security configuration. Health is the readiness exception: it reports
      // invalid mode *names* without their values.
      if (
        route !== undefined &&
        (url.pathname === "/openapi.json" || url.pathname === "/docs" || url.pathname === "/health")
      ) {
        return await route(request, env, ctx);
      }
      const invalidConfigModes = invalidSecurityModeNames(env);
      if ((url.pathname.startsWith("/v1/emergency/") || route !== undefined) && invalidConfigModes.length > 0) {
        logEvent("error", "config.invalid_security_modes", {
          request_id: requestId(request),
          path: url.pathname,
          invalid_config_modes: invalidConfigModes,
        });
        return json({ ok: false, code: "config_error" }, 503);
      }
      // D10 break-glass: a SEPARATE /v1/emergency/* route gated ONLY by EMERGENCY_OPERATOR_BEARER
      // (constant-time), never reachable from the 6 scoped paths. On match it dispatches the
      // corresponding handler with isolation FORCED off (non-isolated, customerId null) and logs
      // loudly. Unset bearer or a non-match => 404/401 (no oracle that the route exists).
      if (url.pathname.startsWith("/v1/emergency/")) {
        return await handleEmergencyRoute(request, env, url, ctx);
      }
      if (route !== undefined) {
        return await route(request, env, ctx);
      }
      return json({ ok: false, code: "not_found" }, 404);
    } catch (error) {
      logEvent("error", "verify.unhandled_error", {
        request_id: requestId(request),
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : "unknown Worker error",
      });
      return json({ ok: false, code: "verification_error" }, 500);
    }
  },
  scheduled,
};

export default app;
