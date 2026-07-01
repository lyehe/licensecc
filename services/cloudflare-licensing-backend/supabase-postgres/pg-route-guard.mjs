// Verify-path-only fence for the Postgres adapter (audit R3.2).
//
// The Postgres runtime (server.mjs) delegates to the SAME Worker as D1, but the generic SQL
// translator (pg-sql.mjs) only covers the /v1/verify + /health path. The order-ingest, webhook
// dispatcher, and shared entitlement mutators emit SQLite-isms (rowid, json_object(), unixepoch())
// that would throw on Postgres. Rather than let a misdirected request hit untranslatable SQL and
// fail obscurely, the server allow-lists exactly the two supported routes and rejects the rest with
// a clear code. This keeps the Postgres port honestly scoped to what it actually supports today.

export const PG_SUPPORTED_ROUTES = [
  { method: "GET", path: "/health" },
  { method: "POST", path: "/v1/verify" },
];

/** True iff (method, pathname) is one of the verify-path routes the Postgres adapter supports. */
export function isSupportedPgRoute(method, pathname) {
  return PG_SUPPORTED_ROUTES.some((route) => route.method === method && route.path === pathname);
}
