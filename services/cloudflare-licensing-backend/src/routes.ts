// Canonical route inventory for the licensing-backend Worker — the single source of truth the
// dispatch table in app.ts is built from and the OpenAPI crosscheck compares against. Every route
// is a static literal (no path parameters). Emergency break-glass re-serves the scoped routes under
// EMERGENCY_PREFIX via a prefix gate in fetch(); compose the full set with allCanonicalRoutes().

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
  { method: "POST", path: "/v1/verify" },
  { method: "POST", path: "/v1/orders" },
] as const satisfies readonly BackendRoute[];

// Account-token scoped lease/seat/report routes — exactly the set the emergency prefix re-serves.
export const SCOPED_ROUTES = [
  { method: "POST", path: "/v1/activate" },
  { method: "POST", path: "/v1/renew" },
  { method: "POST", path: "/v1/checkout" },
  { method: "POST", path: "/v1/heartbeat" },
  { method: "POST", path: "/v1/release" },
  { method: "POST", path: "/v1/meter" },
  { method: "GET", path: "/v1/admin/report" },
] as const satisfies readonly BackendRoute[];

export const EMERGENCY_PREFIX = "/v1/emergency";

// Every route the Worker serves, including the emergency composites, for spec parity.
export function allCanonicalRoutes(): BackendRoute[] {
  return [
    ...META_ROUTES,
    ...CLIENT_ROUTES,
    ...SCOPED_ROUTES,
    ...SCOPED_ROUTES.map((r) => ({ method: r.method, path: `${EMERGENCY_PREFIX}${r.path}` })),
  ];
}
