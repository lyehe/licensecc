import assert from "node:assert/strict";
import test from "node:test";
import { matchRoute } from "../../dist-worker/worker/dispatch.js";
import { accessAuthed, accessEnv, accessFixture, accessToken, authed, baseEnv, json, worker } from "./fixtures.mjs";

// POST /api/admin/webhooks/{id}/test asks the backend's WebhookOperator capability (the only
// Worker that holds WEBHOOK_SIGNING_SECRETS) to send one signed test event. The admin Worker never
// sees the secret: it forwards the endpoint id and relays only a status class. A send that reached
// the receiver also leaves one webhook_events audit row; a refused send leaves none.

function untouchableDb() {
  return {
    prepare() { throw new Error("D1 must not be touched"); },
    batch() { throw new Error("D1 must not be touched"); },
  };
}

// Counts every D1 touch. The audit swallows D1 errors, so a throwing DB alone cannot prove that a
// refusal never reached D1; the counter can.
function countingDb() {
  const db = {
    touches: 0,
    prepare() { db.touches += 1; throw new Error("D1 must not be touched"); },
    batch() { db.touches += 1; throw new Error("D1 must not be touched"); },
  };
  return db;
}

// A D1 stand-in for the test-send audit. It answers the endpoint status read and records each
// webhook_events insert by column name (a "?" takes the next bound value, a quoted literal is
// stored as written), so the test sees the row the real table would receive.
function auditDb({ status = "active", failInsert = false } = {}) {
  const db = {
    rows: [],
    prepare(sql) {
      const text = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...values) {
          return {
            async first() {
              if (text === "SELECT status FROM webhook_endpoints WHERE id = ?") {
                return status === null ? null : { status };
              }
              throw new Error(`unexpected first SQL: ${text}`);
            },
            async run() {
              const match = /^INSERT INTO webhook_events \(([^)]*)\) VALUES \(([^)]*)\)$/.exec(text);
              if (match === null) throw new Error(`unexpected run SQL: ${text}`);
              if (failInsert) throw new Error("CHECK constraint failed: event_type");
              const columns = match[1].split(",").map((column) => column.trim());
              const slots = match[2].split(",").map((slot) => slot.trim());
              assert.equal(slots.length, columns.length, "every column has one value slot");
              let next = 0;
              const row = {};
              columns.forEach((column, index) => {
                row[column] = slots[index] === "?" ? values[next++] : slots[index].replace(/^'(.*)'$/, "$1");
              });
              assert.equal(next, values.length, "every bound value fills a slot");
              db.rows.push(row);
              return { success: true };
            },
            async all() { throw new Error(`unexpected all SQL: ${text}`); },
          };
        },
      };
    },
    batch() { throw new Error("the test-send audit is a single insert, never a batch"); },
  };
  return db;
}

function operator(result) {
  const calls = [];
  return {
    calls,
    binding: {
      async sendTest(...args) {
        calls.push(args);
        return typeof result === "function" ? result(...args) : result;
      },
    },
  };
}

function sendTest(id, options = {}) {
  return authed(`/api/admin/webhooks/${id}/test`, { method: "POST", body: options.body ?? "{}", headers: options.headers });
}

function sent(statusClass) {
  return { ok: true, status: 200, code: "webhook_test_sent", data: { status_class: statusClass } };
}

test("the test-send route is an admin-only webhooks route that keeps the raw id capture", () => {
  const matched = matchRoute("POST", "/api/admin/webhooks/wh%2F1/test");
  assert.ok(matched, "POST /api/admin/webhooks/{id}/test did not resolve");
  assert.equal(matched.descriptor.path, "/api/admin/webhooks/{id}/test");
  assert.equal(matched.descriptor.group, "webhooks");
  assert.equal(matched.descriptor.authorization, "admin");
  assert.deepEqual(matched.params, { id: "wh%2F1" });
  assert.equal(matchRoute("GET", "/api/admin/webhooks/wh_1/test"), null, "a test send is never a GET");
});

test("the route calls the WEBHOOK_OPERATOR binding and relays only the status class", async () => {
  for (const statusClass of ["2xx", "3xx", "4xx", "5xx", "network_error"]) {
    const rpc = operator({ ...sent(statusClass), request_id: "backend-rid" });
    const db = auditDb();
    const response = await worker.fetch(sendTest("wh%2F1"), { ...baseEnv(db), WEBHOOK_OPERATOR: rpc.binding });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await json(response);
    assert.equal(body.ok, true);
    assert.equal(body.code, "webhook_test_sent");
    assert.deepEqual(body.data, { status_class: statusClass });
    assert.notEqual(body.request_id, "backend-rid", "the admin answers with its own request id");
    assert.deepEqual(rpc.calls, [["wh/1"]], "the binding receives only the decoded endpoint id");
    assert.equal(db.rows.length, 1, `one audit row for ${statusClass}`);
    assert.equal(db.rows[0].reason, statusClass);
  }
});

