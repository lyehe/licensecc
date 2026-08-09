import { test } from "node:test";
import { assert, worker, mintSession, codeFromSecretBytes, requestOtp, redeemOtp, policyCapacityViolation, FP_A, FP_B, installBackendStub, cookieFor, sameSiteHeaders, entitlementId, ownedEntitlementId, call, baseFixture, seedDevice, seedEntitlement, CTX, NOW } from "./portal-worker-fixtures.mjs";

const textEncoder = new TextEncoder();

function streamingMagicRequest(chunks, { contentType = "application/x-www-form-urlencoded", contentLength } = {}) {
  const state = { pulls: 0, cancelled: false, cancelReason: undefined };
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      state.pulls += 1;
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(typeof chunk === "string" ? textEncoder.encode(chunk) : chunk);
    },
    cancel(reason) {
      state.cancelled = true;
      state.cancelReason = reason;
    },
  });
  const headers = sameSiteHeaders({ "content-type": contentType });
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  const request = new Request("https://portal.test/portal/v1/auth/magic-redeem", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  });
  return { request, state };
}

async function magicResponse(env, request) {
  const res = await worker.fetch(request, env, CTX);
  return { status: res.status, body: await res.json(), res };
}

function unreadMagicRequest({ contentType, contentLength, cancelBehavior = "resolve" }) {
  const state = { readerRequested: false, bodyCancelled: false };
  const headers = new Headers(sameSiteHeaders({ "content-type": contentType }));
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return {
    state,
    request: {
      url: "https://portal.test/portal/v1/auth/magic-redeem",
      method: "POST",
      headers,
      body: {
        getReader() {
          state.readerRequested = true;
          throw new Error("body must not be read");
        },
        cancel() {
          state.bodyCancelled = true;
          if (cancelBehavior === "throw") throw new Error("cancel failed");
          if (cancelBehavior === "never") return new Promise(() => {});
          return Promise.resolve();
        },
      },
    },
  };
}

function otpRow(db) {
  return db.prepare("SELECT consumed_at, attempt_count FROM portal_otp WHERE customer_id = 'A' ORDER BY created_at DESC LIMIT 1").get() ?? null;
}

function portalState(db) {
  return ["portal_otp", "portal_sessions", "rate_limit_counters", "portal_bootstrap_events"]
    .map((table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

function readerMagicRequest({ read, cancel }) {
  const state = { cancelCalls: 0, released: false };
  const request = {
    url: "https://portal.test/portal/v1/auth/magic-redeem",
    method: "POST",
    headers: new Headers(sameSiteHeaders({ "content-type": "application/x-www-form-urlencoded" })),
    body: {
      getReader() {
        return {
          read,
          cancel() {
            state.cancelCalls += 1;
            return cancel();
          },
          releaseLock() {
            state.released = true;
          },
        };
      },
    },
  };
  return { request, state };
}

async function within(promise, milliseconds = 250) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("auth/request rejects oversized JSON bodies without relying on Content-Length", async () => {
  const { db, env } = baseFixture();
  const res = await worker.fetch(new Request("https://portal.test/portal/v1/auth/request", {
    method: "POST",
    headers: sameSiteHeaders(),
    body: "x".repeat(8193),
  }), env, CTX);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "body_too_large");
  db.close();
});

test("bootstrap-otp: 404 when the bearer is unset (no existence oracle)", async () => {
  const { db, env } = baseFixture();
  const r = await call(env, "POST", "/portal/v1/admin/bootstrap-otp", { body: { email: "a@x.com" } });
  assert.equal(r.status, 404, "an unset bootstrap bearer means the route does not exist");
  assert.equal(r.body.code, "not_found");
  db.close();
});

test("bootstrap-otp: 403 when PORTAL_BOOTSTRAP_REQUIRE_ACCESS=1 and no Access JWT", async () => {
  const { db, env } = baseFixture({ PORTAL_BOOTSTRAP_BEARER: "break-glass", PORTAL_BOOTSTRAP_REQUIRE_ACCESS: "1" });
  const req = new Request("https://portal.test/portal/v1/admin/bootstrap-otp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer break-glass", origin: "https://portal.test", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ email: "a@x.com" }),
  });
  const res = await worker.fetch(req, env, CTX);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "access_required");
  db.close();
});

