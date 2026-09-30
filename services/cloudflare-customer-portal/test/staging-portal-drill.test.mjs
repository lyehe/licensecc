import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  decodeBase64url,
  deviceLeaseSigningInput,
  deviceOperationBody,
  deviceProofSigningInput,
  encodeBase64url,
  encodeDeviceLeaseEnvelope,
  encodeDeviceLeasePayload,
} from "@licensecc/licensing-domain/lease/device_protocol";
import {
  CookieJar,
  runStagingPortalDrill,
  splitSetCookieHeader,
  validateOptions,
} from "../scripts/staging-portal-drill.mjs";

const PORTAL = "https://portal.example";
const BACKEND = "https://backend.example";
const REDIRECT = "http://127.0.0.1:45678/callback";
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

test("portal static assets carry a restrictive browser security policy", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  assert.match(headers, /Content-Security-Policy: default-src 'none'/u);
  assert.match(headers, /script-src 'self'/u);
  assert.match(headers, /frame-ancestors 'none'/u);
  // Native OAuth form POSTs must retain Origin, and Chromium checks their redirects against form-action.
  assert.match(headers, /Referrer-Policy: same-origin/u);
  assert.match(headers, /form-action 'self' https:\/\/github\.com\/login\/oauth\/authorize https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth;/u);
  assert.match(headers, /X-Frame-Options: DENY/u);
  assert.match(headers, /X-Content-Type-Options: nosniff/u);
  assert.doesNotMatch(headers, /unsafe-inline|unsafe-eval/iu);
});

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const randomId = (size) => encodeBase64url(new Uint8Array(randomBytes(size)));
const scalar = (bytes) => BigInt(`0x${Buffer.from(bytes).toString("hex")}`);

function withS(signature, s) {
  const result = new Uint8Array(signature);
  result.set(Buffer.from(s.toString(16).padStart(64, "0"), "hex"), 32);
  return result;
}

// Returns the high-S twin of an ECDSA P-256 signature; both verify, only the low-S form is canonical.
function highS(signature) {
  const s = scalar(signature.subarray(32));
  return s > P256_ORDER / 2n ? new Uint8Array(signature) : withS(signature, P256_ORDER - s);
}

async function leaseSigner() {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const body = Buffer.from(spki).toString("base64").replace(/.{64}/gu, "$&\n").trimEnd();
  return {
    privateKey: keys.privateKey,
    keyId: `sha256:${sha256Hex(spki)}`,
    publicPem: `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`,
  };
}

function protectedEnv(publicPem) {
  return {
    STAGING_PORTAL_PROTECTED_ENTITLEMENT_ID: "ent_protected",
    STAGING_BACKEND_BASE_URL: BACKEND,
    STAGING_DEVICE_CLIENT_ID: "staging-drill",
    STAGING_DEVICE_PROJECT: "APP",
    STAGING_DEVICE_FEATURE: "PRO",
    STAGING_DEVICE_REDIRECT_URI: REDIRECT,
    STAGING_DEVICE_AUDIENCE: "desktop",
    STAGING_BOUND_LEASE_PUBLIC_KEY_SPKI_PEM: publicPem,
  };
}

