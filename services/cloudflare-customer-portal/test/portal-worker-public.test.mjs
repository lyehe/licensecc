import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assert, call, baseFixture } from "./portal-worker-fixtures.mjs";
import { sendEmail, _internals as portalEmailInternals } from "../src/auth/portal_email.mjs";

async function withFetchStub(fetchStub, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function backendHealth({ service = "licensecc-online-verifier", ok = true, protectedDeviceReady, status = 200 } = {}) {
  const body = { ok, service };
  if (protectedDeviceReady !== undefined) body.protected_device_ready = protectedDeviceReady;
  return new Response(JSON.stringify(body), {
    status,
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

const REDIRECT_STATUSES = Object.freeze([301, 302, 307, 308]);

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

test("/health verifies the backend's protected readiness instead of a local portal value", async () => {
  const { db, env } = baseFixture();
  const calls = [];
  try {
    const healthy = await withFetchStub(async (url, init = {}) => {
      calls.push({
        url: String(url),
        method: init.method ?? "GET",
        authorization: new Headers(init.headers ?? {}).get("authorization"),
        redirect: init.redirect,
      });
      return backendHealth({ protectedDeviceReady: true });
    }, () => call(env, "GET", "/health", {}));
    assert.equal(healthy.status, 200);
    assert.equal(healthy.body.code, "healthy");
    assert.equal(healthy.body.data.backend_protected_ready, true);
    assert.deepEqual(calls, [{ url: "https://backend.test/health", method: "GET", authorization: null, redirect: "manual" }]);
  } finally {
    db.close();
  }
});

test("/health uses the same-zone backend service binding when it is configured", async () => {
  const { db, env } = baseFixture();
  const calls = [];
  env.BACKEND = {
    fetch: async (request) => {
      calls.push({ url: request.url, redirect: request.redirect });
      return backendHealth({ protectedDeviceReady: true });
    },
  };
  try {
    const response = await withFetchStub(async () => {
      throw new Error("same-zone health must use the service binding");
    }, () => call(env, "GET", "/health", {}));
    assert.equal(response.status, 200);
    assert.equal(response.body.code, "healthy");
    assert.deepEqual(calls, [{ url: "https://backend.test/health", redirect: "manual" }]);
  } finally {
    db.close();
  }
});

test("portal health is healthy only when the backend reports protected readiness", async () => {
  const { db, env } = baseFixture();
  try {
    const healthy = await withFetchStub(async () => backendHealth({ protectedDeviceReady: true }), () => call(env, "GET", "/health", {}));
    assert.equal(healthy.status, 200);
    assert.equal(typeof healthy.body.request_id, "string");
    assert.deepEqual(healthy.body, { ok: true, code: "healthy", request_id: healthy.body.request_id, data: { backend_protected_ready: true } });

    for (const [label, backend] of [
      ["backend not ready", { ok: false, protectedDeviceReady: false, status: 503 }],
      ["ready flag false", { protectedDeviceReady: false }],
      ["backend not ok", { ok: false, protectedDeviceReady: true }],
      ["ready flag is not a boolean", { protectedDeviceReady: "true" }],
      ["readiness flag missing", {}],
    ]) {
      const unhealthy = await withFetchStub(async () => backendHealth(backend), () => call(env, "GET", "/health", {}));
      assert.equal(unhealthy.status, 503, label);
      assert.deepEqual(
        unhealthy.body,
        { ok: false, code: "backend_not_ready", request_id: unhealthy.body.request_id, data: { backend_protected_ready: false } },
        label,
      );
    }
  } finally {
    db.close();
  }
});

test("/health fails closed when the backend response is missing or mismatches the trusted health identity", async () => {
  const { db, env } = baseFixture();
  try {
    const missingReadiness = await withFetchStub(async () => backendHealth(), () => call(env, "GET", "/health", {}));
    assert.equal(missingReadiness.status, 503);
    assert.equal(missingReadiness.body.data.backend_protected_ready, false);

    const wrongService = await withFetchStub(
      async () => backendHealth({ service: "different-worker", protectedDeviceReady: true }),
      () => call(env, "GET", "/health", {}),
    );
    assert.equal(wrongService.status, 503);
    assert.equal(wrongService.body.data.backend_protected_ready, false);
  } finally {
    db.close();
  }
});

test("/health fails closed when the backend health request is unavailable", async () => {
  const { db, env } = baseFixture();
  try {
    const unavailable = await withFetchStub(async () => { throw new Error("backend unavailable"); }, () => call(env, "GET", "/health", {}));
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.code, "backend_not_ready");
    assert.equal(unavailable.body.data.backend_protected_ready, false);
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
        return backendHealth({ protectedDeviceReady: true });
      }, () => call(env, "GET", "/health", {}));
      assert.equal(response.status, 503, `${label} fails closed`);
      assert.equal(response.body.code, "backend_not_ready");
      assert.deepEqual(calls, [], `${label} never makes an outbound request`);
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
    calls.push({ url: String(url), authorization: new Headers(init.headers ?? {}).get("authorization"), redirect: init.redirect });
    return new Response("{}", { status: 202 });
  }, () => sendEmail({
    PORTAL_EMAIL_API_KEY: "test-key",
    PORTAL_EMAIL_FROM: "portal@example.test",
    PORTAL_EMAIL_API_BASE: "https://email.test/",
  }, "customer@example.test", "Subject", "Body"));
  assert.deepEqual(response, { ok: true, code: "sent" });
  assert.deepEqual(calls, [{ url: "https://email.test/emails", authorization: "Bearer test-key", redirect: "manual" }]);
});