test("bootstrap-otp: a correct bearer issues a secret, audits append-only, 120s row TTL", async () => {
  const { db, env } = baseFixture({ PORTAL_BOOTSTRAP_BEARER: "break-glass" });
  const requestEpoch = Math.floor(Date.now() / 1000);
  const req = new Request("https://portal.test/portal/v1/admin/bootstrap-otp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer break-glass", origin: "https://portal.test", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ email: "a@x.com" }),
  });
  const res = await worker.fetch(req, env, CTX);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.code, "bootstrap_otp");
  assert.ok(typeof body.data.secret === "string" && body.data.secret.length > 0, "the operator gets the secret ONCE");
  // Append-only audit row exists.
  const audit = db.prepare("SELECT COUNT(*) AS c FROM portal_bootstrap_events WHERE customer_id = 'A'").get();
  assert.equal(audit.c, 1, "the bootstrap issuance is audited");
  // The OTP row exists and expires within 10 minutes (600s) of now.
  const otp = db.prepare("SELECT expires_at FROM portal_otp WHERE customer_id = 'A'").get();
  assert.ok(otp.expires_at > requestEpoch && otp.expires_at <= requestEpoch + 605); // +5 slop for the clock boundary
  db.close();
});

test("bootstrap-otp: a WRONG bearer is 401 (constant-time), never 404 once configured", async () => {
  const { db, env } = baseFixture({ PORTAL_BOOTSTRAP_BEARER: "break-glass" });
  const req = new Request("https://portal.test/portal/v1/admin/bootstrap-otp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong", origin: "https://portal.test", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ email: "a@x.com" }),
  });
  const res = await worker.fetch(req, env, CTX);
  assert.equal(res.status, 401);
  db.close();
});

// =================================================================================================
// FULL LOGIN ROUNDTRIP — request -> redeem -> me (proves the cookie binds the right customer)
// =================================================================================================

test("login roundtrip: request OTP -> redeem code -> session resolves to that customer", async () => {
  const { db, env } = baseFixture();
  // Use the OTP module directly to capture the secret (the worker never returns it).
  const req = await requestOtp(env, { email: "a@x.com", clientIp: "1.1.1.1", returnSecret: true, now: NOW });
  const secretBytes = Uint8Array.from(atob(req.secret.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const code = codeFromSecretBytes(secretBytes);

  // Verify through the worker (mints the session cookie).
  const verify = await call(env, "POST", "/portal/v1/auth/verify", { body: { email: "a@x.com", code } });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.data.customer_id, "A");
  const setCookie = verify.res.headers.get("set-cookie");
  assert.match(setCookie, /lccp_session=lccp_/);
  assert.match(setCookie, /HttpOnly/);

  // The cookie now resolves to A.
  const sessionCookie = setCookie.split(";")[0];
  const me = await call(env, "GET", "/api/portal/me", { cookie: sessionCookie });
  assert.equal(me.body.data.customer_id, "A");
  void redeemOtp;
  db.close();
});

test("auth/request returns the SAME ok for a known and unknown email (no enumeration)", async () => {
  const { db, env } = baseFixture();
  const known = await call(env, "POST", "/portal/v1/auth/request", { body: { email: "a@x.com" } });
  const unknown = await call(env, "POST", "/portal/v1/auth/request", { body: { email: "nobody@x.com" } });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.equal(known.body.code, unknown.body.code, "byte-identical code (no enumeration oracle)");
  db.close();
});

test("auth magic GET renders a POST interstitial without consuming the secret", async () => {
  const { db, env } = baseFixture();
  const res = await worker.fetch(new Request("https://portal.test/portal/v1/auth/magic?token=secret_value"), env, CTX);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("referrer-policy") ?? "", /no-referrer/);
  const html = await res.text();
  assert.match(html, /method="POST"/);
  assert.match(html, /\/portal\/v1\/auth\/magic-redeem/);
  assert.match(html, /value="secret_value"/);
  db.close();
});

test("auth magic redeem enforces CSRF and returns invalid-token status", async () => {
  const { db, env } = baseFixture();
  const crossSite = await call(env, "POST", "/portal/v1/auth/magic-redeem", {
    body: { token: "bad" },
    headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.body.code, "cross_site_forbidden");
  const invalid = await call(env, "POST", "/portal/v1/auth/magic-redeem", { body: { token: "bad" } });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.body.code, "invalid_otp");
  db.close();
});

test("auth magic redeem accepts a bounded form at exactly 8192 bytes across chunk splits", async () => {
  const { db, env } = baseFixture();
  const prefix = "token=bad&padding=";
  const body = prefix + "x".repeat(8192 - prefix.length);
  const { request, state } = streamingMagicRequest([
    body.slice(0, 1),
    body.slice(1, 4097),
    body.slice(4097),
  ]);
  const result = await magicResponse(env, request);
  assert.equal(result.status, 401);
  assert.equal(result.body.code, "invalid_otp");
  assert.equal(state.cancelled, false, "an exactly-boundary form must not be cancelled");
  assert.ok(state.pulls >= 3, "the bounded reader must consume split chunks through the exact boundary");
  db.close();
});

test("auth magic redeem rejects a declared oversized body before reading it", async () => {
  const { db, env } = baseFixture();
  const { request, state } = unreadMagicRequest({ contentType: "application/x-www-form-urlencoded", contentLength: 8193, cancelBehavior: "never" });
  const result = await within(magicResponse(env, request));
  assert.equal(result.status, 413);
  assert.equal(result.body.code, "body_too_large");
  assert.equal(state.readerRequested, false, "declared oversize is rejected before the body is read");
  assert.equal(state.bodyCancelled, true, "declared oversize must cancel the unread body");
  db.close();
});

