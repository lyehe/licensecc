// HTTP-level tests for GET /v1/admin/report (usage analytics). The aggregation math is
// covered exhaustively in usage-report.test.mjs and end-to-end over SQLite in
// sql/usage-events.test.mjs; here we confirm the endpoint wiring, auth, and validation.

import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../dist/index.js";

function makeEnv(events, overrides = {}) {
  return {
    DB: {
      prepare(_sql) {
        return {
          bind() {
            return {
              async first() {
                return { baseline: 0 };
              },
              async all() {
                return { results: events };
              },
              async run() {
                return {};
              },
            };
          },
        };
      },
    },
    ...overrides,
  };
}

function reportRequest(query, headers = {}) {
  const url = new URL("https://verifier.example/v1/admin/report");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { method: "GET", headers });
}

const ENTITLEMENT = { project: "DEFAULT", feature: "DEFAULT", license_fingerprint: "a".repeat(64) };

test("report returns the aggregated usage summary", async () => {
  const events = [
    { event_type: "checkout", device_key_id: "d1", ts: 10 },
    { event_type: "checkout", device_key_id: "d2", ts: 20 },
    { event_type: "denied", device_key_id: null, ts: 25 },
    { event_type: "release", device_key_id: null, ts: 30 },
  ];
  const res = await worker.fetch(reportRequest(ENTITLEMENT), makeEnv(events));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.peak_concurrent, 2);
  assert.equal(out.checkouts, 2);
  assert.equal(out.denials, 1);
  assert.equal(out.unique_devices, 2);
  assert.equal(out.denial_rate, 1 / 3); // 2 checkouts + 1 denial = 3 attempts
});

test("report requires the entitlement key", async () => {
  const res = await worker.fetch(reportRequest({ project: "DEFAULT" }), makeEnv([]));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_request");
});

test("report is bearer-gated when configured", async () => {
  const env = makeEnv([], { LEASE_ISSUE_BEARER: "secret" });
  const bad = await worker.fetch(reportRequest(ENTITLEMENT, { authorization: "Bearer wrong" }), env);
  assert.equal(bad.status, 401);
  const good = await worker.fetch(reportRequest(ENTITLEMENT, { authorization: "Bearer secret" }), env);
  assert.equal(good.status, 200);
});
