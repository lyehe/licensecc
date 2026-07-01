import assert from "node:assert/strict";
import { test } from "node:test";

import { isSupportedPgRoute, PG_SUPPORTED_ROUTES } from "./pg-route-guard.mjs";

test("the Postgres adapter allow-lists exactly GET /health and POST /v1/verify (R3.2)", () => {
  assert.equal(isSupportedPgRoute("GET", "/health"), true);
  assert.equal(isSupportedPgRoute("POST", "/v1/verify"), true);
  // Order-ingest / seat / webhook / mutator / admin routes emit SQLite-only SQL and must be fenced.
  for (const path of ["/v1/orders", "/v1/checkout", "/v1/heartbeat", "/v1/release", "/v1/activate", "/v1/admin/report"]) {
    assert.equal(isSupportedPgRoute("POST", path), false, `${path} must be D1-only`);
  }
  // Method matters: GET /v1/verify is not the (POST) verify route.
  assert.equal(isSupportedPgRoute("GET", "/v1/verify"), false);
  assert.equal(PG_SUPPORTED_ROUTES.length, 2);
});