// A fake backend and portal consent service that enforce the real request shapes and verify
// every device proof against the public key the drill registered. `renewalSigningKey`, when
// given, signs only the renewal lease.
function protectedService({ signingKey, claimedKeyId, renewalSigningKey = signingKey }) {
  const now = Math.floor(Date.now() / 1000);
  const attempt = { handle: randomId(32), code: randomId(32), state: null, challenge: null };
  const binding = { id: randomId(16), revision: 0, generation: 1 };
  const challenges = new Map();
  const service = { spki: null, label: null, proofs: [], proofSignatures: [], leases: [] };

  const deviceKeyId = () => `sha256:${sha256Hex(decodeBase64url(service.spki, 384))}`;

  async function verifyProof(purpose, path, semantic, proof) {
    assert.deepEqual(Object.keys(proof).sort(), ["challenge_id", "expires_at", "key_id", "nonce", "signature"]);
    const challenge = challenges.get(proof.challenge_id);
    assert.ok(challenge, "the proof names an issued challenge");
    assert.equal(challenge.purpose, purpose);
    assert.equal(challenge.operation_id, semantic.operation_id);
    assert.equal(proof.nonce, challenge.nonce);
    assert.equal(proof.expires_at, challenge.expires_at);
    assert.equal(proof.key_id, deviceKeyId());
    const key = await crypto.subtle.importKey("spki", decodeBase64url(service.spki, 384), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const signature = decodeBase64url(proof.signature, 64);
    const input = deviceProofSigningInput({
      audience: "desktop",
      method: "POST",
      path,
      key_id: proof.key_id,
      operation_id: semantic.operation_id,
      body_sha256: sha256Hex(deviceOperationBody(purpose, semantic)),
      challenge_id: proof.challenge_id,
      nonce: proof.nonce,
      expires_at: proof.expires_at,
    });
    service.proofs.push({
      path,
      verified: await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, input),
      low_s: scalar(signature.subarray(32)) <= P256_ORDER / 2n,
    });
    service.proofSignatures.push(proof.signature);
  }

  async function lease(operationId) {
    const payload = encodeDeviceLeasePayload({
      version: 1,
      purpose: "device-lease",
      "key-id": claimedKeyId,
      issuer: `${BACKEND}/`,
      audience: "desktop",
      project: "APP",
      feature: "PRO",
      "license-fingerprint": "c".repeat(64),
      "binding-id": binding.id,
      "device-key-id": deviceKeyId(),
      generation: binding.generation,
      "revocation-seq": 0,
      "lease-id": randomId(16),
      "operation-id": operationId,
      "issued-at": now,
      "renew-after": now + 1800,
      "expires-at": now + 3600,
    });
    const key = service.leases.length === 0 ? signingKey : renewalSigningKey;
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, deviceLeaseSigningInput(payload)));
    const token = encodeDeviceLeaseEnvelope(payload, signature);
    service.leases.push(token);
    binding.revision += 1;
    return {
      device_id: randomId(16),
      binding_id: binding.id,
      generation: binding.generation,
      entitlement: { project: "APP", feature: "PRO", license_fingerprint: "c".repeat(64) },
      lease: token,
      renew_after: now + 1800,
      expires_at: now + 3600,
      accept_until: now + 3720,
    };
  }

  service.backend = async (path, headers, body) => {
    assert.equal(headers.get("cookie"), null, "backend calls never carry the portal session");
    if (path === "/v2/device-authorizations") {
      assert.deepEqual(Object.keys(body).sort(), [
        "client_id", "code_challenge", "code_challenge_method", "device_label", "project",
        "public_key_spki", "redirect_uri", "requested_feature", "state",
      ]);
      assert.equal(body.client_id, "staging-drill");
      assert.equal(body.project, "APP");
      assert.equal(body.requested_feature, "PRO");
      assert.equal(body.redirect_uri, REDIRECT);
      assert.equal(body.code_challenge_method, "S256");
      assert.match(body.device_label, /^staging drill \S+$/u);
      assert.equal(decodeBase64url(body.state, 32).length, 32);
      assert.equal(decodeBase64url(body.code_challenge, 32).length, 32);
      service.spki = body.public_key_spki;
      service.label = body.device_label;
      attempt.state = body.state;
      attempt.challenge = body.code_challenge;
      return json({
        ok: true,
        code: "authorization_created",
        data: { attempt_handle: attempt.handle, authorization_url: `${PORTAL}/connect`, expires_at: now + 600, comparison_code: "ABCD-EF01-2345" },
      });
    }
    if (path === "/v2/device-challenges") {
      const subject = body.purpose === "exchange" ? "attempt_handle" : "binding_id";
      assert.deepEqual(Object.keys(body).sort(), [subject, "operation_id", "purpose"].sort());
      assert.equal(body[subject], body.purpose === "exchange" ? attempt.handle : binding.id);
      assert.equal(decodeBase64url(body.operation_id, 32).length, 32);
      const challenge = { challenge_id: randomId(16), nonce: randomId(32), expires_at: now + 120 };
      challenges.set(challenge.challenge_id, { ...challenge, purpose: body.purpose, operation_id: body.operation_id });
      return json({ ok: true, code: "challenge_created", data: challenge });
    }
    if (path === "/v2/device-authorizations/exchange") {
      const { proof, ...semantic } = body;
      assert.deepEqual(Object.keys(semantic).sort(), ["attempt_handle", "code", "code_verifier", "operation_id", "redirect_uri"]);
      assert.equal(semantic.attempt_handle, attempt.handle);
      assert.equal(semantic.code, attempt.code);
      assert.equal(semantic.redirect_uri, REDIRECT);
      assert.equal(encodeBase64url(new Uint8Array(createHash("sha256").update(semantic.code_verifier).digest())), attempt.challenge);
      await verifyProof("exchange", path, semantic, proof);
      return json({ ok: true, code: "device_activated", data: await lease(semantic.operation_id) });
    }
    if (path === "/v2/device-leases/renew") {
      const { proof, ...semantic } = body;
      assert.deepEqual(Object.keys(semantic).sort(), ["binding_id", "generation", "operation_id"]);
      assert.equal(semantic.binding_id, binding.id);
      assert.equal(semantic.generation, binding.generation);
      await verifyProof("renew", path, semantic, proof);
      return json({ ok: true, code: "device_renewed", data: await lease(semantic.operation_id) });
    }
    throw new Error(`unexpected backend request: ${path}`);
  };

  service.portal = async (requestUrl, method, headers, body) => {
    const path = requestUrl.pathname;
    assert.equal(headers.get("x-expected-customer-id"), "cust_1");
    if (method === "POST") {
      assert.equal(headers.get("origin"), PORTAL);
      assert.equal(headers.get("sec-fetch-site"), "same-origin");
    }
    if (method === "POST" && path === "/api/portal/device-authorizations/inspect") {
      assert.equal(headers.get("idempotency-key"), null);
      assert.deepEqual(body, { attempt_handle: attempt.handle });
      return json({
        ok: true,
        code: "authorization_inspected",
        data: {
          app: { name: "Application", project: "APP" },
          device: { label: service.label },
          status: "pending",
          revision: 0,
          expires_at: now + 600,
          entitlements: [{ id: "ent_protected", feature: "PRO", valid_until: null, device_limit: 20, devices_in_use: 0, slot_free_at: null, device_connected: false }],
          has_more: false,
          next_page_cursor: null,
          comparison_code: "ABCD-EF01-2345",
        },
      });
    }
    if (method === "POST" && path === "/api/portal/device-authorizations/approve") {
      assert.match(headers.get("idempotency-key") ?? "", /^[A-Za-z0-9_-]{16,128}$/u);
      assert.deepEqual(body, { attempt_handle: attempt.handle, entitlement_id: "ent_protected", expected_attempt_revision: 0 });
      const callback = new URL(REDIRECT);
      callback.search = new URLSearchParams({ code: attempt.code, state: attempt.state }).toString();
      return json({ ok: true, code: "authorization_approved", data: { callback_url: callback.href, expires_at: now + 60, revision: 1 } });
    }
    if (method === "GET" && path === "/api/portal/device-bindings") {
      assert.equal(requestUrl.search, `?binding_id=${binding.id}`);
      return json({
        ok: true,
        code: "device_bindings",
        data: {
          customer_id: "cust_1",
          items: [{
            binding_id: binding.id, project: "APP", feature: "PRO", revision: binding.revision, hold_until: now + 3720,
            state: "active", label: service.label, last_proof_at: now, created_at: now, server_time: now,
          }],
          has_more: false,
          next_cursor: null,
        },
      });
    }
    if (method === "POST" && path === "/api/portal/device-bindings/retire") {
      assert.equal(decodeBase64url(headers.get("idempotency-key") ?? "", 32).length, 32);
      assert.deepEqual(body, { binding_id: binding.id, expected_revision: binding.revision });
      return json({
        ok: true,
        code: "binding_retired",
        data: { binding_id: binding.id, state: "retiring", effective_release_at: now + 3720, revision: binding.revision + 1, generation: binding.generation + 1 },
      });
    }
    throw new Error(`unexpected portal device request: ${method} ${path}`);
  };

  return service;
}

