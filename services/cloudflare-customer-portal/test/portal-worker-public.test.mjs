import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assert, worker, mintSession, codeFromSecretBytes, requestOtp, redeemOtp, policyCapacityViolation, FP_A, FP_B, installBackendStub, cookieFor, sameSiteHeaders, entitlementId, ownedEntitlementId, call, baseFixture, seedDevice, seedEntitlement, CTX, NOW } from "./portal-worker-fixtures.mjs";
import { sendEmail } from "../src/auth/portal_email.mjs";
import { _internals as portalTokenInternals } from "../src/auth/portal_token.mjs";
import { openApiDocument } from "../dist-worker/worker/openapi/document.js";
import { backendStubCases, proxiedBackendOperations } from "./backend-proxy-contract.mjs";

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

function documentedErrorCodes(path, status) {
  const response = openApiDocument.paths[path]?.post?.responses?.[String(status)];
  const code = response?.content?.["application/json"]?.schema?.properties?.code;
  if (typeof code?.const === "string") return [code.const];
  if (Array.isArray(code?.enum) && code.enum.every((value) => typeof value === "string")) return code.enum;
  throw new Error(`${path} ${status} does not declare an exact error-code schema`);
}

function dereferenceSchema(schema) {
  if (typeof schema?.$ref !== "string") return schema;
  const prefix = "#/components/schemas/";
  assert.ok(schema.$ref.startsWith(prefix), `unsupported OpenAPI schema reference ${schema.$ref}`);
  const resolved = openApiDocument.components.schemas[schema.$ref.slice(prefix.length)];
  assert.ok(resolved && typeof resolved === "object", `missing OpenAPI schema ${schema.$ref}`);
  return resolved;
}

function valueMatchesType(value, type) {
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return true;
}

function assertValueMatchesSchema(value, sourceSchema, label) {
  const schema = dereferenceSchema(sourceSchema);
  assert.ok(schema && typeof schema === "object", `${label} schema must be an object`);
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) assertValueMatchesSchema(value, part, label);
  }
  if (Object.hasOwn(schema, "const")) assert.deepEqual(value, schema.const, `${label} must equal its OpenAPI const`);
  if (Array.isArray(schema.enum)) assert.ok(schema.enum.includes(value), `${label} must be an OpenAPI enum member`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert.ok(types.some((type) => valueMatchesType(value, type)), `${label} must match OpenAPI type ${types.join("|")}`);
  }
  if (schema.type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      assert.ok(Object.hasOwn(value, required), `${label} must include required property ${required}`);
    }
    for (const [name, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, name)) assertValueMatchesSchema(value[name], propertySchema, `${label}.${name}`);
    }
  }
}

function assertRuntimeErrorIsDocumented(path, response) {
  const schema = openApiDocument.paths[path]?.post?.responses?.[String(response.status)]?.content?.["application/json"]?.schema;
  assert.ok(schema, `${path} ${response.status} must expose an assembled JSON response schema`);
  assert.equal(response.body.ok, false, `${path} error envelope must set ok:false`);
  assertValueMatchesSchema(response.body, schema, `${path} ${response.status} runtime envelope`);
  assert.ok(documentedErrorCodes(path, response.status).includes(response.body.code), `${path} ${response.status} runtime code ${response.body.code} must be documented`);
}

async function proxyFailure(operation, { extraEnv = {}, fetchStub, headers, mutateEnv } = {}) {
  const { db, env } = baseFixture(extraEnv);
  let restore;
  try {
    const cookie = await cookieFor(env, "A");
    const id = await ownedEntitlementId(env, cookie);
    restore = mutateEnv?.(env);
    const run = () => call(env, "POST", operation.portalPath, {
      cookie,
      body: operation.requestBody(id),
      headers,
    });
    return fetchStub === undefined ? await run() : await withFetchStub(fetchStub, run);
  } finally {
    if (typeof restore === "function") restore();
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
        redirect: init.redirect,
      });
      return backendHealth({ accountTokenMode: "required" });
    }, () => call(env, "GET", "/health", {}));
    assert.equal(healthy.status, 200);
    assert.equal(healthy.body.code, "healthy");
    assert.equal(healthy.body.data.account_token_mode_required, true);
    assert.deepEqual(calls, [{ url: "https://backend.test/health", method: "GET", authorization: null, redirect: "manual" }]);
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

