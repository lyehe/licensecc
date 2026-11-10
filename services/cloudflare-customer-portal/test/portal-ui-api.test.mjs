import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadUiModules } from "../../../test/helpers/ui-modules.mjs";

async function loadTransportModule(name = "api") {
  const [module] = await loadUiModules(fileURLToPath(new URL("../", import.meta.url)), [`ui/shared/${name}.ts`]);
  return module;
}

const loadApiModule = () => loadTransportModule();

function jsonResponse(status, body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { get: (name) => (Object.hasOwn(lower, name.toLowerCase()) ? lower[name.toLowerCase()] : null) },
  };
}

test("accountApi carries the displayed customer and current-epoch mismatches recheck the session without replay", async () => {
  const api = await loadApiModule();
  const fired = [], calls = [];
  api.setOnSessionProblem(reason => fired.push(reason));
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return jsonResponse(409, { ok: false, code: "account_changed", request_id: "switched" });
  };
  await api.accountApi("customer / A", "/portal/v1/auth/identities/unlink", { method: "POST", headers: new Headers({ "x-test": "kept" }), body: JSON.stringify({ provider: "google" }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.get("x-expected-customer-id"), encodeURIComponent("customer / A"));
  assert.equal(calls[0].init.headers.get("x-test"), "kept");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.deepEqual(fired, ["account_changed"]);
  let resolve;
  globalThis.fetch = () => new Promise(done => { resolve = done; });
  const old = api.accountApi("A", "/portal/v1/auth/identities");
  api.beginNewSession();
  resolve(jsonResponse(409, { ok: false, code: "account_changed", request_id: "old-account" }));
  await old;
  assert.deepEqual(fired, ["account_changed"], "an old account's response cannot bounce the new session");
  api.setOnSessionProblem(null);
});

test("api refuses malformed envelopes and success claims carried by a failed HTTP response", async () => {
  const api = await loadApiModule();
  for (const [status, body] of [[503, { ok: true, code: "signed_in", request_id: "r" }], [200, null], [200, []], [200, { ok: "true", code: "signed_in", request_id: "r" }], [200, { ok: true, code: "signed_in" }], [200, { ok: true, code: "", request_id: "r" }]]) {
    globalThis.fetch = async () => jsonResponse(status, body);
    const result = await api.api("/portal/v1/auth/password/complete");
    assert.equal(result.ok, false); assert.equal(result.code, "invalid_response");
  }
});

// A session epoch stops a straggler -- a request sent under an OLD, already-
// superseded session that only answers 401 long after the customer signed in again -- from bouncing
// that new sign-in back a step.

test("api() fires onUnauthorized for a plain 401 unauthorized (same epoch throughout)", async () => {
  const api = await loadApiModule();
  const fired = [];
  api.setOnSessionProblem(() => fired.push(true));
  globalThis.fetch = async () => jsonResponse(401, { ok: false, code: "unauthorized", request_id: "r1" });
  const result = await api.api("/api/portal/entitlements");
  assert.equal(result.code, "unauthorized");
  assert.equal(fired.length, 1, "a same-epoch 401 unauthorized must fire the hook");
  api.setOnSessionProblem(null);
});

test("api() ignores a straggler 401 whose request started under an OLDER, already-superseded session", async () => {
  const api = await loadApiModule();
  const fired = [];
  api.setOnSessionProblem(() => fired.push(true));

  // A slow request starts -- api() captures the CURRENT epoch internally -- but its response is held
  // back, simulating a request that has been in flight for a while.
  let resolveFetch;
  globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
  const pending = api.api("/api/portal/example", { method: "POST" });

  // The customer signs in again (a brand-new session) while that old request is still in flight.
  api.beginNewSession();

  // The stale request finally resolves with a 401 unauthorized from the now-dead, superseded session.
  resolveFetch(jsonResponse(401, { ok: false, code: "unauthorized", request_id: "r2" }));
  const result = await pending;

  assert.equal(result.code, "unauthorized"); // the caller still sees the real result envelope...
  assert.equal(fired.length, 0, "...but a straggler from an old epoch must not fire the hook");
});

test("api() still fires for a 401 sent AFTER the epoch bump (not just before it)", async () => {
  const api = await loadApiModule();
  const fired = [];
  api.setOnSessionProblem(() => fired.push(true));
  api.beginNewSession();
  globalThis.fetch = async () => jsonResponse(401, { ok: false, code: "unauthorized", request_id: "r3" });
  await api.api("/api/portal/example");
  assert.equal(fired.length, 1, "a request sent in the CURRENT epoch must still fire normally");
});

test("skipSessionHook bypasses the epoch check entirely (retrySession's own /me call)", async () => {
  const api = await loadApiModule();
  const fired = [];
  api.setOnSessionProblem(() => fired.push(true));
  globalThis.fetch = async () => jsonResponse(401, { ok: false, code: "unauthorized", request_id: "r4" });
  await api.api("/api/portal/me", undefined, { skipSessionHook: true });
  assert.equal(fired.length, 0, "the retry's own /me check must never re-enter the handler it is answering");
});

test("api() never fires onUnauthorized for a credential 401, even in the current epoch", async () => {
  const api = await loadApiModule();
  const fired = [];
  api.setOnSessionProblem(() => fired.push(true));
  api.beginNewSession();
  // Same (current) epoch, but a credential failure code -- must never fire, epoch match or not.
  globalThis.fetch = async () => jsonResponse(401, { ok: false, code: "invalid_otp", request_id: "r7" });
  const result = await api.api("/portal/v1/auth/verify", { method: "POST" });
  assert.equal(result.code, "invalid_otp");
  assert.equal(fired.length, 0, "a credential failure means a wrong entry, never a signed-out session");
  api.setOnSessionProblem(null);
});

// The auth 429s now carry a real retry-after header; api() surfaces it on the envelope so the
// UI can build "Try again in {n} minutes." without re-parsing headers at every call site.
test("api() surfaces the retry-after response header as retryAfter on the envelope", async () => {
  const api = await loadApiModule();
  globalThis.fetch = async () => jsonResponse(429, { ok: false, code: "rate_limited", request_id: "r5" }, { "retry-after": "42" });
  const result = await api.api("/portal/v1/auth/request", { method: "POST" });
  assert.equal(result.code, "rate_limited");
  assert.equal(result.retryAfter, 42);
});

test("api() leaves retryAfter unset when no retry-after header is present", async () => {
  const api = await loadApiModule();
  globalThis.fetch = async () => jsonResponse(200, { ok: true, code: "otp_requested", request_id: "r6" });
  const result = await api.api("/portal/v1/auth/request", { method: "POST" });
  assert.equal(result.code, "otp_requested");
  assert.equal(result.retryAfter, undefined);
});

test("api() ignores a non-numeric retry-after header rather than surfacing NaN", async () => {
  const api = await loadApiModule();
  globalThis.fetch = async () => jsonResponse(429, { ok: false, code: "rate_limited", request_id: "r7" }, { "retry-after": "not-a-number" });
  const result = await api.api("/portal/v1/auth/request", { method: "POST" });
  assert.equal(result.retryAfter, undefined);
});

// localMessage builds a plain local StatusMessage: no request id (nothing came from the server),
// and the given ok/code pair, verbatim.
test("localMessage builds a plain local StatusMessage with no request id", async () => {
  const api = await loadApiModule();
  const plain = api.localMessage("invalid_email", false);
  assert.deepEqual(plain, { code: "invalid_email", request_id: "", ok: false });
  const confirmation = api.localMessage("logged_out", true);
  assert.deepEqual(confirmation, { code: "logged_out", request_id: "", ok: true });
});

const protectedRequest = (overrides = {}) => ({
  path: "/api/portal/device-bindings",
  customerId: "customer / A",
  method: "GET",
  successCode: "device_bindings",
  failureStatuses: { unauthorized: 401, account_changed: 409, rate_limited: 429 },
  validate: value => value?.customer_id === "customer / A",
  ...overrides,
});

test("protected-device requests retain account and transport policy without entering the ordinary session hook", async t => {
  const { protectedDeviceRequest } = await loadTransportModule("protectedDeviceRequest");
  const api = await loadApiModule();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; api.setOnSessionProblem(null); });
  const calls = [], sessionProblems = [];
  api.setOnSessionProblem(reason => sessionProblems.push(reason));
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return jsonResponse(200, { ok: true, code: "device_bindings", data: { customer_id: "customer / A" } });
  };
  assert.deepEqual(await protectedDeviceRequest(protectedRequest()), { ok: true, data: { customer_id: "customer / A" } });
  assert.equal(calls[0].path, "/api/portal/device-bindings");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers["x-expected-customer-id"], encodeURIComponent("customer / A"));
  assert.equal(calls[0].init.headers["content-type"], undefined);
  assert.equal(calls[0].init.body, undefined);
  globalThis.fetch = async () => jsonResponse(401, { ok: false, code: "unauthorized" });
  assert.deepEqual(await protectedDeviceRequest(protectedRequest()), { ok: false, code: "unauthorized" });
  assert.deepEqual(sessionProblems, [], "protected-device flows own their explicit session recovery");
});

