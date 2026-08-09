import assert from "node:assert/strict";
import test from "node:test";

import { boundedCursor, csvField, toCsv } from "../../dist-worker/worker/query.js";
import { authed, baseEnv, MockD1, json, worker } from "./fixtures.mjs";

const INVALID_LIMIT_VALUES = [
  "-1",
  "-2",
  "0",
  "1.5",
  "Infinity",
  "NaN",
  "9007199254740992",
  "999999999999999999999999999999999999999999999999999999999999999999",
];

const INVALID_CURSOR_VALUES = INVALID_LIMIT_VALUES.filter((value) => value !== "0");

function queryPath(path, name, value) {
  return `${path}${path.includes("?") ? "&" : "?"}${name}=${encodeURIComponent(value)}`;
}

test("boundedCursor uses compatible defaults only for omitted or empty values", () => {
  assert.deepEqual(boundedCursor(new URL("https://admin.example/api/admin/customers")), { limit: 50, cursor: 0 });
  assert.deepEqual(boundedCursor(new URL("https://admin.example/api/admin/customers?limit=&cursor=")), { limit: 50, cursor: 0 });
  assert.deepEqual(boundedCursor(new URL("https://admin.example/api/admin/customers?limit=1&cursor=0")), { limit: 1, cursor: 0 });
  assert.deepEqual(boundedCursor(new URL("https://admin.example/api/admin/customers?limit=100&cursor=9007199254740991")), {
    limit: 100,
    cursor: Number.MAX_SAFE_INTEGER,
  });
});

test("boundedCursor rejects malformed, unsafe, and out-of-range explicit values", () => {
  for (const value of INVALID_LIMIT_VALUES) {
    assert.equal(boundedCursor(new URL(`https://admin.example/api/admin/customers?limit=${encodeURIComponent(value)}`)), null, `limit=${value}`);
  }
  for (const value of INVALID_CURSOR_VALUES) {
    assert.equal(boundedCursor(new URL(`https://admin.example/api/admin/customers?cursor=${encodeURIComponent(value)}`)), null, `cursor=${value}`);
  }
  assert.equal(boundedCursor(new URL("https://admin.example/api/admin/customers?limit=101")), null);
  assert.equal(boundedCursor(new URL("https://admin.example/api/admin/customers?limit= 1")), null);
  assert.equal(boundedCursor(new URL("https://admin.example/api/admin/customers?cursor= 1")), null);
});

const PAGINATED_LIMIT_ROUTES = [
  "/api/admin/customers",
  "/api/admin/licenses",
  "/api/admin/orders",
  "/api/admin/search?q=needle",
  "/api/admin/entitlements",
  "/api/admin/events",
  "/api/admin/policies",
  "/api/admin/catalog/features",
  "/api/admin/catalog/plans",
  "/api/admin/webhooks",
  "/api/admin/webhooks/deliveries",
  "/api/admin/report/expiring",
];

const CURSOR_ROUTES = PAGINATED_LIMIT_ROUTES.filter((path) => !path.startsWith("/api/admin/events") && !path.startsWith("/api/admin/search"));

async function assertInvalidQuery(path, name, value) {
  const response = await worker.fetch(authed(queryPath(path, name, value)), baseEnv(new MockD1()));
  assert.equal(response.status, 400, `${path} ${name}=${value}`);
  assert.equal((await json(response)).code, "invalid_request", `${path} ${name}=${value}`);
}

test("every paginated route family rejects malformed limits before touching D1", async () => {
  for (const path of PAGINATED_LIMIT_ROUTES) {
    for (const value of INVALID_LIMIT_VALUES) {
      await assertInvalidQuery(path, "limit", value);
    }
    await assertInvalidQuery(path, "limit", "101");
  }
});

test("every cursor-paginated route family rejects malformed cursors before touching D1", async () => {
  for (const path of CURSOR_ROUTES) {
    for (const value of INVALID_CURSOR_VALUES) {
      await assertInvalidQuery(path, "cursor", value);
    }
  }
});

test("CSV fields neutralize formula prefixes after leading spaces and preserve RFC-4180 escaping", () => {
  for (const prefix of ["=", "+", "-", "@", "\t", "\r"]) {
    for (const leading of ["", " ", "  ", "\t", "\r", " \t\r"]) {
      const value = `${leading}${prefix}SUM(A1)`;
      assert.equal(csvField(value), `"'${value.replaceAll('"', '""')}"`, JSON.stringify(value));
    }
  }

  assert.equal(csvField("ordinary"), '"ordinary"');
  assert.equal(csvField("  ordinary"), '"  ordinary"');
  assert.equal(csvField(42), '"42"');
  assert.equal(csvField(3.5), '"3.5"');
  assert.equal(csvField(null), '""');
  assert.equal(csvField(undefined), '""');
  assert.equal(csvField("comma,quote\"and\nnewline"), '"comma,quote""and\nnewline"');
  assert.equal(csvField("\n=SUM(A1)"), '"\n=SUM(A1)"');

  assert.equal(
    toCsv(["value"], [{ value: "=SUM(A1)" }, { value: "normal" }], false),
    '"value"\r\n"\'=SUM(A1)"\r\n"normal"\r\n',
  );
});