test("email provider responses are cancelled for success and failure statuses", async () => {
  for (const [status, expected] of [[202, { ok: true, code: "sent" }], [400, { ok: false, code: "email_send_failed" }]]) {
    let cancelled = false;
    const endless = new ReadableStream({
      cancel() { cancelled = true; },
    });
    const response = await withFetchStub(
      async () => new Response(endless, { status }),
      () => sendEmail({
        PORTAL_EMAIL_API_KEY: "test-key",
        PORTAL_EMAIL_FROM: "portal@example.test",
        PORTAL_EMAIL_API_BASE: "https://email.test",
      }, "customer@example.test", "Subject", "OTP body"),
    );
    assert.deepEqual(response, expected, `email ${status} keeps its status-only result`);
    assert.equal(cancelled, true, `email ${status} cancels the unneeded provider body`);
  }
});

test("email provider header stalls are bounded without retrying or leaking the OTP", async () => {
  assert.equal(portalEmailInternals.EMAIL_RESPONSE_TIMEOUT_MS, 2_000, "production email timeout remains explicit and short");
  const calls = [];
  let aborted = false;
  const otpBody = "One-time sign-in code: 867530";
  const result = await settlesWithin(withFetchStub(
    async (url, init = {}) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init.headers ?? {}).get("authorization"),
        body: init.body,
        redirect: init.redirect,
      });
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("email provider timed out"));
        }, { once: true });
      });
    },
    () => portalEmailInternals.sendEmailWithTimeout({
      PORTAL_EMAIL_API_KEY: "test-key",
      PORTAL_EMAIL_FROM: "portal@example.test",
      PORTAL_EMAIL_API_BASE: "https://email.test",
    }, "customer@example.test", "Subject", otpBody, 1),
  ), 500);
  assert.notEqual(result, null, "email send does not wait indefinitely for response headers");
  assert.deepEqual(result, { ok: false, code: "email_send_indeterminate" });
  assert.equal(aborted, true, "the single email subrequest is aborted");
  assert.equal(calls.length, 1, "the provider request is never retried");
  assert.equal(calls[0].redirect, "manual", "the API key request remains redirect-safe");
  assert.equal(calls[0].authorization, "Bearer test-key", "the API key is sent only to the configured provider");
  assert.equal(JSON.parse(calls[0].body).text, otpBody, "the OTP only appears in the original provider request");
});

