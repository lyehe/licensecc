import { test } from "node:test";
import { assert, baseFixture, call, NOW, mintSession } from "./portal-worker-fixtures.mjs";
import { hashPassword } from "../dist-worker/worker/password/crypto.js";

const PATH = "/portal/v1/auth/password";
const PASSWORD = "A long testing passphrase 1!";
const NEXT = "Another testing passphrase 2!";
function fixture(t) {
  t.mock.method(Date, "now", () => NOW * 1000);
  const data = baseFixture({ PORTAL_PASSWORD_ENABLED: "1", PORTAL_EMAIL_API_KEY: "test-only", PORTAL_EMAIL_FROM: "sender@example.com" });
  data.db.exec("PRAGMA foreign_keys = ON");
  const mail = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init.redirect, "manual");
    mail.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  });
  const pending = [];
  const ctx = { waitUntil: p => { pending.push(Promise.resolve(p)); } };
  const settle = async () => { while (pending.length) await pending.shift(); };
  const request = async (purpose, email = "new@example.com", env = data.env) => {
    const result = await call(env, "POST", `${PATH}/${purpose}`, { body: { email }, ctx });
    await settle();
    return result;
  };
  const token = () => new URL(mail.at(-1).text.match(/https:\/\/\S+/)[0]).hash.slice("#token=".length);
  const complete = (value = token(), password = PASSWORD) => call(data.env, "POST", `${PATH}/complete`, { body: { token: value, password } });
  return { ...data, mail, request, token, complete, ctx, settle };
}
const cookie = result => result.res.headers.get("set-cookie").split(";")[0];
async function credential(env, email = "a@x.com") {
  const hash = await hashPassword(PASSWORD);
  await env.DB.prepare("INSERT INTO portal_passwords (customer_id,email_lower,password_hash,created_at,updated_at) VALUES ('A',?,?,?,?)").bind(email, hash, NOW, NOW).run();
  return hash;
}
async function legacy(env, email) {
  await env.DB.prepare("INSERT INTO customers (id,name,email,created_at,updated_at) VALUES ('L','Personal account','',?,?)").bind(NOW, NOW).run();
  await env.DB.prepare("INSERT INTO portal_passwords (customer_id,email_lower,password_hash,created_at,updated_at) VALUES ('L',?,?,?,?)").bind(email, await hashPassword(PASSWORD), NOW, NOW).run();
}

