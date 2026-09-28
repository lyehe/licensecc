import assert from "node:assert/strict";
import test from "node:test";
import { matchRoute } from "../../dist-worker/worker/dispatch.js";
import { accessAuthed, accessEnv, accessFixture, accessToken, authed, baseEnv, json, worker } from "./fixtures.mjs";

// POST /api/admin/webhooks/{id}/test asks the backend's WebhookOperator capability (the only
// Worker that holds WEBHOOK_SIGNING_SECRETS) to send one signed test event. The admin Worker never
// sees the secret: it forwards the endpoint id and relays only a status class.

function untouchableDb() {
  return {
    prepare() { throw new Error("D1 must not be touched"); },
    batch() { throw new Error("D1 must not be touched"); },
  };
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
    const rpc = operator({ ok: true, status: 200, code: "webhook_test_sent", request_id: "backend-rid", data: { status_class: statusClass } });
    const response = await worker.fetch(sendTest("wh%2F1"), { ...baseEnv(untouchableDb()), WEBHOOK_OPERATOR: rpc.binding });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await json(response);
    assert.equal(body.ok, true);
    assert.equal(body.code, "webhook_test_sent");
    assert.deepEqual(body.data, { status_class: statusClass });
    assert.notEqual(body.request_id, "backend-rid", "the admin answers with its own request id");
    assert.deepEqual(rpc.calls, [["wh/1"]], "the binding receives only the decoded endpoint id");
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
  const rpc = operator({ ok: true, status: 200, code: "webhook_test_sent", data: { status_class: "2xx" } });
  const env = { ...accessEnv(untouchableDb(), fixture), WEBHOOK_OPERATOR: rpc.binding };
  const reader = await accessToken(fixture, "reader@example.com");
  const response = await worker.fetch(accessAuthed("/api/admin/webhooks/wh_1/test", reader, { method: "POST", body: "{}" }), env);
  assert.equal(response.status, 403);
  assert.equal((await json(response)).code, "admin_role_required");
  assert.equal(rpc.calls.length, 0);

  const admin = await accessToken(fixture, "admin@example.com");
  const allowed = await worker.fetch(accessAuthed("/api/admin/webhooks/wh_1/test", admin, { method: "POST", body: "{}" }), env);
  assert.equal(allowed.status, 200);
  assert.equal(rpc.calls.length, 1);
});

test("an invalid endpoint id or body is rejected before the binding is called", async () => {
  const rpc = operator({ ok: true, status: 200, code: "webhook_test_sent", data: { status_class: "2xx" } });
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
