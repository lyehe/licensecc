import { test } from "node:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { assert, worker, baseFixture, call, cookieFor, mintSession, sameSiteHeaders, within, NOW, CTX } from "./portal-worker-fixtures.mjs";
import { identityCustomer } from "../dist-worker/worker/oauth/accounts.js";
// Namespace import: a missing export fails its own test instead of the whole suite's module load.
import * as support from "../dist-worker/worker/support.js";

const configuration = { PORTAL_GOOGLE_CLIENT_ID: "google-client", PORTAL_GOOGLE_CLIENT_SECRET: "google-secret", PORTAL_GITHUB_CLIENT_ID: "github-client", PORTAL_GITHUB_CLIENT_SECRET: "github-secret" };
async function start(env, provider = "github", sessionCookie) {
  const result = await call(env, "POST", `/portal/v1/auth/${provider}/start${sessionCookie ? "?mode=link" : ""}`, { cookie: sessionCookie });
  assert.equal(result.status, 303);
  const url = new URL(result.res.headers.get("location"));
  const cookie = result.res.headers.get("set-cookie").split(";")[0];
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(result.res.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  return { url, cookie: sessionCookie ? `${cookie}; ${sessionCookie}` : cookie };
}
async function finish(env, flow, provider = "github", query = "code=provider-code") {
  return worker.fetch(new Request(`https://portal.test/portal/v1/auth/${provider}/callback?state=${flow.url.searchParams.get("state")}&${query}`, { headers: { cookie: flow.cookie } }), env, CTX);
}
function githubStub(t, { email = "new@example.com", verified = true, id = 123, failure = false } = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, "manual");
    if (failure) return new Response("failure", { status: 502 });
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "private-provider-token", token_type: "bearer" });
    if (url === "https://api.github.com/user") return Response.json({ id, name: "Customer", email: "untrusted@example.com" });
    if (url === "https://api.github.com/user/emails?per_page=100") return Response.json([{ email, verified, primary: true }]);
    throw new Error(`Unexpected fetch ${url}`);
  });
  return calls;
}
test("OAuth availability, exact-origin enforcement, disabled provider, authenticated identity inventory", async () => {
  const { env } = baseFixture();
  assert.deepEqual((await call(env, "GET", "/portal/v1/auth/providers")).body.data, { google: false, github: false, email: false, password: false, support: null });
  assert.equal((await call(env, "GET", "/portal/v1/auth/identities")).status, 401);
  assert.equal((await call(env, "POST", "/portal/v1/auth/github/start", { headers: { origin: "https://evil.test" } })).status, 403);
  assert.match((await call(env, "POST", "/portal/v1/auth/github/start")).res.headers.get("location"), /provider_unavailable/);
});
test("the providers envelope hides email actions when the configured email destination is not a canonical HTTPS origin", async () => {
  const { env } = baseFixture({
    PORTAL_EMAIL_API_KEY: "test-only",
    PORTAL_EMAIL_FROM: "sender@example.com",
    PORTAL_EMAIL_API_BASE: "http://insecure.test",
  });
  assert.equal((await call(env, "GET", "/portal/v1/auth/providers")).body.data.email, false);
});
test("the providers envelope publishes the support contact only as an https: URL or a mailto: address", async () => {
  for (const [configured, published] of [
    ["https://support.example.com/help", "https://support.example.com/help"],
    ["mailto:help@example.com", "mailto:help@example.com"],
    ["javascript:alert(1)", null],
    ["http://support.example.com/help", null],
    ["", null],
  ]) {
    const { env } = baseFixture({ PORTAL_SUPPORT_CONTACT: configured });
    const providers = await call(env, "GET", "/portal/v1/auth/providers");
    assert.equal(providers.body.data.support, published, `PORTAL_SUPPORT_CONTACT=${JSON.stringify(configured)}`);
  }
});
test("supportContact accepts a credential-free https: URL or one mailto: address and treats anything else as unset", () => {
  const contact = (value) => support.supportContact({ PORTAL_SUPPORT_CONTACT: value });
  assert.equal(contact(undefined), null);
  assert.equal(contact("  https://Support.Example.com/help?topic=sign-in  "), "https://support.example.com/help?topic=sign-in");
  assert.equal(contact("https://support.example.com"), "https://support.example.com/");
  assert.equal(contact(" mailto:help@example.com "), "mailto:help@example.com");
  assert.equal(contact("MAILTO:Help@Example.com"), "MAILTO:Help@Example.com");
  for (const rejected of [
    "", "   ", "javascript:alert(1)", "JavaScript:alert(1)", "http://support.example.com", "data:text/html,<p>support</p>",
    "ftp://support.example.com", "/support", "support.example.com", "//support.example.com",
    "https://user:secret@support.example.com", "https://user@support.example.com",
    "mailto:", "mailto:help", "mailto:@example.com", "mailto:help@", "mailto:help@example.com?subject=hi",
    "mailto:a@example.com,b@example.com", "mailto:a b@example.com", "mailto:a@b@example.com",
    // A percent-encoded comma or a semicolon can still name a second recipient, and a control
    // character has no place in an href.
    "mailto:a%2Cb@example.com", "mailto:a@example.com;b", "mailto:help@example.com\u0000",
  ]) {
    assert.equal(contact(rejected), null, `must reject ${JSON.stringify(rejected)}`);
  }
});
test("GitHub registers an empty customer and mints a usable opaque session; callback replay fails", async (t) => {
  const { env, db } = baseFixture(configuration);
  const calls = githubStub(t);
  const flow = await start(env);
  const response = await finish(env, flow);
  assert.equal(response.headers.get("location"), "https://portal.test/#/apps");
  const sessionCookie = response.headers.getSetCookie().find((v) => v.startsWith("lccp_session=")).split(";")[0];
  const me = await call(env, "GET", "/api/portal/me", { cookie: sessionCookie });
  assert.equal(me.status, 200);
  assert.equal((await call(env, "GET", "/api/portal/entitlements", { cookie: sessionCookie })).body.data.items.length, 0);
  const row = db.prepare("SELECT * FROM portal_identities").get();
  assert.equal(row.customer_id, me.body.data.customer_id);
  assert.equal(row.subject, "123");
  assert.equal(row.email, "new@example.com");
  assert.ok(!JSON.stringify(row).includes("private-provider-token"));
  assert.equal(new URLSearchParams(calls[0].init.body).get("code_verifier"), flow.cookie.split("=")[1]);
  assert.match((await finish(env, flow)).headers.get("location"), /sign_in_failed/);
  assert.equal(calls.length, 3);
  const second = await finish(env, await start(env));
  assert.match(second.headers.get("location"), /#\/apps/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM customers").get().n, 3);
});
test("OAuth rejects wrong browser, provider mix-up, duplicate state, expired state and cancellation", async (t) => {
  const { env, db } = baseFixture(configuration);
  const calls = githubStub(t);
  const flow = await start(env);
  assert.match((await finish(env, { ...flow, cookie: "" })).headers.get("location"), /sign_in_failed/);
  assert.match((await finish(env, flow, "google")).headers.get("location"), /sign_in_failed/);
  assert.match((await finish(env, flow, "github", "code=x&state=duplicate")).headers.get("location"), /sign_in_failed/);
  db.prepare("UPDATE portal_oauth_states SET expires_at = ?").run(NOW - 1);
  assert.match((await finish(env, flow)).headers.get("location"), /sign_in_failed/);
  const cancelled = await start(env);
  assert.match((await finish(env, cancelled, "github", "error=access_denied")).headers.get("location"), /sign_in_cancelled/);
  assert.equal(calls.length, 0);
});
test("Existing email requires explicit linking, which cannot cross customer ownership", async (t) => {
  const { env, db } = baseFixture(configuration);
  githubStub(t, { email: "a@x.com" });
  const blocked = await finish(env, await start(env));
  assert.match(blocked.headers.get("location"), /account_link_required/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM portal_identities").get().n, 0);
  const cookieA = await cookieFor(env, "A");
  assert.match((await finish(env, await start(env, "github", cookieA))).headers.get("location"), /auth_result=linked/);
  const methods = await call(env, "GET", "/portal/v1/auth/identities", { cookie: cookieA });
  assert.equal(methods.body.data.items[0].provider, "github");
  const cookieB = await cookieFor(env, "B");
  assert.match((await finish(env, await start(env, "github", cookieB))).headers.get("location"), /sign_in_failed/);
  assert.equal(db.prepare("SELECT customer_id FROM portal_identities").get().customer_id, "A");
  assert.equal((await call(env, "GET", "/portal/v1/auth/identities", { cookie: cookieB })).body.data.items.length, 0);
});
test("A password-login account (empty customers.email, portal_passwords.email_lower set) is never duplicated by OAuth", async (t) => {
  const { env, db } = baseFixture(configuration);
  const passwordCustomerId = "cust_pw1";
  db.prepare("INSERT INTO customers (id, name, email, created_at, updated_at) VALUES (?, 'Personal account', '', ?, ?)").run(passwordCustomerId, NOW, NOW);
  db.prepare("INSERT INTO portal_passwords (customer_id, email_lower, password_hash, created_at, updated_at) VALUES (?, 'alice@example.com', 'x', ?, ?)").run(passwordCustomerId, NOW, NOW);
  const before = db.prepare("SELECT count(*) AS n FROM customers").get().n;
  // Mixed case, as a real GitHub account can return it: also pins that oauth/providers.ts's
  // email() lowercases before the guard compares against the always-lowercase email_lower column.
  githubStub(t, { email: "Alice@Example.COM", id: 999 });
  const blocked = await finish(env, await start(env));
  assert.match(blocked.headers.get("location"), /account_link_required/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM customers").get().n, before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM portal_identities").get().n, 0);
});
test("a brand-new email still self-registers when an unrelated password login already exists", async (t) => {
  const { env, db } = baseFixture(configuration);
  // An unrelated password-login account must not make portal_passwords non-empty enough to trip
  // a guard that forgets to compare the actual email (e.g. one keyed only on "some row exists").
  const passwordCustomerId = "cust_pw_other";
  db.prepare("INSERT INTO customers (id, name, email, created_at, updated_at) VALUES (?, 'Personal account', '', ?, ?)").run(passwordCustomerId, NOW, NOW);
  db.prepare("INSERT INTO portal_passwords (customer_id, email_lower, password_hash, created_at, updated_at) VALUES (?, 'alice@example.com', 'x', ?, ?)").run(passwordCustomerId, NOW, NOW);
  const before = db.prepare("SELECT count(*) AS n FROM customers").get().n;
  githubStub(t, { email: "brandnew@example.com", id: 4242 });
  const response = await finish(env, await start(env));
  assert.equal(response.headers.get("location"), "https://portal.test/#/apps");
  assert.equal(db.prepare("SELECT count(*) AS n FROM customers").get().n, before + 1);
  assert.equal(db.prepare("SELECT email FROM portal_identities").get().email, "brandnew@example.com");
});
test("Linking requires the initiating session at callback and rejects revoked sessions", async (t) => {
  const { env, db } = baseFixture(configuration);
  db.exec("PRAGMA foreign_keys = ON");
  const calls = githubStub(t);
  const cookieA = await cookieFor(env, "A");
  const flow = await start(env, "github", cookieA);
  await call(env, "POST", "/portal/v1/auth/logout", { cookie: cookieA });
  assert.match((await finish(env, flow)).headers.get("location"), /link_failed/);
  assert.equal(calls.length, 0);
  await start(env, "github", await cookieFor(env, "A"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM portal_oauth_states").get().n, 1);
  db.prepare("UPDATE portal_sessions SET status = 'revoked'").run();
  db.prepare("DELETE FROM portal_sessions WHERE status = 'revoked'").run();
  assert.equal(db.prepare("SELECT count(*) AS n FROM portal_oauth_states").get().n, 0);
});
test("Unverified GitHub email never creates customers", async (t) => {
  const { env, db } = baseFixture(configuration);
  githubStub(t, { verified: false });
  assert.match((await finish(env, await start(env))).headers.get("location"), /sign_in_failed/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM customers").get().n, 2);
});
test("Provider failure is sanitized and OAuth starts are rate limited", async (t) => {
  const { env, db } = baseFixture(configuration);
  githubStub(t, { failure: true });
  const failed = await finish(env, await start(env));
  assert.match(failed.headers.get("location"), /sign_in_failed/);
  assert.equal(failed.headers.get("cache-control"), "no-store");
  assert.equal(db.prepare("SELECT count(*) AS n FROM portal_oauth_states").get().n, 0);
  for (let i = 1; i < 30; i++) await start(env);
  const limited = await call(env, "POST", "/portal/v1/auth/github/start");
  assert.match(limited.res.headers.get("location"), /rate_limited/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM customers").get().n, 2);
});
test("Google validates signature, issuer, audience, nonce, expiry and verified email", async (t) => {
  const { env, db } = baseFixture(configuration);
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256" };
  let claims = {};
  let badSignature = false;
  const wrongKey = await generateKeyPair("RS256");
  let activeFlow;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
    assert.equal(url, "https://oauth2.googleapis.com/token");
    const jwt = await new SignJWT({ nonce: activeFlow.url.searchParams.get("nonce"), email: "google@example.com", email_verified: true, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setSubject("google-subject").setIssuer(claims.iss ?? "https://accounts.google.com")
      .setAudience(claims.aud ?? "google-client").setIssuedAt(NOW).setExpirationTime(claims.exp ?? NOW + 300).sign(badSignature ? wrongKey.privateKey : privateKey);
    return Response.json({ id_token: jwt });
  });
  for (const invalid of [{ nonce: "wrong" }, { email_verified: false }, { aud: "other-client" }, { iss: "https://evil.test" }, { exp: NOW - 10 }]) {
    claims = invalid; activeFlow = await start(env, "google");
    assert.match((await finish(env, activeFlow, "google")).headers.get("location"), /sign_in_failed/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM portal_identities").get().n, 0);
  }
  claims = {}; badSignature = true; activeFlow = await start(env, "google");
  assert.match((await finish(env, activeFlow, "google")).headers.get("location"), /sign_in_failed/);
  badSignature = false; activeFlow = await start(env, "google");
  assert.equal((await finish(env, activeFlow, "google")).headers.get("location"), "https://portal.test/#/apps");
  assert.equal(db.prepare("SELECT subject FROM portal_identities").get().subject, "google-subject");
});
test("A suspended customer signing in through a previously linked provider is told so, without a session", async (t) => {
  const { env, db } = baseFixture(configuration);
  githubStub(t);
  await finish(env, await start(env));
  db.prepare("UPDATE customers SET status = 'disabled' WHERE email = 'new@example.com'").run();
  const sessions = () => db.prepare("SELECT count(*) AS n FROM portal_sessions").get().n;
  const before = sessions();
  const suspended = await finish(env, await start(env));
  assert.equal(suspended.status, 303);
  assert.equal(suspended.headers.get("location"), "https://portal.test/?auth_error=account_suspended#/account");
  assert.deepEqual(suspended.headers.getSetCookie().map((value) => value.split(";")[0]), ["__Host-lccp_oauth="]);
  assert.equal(sessions(), before);
  const { subject } = db.prepare("SELECT subject FROM portal_identities").get();
  await assert.rejects(identityCustomer(env, { provider: "github", subject, email: "new@example.com", name: "Customer" }, null, NOW), { message: "account_suspended" });
});

test("Concurrent registration cannot leave an orphan customer or duplicate provider identity", async () => {
  const { env, db } = baseFixture(configuration);
  const outcomes = await Promise.allSettled([
    identityCustomer(env, { provider: "github", subject: "456", email: "first@example.com", name: "First" }, null, NOW),
    identityCustomer(env, { provider: "github", subject: "456", email: "second@example.com", name: "Second" }, null, NOW),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM customers").get().n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM portal_identities").get().n, 1);
  const same = await identityCustomer(env, { provider: "github", subject: "456", email: "changed@example.com", name: "Changed" }, null, NOW);
  assert.equal(same, db.prepare("SELECT customer_id FROM portal_identities").get().customer_id);
});

// ---- POST /portal/v1/auth/identities/unlink ------------------------------------------------------
// A provider may be disconnected only while another sign-in method is usable NOW: a password while
// password sign-in is enabled, another identity whose provider is configured, or a contact email
// while email codes can be delivered. Anything else is the customer's last way in.

const UNLINK = "/portal/v1/auth/identities/unlink";
const EMAIL_DELIVERY = { PORTAL_EMAIL_API_KEY: "test-only", PORTAL_EMAIL_FROM: "sender@example.com" };
const GOOGLE_ONLY = { PORTAL_GOOGLE_CLIENT_ID: "google-client", PORTAL_GOOGLE_CLIENT_SECRET: "google-secret" };

function linkIdentity(db, customerId, provider) {
  db.prepare("INSERT INTO portal_identities (provider, subject, customer_id, email, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(provider, `${provider}-${customerId}`, customerId, `${provider}-${customerId.toLowerCase()}@example.com`, NOW);
}
function linkedProviders(db, customerId) {
  return db.prepare("SELECT provider FROM portal_identities WHERE customer_id = ? ORDER BY provider").all(customerId).map((row) => row.provider);
}
function setPassword(db, customerId) {
  db.prepare("INSERT INTO portal_passwords (customer_id, email_lower, password_hash, created_at, updated_at) VALUES (?, ?, 'x', ?, ?)")
    .run(customerId, `login-${customerId.toLowerCase()}@example.com`, NOW, NOW);
}
function clearContactEmail(db, customerId) {
  db.prepare("UPDATE customers SET email = '' WHERE id = ?").run(customerId);
}
function setMalformedContactEmail(db, customerId) {
  // Raw SQL only: every writer of customers.email validates the address. The unlink rule still
  // refuses to count such an address, because requestOtp's own validation would never send a code here.
  db.prepare("UPDATE customers SET email = 'not-an-email' WHERE id = ?").run(customerId);
}
async function sessionFor(env, customerId, authMethod) {
  const minted = await mintSession(env, { customerId, authMethod, now: NOW });
  assert.equal(minted.ok, true);
  return `lccp_session=${minted.raw}`;
}
const unlink = (env, cookie, provider = "google", headers) => call(env, "POST", UNLINK, { cookie, body: { provider }, headers });
const signedIn = async (env, cookie) => (await call(env, "GET", "/api/portal/me", { cookie })).status === 200;
// Holds each D1 batch until `count` requests have reached one, so every request passes its pre-checks
// before any conditional DELETE runs; the batches then run one at a time, as D1 serializes them.
function holdBatches(env, count) {
  const batch = env.DB.batch.bind(env.DB);
  let arrived = 0;
  let release;
  const everyone = new Promise((resolve) => { release = resolve; });
  env.DB.batch = async (statements) => {
    arrived += 1;
    if (arrived === count) release();
    await within(everyone, 2000);
    return batch(statements);
  };
}

test("Unlink succeeds via a password while password sign-in is enabled, even for a provider no longer configured", async () => {
  // No provider is configured and email delivery is off, so only the password remains usable.
  const { env, db } = baseFixture({ PORTAL_PASSWORD_ENABLED: "1" });
  linkIdentity(db, "A", "google");
  setPassword(db, "A");
  const result = await unlink(env, await sessionFor(env, "A", "oauth"));
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.code, "identity_unlinked");
  assert.deepEqual(result.body.data, { provider: "google" });
  assert.equal(result.res.headers.get("cache-control"), "no-store");
  assert.deepEqual(linkedProviders(db, "A"), []);
});

test("Unlink succeeds via another identity whose provider is configured", async () => {
  const { env, db } = baseFixture(configuration);
  linkIdentity(db, "A", "google");
  linkIdentity(db, "A", "github");
  const cookie = await sessionFor(env, "A", "oauth");
  const result = await unlink(env, cookie, "github");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { provider: "github" });
  assert.deepEqual(linkedProviders(db, "A"), ["google"]);
  const listed = await call(env, "GET", "/portal/v1/auth/identities", { cookie });
  assert.deepEqual(listed.body.data.items.map((item) => item.provider), ["google"]);
});

test("Unlink succeeds via a contact email while email codes are configured", async () => {
  const { env, db } = baseFixture(EMAIL_DELIVERY);
  linkIdentity(db, "A", "github");
  const result = await unlink(env, await sessionFor(env, "A", "oauth"), "github");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, { provider: "github" });
  assert.deepEqual(linkedProviders(db, "A"), []);
});

test("Unlink is refused as the last sign-in method when no other method is usable now, and changes nothing", async () => {
  const cases = [
    ["a password while password sign-in is disabled", { ...configuration, PORTAL_PASSWORD_ENABLED: "0" }, (db) => { clearContactEmail(db, "A"); setPassword(db, "A"); }],
    ["another identity whose provider is not configured", GOOGLE_ONLY, (db) => { clearContactEmail(db, "A"); linkIdentity(db, "A", "github"); }],
    ["a contact email while email delivery is not configured", configuration, () => {}],
    ["email delivery without a contact email", { ...configuration, ...EMAIL_DELIVERY }, (db) => clearContactEmail(db, "A")],
    ["no other method at all", { ...configuration, ...EMAIL_DELIVERY, PORTAL_PASSWORD_ENABLED: "1" }, (db) => clearContactEmail(db, "A")],
    // Email codes also need the OTP peppers: without them requestOtp answers config_error.
    ["email delivery without OTP peppers", { ...configuration, ...EMAIL_DELIVERY, PORTAL_OTP_PEPPERS: undefined }, () => {}],
    // A malformed contact address (no "@") can never receive a code; it must not count as a
    // usable sign-in method even though it is non-empty.
    ["a malformed contact email even with email delivery configured", { ...configuration, ...EMAIL_DELIVERY }, (db) => setMalformedContactEmail(db, "A")],
  ];
  for (const [name, extraEnv, seed] of cases) {
    const { env, db } = baseFixture(extraEnv);
    linkIdentity(db, "A", "google");
    seed(db);
    const before = linkedProviders(db, "A");
    const current = await sessionFor(env, "A", "oauth");
    const other = await sessionFor(env, "A", "oauth");
    const refused = await unlink(env, current);
    assert.equal(refused.status, 409, name);
    assert.equal(refused.body.code, "last_sign_in_method", name);
    assert.equal(refused.body.data, undefined, name);
    assert.equal(refused.res.headers.get("cache-control"), "no-store", name);
    assert.deepEqual(linkedProviders(db, "A"), before, `${name}: nothing is unlinked`);
    assert.ok(await signedIn(env, current), `${name}: the current session is kept`);
    assert.ok(await signedIn(env, other), `${name}: a refused unlink revokes no session`);
  }
});

test("A successful unlink revokes the customer's other OAuth sessions and keeps the current one; other sessions are untouched", async () => {
  const { env, db } = baseFixture(configuration);
  linkIdentity(db, "A", "google");
  linkIdentity(db, "A", "github");
  const current = await sessionFor(env, "A", "oauth");
  const otherOauth = [await sessionFor(env, "A", "oauth"), await sessionFor(env, "A", "oauth")];
  const untouched = {
    password: await sessionFor(env, "A", "password"),
    otp: await sessionFor(env, "A", "otp"),
    "another customer's OAuth": await sessionFor(env, "B", "oauth"),
  };
  assert.equal((await unlink(env, current, "github")).status, 200);
  assert.ok(await signedIn(env, current), "the current session is kept");
  for (const cookie of otherOauth) assert.equal(await signedIn(env, cookie), false, "another OAuth session is revoked");
  for (const [name, cookie] of Object.entries(untouched)) assert.ok(await signedIn(env, cookie), `the ${name} session is untouched`);
  assert.equal(db.prepare("SELECT count(*) AS n FROM portal_sessions WHERE status = 'revoked'").get().n, otherOauth.length);

  // From a password session, every OAuth session is another session.
  const second = baseFixture({ PORTAL_PASSWORD_ENABLED: "1" });
  linkIdentity(second.db, "A", "google");
  setPassword(second.db, "A");
  const viaPassword = await sessionFor(second.env, "A", "password");
  const oauth = await sessionFor(second.env, "A", "oauth");
  assert.equal((await unlink(second.env, viaPassword)).status, 200);
  assert.ok(await signedIn(second.env, viaPassword));
  assert.equal(await signedIn(second.env, oauth), false);
});

test("Unlinking Google and then GitHub refuses the second as the last sign-in method", async () => {
  const { env, db } = baseFixture(configuration);
  clearContactEmail(db, "A");
  linkIdentity(db, "A", "google");
  linkIdentity(db, "A", "github");
  const cookie = await sessionFor(env, "A", "oauth");
  assert.equal((await unlink(env, cookie, "google")).status, 200);
  const second = await unlink(env, cookie, "github");
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "last_sign_in_method");
  assert.deepEqual(linkedProviders(db, "A"), ["github"]);
  assert.ok(await signedIn(env, cookie));
});

test("Concurrent unlinks of Google and GitHub cannot both succeed", async () => {
  const { env, db } = baseFixture(configuration);
  clearContactEmail(db, "A");
  linkIdentity(db, "A", "google");
  linkIdentity(db, "A", "github");
  // Neither session signed in with a provider, so the winner's revocation cannot decide the race;
  // only the conditional DELETE's remaining-method rule can.
  const tabs = [await sessionFor(env, "A", "otp"), await sessionFor(env, "A", "password")];
  holdBatches(env, 2);
  const results = await Promise.all([unlink(env, tabs[0], "google"), unlink(env, tabs[1], "github")]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(results.find((result) => result.status === 409).body.code, "last_sign_in_method");
  assert.equal(linkedProviders(db, "A").length, 1, "one sign-in method always remains");
  for (const cookie of tabs) assert.ok(await signedIn(env, cookie), "neither session is an OAuth session to revoke");
});

test("A concurrent unlink cannot complete on an OAuth session that another unlink just revoked", async () => {
  // A password remains, so each unlink alone would be allowed.
  const { env, db } = baseFixture({ ...configuration, PORTAL_PASSWORD_ENABLED: "1" });
  clearContactEmail(db, "A");
  setPassword(db, "A");
  linkIdentity(db, "A", "google");
  linkIdentity(db, "A", "github");
  const providers = ["google", "github"];
  const tabs = [await sessionFor(env, "A", "oauth"), await sessionFor(env, "A", "oauth")];
  holdBatches(env, 2);
  const results = await Promise.all(tabs.map((cookie, index) => unlink(env, cookie, providers[index])));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 401]);
  const winner = results.findIndex((result) => result.status === 200);
  assert.equal(results[1 - winner].body.code, "unauthorized");
  assert.deepEqual(linkedProviders(db, "A"), [providers[1 - winner]], "the revoked tab disconnects nothing");
  assert.ok(await signedIn(env, tabs[winner]), "the successful unlink keeps its own session");
  assert.equal(await signedIn(env, tabs[1 - winner]), false);
});

test("Concurrent unlinks of the same provider: the loser gets 404 and revokes nothing, so the winner keeps its session", async () => {
  const { env, db } = baseFixture(configuration);
  linkIdentity(db, "A", "google");
  linkIdentity(db, "A", "github");
  const tabs = [await sessionFor(env, "A", "oauth"), await sessionFor(env, "A", "oauth")];
  holdBatches(env, 2);
  const results = await Promise.all(tabs.map((cookie) => unlink(env, cookie, "google")));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 404]);
  const winner = results.findIndex((result) => result.status === 200);
  assert.equal(results[1 - winner].body.code, "not_found", "the provider is already disconnected, not the last method");
  assert.deepEqual(linkedProviders(db, "A"), ["github"]);
  assert.ok(await signedIn(env, tabs[winner]), "the successful unlink keeps its own session");
  assert.equal(await signedIn(env, tabs[1 - winner]), false, "the successful unlink revokes the other OAuth session");
});

