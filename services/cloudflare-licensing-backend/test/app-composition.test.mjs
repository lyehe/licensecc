import assert from "node:assert/strict";
import { test } from "node:test";
import app, { scheduled } from "../dist/app.js";

function recordingDb(statements = []) {
  return {
    prepare(sql) {
      statements.push(sql);
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: [] };
        },
        async first() {
          return null;
        },
        async run() {
          return {};
        },
      };
    },
  };
}

async function responseBody(response) {
  return response.json();
}

test("app returns the generic top-level 404 contract", async () => {
  const response = await app.fetch(new Request("https://example.test/not-a-route"), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await responseBody(response), { ok: false, code: "not_found" });
});

test("scheduled is directly callable and retains each best-effort retention sweep", async () => {
  const statements = [];
  await scheduled({ cron: "0 * * * *" }, { DB: recordingDb(statements) }, { waitUntil() {} });
  for (const table of ["usage_events", "lease_issuance", "usage_meters", "portal_otp", "portal_sessions"]) {
    assert.ok(statements.some((sql) => sql.includes(`DELETE FROM ${table}`)), `expected scheduled retention for ${table}`);
  }
});

test("app dispatches the live orders and meter routes before their handler-specific guards", async () => {
  const orders = await app.fetch(
    new Request("https://example.test/v1/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { DB: recordingDb(), ORDER_INGEST_MODE: "required" },
  );
  assert.equal(orders.status, 503);
  assert.deepEqual(await responseBody(orders), { ok: false, code: "config_error" });

  const meter = await app.fetch(
    new Request("https://example.test/v1/meter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { DB: recordingDb() },
  );
  assert.equal(meter.status, 400);
  assert.deepEqual(await responseBody(meter), { ok: false, code: "invalid_request" });
});

test("emergency prefix delegates each of its seven scoped operations", async () => {
  const cases = [
    ["POST", "/v1/emergency/v1/activate", 503, "lease_signing_unavailable"],
    ["POST", "/v1/emergency/v1/renew", 503, "lease_signing_unavailable"],
    ["POST", "/v1/emergency/v1/checkout", 503, "seat_signing_unavailable"],
    ["POST", "/v1/emergency/v1/heartbeat", 503, "seat_signing_unavailable"],
    ["POST", "/v1/emergency/v1/release", 400, "invalid_request"],
    ["POST", "/v1/emergency/v1/meter", 400, "invalid_request"],
    ["GET", "/v1/emergency/v1/admin/report", 400, "invalid_request"],
  ];
  for (const [method, path, status, code] of cases) {
    const response = await app.fetch(
      new Request(`https://example.test${path}`, {
        method,
        headers: { authorization: "Bearer emergency", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: "{}" } : {}),
      }),
      { DB: recordingDb(), EMERGENCY_OPERATOR_BEARER: "emergency" },
    );
    assert.equal(response.status, status, `${method} ${path}`);
    assert.deepEqual(await responseBody(response), { ok: false, code }, `${method} ${path}`);
  }
});
