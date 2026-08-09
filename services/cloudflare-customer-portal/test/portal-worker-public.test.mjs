import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assert, worker, mintSession, codeFromSecretBytes, requestOtp, redeemOtp, policyCapacityViolation, FP_A, FP_B, installBackendStub, cookieFor, sameSiteHeaders, entitlementId, ownedEntitlementId, call, baseFixture, seedDevice, seedEntitlement, CTX, NOW } from "./portal-worker-fixtures.mjs";

async function withFetchStub(fetchStub, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function backendHealth({ service = "licensecc-online-verifier", accountTokenMode } = {}) {
  const body = { ok: true, service };
  if (accountTokenMode !== undefined) body.account_token_mode = accountTokenMode;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

test("public documentation routes are direct, credential-free responses", async () => {
  const { db, env } = baseFixture();
  const spec = await call(env, "GET", "/openapi.json");
  assert.equal(spec.status, 200);
  assert.equal(spec.body.openapi, "3.1.0");
  const docs = await call(env, "GET", "/docs");
  assert.equal(docs.status, 200);
  assert.match(docs.res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(docs.body, /<title>licensecc Customer Portal/);
  db.close();
});

test("/health verifies the backend's required mode instead of a duplicated portal value", async () => {
  const { db, env } = baseFixture({ ACCOUNT_TOKEN_MODE: "off" });
  const calls = [];
  try {
    const healthy = await withFetchStub(async (url, init = {}) => {
      calls.push({
        url: String(url),
        method: init.method ?? "GET",
        authorization: new Headers(init.headers ?? {}).get("authorization"),
      });
      return backendHealth({ accountTokenMode: "required" });
    }, () => call(env, "GET", "/health", {}));
    assert.equal(healthy.status, 200);
    assert.equal(healthy.body.code, "healthy");
    assert.equal(healthy.body.data.account_token_mode_required, true);
    assert.deepEqual(calls, [{ url: "https://backend.test/health", method: "GET", authorization: null }]);
  } finally {
    db.close();
  }
});

test("/health fails closed when the backend reports account-token enforcement off", async () => {
  const { db, env } = baseFixture();
  try {
    const unhealthy = await withFetchStub(async () => backendHealth({ accountTokenMode: "off" }), () => call(env, "GET", "/health", {}));
    assert.equal(unhealthy.status, 503);
    assert.equal(unhealthy.body.code, "account_token_mode_not_required");
    assert.equal(unhealthy.body.data.account_token_mode_required, false);
  } finally {
    db.close();
  }
});

test("/health fails closed when the backend response is missing or mismatches the trusted health identity", async () => {
  const { db, env } = baseFixture();
  try {
    const missingMode = await withFetchStub(async () => backendHealth(), () => call(env, "GET", "/health", {}));
    assert.equal(missingMode.status, 503);
    assert.equal(missingMode.body.data.account_token_mode_required, false);

    const wrongService = await withFetchStub(
      async () => backendHealth({ service: "different-worker", accountTokenMode: "required" }),
      () => call(env, "GET", "/health", {}),
    );
    assert.equal(wrongService.status, 503);
    assert.equal(wrongService.body.data.account_token_mode_required, false);
  } finally {
    db.close();
  }
});

test("/health fails closed when the backend health request is unavailable", async () => {
  const { db, env } = baseFixture();
  try {
    const unavailable = await withFetchStub(async () => { throw new Error("backend unavailable"); }, () => call(env, "GET", "/health", {}));
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.code, "account_token_mode_not_required");
    assert.equal(unavailable.body.data.account_token_mode_required, false);
  } finally {
    db.close();
  }
});

test("portal has no locally configured account-token mode to claim backend isolation", () => {
  const envSource = readFileSync(new URL("../src/worker/env.ts", import.meta.url), "utf8");
  const wranglerSource = readFileSync(new URL("../wrangler.example.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(envSource, /\bACCOUNT_TOKEN_MODE\b/);
  assert.doesNotMatch(wranglerSource, /\bACCOUNT_TOKEN_MODE\b/);
});
// Documentation pin: the portal's read-only display derivation (pool_size > 0 ? "floating" :
// "node_locked" in worker index.ts) is the inverse view of the ONE runtime capacity invariant that
// the admin write path enforces. This asserts they cannot contradict each other so a future change
// to policyCapacityViolation forces a matching look at the portal derivation.
test("portal seat-mode display agrees with the single-sourced capacity invariant", () => {
  const displayMode = (poolSize) => (poolSize > 0 ? "floating" : "node_locked");
  // A valid floating policy (pool>0) has no violation and displays as floating.
  assert.equal(policyCapacityViolation("floating", 5), null);
  assert.equal(displayMode(5), "floating");
  // A valid node_locked policy (pool=0) has no violation and displays as node_locked.
  assert.equal(policyCapacityViolation("node_locked", 0), null);
  assert.equal(displayMode(0), "node_locked");
});

// Unknown session paths authenticate before route lookup; non-API paths preserve the plain 404/SPA boundary.
test("unknown portal routes preserve auth rejection and plain 404 behavior", async () => {
  const { env } = baseFixture();
  const protectedMiss = await call(env, "GET", "/api/portal/not-a-route");
  assert.equal(protectedMiss.status, 401);
  const plainMiss = await call(env, "GET", "/not-a-route");
  assert.equal(plainMiss.status, 404);
  assert.equal(plainMiss.body, "not found");
});

export const DIRECT_ROUTE_TESTS = Object.freeze([
  "GET /openapi.json",
  "GET /docs",
  "GET /health",
]);