function makeFetch(calls, service) {
  return async (url, init = {}) => {
    const requestUrl = new URL(String(url));
    const path = requestUrl.pathname;
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers ?? {});
    const body = init.body === undefined ? null : JSON.parse(init.body);
    calls.push({ origin: requestUrl.origin, path, method, headers, body });

    if (requestUrl.origin === BACKEND) {
      assert.ok(service, `unexpected backend request: ${path}`);
      return service.backend(path, headers, body);
    }
    assert.equal(requestUrl.origin, PORTAL);
    if (path === "/") {
      return new Response("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }
    if (path === "/health") {
      return json({ ok: true, code: "healthy", data: { account_token_mode_required: true } });
    }
    if (path === "/portal/v1/admin/bootstrap-otp") {
      assert.equal(headers.get("authorization"), "Bearer break-glass");
      assert.equal(headers.get("cf-access-jwt-assertion"), "access-jwt");
      assert.equal(body.email, "customer@example.com");
      return json({ ok: true, code: "bootstrap_otp", data: { secret: "bootstrap-secret" } });
    }
    if (path === "/portal/v1/auth/magic-redeem") {
      assert.equal(body.token, "bootstrap-secret");
      return json(
        { ok: true, code: "signed_in", data: { customer_id: "cust_1" } },
        200,
        { "set-cookie": "lccp_session=lccp_from_bootstrap; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400" },
      );
    }
    if (path === "/portal/v1/auth/verify") {
      assert.equal(body.email, "customer@example.com");
      assert.equal(body.code, "123456");
      return json(
        { ok: true, code: "signed_in", data: { customer_id: "cust_1" } },
        200,
        { "set-cookie": "lccp_session=lccp_from_otp; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400" },
      );
    }
    if (path === "/portal/v1/auth/logout") {
      return json({ ok: true, code: "logged_out" }, 200, { "set-cookie": "lccp_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax" });
    }

    if (path === "/api/portal/me" && !/lccp_session=/u.test(headers.get("cookie") ?? "")) {
      return json({ ok: false, code: "unauthorized" }, 401);
    }
    assert.match(headers.get("cookie") ?? "", /lccp_session=/);
    if (path === "/api/portal/me") {
      return json({ ok: true, code: "me", data: { customer_id: "cust_1" } });
    }
    if (path === "/api/portal/entitlements") {
      return json({
        ok: true,
        code: "entitlements",
        data: {
          items: [
            { id: "ent_node", license_mode: "node_locked" },
            { id: "ent_protected", license_mode: "node_locked" },
          ],
        },
      });
    }
    if (path.startsWith("/api/portal/device-")) {
      assert.ok(service, `unexpected portal device request: ${path}`);
      return service.portal(requestUrl, method, headers, body);
    }
    throw new Error(`unexpected request: ${path}`);
  };
}

test("portal staging drill validates skip and partial configuration", () => {
  assert.deepEqual(validateOptions({}), {
    skipped: true,
    reason: "staging portal drill environment is not configured",
  });
  assert.throws(() => validateOptions({ STAGING_PORTAL_BASE_URL: "https://portal.example" }), /configure STAGING_PORTAL_SESSION_COOKIE/);
});

test("portal staging drill supports bootstrap auth and logs out", async () => {
  const calls = [];
  const result = await runStagingPortalDrill(validateOptions({
    STAGING_PORTAL_BASE_URL: PORTAL,
    STAGING_PORTAL_EMAIL: "customer@example.com",
    STAGING_PORTAL_BOOTSTRAP_BEARER: "break-glass",
    STAGING_PORTAL_ACCESS_JWT: "access-jwt",
  }), { fetchFn: makeFetch(calls) });

  assert.equal(result.ok, true);
  assert.equal(result.auth_mode, "bootstrap_bearer");
  assert.equal(result.ui_status, 200);
  assert.equal(result.unauthenticated_status, 401);
  assert.equal(result.session_cookie_policy_checked, true);
  assert.equal(result.post_logout_status, 401);
  assert.equal(result.customer_id_present, true);
  assert.equal(result.entitlement_count, 2);
  assert.deepEqual(result.protected_device, { enabled: false });
  assert.equal(result.logout_performed, true);
  assert.deepEqual(calls.map((call) => call.path), [
    "/",
    "/health",
    "/api/portal/me",
    "/portal/v1/admin/bootstrap-otp",
    "/portal/v1/auth/magic-redeem",
    "/api/portal/me",
    "/api/portal/entitlements",
    "/portal/v1/auth/logout",
    "/api/portal/me",
  ]);
});

test("portal staging drill accepts an existing session cookie without logging it out", async () => {
  const calls = [];
  const result = await runStagingPortalDrill(validateOptions({
    LICENSECC_PORTAL_URL: PORTAL,
    LICENSECC_PORTAL_SESSION_COOKIE: "lccp_session=lccp_existing; Path=/; HttpOnly",
  }), { fetchFn: makeFetch(calls), cookieJar: new CookieJar() });

  assert.equal(result.auth_mode, "session_cookie");
  assert.equal(result.unauthenticated_status, 401);
  assert.equal(result.session_cookie_policy_checked, false);
  assert.equal(result.post_logout_status, null);
  assert.deepEqual(result.protected_device, { enabled: false });
  assert.equal(result.logout_performed, false);
  assert.equal(calls.some((call) => call.path === "/portal/v1/auth/logout"), false);
});

test("portal staging drill rejects an insecure session cookie policy", async () => {
  const calls = [];
  const fallback = makeFetch(calls);
  const fetchFn = async (url, init) => {
    if (new URL(String(url)).pathname === "/portal/v1/auth/magic-redeem") {
      return json(
        { ok: true, code: "signed_in", data: { customer_id: "cust_1" } },
        200,
        { "set-cookie": "lccp_session=insecure; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400" },
      );
    }
    return fallback(url, init);
  };

  await assert.rejects(
    runStagingPortalDrill(validateOptions({
      STAGING_PORTAL_BASE_URL: PORTAL,
      STAGING_PORTAL_EMAIL: "customer@example.com",
      STAGING_PORTAL_BOOTSTRAP_BEARER: "break-glass",
      STAGING_PORTAL_ACCESS_JWT: "access-jwt",
    }), { fetchFn }),
    /did not issue the required secure session cookie policy/u,
  );
});

test("the staging portal drill completes a protected enrollment, exchange and renewal and retires the binding", async (t) => {
  const [trusted, other] = await Promise.all([leaseSigner(), leaseSigner()]);
  const sign = crypto.subtle.sign;
  // Hand the drill only high-S device signatures, so every accepted proof shows it normalised to low-S.
  t.mock.method(crypto.subtle, "sign", async (algorithm, key, data) => {
    const signature = new Uint8Array(await sign.call(crypto.subtle, algorithm, key, data));
    return algorithm?.name === "ECDSA" ? highS(signature).buffer : signature.buffer;
  });

  const calls = [];
  const service = protectedService({ signingKey: trusted.privateKey, claimedKeyId: trusted.keyId });
  const result = await runStagingPortalDrill(validateOptions({
    STAGING_PORTAL_BASE_URL: PORTAL,
    STAGING_PORTAL_EMAIL: "customer@example.com",
    STAGING_PORTAL_BOOTSTRAP_BEARER: "break-glass",
    STAGING_PORTAL_ACCESS_JWT: "access-jwt",
    ...protectedEnv(trusted.publicPem),
  }), { fetchFn: makeFetch(calls, service) });

  assert.deepEqual(result.protected_device, {
    enabled: true,
    exchanged: true,
    renewed: true,
    retired: true,
    lease_key_id: trusted.keyId,
  });
  assert.deepEqual(
    calls
      .filter((call) => call.method === "POST" && (call.origin === BACKEND || call.path.startsWith("/api/portal/device-")))
      .map((call) => `${call.origin === BACKEND ? "backend" : "portal"} ${call.path}`),
    [
      "backend /v2/device-authorizations",
      "portal /api/portal/device-authorizations/inspect",
      "portal /api/portal/device-authorizations/approve",
      "backend /v2/device-challenges",
      "backend /v2/device-authorizations/exchange",
      "backend /v2/device-challenges",
      "backend /v2/device-leases/renew",
      "portal /api/portal/device-bindings/retire",
    ],
  );
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    "GET /",
    "GET /health",
    "GET /api/portal/me",
    "POST /portal/v1/admin/bootstrap-otp",
    "POST /portal/v1/auth/magic-redeem",
    "GET /api/portal/me",
    "GET /api/portal/entitlements",
    "POST /v2/device-authorizations",
    "POST /api/portal/device-authorizations/inspect",
    "POST /api/portal/device-authorizations/approve",
    "POST /v2/device-challenges",
    "POST /v2/device-authorizations/exchange",
    "POST /v2/device-challenges",
    "POST /v2/device-leases/renew",
    "GET /api/portal/device-bindings",
    "POST /api/portal/device-bindings/retire",
    "POST /portal/v1/auth/logout",
    "GET /api/portal/me",
  ]);
  assert.deepEqual(service.proofs, [
    { path: "/v2/device-authorizations/exchange", verified: true, low_s: true },
    { path: "/v2/device-leases/renew", verified: true, low_s: true },
  ]);
  const evidence = JSON.stringify(result);
  for (const secret of [...service.leases, ...service.proofSignatures, service.spki, "lccp_from_bootstrap", "bootstrap-secret"]) {
    assert.equal(evidence.includes(secret), false);
  }

  // A second run whose backend signs leases with a different key must fail closed and redacted.
  const forgedCalls = [];
  const forged = protectedService({ signingKey: other.privateKey, claimedKeyId: trusted.keyId });
  await assert.rejects(
    runStagingPortalDrill(validateOptions({
      LICENSECC_PORTAL_URL: PORTAL,
      LICENSECC_PORTAL_SESSION_COOKIE: "lccp_session=lccp_existing",
      ...protectedEnv(trusted.publicPem),
    }), { fetchFn: makeFetch(forgedCalls, forged) }),
    (error) => error instanceof Error
      && /protected device exchange lease signature did not verify/u.test(error.message)
      && [...forged.leases, ...forged.proofSignatures, forged.spki, "lccp_existing"].every((secret) => !error.message.includes(secret)),
  );
  assert.equal(forged.leases.length, 1);
  assert.equal(forgedCalls.some((call) => call.path === "/v2/device-leases/renew" || call.path === "/api/portal/device-bindings/retire"), false);
});

