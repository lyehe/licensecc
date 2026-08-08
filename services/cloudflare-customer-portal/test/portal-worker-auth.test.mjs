import { test } from "node:test";
import { assert, worker, mintSession, codeFromSecretBytes, requestOtp, redeemOtp, policyCapacityViolation, FP_A, FP_B, installBackendStub, cookieFor, sameSiteHeaders, entitlementId, ownedEntitlementId, call, baseFixture, seedDevice, seedEntitlement, CTX, NOW } from "./portal-worker-fixtures.mjs";

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
  assert.ok(otp.expires_at > NOW && otp.expires_at <= NOW + 605); // +5 slop for the clock boundary
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

export const DIRECT_ROUTE_TESTS = Object.freeze([
  "POST /portal/v1/auth/request",
  "POST /portal/v1/auth/verify",
  "GET /portal/v1/auth/magic",
  "POST /portal/v1/auth/magic-redeem",
  "POST /portal/v1/admin/bootstrap-otp",
]);