test("credentialed backend calls never follow cross-origin redirects", async () => {
  for (const operation of proxiedBackendOperations) {
    for (const status of REDIRECT_STATUSES) {
      const calls = [];
      let cancelled = false;
      const endless = new ReadableStream({
        cancel() { cancelled = true; },
      });
      const response = await proxyFailure(operation, {
        fetchStub: async (url, init = {}) => {
          calls.push({
            url: String(url),
            authorization: new Headers(init.headers ?? {}).get("authorization"),
            body: init.body,
            redirect: init.redirect,
          });
          return new Response(endless, {
            status,
            headers: { location: "https://attacker.test/credential-collector" },
          });
        },
      });
      assert.equal(response.status, 502, `${operation.name} ${status} redirect is a transport failure`);
      assert.equal(response.body.code, "backend_invalid_response", `${operation.name} ${status} redirect is never passed through`);
      assert.equal(response.body.data, undefined, `${operation.name} ${status} redirect body is not reflected`);
      assert.equal(calls.length, 1, `${operation.name} ${status} makes exactly one request`);
      assert.equal(calls[0].redirect, "manual", `${operation.name} ${status} disables automatic redirect following`);
      assert.equal(new URL(calls[0].url).origin, "https://backend.test", `${operation.name} ${status} never contacts the redirect target`);
      assert.match(calls[0].authorization ?? "", /^Bearer lcca_/, `${operation.name} ${status} only sends the bearer to the configured backend`);
      assert.equal(typeof calls[0].body, "string", `${operation.name} ${status} only sends the JSON body to the configured backend`);
      assert.equal(cancelled, true, `${operation.name} ${status} cancels the redirect body`);
    }
  }
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
      assert.equal(response.body.code, "account_token_mode_not_required");
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

test("canonical backend failures preserve their status and code through every portal proxy", async () => {
  for (const operation of proxiedBackendOperations) {
    for (const failure of backendStubCases(operation)) {
      const upstreamBody = { ok: false, code: failure.code, backend_marker: `${operation.name}:${failure.status}` };
      const response = await proxyFailure(operation, {
        fetchStub: async () => new Response(JSON.stringify(upstreamBody), {
          status: failure.status,
          headers: { "content-type": "application/json" },
        }),
      });
      assert.equal(response.status, failure.status, `${operation.name} preserves backend ${failure.status}`);
      assert.equal(response.body.code, failure.code, `${operation.name} preserves backend ${failure.code}`);
      assert.equal(response.body.data, undefined, `${operation.name} does not reflect arbitrary backend error fields`);
      assertRuntimeErrorIsDocumented(operation.portalPath, response);
    }
  }
});

test("action and download reject malformed or disallowed backend error envelopes", async () => {
  const malformed = [
    ["empty object", 400, {}],
    ["missing code", 400, { ok: false }],
    ["empty code", 400, { ok: false, code: "" }],
    ["wrong ok type", 400, { ok: "false", code: "invalid_request" }],
    ["wrong code type", 400, { ok: false, code: 42 }],
    ["status/code mismatch", 400, { ok: false, code: "seat_signing_error" }],
    ["unsupported status", 418, { ok: false, code: "invalid_request" }],
  ];
  for (const operation of proxiedBackendOperations) {
    for (const [label, status, upstreamBody] of malformed) {
      const response = await proxyFailure(operation, {
        fetchStub: async () => new Response(JSON.stringify(upstreamBody), {
          status,
          headers: { "content-type": "application/json" },
        }),
      });
      assert.equal(response.status, 502, `${operation.name} ${label} maps to the bounded transport error`);
      assert.equal(response.body.code, "backend_invalid_response", `${operation.name} ${label} is not reflected`);
      assert.equal(response.body.data, undefined, `${operation.name} ${label} exposes no upstream fields`);
      assertRuntimeErrorIsDocumented(operation.portalPath, response);
    }
  }
});

test("bounded backend error reads cancel oversized and failed action/download streams", async () => {
  for (const operation of proxiedBackendOperations.filter((candidate) => candidate.name === "checkout" || candidate.name === "download")) {
    let oversizedCancelled = false;
    const oversized = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(8_192))); },
      cancel() { oversizedCancelled = true; },
    });
    const tooLarge = await proxyFailure(operation, {
      fetchStub: async () => new Response(oversized, { status: 400, headers: { "content-type": "application/json" } }),
    });
    assert.equal(tooLarge.status, 502, `${operation.name} oversized error body fails closed`);
    assert.equal(tooLarge.body.code, "backend_invalid_response");
    assert.equal(oversizedCancelled, true, `${operation.name} cancels an oversized error stream`);

    const failed = new ReadableStream({
      pull(controller) { controller.error(new Error("backend stream failed")); },
    });
    const readFailure = await proxyFailure(operation, {
      fetchStub: async () => new Response(failed, { status: 400, headers: { "content-type": "application/json" } }),
    });
    assert.equal(readFailure.status, 502, `${operation.name} read failure fails closed`);
    assert.equal(readFailure.body.code, "backend_invalid_response");
  }
});