test("a test send that reached the receiver leaves exactly one test_send audit row", async () => {
  const db = auditDb();
  const before = Math.floor(Date.now() / 1000);
  const response = await worker.fetch(sendTest("wh%2F1"), { ...baseEnv(db), WEBHOOK_OPERATOR: operator(sent("2xx")).binding });
  const after = Math.floor(Date.now() / 1000);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(db.rows.length, 1);
  const { created_at: createdAt, ...row } = db.rows[0];
  assert.deepEqual(row, {
    endpoint_id: "wh/1",
    event_type: "test_send",
    prev_status: "active",
    next_status: "active",
    actor: "dev.local",
    actor_type: "dev",
    source: "admin",
    reason: "2xx",
    request_id: body.request_id,
  });
  assert.ok(Number.isInteger(createdAt) && createdAt >= before && createdAt <= after, `created_at ${createdAt}`);

  // The row records the endpoint's status as read, unchanged: a test send never flips it.
  const disabled = auditDb({ status: "disabled" });
  await worker.fetch(sendTest("wh_2"), { ...baseEnv(disabled), WEBHOOK_OPERATOR: operator(sent("network_error")).binding });
  assert.equal(disabled.rows.length, 1);
  assert.equal(disabled.rows[0].prev_status, "disabled");
  assert.equal(disabled.rows[0].next_status, "disabled");
  assert.equal(disabled.rows[0].reason, "network_error");
});

test("a refused or malformed backend result writes no audit row and never touches D1", async () => {
  const results = [
    { ok: false, status: 404, code: "not_found" },
    { ok: false, status: 400, code: "invalid_url" },
    { ok: false, status: 503, code: "webhook_signing_unconfigured" },
    { ok: false, status: 503, code: "temporarily_unavailable" },
    { ok: false, status: 429, code: "rate_limited", data: { retry_after: 42 } },
    { ok: false, status: 429, code: "rate_limited", data: { retry_after: 0 } },
    { ok: true, status: 200, code: "webhook_test_sent", data: { status_class: "200" } },
    { ok: true, status: 200, code: "webhook_test_sent", data: { status_class: "2xx", signature: "t=1,keyid=k,v1=00" } },
    { ok: true, status: 201, code: "webhook_test_sent", data: { status_class: "2xx" } },
    { ok: false, status: 200, code: "webhook_test_sent", data: { status_class: "2xx" } },
    null,
  ];
  for (const result of results) {
    const db = countingDb();
    const response = await worker.fetch(sendTest("wh_1"), { ...baseEnv(db), WEBHOOK_OPERATOR: operator(result).binding });
    assert.notEqual(response.status, 200, JSON.stringify(result));
    assert.equal(db.touches, 0, `no audit for ${JSON.stringify(result)}`);
  }
  const db = countingDb();
  const throwing = { async sendTest() { throw new Error("RPC transport lost"); } };
  await worker.fetch(sendTest("wh_1"), { ...baseEnv(db), WEBHOOK_OPERATOR: throwing });
  assert.equal(db.touches, 0, "no audit when the RPC itself failed");
});

test("a failed audit is logged and never changes the relayed result", async (t) => {
  const failures = [
    ["the insert fails", auditDb({ failInsert: true })],
    ["the endpoint row is gone", auditDb({ status: null })],
    ["D1 throws on prepare", untouchableDb()],
  ];
  for (const [label, db] of failures) {
    const logged = t.mock.method(console, "error", () => {});
    const response = await worker.fetch(sendTest("wh%2F1"), { ...baseEnv(db), WEBHOOK_OPERATOR: operator(sent("5xx")).binding });
    logged.mock.restore();
    assert.equal(response.status, 200, label);
    const body = await json(response);
    assert.equal(body.ok, true, label);
    assert.equal(body.code, "webhook_test_sent", label);
    assert.deepEqual(body.data, { status_class: "5xx" }, label);
    assert.equal(logged.mock.callCount(), 1, label);
    const [line] = logged.mock.calls[0].arguments;
    assert.deepEqual(JSON.parse(line), { event: "webhook.test_send_audit_failed", request_id: body.request_id, endpoint_id: "wh/1", error_type: "Error" }, label);
    assert.equal(db.rows?.length ?? 0, 0, label);
  }
});

