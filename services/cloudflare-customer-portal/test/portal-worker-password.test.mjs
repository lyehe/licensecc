import { test } from "node:test";
import { scryptSync } from "node:crypto";
import { assert, baseFixture, call, mintSession, NOW } from "./portal-worker-fixtures.mjs";
import { hashPassword, verifyPassword, validPassword } from "../dist-worker/worker/password/crypto.js";

const PASSWORD = "A long testing passphrase 1!";
const NEXT = "Another long passphrase 2!";
const PATH = "/portal/v1/auth/password";
const fixture = () => { const data = baseFixture({ PORTAL_PASSWORD_ENABLED: "1" }); data.db.exec("PRAGMA foreign_keys = ON"); return data; };
const cookie = (result) => result.res.headers.get("set-cookie").split(";")[0];
const register = (env, email = "new@example.com") => call(env, "POST", `${PATH}/register`, { body: { email, password: PASSWORD } });
const login = (env, email = "new@example.com", password = PASSWORD) => call(env, "POST", `${PATH}/login`, { body: { email, password } });
async function verifiedCookie(env, customerId, age = 0) {
  const minted = await mintSession(env, { customerId, authMethod: "oauth", now: NOW - age });
  return `lccp_session=${minted.raw}`;
}
test("scrypt encoding matches native crypto and supports long Unicode passwords without truncation", async () => {
  const value = "A long passphrase 密码 123456";
  const hash = await hashPassword(value);
  const [, salt, digest] = hash.split("$");
  assert.equal(digest, scryptSync(value, Buffer.from(salt, "hex"), 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString("hex"));
  assert.ok(await verifyPassword(value, hash));
  assert.equal(await verifyPassword(value + "x", hash), false);
  assert.notEqual(await hashPassword(value), hash);
  assert.equal(validPassword("x".repeat(14)), false);
  assert.equal(validPassword("x".repeat(129)), false);
});
test("password registration creates isolated empty account with usable opaque session", async () => {
  const { env, db } = fixture();
  const result = await register(env, " New@Example.com ");
  assert.equal(result.status, 200);
  assert.match(result.res.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  const me = await call(env, "GET", "/api/portal/me", { cookie: cookie(result) });
  const row = db.prepare("SELECT * FROM portal_passwords").get();
  assert.equal(row.customer_id, me.body.data.customer_id);
  assert.equal(row.email_lower, "new@example.com");
  assert.ok(row.password_hash.startsWith("scrypt-32768-8-3$"));
  assert.equal(db.prepare("SELECT email FROM customers WHERE id = ?").get(row.customer_id).email, "");
  assert.equal((await call(env, "GET", "/api/portal/entitlements", { cookie: cookie(result) })).body.data.items.length, 0);
  assert.equal(db.prepare("SELECT auth_method FROM portal_sessions WHERE customer_id = ?").get(row.customer_id).auth_method, "password");
  assert.equal((await login(env)).status, 200);
  assert.equal((await register(env)).status, 409);
  const settings = await call(env, "GET", PATH, { cookie: cookie(result) });
  assert.deepEqual(settings.body.data, { has_password: true, email: "new@example.com", can_reset: false, email_verified: false });
  assert.ok(!JSON.stringify(settings.body).includes(row.password_hash));
});
test("registration cannot claim an existing customer email or licenses", async () => {
  const { env, db } = fixture();
  assert.equal((await register(env, "a@x.com")).status, 409);
  assert.equal(db.prepare("SELECT count(*) AS n FROM portal_passwords").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM customers").get().n, 2);
});
test("wrong password, missing user and disabled customer share the same denial", async () => {
  const { env, db } = fixture();
  await register(env);
  const wrong = await login(env, "new@example.com", NEXT);
  const missing = await login(env, "missing@example.com");
  db.prepare("UPDATE customers SET status = 'disabled' WHERE id IN (SELECT customer_id FROM portal_passwords)").run();
  const disabled = await login(env);
  for (const response of [wrong, missing, disabled]) {
    assert.equal(response.status, 401); assert.equal(response.body.code, "invalid_credentials");
    assert.equal(response.res.headers.get("set-cookie"), null);
  }
});
test("CSRF, body limits, disabled configuration and throttling gate credential writes", async t => {
  // Keep the seeded counter and request in the same fixed rate-limit window.
  t.mock.method(Date, "now", () => NOW * 1000);
  const { env, db } = fixture();
  assert.equal((await call(env, "POST", `${PATH}/register`, { headers: { origin: "https://evil.test" }, body: { email: "new@example.com", password: PASSWORD } })).status, 403);
  assert.equal((await call(env, "POST", `${PATH}/register`, { body: { email: "new@example.com", password: "x".repeat(9000) } })).status, 413);
  assert.equal((await register({ ...env, PORTAL_PASSWORD_ENABLED: "0" })).status, 404);
  const window = Math.floor(NOW / 900) * 900;
  db.prepare("INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) VALUES ('portal', 'password:register:ip:', ?, 5, ?, ?)").run(window, NOW + 1800, NOW);
  assert.equal((await register(env)).status, 429);
  assert.equal(db.prepare("SELECT count(*) AS n FROM portal_passwords").get().n, 0);
  assert.equal((await call(env, "GET", PATH)).status, 401);
});
test("password change requires proof, rotates sessions and prevents old-hash session minting", async () => {
  const { env, db } = fixture();
  const first = await register(env);
  const second = await login(env);
  const credential = db.prepare("SELECT * FROM portal_passwords").get();
  assert.equal((await call(env, "POST", PATH, { cookie: cookie(first), body: { password: NEXT } })).status, 401);
  const changed = await call(env, "POST", PATH, { cookie: cookie(first), body: { password: NEXT, current_password: PASSWORD, customer_id: "B" } });
  assert.equal(changed.status, 200);
  assert.equal((await call(env, "GET", "/api/portal/me", { cookie: cookie(second) })).status, 401);
  assert.equal((await call(env, "GET", "/api/portal/me", { cookie: cookie(first) })).status, 401);
  assert.equal((await call(env, "GET", "/api/portal/me", { cookie: cookie(changed) })).status, 200);
  assert.equal((await login(env)).status, 401);
  assert.equal((await login(env, "new@example.com", NEXT)).status, 200);
  assert.equal(db.prepare("SELECT revocation_seq FROM account_token_revocations WHERE customer_id = ?").get(credential.customer_id).revocation_seq, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM portal_passwords WHERE customer_id = 'B'").get().n, 0);
  assert.equal((await mintSession(env, { customerId: credential.customer_id, authMethod: "password", passwordHash: credential.password_hash, now: NOW })).ok, false);
});
test("first password and recovery require recent verified sign-in", async () => {
  const { env } = fixture();
  const old = await verifiedCookie(env, "A", 700);
  assert.equal((await call(env, "POST", PATH, { cookie: old, body: { password: PASSWORD } })).status, 403);
  const fresh = await verifiedCookie(env, "A");
  const set = await call(env, "POST", PATH, { cookie: fresh, body: { password: PASSWORD } });
  assert.equal(set.status, 200);
  assert.equal((await login(env, "a@x.com")).status, 200);
  const reauthenticated = await verifiedCookie(env, "A");
  const reset = await call(env, "POST", PATH, { cookie: reauthenticated, body: { password: NEXT } });
  assert.equal(reset.status, 200);
  assert.equal((await login(env, "a@x.com", NEXT)).status, 200);
});

export const DIRECT_ROUTE_TESTS = ["POST /portal/v1/auth/password/register", "POST /portal/v1/auth/password/login", "GET /portal/v1/auth/password", "POST /portal/v1/auth/password"];