test("bounded backend error helper aborts stalled streams and header stalls without retrying", async () => {
  assert.equal(portalTokenInternals.BACKEND_RESPONSE_TIMEOUT_MS, 2_000, "production proxy timeout remains explicit and short");
  let stalledCancelled = false;
  const stalled = new ReadableStream({
    cancel() { stalledCancelled = true; },
  });
  const stalledResult = await settlesWithin(withFetchStub(
    async () => new Response(stalled, { status: 400, headers: { "content-type": "application/json" } }),
    () => portalTokenInternals.proxyBackendWithTimeout("https://backend.test", "/v1/checkout", "lcca_test", {}, "checkout", 1),
  ), 500);
  assert.notEqual(stalledResult, null, "stalled backend error stream is bounded by an abort timeout");
  assert.deepEqual(stalledResult, { ok: false, status: 502, code: "backend_invalid_response" });
  assert.equal(stalledCancelled, true, "stalled backend error stream is cancelled after abort");

  const calls = [];
  let aborted = false;
  const abortedResult = await settlesWithin(withFetchStub(
    async (url, init = {}) => {
      calls.push({ url: String(url), redirect: init.redirect, authorization: new Headers(init.headers ?? {}).get("authorization") });
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("backend request timed out"));
        }, { once: true });
      });
    },
    () => portalTokenInternals.proxyBackendWithTimeout("https://backend.test", "/v1/activate", "lcca_test", {}, "download", 1),
  ), 500);
  assert.notEqual(abortedResult, null, "header stall is bounded by an abort timeout");
  assert.deepEqual(abortedResult, { ok: false, status: 502, code: "backend_unreachable" });
  assert.equal(aborted, true, "the credentialed subrequest is aborted");
  assert.deepEqual(calls, [{ url: "https://backend.test/v1/activate", redirect: "manual", authorization: "Bearer lcca_test" }]);
});

test("local proxy failures from every action and download fit their assembled OpenAPI schemas", async () => {
  const cases = [
    {
      label: "cross-site rejection",
      status: 403,
      code: "cross_site_forbidden",
      options: { headers: { origin: "https://cross-site.test", "sec-fetch-site": "cross-site" } },
    },
    {
      label: "unconfigured backend",
      status: 503,
      code: "backend_unconfigured",
      options: { extraEnv: { BACKEND_ORIGIN: "http://backend.test" } },
    },
    {
      label: "token-mint configuration failure",
      status: 503,
      code: "config_error",
      options: { extraEnv: { ACCOUNT_TOKEN_PEPPERS: "" } },
    },
    {
      label: "unreachable backend",
      status: 502,
      code: "backend_unreachable",
      options: { fetchStub: async () => { throw new Error("backend unavailable"); } },
    },
    {
      label: "invalid backend response",
      status: 502,
      code: "backend_invalid_response",
      options: { fetchStub: async () => new Response("not-json", { status: 200 }) },
    },
    {
      label: "unhandled portal failure",
      status: 500,
      code: "portal_error",
      options: {
        mutateEnv: (env) => {
          const originalPrepare = env.DB.prepare;
          env.DB.prepare = () => { throw new Error("D1 unavailable"); };
          return () => { env.DB.prepare = originalPrepare; };
        },
      },
    },
  ];
  for (const operation of proxiedBackendOperations) {
    for (const failure of cases) {
      const response = await proxyFailure(operation, failure.options);
      assert.equal(response.status, failure.status, `${operation.name} ${failure.label} status`);
      assert.equal(response.body.code, failure.code, `${operation.name} ${failure.label} code`);
      assertRuntimeErrorIsDocumented(operation.portalPath, response);
    }
  }
});

test("device-release portal errors are declared by OpenAPI", async () => {
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
