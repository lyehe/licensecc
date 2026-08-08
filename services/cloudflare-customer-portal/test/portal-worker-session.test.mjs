import { test } from "node:test";
import { assert, worker, mintSession, codeFromSecretBytes, requestOtp, redeemOtp, policyCapacityViolation, FP_A, FP_B, installBackendStub, cookieFor, sameSiteHeaders, entitlementId, ownedEntitlementId, call, baseFixture, seedDevice, seedEntitlement, CTX, NOW } from "./portal-worker-fixtures.mjs";
test("missing / invalid / revoked session -> 401 on a protected read", async () => {
  const { db, env } = baseFixture();
  // Missing.
  assert.equal((await call(env, "GET", "/api/portal/me", {})).status, 401);
  // Invalid token.
  assert.equal((await call(env, "GET", "/api/portal/me", { cookie: "lccp_session=lccp_garbage" })).status, 401);
  // Revoked.
  const cookie = await cookieFor(env, "A");
  const sid = db.prepare("SELECT id FROM portal_sessions WHERE customer_id = 'A'").get().id;
  db.prepare("UPDATE portal_sessions SET status = 'revoked' WHERE id = ?").run(sid);
  assert.equal((await call(env, "GET", "/api/portal/me", { cookie })).status, 401);
  db.close();
});

test("a disabled customer's session -> 401", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
  db.prepare("UPDATE customers SET status = 'disabled' WHERE id = 'A'").run();
  assert.equal((await call(env, "GET", "/api/portal/me", { cookie })).status, 401);
  db.close();
});

test("cross-site POST is rejected 403 (CSRF defense)", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
  const req = new Request("https://portal.test/api/portal/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "sec-fetch-site": "cross-site", origin: "https://evil.test" },
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT" }),
  });
  const res = await worker.fetch(req, env, CTX);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "cross_site_forbidden");
  db.close();
});

// =================================================================================================
// LOGOUT bumps revocation_seq (invariant 9)
// =================================================================================================

test("logout revokes the session AND bumps account_token_revocations.revocation_seq", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
  const r = await call(env, "POST", "/portal/v1/auth/logout", { cookie, body: {} });
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get("set-cookie") ?? "", /Max-Age=0/, "the cookie is cleared");
  const seq = db.prepare("SELECT revocation_seq FROM account_token_revocations WHERE customer_id = 'A'").get();
  assert.ok(seq && seq.revocation_seq >= 1, "the per-customer revocation floor is bumped on logout");
  // The session is revoked.
  const after = await call(env, "GET", "/api/portal/me", { cookie });
  assert.equal(after.status, 401, "the session no longer resolves after logout");
  db.close();
});

// =================================================================================================
// CONFIG GATES — pepper-unset 503; /health mode!=required; bootstrap break-glass
// =================================================================================================

test("pepper-unset (session) -> 503 config_error on a protected route", async () => {
  const { db, env } = baseFixture({ PORTAL_SESSION_PEPPERS: undefined });
  // With no session peppers we cannot even mint a cookie; resolveSession returns config_error -> 503.
  const r = await call(env, "GET", "/api/portal/me", { cookie: "lccp_session=lccp_anything" });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "config_error");
  db.close();
});

export const DIRECT_ROUTE_TESTS = Object.freeze([
  "POST /portal/v1/auth/logout",
]);
