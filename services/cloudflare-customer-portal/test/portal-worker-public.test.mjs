import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assert, worker, mintSession, codeFromSecretBytes, requestOtp, redeemOtp, policyCapacityViolation, FP_A, FP_B, installBackendStub, cookieFor, sameSiteHeaders, entitlementId, ownedEntitlementId, call, baseFixture, seedDevice, seedEntitlement, CTX, NOW } from "./portal-worker-fixtures.mjs";
import { sendEmail } from "../src/auth/portal_email.mjs";
import { openApiDocument } from "../dist-worker/worker/openapi/document.js";

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

const INVALID_DESTINATIONS = Object.freeze([
  ["scheme typo", "https:/backend.test"],
  ["plaintext HTTP", "http://backend.test"],
  ["malformed URL", "https://"],
  ["userinfo injection", "https://attacker:password@backend.test"],
  ["path/query/fragment injection", "https://backend.test/health?next=https://attacker.test#fragment"],
]);

async function settlesWithin(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), milliseconds); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function documentedErrorCodes(path, status) {
  const response = openApiDocument.paths[path]?.post?.responses?.[String(status)];
  const code = response?.content?.["application/json"]?.schema?.properties?.code;
  if (typeof code?.const === "string") return [code.const];
  if (Array.isArray(code?.enum) && code.enum.every((value) => typeof value === "string")) return code.enum;
  throw new Error(`${path} ${status} does not declare an exact error-code schema`);
}

function assertRuntimeErrorIsDocumented(path, response) {
  assert.equal(response.body.ok, false, `${path} error envelope must set ok:false`);
  assert.ok(
    documentedErrorCodes(path, response.status).includes(response.body.code),
    `${path} ${response.status} runtime code ${response.body.code} must be documented`,
  );
}

async function checkoutFailure(extraEnv, fetchStub) {
  const { db, env } = baseFixture(extraEnv);
  try {
    const cookie = await cookieFor(env, "A");
    const id = await ownedEntitlementId(env, cookie);
    const run = () => call(env, "POST", "/api/portal/checkout", {
      cookie,
      body: { entitlement_id: id, client_instance_id: "i1", nonce: "e".repeat(64) },
    });
    return fetchStub === undefined ? await run() : await withFetchStub(fetchStub, run);
  } finally {
    db.close();
  }
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

test("/health rejects invalid backend destinations before any outbound request", async () => {
  for (const [label, backendOrigin] of INVALID_DESTINATIONS) {
    const { db, env } = baseFixture({ BACKEND_ORIGIN: backendOrigin });
    const calls = [];
    try {
      const response = await withFetchStub(async (url, init = {}) => {
        calls.push({ url: String(url), authorization: new Headers(init.headers ?? {}).get("authorization") });
        return backendHealth({ accountTokenMode: "required" });
      }, () => call(env, "GET", "/health", {}));
      assert.equal(response.status, 503, `${label} fails closed`);
      assert.equal(response.body.code, "account_token_mode_not_required");
      assert.deepEqual(calls, [], `${label} never makes an outbound request`);
    } finally {
      db.close();
    }
  }
});

test("invalid backend destinations stop checkout before account-token minting or bearer proxying", async () => {
  for (const [label, backendOrigin] of INVALID_DESTINATIONS) {
    const { db, env } = baseFixture({ BACKEND_ORIGIN: backendOrigin });
    const calls = [];
    try {
      const cookie = await cookieFor(env, "A");
      const id = await ownedEntitlementId(env, cookie);
      const response = await withFetchStub(async (url, init = {}) => {
        calls.push({ url: String(url), authorization: new Headers(init.headers ?? {}).get("authorization") });
        return backendHealth({ accountTokenMode: "required" });
      }, () => call(env, "POST", "/api/portal/checkout", {
        cookie,
        body: { entitlement_id: id, client_instance_id: "i1", nonce: "e".repeat(64) },
      }));
      assert.equal(response.status, 503, `${label} fails before the backend proxy`);
      assert.equal(response.body.code, "backend_unconfigured");
      assert.deepEqual(calls, [], `${label} never receives a bearer request`);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM account_tokens WHERE customer_id = 'A'").get().n,
        0,
        `${label} does not mint an account token for an invalid destination`,
      );
    } finally {
      db.close();
    }
  }
});

test("invalid email destinations fail before a provider fetch or API-key header", async () => {
  for (const [label, emailOrigin] of INVALID_DESTINATIONS) {
    const calls = [];
    const response = await withFetchStub(async (url, init = {}) => {
      calls.push({ url: String(url), authorization: new Headers(init.headers ?? {}).get("authorization") });
      return new Response("{}", { status: 202 });
    }, () => sendEmail({
      PORTAL_EMAIL_API_KEY: "test-key",
      PORTAL_EMAIL_FROM: "portal@example.test",
      PORTAL_EMAIL_API_BASE: emailOrigin,
    }, "customer@example.test", "Subject", "Body"));
    assert.deepEqual(response, { ok: false, code: "email_send_failed" }, `${label} is rejected`);
    assert.deepEqual(calls, [], `${label} cannot receive the email API key`);
  }
});