test("the protected drill rejects a renewal lease that the configured lease key did not sign", async () => {
  const [trusted, other] = await Promise.all([leaseSigner(), leaseSigner()]);
  const calls = [];
  const service = protectedService({ signingKey: trusted.privateKey, claimedKeyId: trusted.keyId, renewalSigningKey: other.privateKey });
  await assert.rejects(
    runStagingPortalDrill(validateOptions({
      LICENSECC_PORTAL_URL: PORTAL,
      LICENSECC_PORTAL_SESSION_COOKIE: "lccp_session=lccp_existing",
      ...protectedEnv(trusted.publicPem),
    }), { fetchFn: makeFetch(calls, service) }),
    (error) => error instanceof Error
      && /protected device renewal lease signature did not verify/u.test(error.message)
      && [...service.leases, ...service.proofSignatures, service.spki, "lccp_existing"].every((secret) => !error.message.includes(secret)),
  );
  assert.equal(service.leases.length, 2);
  assert.equal(calls.some((call) => call.path === "/v2/device-leases/renew"), true);
  assert.equal(calls.some((call) => call.path.startsWith("/api/portal/device-bindings")), false);
});

test("the drill skips the protected journey when the protected variables are absent", async () => {
  const calls = [];
  const result = await runStagingPortalDrill(validateOptions({
    LICENSECC_PORTAL_URL: PORTAL,
    LICENSECC_PORTAL_SESSION_COOKIE: "lccp_session=lccp_existing",
  }), { fetchFn: makeFetch(calls) });
  assert.deepEqual(result.protected_device, { enabled: false });
  assert.equal(calls.some((call) => call.origin !== PORTAL || call.path.startsWith("/v2/") || call.path.startsWith("/api/portal/device-")), false);

  const present = {
    STAGING_BACKEND_BASE_URL: BACKEND,
    STAGING_DEVICE_CLIENT_ID: "staging-drill",
    LICENSECC_DEVICE_PROJECT: "APP",
  };
  assert.throws(
    () => validateOptions({ LICENSECC_PORTAL_URL: PORTAL, LICENSECC_PORTAL_SESSION_COOKIE: "lccp_session=lccp_existing", ...present }),
    (error) => error instanceof Error
      && [
        "STAGING_PORTAL_PROTECTED_ENTITLEMENT_ID",
        "STAGING_DEVICE_FEATURE",
        "STAGING_DEVICE_REDIRECT_URI",
        "STAGING_DEVICE_AUDIENCE",
        "STAGING_BOUND_LEASE_PUBLIC_KEY_SPKI_PEM",
      ].every((name) => error.message.includes(name))
      && ["STAGING_BACKEND_BASE_URL", "STAGING_DEVICE_CLIENT_ID", "STAGING_DEVICE_PROJECT", BACKEND, "staging-drill", "lccp_existing"]
        .every((text) => !error.message.includes(text)),
  );
});