test("a malformed or over-sharing binding result fails closed instead of being relayed", async () => {
  const results = [
    { ok: true, status: 200, code: "webhook_test_sent", data: { status_class: "2xx", signature: "t=1,keyid=k,v1=00" } },
    { ok: true, status: 200, code: "webhook_test_sent", data: { status_class: "200" } },
    { ok: true, status: 200, code: "webhook_test_sent", data: null },
    { ok: true, status: 201, code: "webhook_test_sent", data: { status_class: "2xx" } },
    { ok: false, status: 418, code: "teapot" },
    { ok: false, status: 404, code: "rate_limited" },
    null,
    "2xx",
  ];
  for (const result of results) {
    const response = await worker.fetch(sendTest("wh_1"), { ...baseEnv(untouchableDb()), WEBHOOK_OPERATOR: operator(result).binding });
    assert.equal(response.status, 503, JSON.stringify(result));
    const body = await json(response);
    assert.equal(body.code, "temporarily_unavailable");
    assert.equal(JSON.stringify(body).includes("signature"), false);
  }
  const throwing = { async sendTest() { throw new Error("RPC transport lost"); } };
  const response = await worker.fetch(sendTest("wh_1"), { ...baseEnv(untouchableDb()), WEBHOOK_OPERATOR: throwing });
  assert.equal(response.status, 503);
  assert.equal((await json(response)).code, "temporarily_unavailable");
});

test("known backend refusals keep their status and code; a rate limit carries retry-after", async () => {
  const cases = [
    [{ ok: false, status: 404, code: "not_found" }, 404],
    [{ ok: false, status: 400, code: "invalid_url" }, 400],
    [{ ok: false, status: 503, code: "webhook_signing_unconfigured" }, 503],
    [{ ok: false, status: 503, code: "temporarily_unavailable" }, 503],
  ];
  for (const [result, status] of cases) {
    const response = await worker.fetch(sendTest("wh_1"), { ...baseEnv(untouchableDb()), WEBHOOK_OPERATOR: operator(result).binding });
    assert.equal(response.status, status, result.code);
    const body = await json(response);
    assert.equal(body.ok, false);
    assert.equal(body.code, result.code);
    assert.equal(body.data, undefined);
  }
  const limited = await worker.fetch(sendTest("wh_1"), { ...baseEnv(untouchableDb()), WEBHOOK_OPERATOR: operator({ ok: false, status: 429, code: "rate_limited", data: { retry_after: 42 } }).binding });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "42");
  const body = await json(limited);
  assert.equal(body.code, "rate_limited");
  assert.deepEqual(body.data, { retry_after: 42 });
  for (const retryAfter of [0, 61, 1.5, "42", undefined]) {
    const odd = await worker.fetch(sendTest("wh_1"), { ...baseEnv(untouchableDb()), WEBHOOK_OPERATOR: operator({ ok: false, status: 429, code: "rate_limited", data: { retry_after: retryAfter } }).binding });
    assert.equal(odd.status, 503, `retry_after ${JSON.stringify(retryAfter)} is not a trusted wait`);
  }
});

test("a missing WEBHOOK_OPERATOR binding answers 503 not-configured without touching D1", async () => {
  const response = await worker.fetch(sendTest("wh_1"), baseEnv(untouchableDb()));
  assert.equal(response.status, 503);
  const body = await json(response);
  assert.equal(body.ok, false);
  assert.equal(body.code, "webhook_operator_not_configured");
});

test("a reader cannot send a test event and the binding is never called", async (t) => {
  const fixture = await accessFixture(t);
  const rpc = operator(sent("2xx"));
  const db = auditDb();
  const env = { ...accessEnv(db, fixture), WEBHOOK_OPERATOR: rpc.binding };
  const reader = await accessToken(fixture, "reader@example.com");
  const response = await worker.fetch(accessAuthed("/api/admin/webhooks/wh_1/test", reader, { method: "POST", body: "{}" }), env);
  assert.equal(response.status, 403);
  assert.equal((await json(response)).code, "admin_role_required");
  assert.equal(rpc.calls.length, 0);
  assert.equal(db.rows.length, 0, "a refused reader leaves no audit row");

  const admin = await accessToken(fixture, "admin@example.com");
  const allowed = await worker.fetch(accessAuthed("/api/admin/webhooks/wh_1/test", admin, { method: "POST", body: "{}" }), env);
  assert.equal(allowed.status, 200);
  assert.equal(rpc.calls.length, 1);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].actor, "admin@example.com", "an Access operator is recorded by email");
  assert.equal(db.rows[0].actor_type, "access");
});

test("an invalid endpoint id or body is rejected before the binding is called", async () => {
  const rpc = operator(sent("2xx"));
  const env = { ...baseEnv(untouchableDb()), WEBHOOK_OPERATOR: rpc.binding };
  for (const id of ["deliveries", "x".repeat(129), "%E0%A4%A"]) {
    const response = await worker.fetch(sendTest(id), env);
    assert.equal(response.status, 400, id);
    assert.equal((await json(response)).code, "invalid_request");
  }
  const badJson = await worker.fetch(sendTest("wh_1", { body: "{" }), env);
  assert.equal(badJson.status, 400);
  assert.equal((await json(badJson)).code, "invalid_json");
  assert.equal(rpc.calls.length, 0);
});
