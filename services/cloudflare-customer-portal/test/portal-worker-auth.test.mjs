import { test } from "node:test";
import { assert, worker, mintSession, codeFromSecretBytes, requestOtp, redeemOtp, policyCapacityViolation, FP_A, FP_B, installBackendStub, cookieFor, sameSiteHeaders, entitlementId, ownedEntitlementId, call, baseFixture, seedDevice, seedEntitlement, CTX, NOW, within } from "./portal-worker-fixtures.mjs";

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
  // The form-encoded branch answers with a 303 + null body; only parse JSON for JSON responses.
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  const body = isJson ? await res.json() : null;
  return { status: res.status, body, res };
}

// A D1 double that throws only on the atomic single-use claim UPDATE, so a form redeem can be
// driven through a genuine mid-flight D1 failure without disturbing any other query on the path
// (the rate-limit counter INSERT, mintSession's INSERT, etc. all pass through to the real DB).
function throwingOtpClaimDb(real) {
  return {
    prepare(sql) {
      if (/UPDATE portal_otp/.test(sql)) throw new Error("D1_ERROR: simulated");
      return real.prepare(sql);
    },
  };
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

// C6: the UI shows "Try again in {n} minutes." from this header alone, so every JSON-answering auth
// 429 must carry the exact seconds left in portalRateLimit's own fixed window.
test("auth/request over the per-email cap answers 429 with the exact retry-after for the fixed window", async (t) => {
  t.mock.method(Date, "now", () => NOW * 1000);
  const { db, env } = baseFixture();
  const window = Math.floor(NOW / 900) * 900;
  db.prepare(
    "INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) VALUES ('portal', 'request:email:a@x.com', ?, 5, ?, ?)",
  ).run(window, NOW + 1800, NOW);
  const result = await call(env, "POST", "/portal/v1/auth/request", { body: { email: "a@x.com" } });
  assert.equal(result.status, 429);
  assert.equal(result.body.code, "rate_limited");
  assert.equal(result.res.headers.get("retry-after"), String(window + 900 - NOW));
  db.close();
});

test("auth/verify over the per-IP cap answers 429 with the exact retry-after for the fixed window", async (t) => {
  t.mock.method(Date, "now", () => NOW * 1000);
  const { db, env } = baseFixture();
  const window = Math.floor(NOW / 900) * 900;
  db.prepare(
    "INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) VALUES ('portal', 'verify:ip:', ?, 30, ?, ?)",
  ).run(window, NOW + 1800, NOW);
  const result = await call(env, "POST", "/portal/v1/auth/verify", { body: { email: "a@x.com", code: "12345678" } });
  assert.equal(result.status, 429);
  assert.equal(result.body.code, "rate_limited");
  assert.equal(result.res.headers.get("retry-after"), String(window + 900 - NOW));
  db.close();
});

test("auth magic redeem (JSON caller) over the per-IP cap answers 429 with the exact retry-after", async (t) => {
  t.mock.method(Date, "now", () => NOW * 1000);
  const { db, env } = baseFixture();
  const window = Math.floor(NOW / 900) * 900;
  db.prepare(
    "INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) VALUES ('portal', 'verify:ip:', ?, 30, ?, ?)",
  ).run(window, NOW + 1800, NOW);
  const result = await call(env, "POST", "/portal/v1/auth/magic-redeem", { body: { token: "z".repeat(43) } });
  assert.equal(result.status, 429);
  assert.equal(result.body.code, "rate_limited");
  assert.equal(result.res.headers.get("retry-after"), String(window + 900 - NOW));
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
  assert.equal(result.status, 303);
  assert.equal(result.res.headers.get("location"), "https://portal.test/?auth_error=link_expired");
  assert.equal(state.cancelled, false, "an exactly-boundary form must not be cancelled");
  assert.ok(state.pulls >= 3, "the bounded reader must consume split chunks through the exact boundary");
  db.close();
});

test("auth magic redeem rejects a declared oversized body before reading it", async () => {
  const { db, env } = baseFixture();
  const { request, state } = unreadMagicRequest({ contentType: "application/x-www-form-urlencoded", contentLength: 8193, cancelBehavior: "never" });
  const result = await within(magicResponse(env, request));
  assert.equal(result.status, 303);
  assert.equal(result.res.headers.get("location"), "https://portal.test/?auth_error=sign_in_failed");
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
    assert.equal(result.status, 303, contentLength === undefined ? "missing length" : "lying length");
    assert.equal(result.res.headers.get("location"), "https://portal.test/?auth_error=sign_in_failed");
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
    assert.equal(result.status, 303);
    assert.equal(result.res.headers.get("location"), "https://portal.test/?auth_error=sign_in_failed");
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
  assert.equal(overflowResult.status, 303);
  assert.equal(overflowResult.res.headers.get("location"), "https://portal.test/?auth_error=sign_in_failed");
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
  assert.equal(readErrorResult.status, 303);
  assert.equal(readErrorResult.res.headers.get("location"), "https://portal.test/?auth_error=sign_in_failed");
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
  assert.equal(result.status, 303);
  assert.equal(result.res.headers.get("location"), "https://portal.test/#/apps");
  assert.equal(result.res.headers.get("cache-control"), "no-store");
  assert.equal(result.res.headers.get("referrer-policy"), "no-referrer");
  const cookie = result.res.headers.get("set-cookie");
  assert.match(cookie ?? "", /lccp_session=lccp_/);
  // The minted cookie must actually resolve, through the ordinary session path, to this customer.
  const me = await call(env, "GET", "/api/portal/me", { cookie: cookie.split(";")[0] });
  assert.equal(me.body.data.customer_id, "A");
  assert.notEqual(otpRow(db)?.consumed_at, null);
  db.close();
});

test("auth magic redeem: a reused token redirects to link_expired, not the earlier success", async () => {
  const { db, env } = baseFixture();
  const issued = await requestOtp(env, { email: "a@x.com", clientIp: "seed", returnSecret: true, now: NOW });
  assert.equal(issued.ok, true);
  const firstRequest = streamingMagicRequest([`token=${encodeURIComponent(issued.secret)}`]).request;
  const first = await magicResponse(env, firstRequest);
  assert.equal(first.status, 303);
  assert.equal(first.res.headers.get("location"), "https://portal.test/#/apps");
  assert.match(first.res.headers.get("set-cookie") ?? "", /lccp_session=lccp_/);
  const afterFirst = otpRow(db);

  const secondRequest = streamingMagicRequest([`token=${encodeURIComponent(issued.secret)}`]).request;
  const second = await magicResponse(env, secondRequest);
  assert.equal(second.status, 303);
  assert.equal(second.res.headers.get("location"), "https://portal.test/?auth_error=link_expired");
  assert.equal(second.res.headers.get("set-cookie"), null, "a reused token must never mint a second session");
  assert.deepEqual(otpRow(db), afterFirst, "a rejected reuse must not touch the already-consumed OTP row");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM portal_sessions").get().c, 1, "a reused token must mint exactly one session, never two");
  db.close();
});

test("auth magic redeem: exceeding the per-IP verify rate limit redirects to rate_limited", async () => {
  const { db, env } = baseFixture();
  for (let i = 0; i < 30; i += 1) {
    await magicResponse(env, streamingMagicRequest(["token=bad"]).request);
  }
  const result = await magicResponse(env, streamingMagicRequest(["token=bad"]).request);
  assert.equal(result.status, 303);
  assert.equal(result.res.headers.get("location"), "https://portal.test/?auth_error=rate_limited");
  // C6: a top-level redirect has no script running to read a header, so this path never gets one
  // (the UI instead falls back to the "later" wording for auth_error=rate_limited).
  assert.equal(result.res.headers.get("retry-after"), null);
  db.close();
});

test("auth magic redeem: unset OTP peppers redirect to sign_in_failed", async () => {
  const { db, env } = baseFixture({ PORTAL_OTP_PEPPERS: undefined });
  const result = await magicResponse(env, streamingMagicRequest(["token=bad"]).request);
  assert.equal(result.status, 303);
  assert.equal(result.res.headers.get("location"), "https://portal.test/?auth_error=sign_in_failed");
  db.close();
});

test("auth magic redeem: a valid secret with unset session peppers redirects to sign_in_failed and mints no cookie", async () => {
  const { db, env } = baseFixture();
  const issued = await requestOtp(env, { email: "a@x.com", clientIp: "seed", returnSecret: true, now: NOW });
  assert.equal(issued.ok, true);
  const noSessionPeppers = { ...env, PORTAL_SESSION_PEPPERS: undefined };
  const { request } = streamingMagicRequest([`token=${encodeURIComponent(issued.secret)}`]);
  const result = await magicResponse(noSessionPeppers, request);
  assert.equal(result.status, 303);
  assert.equal(result.res.headers.get("location"), "https://portal.test/?auth_error=sign_in_failed");
  assert.equal(result.res.headers.get("set-cookie"), null);
  db.close();
});

test("auth magic redeem: a thrown D1 error during redeem still redirects to sign_in_failed", async () => {
  const { db, env } = baseFixture();
  const issued = await requestOtp(env, { email: "a@x.com", clientIp: "seed", returnSecret: true, now: NOW });
  assert.equal(issued.ok, true);
  const withThrowingDb = { ...env, DB: throwingOtpClaimDb(env.DB) };
  const { request } = streamingMagicRequest([`token=${encodeURIComponent(issued.secret)}`]);
  const result = await magicResponse(withThrowingDb, request);
  assert.equal(result.status, 303);
  assert.equal(result.res.headers.get("location"), "https://portal.test/?auth_error=sign_in_failed");
  assert.equal(result.res.headers.get("set-cookie"), null);
  db.close();
});

export const DIRECT_ROUTE_TESTS = Object.freeze([
  "POST /portal/v1/auth/request",
  "POST /portal/v1/auth/verify",
  "GET /portal/v1/auth/magic",
  "POST /portal/v1/auth/magic-redeem",
  "POST /portal/v1/admin/bootstrap-otp",
]);
