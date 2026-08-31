import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";

import {
  buildLeaseLicenseText,
  buildV201CanonicalPayload,
  leaseCanonicalFields,
} from "@licensecc/licensing-domain/lease/canonical_payload";

import {
  parseStagingLeaseEnvironment,
  runStagingLeaseDrill,
} from "../scripts/staging-lease-drill.mjs";

const FINGERPRINT = "a".repeat(64);
const DEVICE_KEY_ID = `sha256:${"b".repeat(64)}`;
const LEASE_KEYS = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
  publicKeyEncoding: { type: "pkcs1", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const LEASE_PUBLIC_KEY_B64 = LEASE_KEYS.publicKey.toString("base64");
const LEASE_KEY_ID = `sha256:${createHash("sha256").update(LEASE_KEYS.publicKey).digest("hex")}`;
const ACCOUNT_TOKEN = "account-token-secret-sentinel";
const PRIVATE_KEY = `${["-----BEGIN ", "PRIVATE KEY-----"].join("")}\nprivate-device-key-secret-sentinel`;
const COMMIT = "d1".repeat(20);
const SERVER_TIME = 1_800_000_000;
const RENEW_BY = 1_800_001_000;
const VALID_TO_EPOCH = 1_800_002_000;

function environment(overrides = {}) {
  return {
    LICENSECC_STAGING_LEASE_DRILL_URL: "https://backend.staging.licensecc.dev",
    LICENSECC_STAGING_LEASE_ACCOUNT_TOKEN: ACCOUNT_TOKEN,
    LICENSECC_STAGING_LEASE_DEVICE_PRIVATE_KEY_PKCS8_PEM: PRIVATE_KEY,
    LICENSECC_STAGING_LEASE_PUBLIC_KEY_PKCS1_DER_BASE64: LEASE_PUBLIC_KEY_B64,
    LICENSECC_STAGING_LEASE_FIXTURE_JSON: JSON.stringify({
      project: "SYNTHETIC_PROJECT",
      feature: "SYNTHETIC",
      license_fingerprint: FINGERPRINT,
      device_key_id: DEVICE_KEY_ID,
      expected_lease_key_id: LEASE_KEY_ID,
    }),
    LICENSECC_STAGING_LEASE_RUN_ID: "123456",
    LICENSECC_STAGING_LEASE_RUN_ATTEMPT: "2",
    LICENSECC_STAGING_LEASE_COMMIT: COMMIT,
    ...overrides,
  };
}

function licenseText(overrides = {}) {
  const fields = leaseCanonicalFields({
    keyId: LEASE_KEY_ID,
    project: "SYNTHETIC_PROJECT",
    feature: "SYNTHETIC",
    validFrom: new Date((SERVER_TIME - 2 * 86_400) * 1_000).toISOString().slice(0, 10),
    validTo: new Date(VALID_TO_EPOCH * 1_000).toISOString().slice(0, 10),
    ...overrides,
  });
  const payload = buildV201CanonicalPayload(fields);
  const signature = sign("RSA-SHA256", Buffer.from(payload.bytes), LEASE_KEYS.privateKey).toString("base64");
  return buildLeaseLicenseText(fields, signature);
}

function successResponse(extra = {}) {
  return new Response(JSON.stringify({
    ok: true,
    lic: licenseText(),
    server_time: SERVER_TIME,
    renew_by: RENEW_BY,
    valid_to_epoch: VALID_TO_EPOCH,
    customer_id: "customer-response-secret-sentinel",
    ...extra,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("lease drill accepts only canonical staging protected fixtures", () => {
  const parsed = parseStagingLeaseEnvironment(environment());
  assert.equal(parsed.fixture.expectedLeaseKeyId, LEASE_KEY_ID);
  assert.equal(parsed.leasePublicKey.asymmetricKeyType, "rsa");
  for (const override of [
    { LICENSECC_STAGING_LEASE_DRILL_URL: "http://backend.staging.licensecc.dev" },
    { LICENSECC_STAGING_LEASE_DRILL_URL: "https://backend.production.licensecc.dev" },
    { LICENSECC_STAGING_LEASE_ACCOUNT_TOKEN: "bad\ntoken" },
    { LICENSECC_STAGING_LEASE_PUBLIC_KEY_PKCS1_DER_BASE64: Buffer.from("not-an-rsa-key").toString("base64") },
    { LICENSECC_STAGING_LEASE_PUBLIC_KEY_PKCS1_DER_BASE64: `${LEASE_PUBLIC_KEY_B64}= ` },
    { LICENSECC_STAGING_LEASE_COMMIT: "e".repeat(39) },
    { LICENSECC_STAGING_LEASE_RUN_ATTEMPT: "0" },
    { LICENSECC_STAGING_LEASE_FIXTURE_JSON: JSON.stringify({ project: "SYNTHETIC_PROJECT" }) },
    { LICENSECC_STAGING_LEASE_FIXTURE_JSON: JSON.stringify({
      project: "SYNTHETIC_PROJECT", feature: "too-long-feature", license_fingerprint: FINGERPRINT,
      device_key_id: DEVICE_KEY_ID, expected_lease_key_id: LEASE_KEY_ID,
    }) },
  ]) {
    assert.throws(() => parseStagingLeaseEnvironment(environment(override)), /invalid_protected_input/u);
  }
});

test("activate and renew exercise account token, fresh device proof, and lease signing without leaking fixtures", async () => {
  const calls = [];
  let nonceIndex = 0;
  const result = await runStagingLeaseDrill({
    env: environment(),
    nowMs: 1_800_000_000_000,
    nonceFactory: () => String(++nonceIndex).padStart(64, "0"),
    proofSigner: async ({ nonce, timestamp }) => Buffer.alloc(64, (nonce.charCodeAt(63) + timestamp) % 255 || 1).toString("base64"),
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return successResponse({ raw_payload: init.body, authorization: init.headers.authorization });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.verdict, "pass");
  assert.deepEqual(result.evidence.request_profile, {
    account_token_present: true,
    device_proof_present: true,
    lease_public_key_validated: true,
    payload: "redacted",
  });
  for (const operation of ["activate", "renew"]) {
    assert.deepEqual(result.evidence[operation], {
      status: 200,
      ok: true,
      code: "lease_issued",
      lease_v201: true,
      expected_lease_key_id_match: true,
      fixture_scope_match: true,
      lease_signature_cryptographically_verified: true,
      server_time_present: true,
      renew_by_present: true,
      valid_to_present: true,
      envelope_ordering_valid: true,
      server_clock_within_request_skew: true,
      signed_validity_window_matches_envelope: true,
    });
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://backend.staging.licensecc.dev/v1/activate",
    "https://backend.staging.licensecc.dev/v1/renew",
  ]);
  assert.equal(calls.every((call) => call.init.headers.authorization === `Bearer ${ACCOUNT_TOKEN}`), true);
  assert.equal(calls.every((call) => call.init.redirect === "error"), true);
  assert.notEqual(calls[0].body.nonce, calls[1].body.nonce);
  assert.notEqual(calls[0].body.request_id, calls[1].body.request_id);
  assert.equal(calls.every((call) => call.body.request_signature_version === 1), true);
  assert.equal(calls.every((call) => call.body.request_signature_algorithm === "ecdsa-p256-sha256"), true);
  const serialized = JSON.stringify(result.evidence);
  for (const forbidden of [
    ACCOUNT_TOKEN, PRIVATE_KEY, FINGERPRINT, DEVICE_KEY_ID, LEASE_KEY_ID,
    "SYNTHETIC_PROJECT", "customer-response-secret-sentinel", calls[0].init.body,
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(result.evidence.semantics.presented_device_proof, "verified_even_when_topology_mode_is_off");
  assert.equal(result.evidence.semantics.lease_signing, "cryptographically_verified_with_expected_public_key");
  assert.equal(result.evidence.semantics.account_token_authorization, "authorized_fixture_tuple_exercised");
});

test("authorization and lease-shape failures fail the drill with safe classifications", async () => {
  let calls = 0;
  const result = await runStagingLeaseDrill({
    env: environment(),
    nowMs: 1_800_000_000_000,
    nonceFactory: () => String(++calls).padStart(64, "0"),
    proofSigner: async () => Buffer.alloc(64, 2).toString("base64"),
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      code: "unauthorized",
      detail: "account-token-secret-response-diagnostic",
    }), { status: 401 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.failure_code, "unexpected_drill_result");
  assert.equal(result.evidence.activate.code, "unauthorized");
  assert.equal(result.evidence.renew.code, "unauthorized");
  assert.doesNotMatch(JSON.stringify(result.evidence), /account-token-secret-response-diagnostic/u);
});

test("a live-format lease with an invalid RSA signature cannot satisfy readiness", async () => {
  const invalidLicense = licenseText().replace(
    /^sig = .*$/mu,
    `sig = ${Buffer.alloc(256, 0x5a).toString("base64")}`,
  );
  const result = await runStagingLeaseDrill({
    env: environment(),
    nowMs: 1_800_000_000_000,
    nonceFactory: () => "3".repeat(64),
    proofSigner: async () => Buffer.alloc(64, 2).toString("base64"),
    fetchImpl: async () => successResponse({ lic: invalidLicense }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.failure_code, "unexpected_drill_result");
  assert.equal(result.evidence.activate.lease_signature_cryptographically_verified, false);
  assert.equal(result.evidence.renew.lease_signature_cryptographically_verified, false);
});

test("lease time evidence requires ordering, request-clock proximity, and signed-date coherence", async () => {
  const cases = [
    {
      response: { renew_by: VALID_TO_EPOCH + 1 },
      failedCheck: "envelope_ordering_valid",
    },
    {
      response: { server_time: SERVER_TIME + 301 },
      failedCheck: "server_clock_within_request_skew",
    },
    {
      response: { valid_to_epoch: VALID_TO_EPOCH + 86_400 },
      failedCheck: "signed_validity_window_matches_envelope",
    },
  ];
  for (const { response, failedCheck } of cases) {
    const result = await runStagingLeaseDrill({
      env: environment(),
      nowMs: SERVER_TIME * 1_000,
      nonceFactory: () => "5".repeat(64),
      proofSigner: async () => Buffer.alloc(64, 2).toString("base64"),
      fetchImpl: async () => successResponse(response),
    });
    assert.equal(result.ok, false);
    assert.equal(result.evidence.failure_code, "unexpected_drill_result");
    assert.equal(result.evidence.activate[failedCheck], false);
    assert.equal(result.evidence.renew[failedCheck], false);
  }
});

test("the signed license section must be the exact protected fixture feature", async () => {
  const wrongSection = licenseText().replace("[SYNTHETIC]", "[OTHER]");
  const result = await runStagingLeaseDrill({
    env: environment(),
    nowMs: 1_800_000_000_000,
    nonceFactory: () => "4".repeat(64),
    proofSigner: async () => Buffer.alloc(64, 2).toString("base64"),
    fetchImpl: async () => successResponse({ lic: wrongSection }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.failure_code, "invalid_lease_response");
});

test("lease responses and request wall time are bounded", async () => {
  const oversized = await runStagingLeaseDrill({
    env: environment(),
    nowMs: 1_800_000_000_000,
    nonceFactory: () => "1".repeat(64),
    proofSigner: async () => Buffer.alloc(64, 2).toString("base64"),
    fetchImpl: async () => new Response("private-oversized-response", {
      status: 200,
      headers: { "content-length": "32769" },
    }),
  });
  assert.equal(oversized.evidence.failure_code, "remote_response_too_large");
  assert.doesNotMatch(JSON.stringify(oversized.evidence), /private-oversized-response/u);

  const timeout = await runStagingLeaseDrill({
    env: environment(),
    nowMs: 1_800_000_000_000,
    nonceFactory: () => "2".repeat(64),
    proofSigner: async () => Buffer.alloc(64, 2).toString("base64"),
    requestTimeoutMs: 25,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("private-timeout-diagnostic")), { once: true });
    }),
  });
  assert.equal(timeout.evidence.failure_code, "remote_request_timeout");
  assert.doesNotMatch(JSON.stringify(timeout.evidence), /private-timeout-diagnostic/u);
});

test("invalid protected input is rejected before traffic without claiming credentials were validated", async () => {
  let calls = 0;
  const result = await runStagingLeaseDrill({
    env: environment({ LICENSECC_STAGING_LEASE_ACCOUNT_TOKEN: "bad\ntoken" }),
    fetchImpl: async () => {
      calls += 1;
      return successResponse();
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.evidence.failure_code, "invalid_protected_input");
  assert.deepEqual(result.evidence.request_profile, {
    account_token_present: false,
    device_proof_present: false,
    lease_public_key_validated: false,
    payload: "redacted",
  });
});
