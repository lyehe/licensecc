import { test } from "node:test";
import { assert, worker, cookieFor, call, baseFixture, CTX } from "./portal-worker-fixtures.mjs";
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
  const retirements = [];
  const { db, env } = baseFixture({ DEVICE_CONSENT: { retire: async (...args) => { retirements.push(args); throw new Error("a cross-site request must not reach the backend"); } } });
  const cookie = await cookieFor(env, "A");
  const req = new Request("https://portal.test/api/portal/device-bindings/retire", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "sec-fetch-site": "cross-site", origin: "https://evil.test", "x-expected-customer-id": "A" },
    body: JSON.stringify({ binding_id: Buffer.alloc(16, 1).toString("base64url"), expected_revision: 0 }),
  });
  const res = await worker.fetch(req, env, CTX);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "cross_site_forbidden");
  assert.equal(retirements.length, 0, "the rejected retirement never reaches the backend");
  db.close();
});

// =================================================================================================
// LOGOUT revokes the session
// =================================================================================================

test("logout revokes the session and clears the cookie", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
  const r = await call(env, "POST", "/portal/v1/auth/logout", { cookie, body: {} });
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get("set-cookie") ?? "", /Max-Age=0/, "the cookie is cleared");
  // The session is revoked.
  const after = await call(env, "GET", "/api/portal/me", { cookie });
  assert.equal(after.status, 401, "the session no longer resolves after logout");
  db.close();
});

// =================================================================================================
// CONFIG GATES — pepper-unset 503; bootstrap break-glass
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
