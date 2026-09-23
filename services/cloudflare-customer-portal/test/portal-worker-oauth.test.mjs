import { test } from "node:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { assert, worker, baseFixture, call, cookieFor, NOW, CTX } from "./portal-worker-fixtures.mjs";
import { identityCustomer } from "../dist-worker/worker/oauth/accounts.js";

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
  assert.deepEqual((await call(env, "GET", "/portal/v1/auth/providers")).body.data, { google: false, github: false, email: false, password: false });
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
test("Disabled customer cannot sign in through a previously linked provider", async (t) => {
  const { env, db } = baseFixture(configuration);
  githubStub(t);
  await finish(env, await start(env));
  db.prepare("UPDATE customers SET status = 'disabled' WHERE email = 'new@example.com'").run();
  assert.match((await finish(env, await start(env))).headers.get("location"), /sign_in_failed/);
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

export const DIRECT_ROUTE_TESTS = ["GET /portal/v1/auth/providers", "POST /portal/v1/auth/google/start", "POST /portal/v1/auth/github/start", "GET /portal/v1/auth/google/callback", "GET /portal/v1/auth/github/callback", "GET /portal/v1/auth/identities"];
