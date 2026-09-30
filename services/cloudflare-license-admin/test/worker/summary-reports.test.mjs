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

test("timeseries reports protected denials and no checkout series", async () => {
  // D1 answers the usage query with every column the old checkout-series query named; the report
  // must read only the protected refusal count and fulfillment events from it.
  const queries = [];
  const db = {
    prepare(sql) {
      queries.push(sql);
      const rows = sql.includes("FROM usage_events")
        ? [{ bucket: 0, checkouts: 3, releases: 2, denials: 1 }]
        : [{ bucket: 1, fulfillment_events: 4 }];
      const statement = { bind: () => statement, all: async () => ({ results: rows }) };
      return statement;
    },
  };
  const response = await worker.fetch(authed("/api/admin/report/timeseries?from=0&to=200&buckets=2"), baseEnv(db));
  assert.equal(response.status, 200);
  const data = (await json(response)).data;
  assert.deepEqual(data.buckets, [
    { start: 0, denials: 1, fulfillment_events: 0 },
    { start: 100, denials: 0, fulfillment_events: 4 },
  ]);
  const usage = queries.find((sql) => sql.includes("FROM usage_events"));
  assert.ok(usage, "the report reads the refusal audit");
  assert.doesNotMatch(usage, /checkout|release|reclaim/, "no checkout or release series is read");
  assert.match(usage, /event_type = 'denied' AND reason = 'device_limit_reached'/, "only protected device-limit refusals count");
});