test("Unlink requires a same-site request, a session, a known provider and this customer's own identity", async () => {
  const { env, db } = baseFixture(configuration);
  linkIdentity(db, "A", "google");
  linkIdentity(db, "A", "github");
  linkIdentity(db, "B", "github");
  const cookieA = await sessionFor(env, "A", "oauth");
  const expectCode = (result, status, code) => {
    assert.equal(result.status, status, code);
    assert.equal(result.body.code, code);
  };
  // Cross-site is refused before the session is looked at.
  expectCode(await unlink(env, undefined, "google", { "sec-fetch-site": "cross-site" }), 403, "cross_site_forbidden");
  expectCode(await unlink(env, cookieA, "google", { "sec-fetch-site": "same-site" }), 403, "cross_site_forbidden");
  expectCode(await unlink(env, undefined, "google"), 401, "unauthorized");
  const signedOut = await sessionFor(env, "A", "oauth");
  await call(env, "POST", "/portal/v1/auth/logout", { cookie: signedOut });
  expectCode(await unlink(env, signedOut, "google"), 401, "unauthorized");
  for (const body of [{}, { provider: "" }, { provider: "GitHub" }, { provider: "gitlab" }, { provider: ["google"] }]) {
    expectCode(await call(env, "POST", UNLINK, { cookie: cookieA, body }), 400, "invalid_request");
  }
  const malformed = await worker.fetch(new Request(`https://portal.test${UNLINK}`, { method: "POST", headers: { ...sameSiteHeaders(), cookie: cookieA }, body: "{" }), env, CTX);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "invalid_json");
  // Another customer's identity is the same 404 as one that does not exist.
  db.prepare("DELETE FROM portal_identities WHERE customer_id = 'A' AND provider = 'github'").run();
  expectCode(await unlink(env, cookieA, "github"), 404, "not_found");
  assert.deepEqual(linkedProviders(db, "B"), ["github"]);
  assert.deepEqual(linkedProviders(db, "A"), ["google"]);
  assert.ok(await signedIn(env, cookieA));
});

export const DIRECT_ROUTE_TESTS = ["GET /portal/v1/auth/providers", "POST /portal/v1/auth/google/start", "POST /portal/v1/auth/github/start", "GET /portal/v1/auth/google/callback", "GET /portal/v1/auth/github/callback", "GET /portal/v1/auth/identities", "POST /portal/v1/auth/identities/unlink"];
