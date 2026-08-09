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

const UNSAFE_MUTATION_METHODS = ["POST", "PATCH", "DELETE", "PUT"];

function accessRequest(path, token, options = {}) {
  const method = options.method ?? "GET";
  return new Request(options.url ?? `https://admin.example${path}`, {
    method,
    headers: {
      "cf-access-jwt-assertion": token,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function trackedD1() {
  const db = new MockD1();
  const prepare = db.prepare.bind(db);
  const batch = db.batch.bind(db);
  let prepareCalls = 0;
  let batchCalls = 0;
  db.prepare = (...args) => {
    prepareCalls += 1;
    return prepare(...args);
  };
  db.batch = async (...args) => {
    batchCalls += 1;
    return batch(...args);
  };
  return {
    db,
    get prepareCalls() {
      return prepareCalls;
    },
    get batchCalls() {
      return batchCalls;
    },
  };
}

async function assertMutationBlockedBeforeAuthOrPersistence(fixture, token, headers, options = {}) {
  const tracked = trackedD1();
  const response = await worker.fetch(accessRequest(options.path ?? "/api/admin/entitlements", token, {
    method: options.method ?? "POST",
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      ...headers,
    },
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), accessEnv(tracked.db, fixture));
  assert.equal(response.status, 403, options.label ?? "cross-site mutation is rejected");
  const responseBody = await json(response);
  assert.equal(responseBody.code, "cross_site_mutation_forbidden");
  assert.equal(typeof responseBody.request_id, "string");
  assert.equal(fixture.state.requests, 0, "provenance rejection happens before Access JWT verification");
  assert.equal(tracked.prepareCalls, 0, "provenance rejection reaches no database statement");
  assert.equal(tracked.batchCalls, 0, "provenance rejection reaches no database batch");
  assert.equal(tracked.db.entitlements.size, 0, "provenance rejection creates no entitlement");
  assert.equal(tracked.db.events.length, 0, "provenance rejection creates no audit event");
  assert.equal(tracked.db.idempotency.size, 0, "provenance rejection creates no replay entry");
}

async function assertMutationAccepted(request, env) {
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal((await json(response)).ok, true);
}

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

test("access-authenticated browser mutations fail closed before auth or persistence", async (t) => {
  const fixture = await rotatableAccessFixture(t);
  const token = await accessToken(fixture, "admin@example.com");
  for (const [label, headers] of [
    ["cross-site Origin", { origin: "https://evil.example" }],
    ["cross-site fetch metadata", { "sec-fetch-site": "cross-site" }],
    ["opaque Origin", { origin: "null" }],
    ["malformed Origin", { origin: "not-an-origin" }],
    ["trailing slash Origin", { origin: "https://admin.example/" }],
    ["non-origin URL Origin", { origin: "https://admin.example/path" }],
  ]) {
    await assertMutationBlockedBeforeAuthOrPersistence(fixture, token, headers, { label });
  }
  for (const [method, path] of [
    ["POST", "/api/admin/entitlements"],
    ["PATCH", "/api/admin/entitlements/not-a-real-id"],
  ]) {
    await assertMutationBlockedBeforeAuthOrPersistence(fixture, token, { origin: "https://evil.example" }, {
      method,
      path,
      label: `${method} is blocked through the matched-route guard`,
    });
  }
});

test("unsafe mutation method handling is centralized for current and future routes", async () => {
  const { ROUTE_DESCRIPTORS, isUnsafeMutationMethod } = await import("../../dist-worker/worker/dispatch.js");
  for (const method of UNSAFE_MUTATION_METHODS) {
    assert.equal(isUnsafeMutationMethod(method), true, `${method} must use mutation provenance checks`);
  }
  assert.equal(isUnsafeMutationMethod("GET"), false);
  assert.deepEqual(
    UNSAFE_MUTATION_METHODS.filter((method) => ROUTE_DESCRIPTORS.some((route) => route.method === method)),
    ["POST", "PATCH"],
    "the current admin route inventory exposes no PUT or DELETE mutations",
  );
});

test("same-origin browser JSON, canonical origins, and non-browser Access clients remain compatible", async (t) => {
  const fixture = await accessFixture(t);
  const token = await accessToken(fixture, "admin@example.com");
  const body = JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint });

  const browserDb = new MockD1();
  await assertMutationAccepted(accessRequest("/api/admin/entitlements", token, {
    method: "POST",
    headers: { origin: "https://admin.example", "sec-fetch-site": "same-origin" },
    body,
  }), accessEnv(browserDb, fixture));
  assert.equal(browserDb.entitlements.size, 1);

  const canonicalDb = new MockD1();
  await assertMutationAccepted(accessRequest("/api/admin/entitlements", token, {
    method: "POST",
    url: "HTTPS://ADMIN.EXAMPLE:443/api/admin/entitlements",
    headers: { origin: "HTTPS://ADMIN.EXAMPLE:443", "sec-fetch-site": "same-origin" },
    body,
  }), accessEnv(canonicalDb, fixture));
  assert.equal(canonicalDb.entitlements.size, 1);

  const apiClientDb = new MockD1();
  await assertMutationAccepted(accessRequest("/api/admin/entitlements", token, {
    method: "POST",
    body,
  }), accessEnv(apiClientDb, fixture));
  assert.equal(apiClientDb.entitlements.size, 1);
});

test("mutation provenance leaves GET and public metadata behavior unchanged", async (t) => {
  const meta = await worker.fetch(new Request("https://admin.example/openapi.json", {
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  }), baseEnv());
  assert.equal(meta.status, 200);

  const fixture = await accessFixture(t);
  const summary = await worker.fetch(accessRequest("/api/admin/summary", await accessToken(fixture, "admin@example.com"), {
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  }), accessEnv(new MockD1(), fixture));
  assert.equal(summary.status, 200);
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