test("protected-device mutations preserve keys and accept only their endpoint's status, code and data contract", async t => {
  const { protectedDeviceRequest } = await loadTransportModule("protectedDeviceRequest");
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    return jsonResponse(200, { ok: true, code: "binding_retired", data: { customer_id: "customer / A" } });
  };
  const request = protectedRequest({ path: "/api/portal/device-bindings/retire", method: "POST", successCode: "binding_retired", body: { binding_id: "binding", expected_revision: 3 }, idempotencyKey: "same-key" });
  assert.equal((await protectedDeviceRequest(request)).ok, true);
  assert.equal(calls[0].init.headers["idempotency-key"], "same-key");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), request.body);
  for (const [status, body] of [
    [503, { ok: true, code: "binding_retired", data: { customer_id: "customer / A" } }],
    [200, { ok: true, code: "device_bindings", data: { customer_id: "customer / A" } }],
    [200, { ok: true, code: "binding_retired", data: { customer_id: "other" } }],
    [403, { ok: false, code: "unauthorized" }],
    [404, { ok: false, code: "unknown_failure" }],
    [200, null],
  ]) {
    globalThis.fetch = async () => jsonResponse(status, body);
    assert.deepEqual(await protectedDeviceRequest(request), { ok: false, code: "temporarily_unavailable" });
  }
  globalThis.fetch = async () => ({ ...jsonResponse(200, null), json: async () => { throw new Error("invalid JSON"); } });
  assert.deepEqual(await protectedDeviceRequest(request), { ok: false, code: "temporarily_unavailable" });
  for (const [header, expected] of [["900", 300], ["5", 60], ["77", 77], ["invalid", 60], [null, 60]]) {
    globalThis.fetch = async () => jsonResponse(429, { ok: false, code: "rate_limited" }, header === null ? {} : { "retry-after": header });
    assert.deepEqual(await protectedDeviceRequest(request), { ok: false, code: "rate_limited", retryAfter: expected });
  }
});

test("a protected-device timeout aborts once, clears its timer and leaves an unknown result for explicit recovery", async t => {
  const { protectedDeviceRequest } = await loadTransportModule("protectedDeviceRequest");
  const originalFetch = globalThis.fetch, originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; });
  let abort, sends = 0;
  const cleared = [];
  globalThis.setTimeout = (callback, milliseconds) => { assert.equal(milliseconds, 15000); abort = callback; return 29; };
  globalThis.clearTimeout = timer => cleared.push(timer);
  globalThis.fetch = async (_path, init) => {
    sends += 1;
    return await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
  const pending = protectedDeviceRequest(protectedRequest({ method: "POST", body: {}, idempotencyKey: "retained" }));
  abort();
  assert.deepEqual(await pending, { ok: false, code: "temporarily_unavailable" });
  assert.equal(sends, 1, "the transport must not replay a mutation on its own");
  assert.deepEqual(cleared, [29]);
});
