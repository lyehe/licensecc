// Canonical route inventory for the customer-portal Worker — the single source of truth the
// dispatch tables in index.ts are built from and the OpenAPI crosscheck compares against. Every
// route is a static literal (no path parameters). `inSpec: false` marks the two doc-serving meta
// routes, which are real routes but deliberately not documented inside the spec they serve.

export interface PortalRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly inSpec: boolean;
}

// Unauthenticated doc routes (env-free by contract — the crosscheck calls them with an empty env).
export const META_ROUTES = [
  { method: "GET", path: "/openapi.json", inSpec: false },
  { method: "GET", path: "/docs", inSpec: false },
] as const satisfies readonly PortalRoute[];

// Cookie-less public routes: health plus the auth handshake (each handler does its own gating).
export const PUBLIC_ROUTES = [
  { method: "GET", path: "/health", inSpec: true },
  { method: "POST", path: "/portal/v1/auth/request", inSpec: true },
  { method: "POST", path: "/portal/v1/auth/verify", inSpec: true },
  { method: "GET", path: "/portal/v1/auth/magic", inSpec: true },
  { method: "POST", path: "/portal/v1/auth/magic-redeem", inSpec: true },
  { method: "POST", path: "/portal/v1/auth/logout", inSpec: true },
  { method: "POST", path: "/portal/v1/admin/bootstrap-otp", inSpec: true },
] as const satisfies readonly PortalRoute[];

// Session-scoped routes served under the /api/portal/ prefix gate, after authSession() succeeds.
export const SESSION_ROUTES = [
  { method: "GET", path: "/api/portal/me", inSpec: true },
  { method: "GET", path: "/api/portal/entitlements", inSpec: true },
  { method: "GET", path: "/api/portal/devices", inSpec: true },
  { method: "POST", path: "/api/portal/devices/release", inSpec: true },
  { method: "GET", path: "/api/portal/usage", inSpec: true },
  { method: "POST", path: "/api/portal/checkout", inSpec: true },
  { method: "POST", path: "/api/portal/heartbeat", inSpec: true },
  { method: "POST", path: "/api/portal/release", inSpec: true },
  { method: "POST", path: "/api/portal/download", inSpec: true },
] as const satisfies readonly PortalRoute[];

export const ALL_ROUTES = [...META_ROUTES, ...PUBLIC_ROUTES, ...SESSION_ROUTES] as const;
