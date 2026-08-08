import assert from "node:assert/strict";
import test from "node:test";
import {
  NEXT_JSON_KEYS,
  MockD1,
  accessAuthed,
  accessEnv,
  accessFixture,
  accessToken,
  adminInternalsForTests,
  authed,
  baseEnv,
  clone,
  effectiveLicenseMode,
  entitlementDefaults,
  fingerprint,
  json,
  keyOf,
  rotatableAccessFixture,
  syncAuthed,
  syncEnv,
  worker,
} from "./fixtures.mjs";
import { assertRouteGroup, assertRouteGroupRejectsUnauthenticated } from "./route-group-assertions.mjs";
test("summary and report routes have direct owners and reject anonymous access", async () => {
  assertRouteGroup("summary-reports", 6);
  await assertRouteGroupRejectsUnauthenticated("summary-reports");
});

test("admin summary requires authentication", async () => {
  const response = await worker.fetch(new Request("https://admin.example/api/admin/summary"), baseEnv());
  assert.equal(response.status, 401);
  assert.equal((await json(response)).code, "admin_auth_not_configured");
});


test("cloudflare access jwt admin can read admin summary", async (t) => {
  const fixture = await accessFixture(t);
  const token = await accessToken(fixture, "admin@example.com");
  const response = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 200);
  assert.equal((await json(response)).code, "summary");
});
