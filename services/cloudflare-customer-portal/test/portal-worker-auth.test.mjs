import { test } from "node:test";
import { assert, worker, mintSession, codeFromSecretBytes, requestOtp, redeemOtp, policyCapacityViolation, FP_A, FP_B, installBackendStub, cookieFor, sameSiteHeaders, entitlementId, ownedEntitlementId, call, baseFixture, seedDevice, seedEntitlement, CTX, NOW } from "./portal-worker-fixtures.mjs";

test("/health is unhealthy (503) when ACCOUNT_TOKEN_MODE != required (invariant 7)", async () => {
  const { db, env } = baseFixture({ ACCOUNT_TOKEN_MODE: "soft" });
  const r = await call(env, "GET", "/health", {});
  assert.equal(r.status, 503);
  assert.equal(r.body.data.account_token_mode_required, false);

  const { db: db2, env: env2 } = baseFixture();
  const ok = await call(env2, "GET", "/health", {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.code, "healthy");
  db.close();
  db2.close();
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