test("email API credentials and OTP content never follow cross-origin redirects", async () => {
  for (const status of REDIRECT_STATUSES) {
    const calls = [];
    const otpBody = "One-time sign-in code: 867530";
    let cancelled = false;
    const endless = new ReadableStream({
      cancel() { cancelled = true; },
    });
    const response = await withFetchStub(async (url, init = {}) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init.headers ?? {}).get("authorization"),
        body: init.body,
        redirect: init.redirect,
      });
      return new Response(endless, {
        status,
        headers: { location: "https://attacker.test/otp-collector" },
      });
    }, () => sendEmail({
      PORTAL_EMAIL_API_KEY: "test-key",
      PORTAL_EMAIL_FROM: "portal@example.test",
      PORTAL_EMAIL_API_BASE: "https://email.test",
    }, "customer@example.test", "Your licensecc sign-in code", otpBody));
    assert.deepEqual(response, { ok: false, code: "email_send_failed" }, `email ${status} redirect fails closed`);
    assert.equal(calls.length, 1, `email ${status} makes exactly one request`);
    assert.equal(calls[0].redirect, "manual", `email ${status} disables automatic redirect following`);
    assert.equal(new URL(calls[0].url).origin, "https://email.test", `email ${status} never contacts the redirect target`);
    assert.equal(calls[0].authorization, "Bearer test-key", `email ${status} sends the API key only to the configured provider`);
    assert.equal(JSON.parse(calls[0].body).text, otpBody, `email ${status} sends the OTP only to the configured provider`);
    assert.equal(cancelled, true, `email ${status} cancels the redirect body`);
  }
});

test("health treats redirects as terminal and cancels their body", async () => {
  for (const status of REDIRECT_STATUSES) {
    const { db, env } = baseFixture();
    const calls = [];
    let cancelled = false;
    const endless = new ReadableStream({
      cancel() { cancelled = true; },
    });
    try {
      const response = await withFetchStub(async (url, init = {}) => {
        calls.push({ url: String(url), redirect: init.redirect });
        return new Response(endless, {
          status,
          headers: { location: "https://attacker.test/readiness-collector" },
        });
      }, () => settlesWithin(call(env, "GET", "/health", {}), 500));
      assert.notEqual(response, null, `health ${status} never waits for a redirect body`);
      assert.equal(response.status, 503, `health ${status} retains the readiness failure envelope`);
      assert.equal(response.body.code, "backend_not_ready");
      assert.deepEqual(calls, [{ url: "https://backend.test/health", redirect: "manual" }]);
      assert.equal(cancelled, true, `health ${status} cancels the redirect body`);
    } finally {
      db.close();
    }
  }
});

test("/health bounds an oversized backend health body", async () => {
  const { db, env } = baseFixture();
  const payload = JSON.stringify({
    ok: true,
    service: "licensecc-online-verifier",
    protected_device_ready: true,
    padding: "x".repeat(8192),
  });
  try {
    const response = await withFetchStub(async () => new Response(payload, {
      status: 200,
      headers: { "content-type": "application/json" },
    }), () => call(env, "GET", "/health", {}));
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "backend_not_ready");
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
    assert.equal(response.body.code, "backend_not_ready");
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
    assert.equal(response.body.code, "backend_not_ready");
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
    assert.equal(response.body.code, "backend_not_ready");
    assert.equal(cancelled, true, "the non-200 backend body is cancelled before readiness returns");
  } finally {
    db.close();
  }
});

// The portal neither claims backend isolation through a local account-token mode nor holds the
// peppers it would need to mint an account token.
test("portal has no locally configured account-token mode or pepper", () => {
  const envSource = readFileSync(new URL("../src/worker/env.ts", import.meta.url), "utf8");
  const wranglerSource = readFileSync(new URL("../wrangler.example.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(envSource, /\bACCOUNT_TOKEN_[A-Z_]+\b/);
  assert.doesNotMatch(wranglerSource, /\bACCOUNT_TOKEN_[A-Z_]+\b/);
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