test("a canonical HTTPS email destination keeps the compatible email flow", async () => {
  const calls = [];
  const response = await withFetchStub(async (url, init = {}) => {
    calls.push({ url: String(url), authorization: new Headers(init.headers ?? {}).get("authorization") });
    return new Response("{}", { status: 202 });
  }, () => sendEmail({
    PORTAL_EMAIL_API_KEY: "test-key",
    PORTAL_EMAIL_FROM: "portal@example.test",
    PORTAL_EMAIL_API_BASE: "https://email.test/",
  }, "customer@example.test", "Subject", "Body"));
  assert.deepEqual(response, { ok: true, code: "sent" });
  assert.deepEqual(calls, [{ url: "https://email.test/emails", authorization: "Bearer test-key" }]);
});

test("/health bounds an oversized backend health body", async () => {
  const { db, env } = baseFixture();
  const payload = JSON.stringify({
    ok: true,
    service: "licensecc-online-verifier",
    account_token_mode: "required",
    padding: "x".repeat(8192),
  });
  try {
    const response = await withFetchStub(async () => new Response(payload, {
      status: 200,
      headers: { "content-type": "application/json" },
    }), () => call(env, "GET", "/health", {}));
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "account_token_mode_not_required");
  } finally {
    db.close();
  }
});

test("/health fails closed when the bounded backend body is not JSON", async () => {
  const { db, env } = baseFixture();
  try {
    const response = await withFetchStub(async () => new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }), () => call(env, "GET", "/health", {}));
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "account_token_mode_not_required");
  } finally {
    db.close();
  }
});

test("/health times out and cancels a stalled backend response stream", async () => {
  const { db, env } = baseFixture();
  let cancelled = false;
  const stalled = new ReadableStream({
    cancel() { cancelled = true; },
  });
  try {
    const response = await withFetchStub(
      async () => new Response(stalled, { status: 200, headers: { "content-type": "application/json" } }),
      () => settlesWithin(call(env, "GET", "/health", {}), 2_500),
    );
    assert.notEqual(response, null, "readiness must not wait indefinitely for a backend body");
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "account_token_mode_not_required");
    assert.equal(cancelled, true, "the stalled response reader is cancelled on timeout");
  } finally {
    db.close();
  }
});

test("/health cancels a non-200 backend stream before returning its existing 503 envelope", async () => {
  const { db, env } = baseFixture();
  let cancelled = false;
  const endless = new ReadableStream({
    cancel() { cancelled = true; },
  });
  try {
    const response = await withFetchStub(
      async () => new Response(endless, { status: 502, headers: { "content-type": "application/json" } }),
      () => settlesWithin(call(env, "GET", "/health", {}), 500),
    );
    assert.notEqual(response, null, "readiness must not wait for a non-200 backend body");
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "account_token_mode_not_required");
    assert.equal(cancelled, true, "the non-200 backend body is cancelled before readiness returns");
  } finally {
    db.close();
  }
});

test("runtime action and device-release error envelopes are declared by OpenAPI", async () => {
  const unconfigured = await checkoutFailure({ BACKEND_ORIGIN: "http://backend.test" });
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.code, "backend_unconfigured");
  assertRuntimeErrorIsDocumented("/api/portal/checkout", unconfigured);

  const configError = await checkoutFailure({ ACCOUNT_TOKEN_PEPPERS: "" });
  assert.equal(configError.status, 503);
  assert.equal(configError.body.code, "config_error");
  assertRuntimeErrorIsDocumented("/api/portal/checkout", configError);

  const unreachable = await checkoutFailure({}, async () => { throw new Error("backend unavailable"); });
  assert.equal(unreachable.status, 502);
  assert.equal(unreachable.body.code, "backend_unreachable");
  assertRuntimeErrorIsDocumented("/api/portal/checkout", unreachable);

  const invalidResponse = await checkoutFailure({}, async () => new Response("not-json", { status: 200 }));
  assert.equal(invalidResponse.status, 502);
  assert.equal(invalidResponse.body.code, "backend_invalid_response");
  assertRuntimeErrorIsDocumented("/api/portal/checkout", invalidResponse);

  const { db, env } = baseFixture();
  try {
    seedDevice(db, { fingerprint: FP_A, deviceKeyId: "dk_a" });
    env.DB.batch = undefined;
    const response = await call(env, "POST", "/api/portal/devices/release", {
      cookie: await cookieFor(env, "A"),
      body: { device_key_id: "dk_a" },
    });
    assert.equal(response.status, 500);
    assert.equal(response.body.code, "portal_error");
    assertRuntimeErrorIsDocumented("/api/portal/devices/release", response);
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
