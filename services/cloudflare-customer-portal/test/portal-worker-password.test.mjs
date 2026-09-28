import { test } from "node:test";
import { scryptSync } from "node:crypto";
import { assert, baseFixture, call, mintSession, NOW } from "./portal-worker-fixtures.mjs";
import { hashPassword, verifyPassword, validPassword } from "../dist-worker/worker/password/crypto.js";

const PASSWORD = "A long testing passphrase 1!";
const NEXT = "Another long passphrase 2!";
const PATH = "/portal/v1/auth/password";
const fixture = () => { const data = baseFixture({ PORTAL_PASSWORD_ENABLED: "1" }); data.db.exec("PRAGMA foreign_keys = ON"); return data; };
const cookie = (result) => result.res.headers.get("set-cookie").split(";")[0];
// Existing login/settings tests deliberately exercise legacy unverified credentials.
async function register(env, email = "new@example.com") {
  const id = `cust_${crypto.randomUUID()}`;
  email = email.trim().toLowerCase();
  await env.DB.prepare("INSERT INTO customers (id,name,email,created_at,updated_at) VALUES (?, 'Personal account', '', ?, ?)").bind(id, NOW, NOW).run();
  await env.DB.prepare("INSERT INTO portal_passwords (customer_id,email_lower,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)").bind(id,email,await hashPassword(PASSWORD),NOW,NOW).run();
  return login(env,email);
}
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
test("wrong password, missing user and a wrong password on a suspended customer share the same denial", async () => {
  const { env, db } = fixture();
  await register(env);
  const wrong = await login(env, "new@example.com", NEXT);
  const missing = await login(env, "missing@example.com");
  db.prepare("UPDATE customers SET status = 'disabled' WHERE id IN (SELECT customer_id FROM portal_passwords)").run();
  // The password is checked before the account status, so a guess never reveals a suspension.
  const suspendedWrong = await login(env, "new@example.com", NEXT);
  for (const response of [wrong, missing, suspendedWrong]) {
    assert.equal(response.status, 401); assert.equal(response.body.code, "invalid_credentials");
    assert.equal(response.res.headers.get("set-cookie"), null);
  }
});
test("the correct password on a suspended customer is told the account is suspended, without a session", async () => {
  const { env, db } = fixture();
  await register(env);
  db.prepare("UPDATE customers SET status = 'disabled' WHERE id IN (SELECT customer_id FROM portal_passwords)").run();
  const sessions = () => db.prepare("SELECT count(*) AS n FROM portal_sessions").get().n;
  const before = sessions();
  const suspended = await login(env);
  assert.equal(suspended.status, 403);
  assert.equal(suspended.body.code, "account_suspended");
  assert.equal(suspended.body.data, undefined);
  assert.equal(suspended.res.headers.get("set-cookie"), null);
  assert.equal(suspended.res.headers.get("cache-control"), "no-store");
  assert.equal(sessions(), before);
});
test("CSRF, body limits, disabled configuration and throttling gate credential writes", async t => {
  // Keep the seeded counter and request in the same fixed rate-limit window.
  t.mock.method(Date, "now", () => NOW * 1000);
  const { env, db } = fixture();
  assert.equal((await call(env, "POST", `${PATH}/register`, { headers: { origin: "https://evil.test" }, body: { email: "new@example.com", password: PASSWORD } })).status, 403);
  assert.equal((await call(env, "POST", `${PATH}/register`, { body: { email: "new@example.com", password: "x".repeat(9000) } })).status, 413);
  assert.equal((await call({ ...env, PORTAL_PASSWORD_ENABLED: "0" }, "POST", `${PATH}/register`, { body: { email: "new@example.com" } })).status, 404);
  const window = Math.floor(NOW / 900) * 900;
  db.prepare("INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) VALUES ('portal', 'password:register:ip:', ?, 5, ?, ?)").run(window, NOW + 1800, NOW);
  const limited = await call({ ...env, PORTAL_EMAIL_API_KEY: "test", PORTAL_EMAIL_FROM: "sender@example.com" }, "POST", `${PATH}/register`, { body: { email: "new@example.com" } });
  assert.equal(limited.status, 429);
  // The auth 429s carry the exact seconds left in the fixed window, so the UI can say "Try again
  // in {n} minutes." instead of a vague "later".
  assert.equal(limited.res.headers.get("retry-after"), String(window + 900 - NOW));
  assert.equal(db.prepare("SELECT count(*) AS n FROM portal_passwords").get().n, 0);
  assert.equal((await call(env, "GET", PATH)).status, 401);
});
test("login over the per-IP cap answers 429 with the exact retry-after for the fixed window", async t => {
  t.mock.method(Date, "now", () => NOW * 1000);
  const { env, db } = fixture();
  const window = Math.floor(NOW / 900) * 900;
  db.prepare("INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) VALUES ('portal', 'password:login:ip:', ?, 30, ?, ?)").run(window, NOW + 1800, NOW);
  const limited = await login(env, "nobody@example.com", PASSWORD);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "rate_limited");
  assert.equal(limited.res.headers.get("retry-after"), String(window + 900 - NOW));
});
// The password-change ("settings" POST) 429 was deliberately left out of the retry-after rollout
// (it is not one of the auth entry points the UI drives the countdown sentence from), so its 429
// must keep answering with no header at all.
test("a signed-in password change over its own rate limit answers 429 with no retry-after header", async t => {
  t.mock.method(Date, "now", () => NOW * 1000);
  const { env, db } = fixture();
  const result = await register(env);
  const sessionCookie = cookie(result);
  const window = Math.floor(NOW / 900) * 900;
  db.prepare("INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) VALUES ('portal', 'password:change:ip:', ?, 30, ?, ?)").run(window, NOW + 1800, NOW);
  const limited = await call(env, "POST", PATH, { cookie: sessionCookie, body: { password: NEXT, current_password: PASSWORD } });
  assert.equal(limited.status, 429);
  assert.equal(limited.res.headers.get("retry-after"), null);
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
test("a raced password change preserves the winning credential and existing access", async t => {
  const { env, db } = fixture();
  const first = await register(env);
  const credential = db.prepare("SELECT * FROM portal_passwords").get();
  const winningHash = await hashPassword(NEXT);
  db.prepare("INSERT INTO portal_otp (id,customer_id,email_lower,secret_hmac,code_hmac,pepper_key_id,expires_at,created_at) VALUES ('otp-race',?,?,'secret-test','code-test','p1',?,?)")
    .run(credential.customer_id, credential.email_lower, NOW + 600, NOW);
  const batch = env.DB.batch.bind(env.DB);
  t.mock.method(env.DB, "batch", statements => {
    // Another request commits after this route reads the old credential.
    db.prepare("UPDATE portal_passwords SET password_hash = ? WHERE customer_id = ?")
      .run(winningHash, credential.customer_id);
    return batch(statements);
  });
  const result = await call(env, "POST", PATH, {
    cookie: cookie(first), body: { password: NEXT, current_password: PASSWORD },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "password_change_conflict");
  assert.equal(result.res.headers.get("set-cookie"), null);
  assert.equal(db.prepare("SELECT password_hash FROM portal_passwords").get().password_hash, winningHash);
  assert.equal(db.prepare("SELECT count(*) n FROM portal_sessions WHERE status = 'active'").get().n, 1);
  assert.equal(db.prepare("SELECT consumed_at FROM portal_otp WHERE id = 'otp-race'").get().consumed_at, null);
  assert.equal(db.prepare("SELECT count(*) n FROM account_token_revocations").get().n, 0);
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

// `recovery_available` must use the EXACT predicate the emailed reset endpoint uses
// (password-email.ts), so the settings UI never promises a recovery the server would refuse.
test("password settings report no recovery path before any credential exists", async () => {
  const { env } = fixture();
  const result = await call(env, "GET", PATH, { cookie: await verifiedCookie(env, "A") });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.has_password, false);
  assert.equal(result.body.data.recovery_available, false);
});

test("password settings mark a credential eligible when it matches the customer's own verified email", async () => {
  const { env } = fixture();
  await env.DB.prepare("INSERT INTO portal_passwords (customer_id,email_lower,password_hash,created_at,updated_at) VALUES ('A','a@x.com',?,?,?)").bind(await hashPassword(PASSWORD), NOW, NOW).run();
  const result = await call(env, "GET", PATH, { cookie: await verifiedCookie(env, "A") });
  assert.equal(result.body.data.has_password, true);
  assert.equal(result.body.data.email_verified, true);
  assert.equal(result.body.data.recovery_available, true);
});

test("password settings mark a legacy/set-password-shaped account eligible for one recovery when its address is unclaimed", async () => {
  // register() seeds a KNOWN password (the set-password/legacy shape, empty contact email but a
  // usable credential) -- not the random-secret Invite shape, which portal-worker-password-email.test.mjs
  // covers separately.
  const { env } = fixture();
  const created = await register(env, "invited@example.com");
  const result = await call(env, "GET", PATH, { cookie: cookie(created) });
  assert.equal(result.body.data.has_password, true);
  assert.equal(result.body.data.email_verified, false);
  assert.equal(result.body.data.recovery_available, true);
});

test("password settings never offer recovery for a legacy/set-password-shaped account whose address another customer already verified", async () => {
  // baseFixture seeds customer A with the verified address a@x.com; a second, empty-contact account
  // sharing that same login identifier (the legacy/set-password shape) must not recover with it.
  const { env } = fixture();
  const created = await register(env, "a@x.com");
  const result = await call(env, "GET", PATH, { cookie: cookie(created) });
  assert.equal(result.body.data.email_verified, false);
  assert.equal(result.body.data.recovery_available, false);
});

export const DIRECT_ROUTE_TESTS = ["POST /portal/v1/auth/password/login", "GET /portal/v1/auth/password", "POST /portal/v1/auth/password"];