test("cookie helpers keep only cookie pairs and split combined Set-Cookie headers", () => {
  assert.deepEqual(splitSetCookieHeader("a=1; Path=/, b=2; Path=/"), ["a=1; Path=/", " b=2; Path=/"]);
  const jar = new CookieJar();
  jar.add("a=1; Path=/; HttpOnly");
  jar.add("b=2; Path=/");
  assert.equal(jar.header(), "a=1; b=2");
});

test("portal drill failure diagnostics do not echo response data", async () => {
  const secret = "customer-license-data-must-not-appear";
  const calls = [];
  const fallback = makeFetch(calls);
  const fetchFn = async (url, init) => {
    if (new URL(String(url)).pathname === "/health") {
      return json({ ok: false, code: secret, data: { license: secret } }, 503);
    }
    return fallback(url, init);
  };
  await assert.rejects(
    runStagingPortalDrill(validateOptions({
      LICENSECC_PORTAL_URL: PORTAL,
      LICENSECC_PORTAL_SESSION_COOKIE: "lccp_session=existing",
    }), { fetchFn }),
    (error) => error instanceof Error
      && /status=503; response_ok=false; envelope_ok=false; code_matches=false/u.test(error.message)
      && !error.message.includes(secret),
  );
});

test("portal drill rejects oversized JSON without retaining or reporting its body", async () => {
  const secret = "oversized-customer-data-must-not-appear";
  const calls = [];
  const fallback = makeFetch(calls);
  const fetchFn = async (url, init) => {
    if (new URL(String(url)).pathname === "/health") {
      return new Response(JSON.stringify({ secret: secret.repeat(20_000) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return fallback(url, init);
  };
  await assert.rejects(
    runStagingPortalDrill(validateOptions({
      LICENSECC_PORTAL_URL: PORTAL,
      LICENSECC_PORTAL_SESSION_COOKIE: "lccp_session=existing",
    }), { fetchFn }),
    (error) => error instanceof Error
      && /GET \/health exceeded the bounded response limit/u.test(error.message)
      && !error.message.includes(secret),
  );
});
