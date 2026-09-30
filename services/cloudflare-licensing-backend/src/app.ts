import { json, requestId } from "@licensecc/cloudflare-runtime/http/kit";
import type { Env, ExecutionContextLike } from "./env.js";
import { scheduled as scheduledMaintenance } from "./maintenance/index.js";
import { invalidSecurityModeNames, logEvent } from "./observability/index.js";
import { handleOpenApi, handleDocs, handleHealth } from "./routes/meta.js";
import { handleOrders } from "./routes/orders.js";
import { handleBoundDevice } from "./routes/bound_devices.mjs";
import { META_ROUTES, CLIENT_ROUTES } from "./routes.js";

type RouteHandler = (request: Request, env: Env, ctx?: ExecutionContextLike) => Promise<Response> | Response;

// Dispatch table built from the canonical route inventory (src/routes.ts). Each thunk preserves the
// exact wiring the old if/else chain used. Doc thunks stay env-free (the crosscheck calls them with
// an empty env); /health answers an empty env with 503, never a throw.
const DISPATCH: Record<string, RouteHandler> = {
  "GET /openapi.json": () => handleOpenApi(),
  "GET /docs": () => handleDocs(),
  "GET /health": (request, env) => handleHealth(request, env),
  "POST /v1/orders": (request, env) => handleOrders(request, env),
  "POST /v2/device-authorizations": (request, env) => handleBoundDevice(request, env, "authorize"),
  "POST /v2/device-challenges": (request, env) => handleBoundDevice(request, env, "challenge"),
  "POST /v2/device-authorizations/exchange": (request, env) => handleBoundDevice(request, env, "exchange"),
  "POST /v2/device-leases/renew": (request, env) => handleBoundDevice(request, env, "renew"),
};

// Startup guard: the dispatch table and the inventory must agree exactly, in both directions.
{
  const inventory = new Set([...META_ROUTES, ...CLIENT_ROUTES].map((route) => `${route.method} ${route.path}`));
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
      if (route !== undefined && invalidConfigModes.length > 0) {
        logEvent("error", "config.invalid_security_modes", {
          request_id: requestId(request),
          path: url.pathname,
          invalid_config_modes: invalidConfigModes,
        });
        if (url.pathname.startsWith("/v2/")) {
          const response = json({ ok: false, code: "temporarily_unavailable", request_id: crypto.randomUUID() }, 503);
          response.headers.set("cache-control", "no-store");
          return response;
        }
        return json({ ok: false, code: "config_error" }, 503);
      }
      if (route !== undefined) {
        return await route(request, env, ctx);
      }
      return json({ ok: false, code: "not_found" }, 404);
    } catch (error) {
      logEvent("error", "request.unhandled_error", {
        request_id: requestId(request),
        path: new URL(request.url).pathname,
        error_type: error instanceof Error ? error.name : "UnknownThrownValue",
      });
      return json({ ok: false, code: "verification_error" }, 500);
    }
  },
  scheduled,
};

export default app;
