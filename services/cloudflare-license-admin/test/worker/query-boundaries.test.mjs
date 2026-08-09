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
  for (const prefix of ["=", "+", "-", "@", "\t", "\r", "＝", "＋", "－", "＠"]) {
    for (const leading of ["", " ", "  ", "\t", "\r", "\n", " \t\r\n", "\uFEFF", "\u00A0", "\u2003", "\u200B", "\u2060", "\uFEFF\u00A0\u2003"]) {
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
  assert.equal(csvField("\n=SUM(\"A1\")\n"), '"\'\n=SUM(""A1"")\n"');
  assert.equal(csvField("\u00A0＝SUM(A1)"), '"\'\u00A0＝SUM(A1)"');
  assert.equal(csvField("\u200B＠SUM(A1)"), '"\'\u200B＠SUM(A1)"');

  assert.equal(
    toCsv(["value"], [{ value: "=SUM(A1)" }, { value: "normal" }], false),
    '"value"\r\n"\'=SUM(A1)"\r\n"normal"\r\n',
  );
});

function recordingDb(rows = []) {
  return {
    prepareCalls: 0,
    prepare(sql) {
      this.prepareCalls += 1;
      return {
        bind(...values) {
          return {
            async all() {
              return { results: rows, values, sql };
            },
          };
        },
      };
    },
  };
}

function rejectingDb() {
  return {
    prepareCalls: 0,
    prepare() {
      this.prepareCalls += 1;
      throw new Error("D1 must not be touched for invalid pagination");
    },
  };
}

test("CSV HTTP exports neutralize formula cells for customers, entitlements, and events", async () => {
  const cases = [
    ["/api/admin/customers?format=csv", [{ id: "c-1", name: "\n=SUM(\"A1\")", email: "customer@example.com", status: "active", external_ref: "ref", entitlement_count: 0, active_entitlement_count: 0, created_at: 1, updated_at: 1 }]],
    ["/api/admin/entitlements?format=csv", [{ project: "p", feature: "f", license_fingerprint: "a".repeat(64), device_hash: "", status: "active", assertion_ttl_seconds: 300, revocation_seq: 1, valid_from: null, valid_until: null, notes: "\uFEFF＠SUM(A1)", customer_id: null, license_id: null, created_at: 1, updated_at: 1 }]],
    ["/api/admin/events?format=csv", [{ id: 1, project: "p", feature: "f", license_fingerprint: "a".repeat(64), event_type: "update", status: "active", revocation_seq: 1, actor: "admin", actor_type: "admin", source: "admin", request_id: "req", reason: "\u00A0＋SUM(A1)", detail: "", created_at: 1 }]],
  ];
  for (const [path, rows] of cases) {
    const db = recordingDb(rows);
    const response = await worker.fetch(authed(path), baseEnv(db));
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", /^text\/csv/);
    const body = await response.text();
    assert.match(body, /"'[\s\uFEFF\u200B\u200C\u200D\u2060]*(?:=|＠|＋)SUM/u, path);
    assert.equal(db.prepareCalls, 1, `${path} uses one export query`);
  }
});

test("malformed pagination on CSV routes returns 400 without preparing D1", async () => {
  for (const path of ["/api/admin/customers?format=csv", "/api/admin/entitlements?format=csv", "/api/admin/events?format=csv"]) {
    for (const query of ["limit=-1", "cursor=-1", "limit=Infinity"]) {
      const db = rejectingDb();
      const response = await worker.fetch(authed(`${path}&${query}`), baseEnv(db));
      assert.equal(response.status, 400, `${path}&${query}`);
      assert.equal((await json(response)).code, "invalid_request", `${path}&${query}`);
      assert.equal(db.prepareCalls, 0, `${path}&${query}`);
    }
  }
});