test("email proof precedes account creation and creates verified, empty account once", async t => {
  const f = fixture(t);
  const response = await f.request("register", " New@Example.com ");
  assert.equal(response.status, 202);
  assert.equal(response.res.headers.get("set-cookie"), null);
  assert.equal(f.db.prepare("SELECT count(*) n FROM customers").get().n, 2);
  assert.equal(f.db.prepare("SELECT count(*) n FROM portal_passwords").get().n, 0);
  const proof = f.db.prepare("SELECT * FROM portal_password_actions").get();
  assert.equal(proof.expires_at - proof.created_at, 900);
  assert.ok(!JSON.stringify(proof).includes(f.token()));
  assert.ok(!JSON.stringify(response.body).includes(f.token()));
  const result = await f.complete();
  assert.equal(result.status, 200);
  assert.equal(f.db.prepare("SELECT count(*) n FROM account_token_revocations").get().n, 0);
  assert.match(result.res.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(f.db.prepare("SELECT email FROM customers WHERE id = ?").get(result.body.data.customer_id).email, "new@example.com");
  const settings = await call(f.env, "GET", PATH, { cookie: cookie(result) });
  assert.equal(settings.body.data.email_verified, true);
  assert.equal((await call(f.env, "GET", "/api/portal/entitlements", { cookie: cookie(result) })).body.data.items.length, 0);
  assert.equal((await f.complete()).body.code, "invalid_link");
  assert.equal((await call(f.env, "POST", `${PATH}/login`, { body: { email: "new@example.com", password: PASSWORD } })).status, 200);
});

test("existing, missing, disabled and unverified accounts get generic email request responses", async t => {
  const f = fixture(t);
  await credential(f.env, "unverified@example.com");
  for (const [purpose,email] of [["register","a@x.com"],["reset","missing@example.com"],["reset","unverified@example.com"],["register","unverified@example.com"]]) {
    f.db.exec("DELETE FROM rate_limit_counters");
    const result = await f.request(purpose,email);
    assert.equal(result.status,202); assert.equal(result.body.code,"verification_requested");
  }
  assert.equal(f.mail.length,0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM customers").get().n,2);
});

test("reset rotates credentials, sessions, OTPs and token revocations; old links cannot replay", async t => {
  const f = fixture(t);
  const oldHash = await credential(f.env);
  f.db.prepare("INSERT INTO portal_otp (id,customer_id,email_lower,secret_hmac,code_hmac,pepper_key_id,expires_at,created_at) VALUES ('otp-reset','A','a@x.com','secret-test','code-test','p1',?,?)").run(NOW+600,NOW);
  const old = await mintSession(f.env, { customerId: "A", authMethod: "password", passwordHash: oldHash, now: NOW });
  assert.equal((await f.request("reset", "a@x.com")).status,202);
  const result = await f.complete(undefined,NEXT);
  assert.equal(result.status,200);
  assert.equal((await call(f.env,"GET","/api/portal/me",{cookie:`lccp_session=${old.raw}`})).status,401);
  assert.equal((await call(f.env,"GET","/api/portal/me",{cookie:cookie(result)})).status,200);
  assert.equal(f.db.prepare("SELECT revocation_seq FROM account_token_revocations WHERE customer_id = 'A'").get().revocation_seq,1);
  assert.equal(f.db.prepare("SELECT consumed_at FROM portal_otp WHERE id = 'otp-reset'").get().consumed_at,NOW);
  assert.equal((await call(f.env,"POST",`${PATH}/login`,{body:{email:"a@x.com",password:PASSWORD}})).status,401);
  assert.equal((await call(f.env,"POST",`${PATH}/login`,{body:{email:"a@x.com",password:NEXT}})).status,200);
  assert.equal((await f.complete(undefined,NEXT)).body.code,"invalid_link");
});

test("expiry, password change, disabling and account creation invalidate outstanding proofs", async t => {
  const f = fixture(t);
  await f.request("register");
  f.db.prepare("UPDATE portal_password_actions SET created_at = created_at - 900, expires_at = ?").run(NOW);
  assert.equal((await f.complete()).body.code,"invalid_link");
  assert.equal(f.db.prepare("SELECT count(*) n FROM customers").get().n,2);
  await credential(f.env);
  await f.request("reset","a@x.com");
  f.db.prepare("UPDATE portal_passwords SET password_hash = ? WHERE customer_id = 'A'").run(await hashPassword(NEXT));
  assert.equal((await f.complete()).body.code,"invalid_link");
  assert.equal(f.db.prepare("SELECT count(*) n FROM account_token_revocations").get().n,0);
  f.db.exec("DELETE FROM rate_limit_counters");
  await f.request("reset","a@x.com");
  f.db.exec("UPDATE customers SET status = 'disabled' WHERE id = 'A'");
  assert.equal((await f.complete()).body.code,"invalid_link");
  f.db.exec("DELETE FROM rate_limit_counters");
  await f.request("register");
  f.db.prepare("UPDATE customers SET email = 'new@example.com' WHERE id = 'B'").run();
  assert.equal((await f.complete()).body.code,"invalid_link");
  assert.equal(f.db.prepare("SELECT count(*) n FROM customers").get().n,2);
});

test("parallel redemption permits one password write and one session", async t => {
  const f = fixture(t);
  await f.request("register");
  const results = await Promise.all([f.complete(),f.complete(undefined,NEXT)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
  assert.equal(f.db.prepare("SELECT count(*) n FROM portal_passwords").get().n,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM portal_sessions").get().n,1);
});

test("mail cooldown, missing sender, delivery failure, CSRF and disabled flag fail safely", async t => {
  const f = fixture(t);
  assert.equal((await f.request("register","new@example.com",{...f.env,PORTAL_EMAIL_API_KEY:""})).status,503);
  assert.equal((await call(f.env,"POST",`${PATH}/reset`,{headers:{origin:"https://evil.test"},body:{email:"a@x.com"}})).status,403);
  assert.equal((await call({...f.env,PORTAL_PASSWORD_ENABLED:"0"},"POST",`${PATH}/complete`,{body:{token:"a".repeat(43),password:PASSWORD}})).status,404);
  await f.request("register");
  assert.equal((await f.request("register")).status,429);
  assert.equal((await f.request("reset")).status,429);
  assert.equal(f.mail.length,1);
  t.mock.method(globalThis,"fetch",async()=>new Response("error",{status:503}));
  const failed=await f.request("register","failed@example.com");
  assert.equal(failed.status,202);
  assert.equal(f.db.prepare("SELECT count(*) n FROM portal_password_actions WHERE email_lower = 'failed@example.com'").get().n,0);
  assert.equal((await call(f.env,"GET",`${PATH}/complete?token=${f.token()}`)).status,404);
  assert.equal(f.db.prepare("SELECT consumed_at FROM portal_password_actions").get().consumed_at,null);
});

test("pre-verification password accounts recover and adopt the proven email", async t => {
  const f = fixture(t);
  await legacy(f.env, "legacy@example.com");
  assert.equal((await f.request("reset", "legacy@example.com")).status, 202);
  assert.equal(f.mail.length, 1);
  const result = await f.complete(undefined, NEXT);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.customer_id, "L");
  assert.equal(f.db.prepare("SELECT email FROM customers WHERE id = 'L'").get().email, "legacy@example.com");
  assert.equal((await call(f.env, "POST", `${PATH}/login`, { body: { email: "legacy@example.com", password: NEXT } })).status, 200);
});

test("legacy reset stays generic when another customer owns the address", async t => {
  const f = fixture(t);
  await legacy(f.env, "a@x.com");
  assert.equal((await f.request("reset", "a@x.com")).status, 202);
  assert.equal(f.mail.length, 0);
  assert.equal(f.db.prepare("SELECT email FROM customers WHERE id = 'L'").get().email, "");
});

test("link requests answer before any account lookup or delivery", async t => {
  const f = fixture(t);
  await credential(f.env);
  let release; const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, init) => { await gate; f.mail.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); });
  const response = await call(f.env, "POST", `${PATH}/reset`, { body: { email: "a@x.com" }, ctx: f.ctx });
  assert.equal(response.status, 202);
  assert.equal(f.mail.length, 0);
  release(); await f.settle();
  assert.equal(f.mail.length, 1);
});

test("a provider timeout keeps the emailed link redeemable", async t => {
  const f = fixture(t);
  t.mock.method(globalThis, "fetch", async (_url, init) => { f.mail.push(JSON.parse(init.body)); throw new DOMException("aborted", "AbortError"); });
  assert.equal((await f.request("register", "slow@example.com")).status, 202);
  assert.equal(f.db.prepare("SELECT count(*) n FROM portal_password_actions WHERE email_lower = 'slow@example.com'").get().n, 1);
  assert.equal((await f.complete()).status, 200);
});

test("a committed reset reports success even when the new session cannot be minted", async t => {
  const f = fixture(t);
  await credential(f.env);
  await f.request("reset", "a@x.com");
  f.db.exec("CREATE TRIGGER no_sessions BEFORE INSERT ON portal_sessions BEGIN SELECT RAISE(ABORT, 'test'); END");
  const result = await f.complete(undefined, NEXT);
  assert.equal(result.status, 200);
  assert.equal(result.body.code, "password_updated");
  assert.equal(result.body.data.sign_in_required, true);
  f.db.exec("DROP TRIGGER no_sessions");
  assert.equal((await call(f.env, "POST", `${PATH}/login`, { body: { email: "a@x.com", password: NEXT } })).status, 200);
});

test("a legacy reset link cannot adopt an address another customer claimed after it was sent", async t => {
  const f = fixture(t);
  await legacy(f.env, "legacy@example.com");
  const before = f.db.prepare("SELECT password_hash FROM portal_passwords WHERE customer_id = 'L'").get().password_hash;
  assert.equal((await f.request("reset", "legacy@example.com")).status, 202);
  assert.equal(f.mail.length, 1);
  f.db.prepare("UPDATE customers SET email = 'legacy@example.com' WHERE id = 'B'").run();
  assert.equal((await f.complete(undefined, NEXT)).body.code, "invalid_link");
  assert.equal(f.db.prepare("SELECT email FROM customers WHERE id = 'L'").get().email, "");
  assert.equal(f.db.prepare("SELECT password_hash FROM portal_passwords WHERE customer_id = 'L'").get().password_hash, before);
});

function captureEvents(t) {
  const lines = [];
  t.mock.method(console, "error", (...args) => { lines.push(args.map(String).join(" ")); });
  return { raw: () => lines.join("\n"), parsed: () => lines.map(line => JSON.parse(line)) };
}

test("background link delivery failures emit exactly one closed-shape event", async t => {
  const f = fixture(t);
  const events = captureEvents(t);
  const failure = error_type => ({ event: "portal.email_delivery_failed", severity: "error", error_type });

  assert.equal((await f.request("register", "ok@example.com")).status, 202);
  assert.deepEqual(events.parsed(), [], "a delivered link emits nothing");

  t.mock.method(globalThis, "fetch", async () => new Response("provider-secret-text", { status: 503 }));
  assert.equal((await f.request("register", "failed@example.com")).status, 202);
  assert.deepEqual(events.parsed(), [failure("send_failed")]);

  t.mock.method(globalThis, "fetch", async () => { throw new DOMException("aborted", "AbortError"); });
  assert.equal((await f.request("register", "slow@example.com")).status, 202);
  assert.deepEqual(events.parsed(), [failure("send_failed"), failure("send_failed")], "an indeterminate send reports send_failed");

  f.db.exec("CREATE TRIGGER no_actions BEFORE INSERT ON portal_password_actions BEGIN SELECT RAISE(ABORT, 'secret-sql-detail'); END");
  const response = await f.request("register", "boom@example.com");
  assert.equal(response.status, 202);
  assert.equal(response.body.code, "verification_requested");
  assert.deepEqual(events.parsed(), [failure("send_failed"), failure("send_failed"), failure("rejected")], "a background exception emits once");
  for (const sensitive of ["@example.com", "secret-sql-detail", "provider-secret-text", "token", "aborted"]) {
    assert.equal(events.raw().includes(sensitive), false, `telemetry excludes ${sensitive}`);
  }
});

export const DIRECT_ROUTE_TESTS = ["POST /portal/v1/auth/password/register", "POST /portal/v1/auth/password/reset", "POST /portal/v1/auth/password/complete"];