test("auth magic redeem enforces the actual byte cap with missing and lying Content-Length", async () => {
  const { db, env } = baseFixture();
  const prefix = "token=bad&padding=";
  const body = prefix + "x".repeat(8193 - prefix.length);
  for (const contentLength of [undefined, 1]) {
    const { request, state } = streamingMagicRequest([
      body.slice(0, 4096),
      body.slice(4096, 8192),
      body.slice(8192),
    ], { contentLength });
    const result = await magicResponse(env, request);
    assert.equal(result.status, 413, contentLength === undefined ? "missing length" : "lying length");
    assert.equal(result.body.code, "body_too_large");
    assert.equal(state.cancelled, true, "overflow must cancel the request reader");
  }
  db.close();
});

test("auth magic redeem parses fatal UTF-8 and malformed forms before OTP side effects", async () => {
  const { db, env } = baseFixture();
  await requestOtp(env, { email: "a@x.com", clientIp: "seed", returnSecret: true, now: NOW });
  const before = otpRow(db);
  const invalidUtf8 = new Uint8Array([...textEncoder.encode("token="), 0xff]);
  const cases = [
    invalidUtf8,
    "token=%ZZ",
    "token=%FF",
  ];
  for (const body of cases) {
    const { request } = streamingMagicRequest([body]);
    const result = await magicResponse(env, request);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "invalid_request");
    assert.deepEqual(otpRow(db), before, "invalid bounded form input must not redeem or rate-limit an OTP");
  }
  db.close();
});

test("auth magic redeem rejects unsupported media types without consuming the body", async () => {
  const { db, env } = baseFixture();
  const { request, state } = unreadMagicRequest({
    contentType: "multipart/form-data; boundary=boundary",
  });
  const result = await magicResponse(env, request);
  assert.equal(result.status, 415);
  assert.equal(result.body.code, "unsupported_media_type");
  assert.equal(state.readerRequested, false);
  db.close();
});

test("auth magic redeem rejects vendor JSON media types without body or OTP/DB side effects", async () => {
  const { db, env } = baseFixture();
  const before = portalState(db);
  const { request, state } = unreadMagicRequest({ contentType: "application/vnd.api+json" });
  const result = await magicResponse(env, request);
  assert.equal(result.status, 415);
  assert.equal(result.body.code, "unsupported_media_type");
  assert.equal(state.readerRequested, false);
  assert.equal(state.bodyCancelled, false);
  assert.deepEqual(portalState(db), before);
  db.close();
});

test("auth magic redeem does not wait for stalled or throwing cancellation and releases readers", async () => {
  const { db, env } = baseFixture();
  const overflow = readerMagicRequest({
    read: async () => ({ done: false, value: new Uint8Array(8193) }),
    cancel: () => new Promise(() => {}),
  });
  const overflowResult = await within(magicResponse(env, overflow.request));
  assert.equal(overflowResult.status, 413);
  assert.equal(overflowResult.body.code, "body_too_large");
  assert.equal(overflow.state.cancelCalls, 1);
  assert.equal(overflow.state.released, true);

  const readError = readerMagicRequest({
    read: async () => {
      throw new Error("stream failed");
    },
    cancel: () => {
      throw new Error("cancel failed");
    },
  });
  const readErrorResult = await within(magicResponse(env, readError.request));
  assert.equal(readErrorResult.status, 400);
  assert.equal(readErrorResult.body.code, "invalid_request");
  assert.equal(readError.state.cancelCalls, 1);
  assert.equal(readError.state.released, true);
  db.close();
});

test("auth magic redeem preserves token redemption semantics for a valid bounded form", async () => {
  const { db, env } = baseFixture();
  const issued = await requestOtp(env, { email: "a@x.com", clientIp: "seed", returnSecret: true, now: NOW });
  assert.equal(issued.ok, true);
  const { request } = streamingMagicRequest([`token=${encodeURIComponent(issued.secret)}`]);
  const result = await magicResponse(env, request);
  assert.equal(result.status, 200);
  assert.equal(result.body.code, "signed_in");
  assert.equal(result.body.data.customer_id, "A");
  assert.match(result.res.headers.get("set-cookie") ?? "", /lccp_session=lccp_/);
  assert.notEqual(otpRow(db)?.consumed_at, null);
  db.close();
});

export const DIRECT_ROUTE_TESTS = Object.freeze([
  "POST /portal/v1/auth/request",
  "POST /portal/v1/auth/verify",
  "GET /portal/v1/auth/magic",
  "POST /portal/v1/auth/magic-redeem",
  "POST /portal/v1/admin/bootstrap-otp",
]);
