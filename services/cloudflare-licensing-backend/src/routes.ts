// Canonical route inventory for the licensing-backend Worker — the single source of truth the
// dispatch table in app.ts is built from and the OpenAPI crosscheck compares against. Every route
// is a static literal (no path parameters); allCanonicalRoutes() composes the full set.

export interface BackendRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
}

// Unauthenticated meta/doc routes (never touch env-backed auth).
export const META_ROUTES = [
  { method: "GET", path: "/openapi.json" },
  { method: "GET", path: "/docs" },
  { method: "GET", path: "/health" },
] as const satisfies readonly BackendRoute[];

// Client + fulfillment routes (their handlers do their own auth/HMAC gating).
export const CLIENT_ROUTES = [
  { method: "POST", path: "/v1/orders" },
  { method: "POST", path: "/v2/device-authorizations" },
  { method: "POST", path: "/v2/device-challenges" },
  { method: "POST", path: "/v2/device-authorizations/exchange" },
  { method: "POST", path: "/v2/device-leases/renew" },
] as const satisfies readonly BackendRoute[];

// Every route the Worker serves, for spec parity.
export function allCanonicalRoutes(): BackendRoute[] {
  return [...META_ROUTES, ...CLIENT_ROUTES];
}
