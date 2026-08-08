import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT } from "jose";
import {
  NEXT_JSON_KEYS,
  MockD1,
  accessAuthed,
  accessEnv,
  accessFixture,
  accessToken,
  adminInternalsForTests,
  authed,
  baseEnv,
  clone,
  effectiveLicenseMode,
  entitlementDefaults,
  fingerprint,
  json,
  keyOf,
  rotatableAccessFixture,
  syncAuthed,
  syncEnv,
  worker,
} from "./fixtures.mjs";
test("dev bearer cannot be enabled in production", async () => {
  const env = baseEnv();
  env.ENVIRONMENT = "production";
  const response = await worker.fetch(authed("/api/admin/summary"), env);
  assert.equal(response.status, 500);
  assert.equal((await json(response)).code, "dev_bearer_forbidden_in_environment");
});

test("dev bearer is accepted only in development", async () => {
  const env = baseEnv();
  env.ENVIRONMENT = "staging";
  const response = await worker.fetch(authed("/api/admin/summary"), env);
  assert.equal(response.status, 500);
  assert.equal((await json(response)).code, "dev_bearer_forbidden_in_environment");
});

test("admin worker rejects oversized JSON bodies without relying on Content-Length", async () => {
  const response = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: "x".repeat(8193),
  }), baseEnv());
  assert.equal(response.status, 413);
  assert.equal((await json(response)).code, "body_too_large");
});


test("cloudflare access jwt rejects invalid audience", async (t) => {
  const fixture = await accessFixture(t);
  const token = await accessToken(fixture, "admin@example.com", { audience: "wrong-audience" });
  const response = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 403);
  assert.equal((await json(response)).code, "invalid_access_jwt");
});

test("cloudflare access jwt rejects expired token", async (t) => {
  const fixture = await accessFixture(t);
  const token = await accessToken(fixture, "admin@example.com", { expired: true });
  const response = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 403);
  assert.equal((await json(response)).code, "invalid_access_jwt");
});

test("cloudflare access jwt rejects unknown role", async (t) => {
  const fixture = await accessFixture(t);
  const token = await accessToken(fixture, "unknown@example.com");
  const response = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 403);
  assert.equal((await json(response)).code, "admin_role_denied");
});

test("cloudflare access jwt rejects malformed token", async (t) => {
  const fixture = await accessFixture(t);
  const response = await worker.fetch(accessAuthed("/api/admin/summary", "not-a-jwt"), accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 403);
  assert.equal((await json(response)).code, "invalid_access_jwt");
});

test("cloudflare access identity header without jwt is rejected", async (t) => {
  const fixture = await accessFixture(t);
  const request = new Request("https://admin.example/api/admin/summary", {
    headers: { "cf-access-authenticated-user-email": "admin@example.com" },
  });
  const response = await worker.fetch(request, accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 401);
  assert.equal((await json(response)).code, "missing_access_jwt");
});


test("access auth fails closed for a token signed with an unknown kid", async (t) => {
  const fixture = await rotatableAccessFixture(t);
  const token = await new SignJWT({ email: "admin@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "never-published" })
    .setIssuer(fixture.issuer)
    .setAudience(fixture.audience)
    .setSubject("admin@example.com")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(fixture.privateKey);
  const response = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 403);
  assert.equal((await json(response)).code, "invalid_access_jwt");
  // jose fetches the JWKS once, cannot match the kid, then the cooldown blocks a refetch -> fail closed.
  assert.equal(fixture.state.requests, 1);
});

test("access auth reuses the cached JWKS across repeated valid tokens", async (t) => {
  const fixture = await rotatableAccessFixture(t);
  const token = await accessToken(fixture, "admin@example.com");
  const first = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(first.status, 200);
  const afterFirst = fixture.state.requests;
  const second = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(second.status, 200);
  assert.equal(fixture.state.requests, afterFirst); // served from the memoized key set, no second fetch
});

// ── Stage 3: policy validators (hermetic unit — no DB) ───────────────────────
