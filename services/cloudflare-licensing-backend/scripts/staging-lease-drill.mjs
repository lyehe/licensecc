#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  webcrypto,
} from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CANONICAL_ORDER,
  buildV201CanonicalPayload,
} from "@licensecc/licensing-domain/lease/canonical_payload";

import {
  LEASE_REQUEST_PROOF_PURPOSE,
  REQUEST_PROOF_ALGORITHM,
  REQUEST_PROOF_VERSION,
  canonicalRequestProofPayload,
} from "../src/device/request_proof.mjs";

const MAX_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_SERVER_CLOCK_SKEW_SECONDS = 300;
const MAX_UNIX_SECONDS_FOR_ISO_DATE = 253_402_300_799;
const PRIVATE_KEY_BEGIN = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
const PRIVATE_KEY_END = ["-----END ", "PRIVATE KEY-----"].join("");
const PROJECT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const FEATURE_NAME = /^[A-Z0-9_.-]+$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const DEVICE_KEY_ID = /^sha256:[0-9a-f]{64}$/u;
const RESPONSE_CODE = /^[a-z][a-z0-9_]{0,39}$/u;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const LICENSE_STORAGE_FIELDS = new Set([
  ...CANONICAL_ORDER.filter((key) => key !== "project" && key !== "feature"),
  "sig",
]);

class LeaseDrillError extends Error {
  constructor(code) {
    super(code);
    this.name = "LeaseDrillError";
    this.code = code;
  }
}

function fail(code) {
  throw new LeaseDrillError(code);
}

function required(env, name, maxLength) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.trim() !== value) {
    fail("invalid_protected_input");
  }
  return value;
}

function requiredRaw(env, name, maxLength) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) fail("invalid_protected_input");
  return value;
}

function stagingOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("invalid_protected_input");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    url.pathname !== "/" || url.search || url.hash || url.origin !== value ||
    !url.hostname.toLowerCase().split(".").includes("staging")
  ) {
    fail("invalid_protected_input");
  }
  return url.origin;
}

function strictPositive(value, maxDigits) {
  if (!new RegExp(`^[1-9][0-9]{0,${maxDigits - 1}}$`, "u").test(value) || !Number.isSafeInteger(Number(value))) {
    fail("invalid_protected_input");
  }
  return value;
}

function fixtureJson(value) {
  let fixture;
  try {
    fixture = JSON.parse(value);
  } catch {
    fail("invalid_protected_input");
  }
  if (typeof fixture !== "object" || fixture === null || Array.isArray(fixture)) fail("invalid_protected_input");
  const expected = ["device_key_id", "expected_lease_key_id", "feature", "license_fingerprint", "project"];
  if (JSON.stringify(Object.keys(fixture).sort()) !== JSON.stringify(expected)) fail("invalid_protected_input");
  if (
    typeof fixture.project !== "string" || fixture.project.length > 127 || !PROJECT_NAME.test(fixture.project) ||
    typeof fixture.feature !== "string" || fixture.feature.length > 15 || !FEATURE_NAME.test(fixture.feature) ||
    typeof fixture.license_fingerprint !== "string" || !HEX_64.test(fixture.license_fingerprint) ||
    typeof fixture.device_key_id !== "string" || !DEVICE_KEY_ID.test(fixture.device_key_id) ||
    typeof fixture.expected_lease_key_id !== "string" || !DEVICE_KEY_ID.test(fixture.expected_lease_key_id)
  ) {
    fail("invalid_protected_input");
  }
  return Object.freeze({
    project: fixture.project,
    feature: fixture.feature,
    fingerprint: fixture.license_fingerprint,
    deviceKeyId: fixture.device_key_id,
    expectedLeaseKeyId: fixture.expected_lease_key_id,
  });
}

function leaseVerificationKey(value, expectedKeyId) {
  if (!CANONICAL_BASE64.test(value)) fail("invalid_protected_input");
  const der = Buffer.from(value, "base64");
  if (
    der.byteLength < 128 || der.byteLength > 2_048 ||
    der.toString("base64") !== value ||
    `sha256:${createHash("sha256").update(der).digest("hex")}` !== expectedKeyId
  ) {
    fail("invalid_protected_input");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: "der", type: "pkcs1" });
    const canonicalDer = publicKey.export({ format: "der", type: "pkcs1" });
    const modulusLength = publicKey.asymmetricKeyDetails?.modulusLength;
    if (
      publicKey.asymmetricKeyType !== "rsa" ||
      !Buffer.isBuffer(canonicalDer) || !canonicalDer.equals(der) ||
      !Number.isInteger(modulusLength) || modulusLength < 2_048 || modulusLength > 4_096
    ) {
      fail("invalid_protected_input");
    }
  } catch (error) {
    if (error instanceof LeaseDrillError) throw error;
    fail("invalid_protected_input");
  }
  return publicKey;
}

function pemToDer(pem) {
  const normalized = pem.trim();
  if (!normalized.startsWith(PRIVATE_KEY_BEGIN) || !normalized.endsWith(PRIVATE_KEY_END)) fail("invalid_protected_input");
  const encoded = normalized.slice(PRIVATE_KEY_BEGIN.length, -PRIVATE_KEY_END.length).replace(/\s+/gu, "");
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    fail("invalid_protected_input");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== encoded) fail("invalid_protected_input");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function parseStagingLeaseEnvironment(env) {
  const origin = stagingOrigin(required(env, "LICENSECC_STAGING_LEASE_DRILL_URL", 512));
  const accountToken = required(env, "LICENSECC_STAGING_LEASE_ACCOUNT_TOKEN", 4_096);
  if (/[\r\n]/u.test(accountToken)) fail("invalid_protected_input");
  const devicePrivateKeyPem = requiredRaw(env, "LICENSECC_STAGING_LEASE_DEVICE_PRIVATE_KEY_PKCS8_PEM", 16_384);
  const fixture = fixtureJson(required(env, "LICENSECC_STAGING_LEASE_FIXTURE_JSON", 2_048));
  const leasePublicKey = leaseVerificationKey(
    required(env, "LICENSECC_STAGING_LEASE_PUBLIC_KEY_PKCS1_DER_BASE64", 4_096),
    fixture.expectedLeaseKeyId,
  );
  const runId = strictPositive(required(env, "LICENSECC_STAGING_LEASE_RUN_ID", 20), 20);
  const runAttempt = strictPositive(required(env, "LICENSECC_STAGING_LEASE_RUN_ATTEMPT", 6), 6);
  const commit = required(env, "LICENSECC_STAGING_LEASE_COMMIT", 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(commit)) fail("invalid_protected_input");
  return Object.freeze({ origin, accountToken, devicePrivateKeyPem, fixture, leasePublicKey, runId, runAttempt, commit });
}

async function prepareSigner(config) {
  let key;
  try {
    key = await webcrypto.subtle.importKey(
      "pkcs8",
      pemToDer(config.devicePrivateKeyPem),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    if (error instanceof LeaseDrillError) throw error;
    fail("invalid_protected_input");
  }
  return async ({ nonce, timestamp }) => {
    const canonical = canonicalRequestProofPayload({
      purpose: LEASE_REQUEST_PROOF_PURPOSE,
      version: REQUEST_PROOF_VERSION,
      algorithm: REQUEST_PROOF_ALGORITHM,
      project: config.fixture.project,
      feature: config.fixture.feature,
      licenseFingerprint: config.fixture.fingerprint,
      deviceHash: "",
      nonce,
      requestTimestamp: timestamp,
      clientHardening: 0,
      deviceKeyId: config.fixture.deviceKeyId,
    });
    const signature = new Uint8Array(await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(canonical),
    ));
    if (signature.byteLength !== 64) fail("device_signature_failed");
    return Buffer.from(signature).toString("base64");
  };
}

function requestBody(config, operation, nowMs, nonce, signature) {
  const timestamp = Math.floor(nowMs / 1_000);
  const body = JSON.stringify({
    project: config.fixture.project,
    feature: config.fixture.feature,
    license_fingerprint: config.fixture.fingerprint,
    device_key_id: config.fixture.deviceKeyId,
    request_id: `lcc-staging-${operation}-${config.runId}-${config.runAttempt}-${nowMs}`,
    nonce,
    client_hardening: 0,
    request_signature_version: REQUEST_PROOF_VERSION,
    request_timestamp: timestamp,
    request_signature_algorithm: REQUEST_PROOF_ALGORITHM,
    request_signature: signature,
  });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) fail("request_too_large");
  return body;
}

async function readBoundedResponse(response, controller, config) {
  if (typeof response?.status !== "number" || response.body === null) fail("invalid_remote_response");
  const declared = Number(response.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    controller.abort();
    fail("remote_response_too_large");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        controller.abort();
        void reader.cancel();
        fail("remote_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid_remote_response");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("invalid_remote_response");
  if (parsed.ok !== true || typeof parsed.lic !== "string" || parsed.lic.length === 0 || parsed.lic.length > 16_384) {
    const code = typeof parsed.code === "string" && RESPONSE_CODE.test(parsed.code) ? parsed.code : "invalid_response";
    return { status: response.status, ok: false, code };
  }
  return {
    status: response.status,
    ok: true,
    code: "lease_issued",
    lease: parseLeaseEnvelope(parsed.lic, config),
    serverTime: parsed.server_time,
    renewBy: parsed.renew_by,
    validToEpoch: parsed.valid_to_epoch,
  };
}

function parseLeaseEnvelope(license, config) {
  if (!license.endsWith("\n") || license.includes("\r") || license.includes("\0")) fail("invalid_lease_response");
  const lines = license.split("\n");
  if (lines.length > 64 || lines[0] !== `[${config.fixture.feature}]` || lines.at(-1) !== "") {
    fail("invalid_lease_response");
  }
  const fields = new Map();
  for (const line of lines.slice(1, -1)) {
    const match = /^([a-z][a-z0-9_-]{0,39}) = ([\x20-\x7e]{1,2048})$/u.exec(line);
    if (!match || !LICENSE_STORAGE_FIELDS.has(match[1]) || fields.has(match[1])) fail("invalid_lease_response");
    fields.set(match[1], match[2]);
  }
  const signature = fields.get("sig") ?? "";
  if (!CANONICAL_BASE64.test(signature)) fail("invalid_lease_response");
  const signatureBytes = Buffer.from(signature, "base64");
  const expectedSignatureBytes = config.leasePublicKey.asymmetricKeyDetails.modulusLength / 8;
  if (signatureBytes.byteLength !== expectedSignatureBytes || signatureBytes.toString("base64") !== signature) {
    fail("invalid_lease_response");
  }
  const canonicalFields = {
    project: config.fixture.project,
    feature: config.fixture.feature,
  };
  for (const field of CANONICAL_ORDER) {
    if (field !== "project" && field !== "feature" && fields.has(field)) {
      canonicalFields[field] = fields.get(field);
    }
  }
  let payload;
  try {
    payload = buildV201CanonicalPayload(canonicalFields);
  } catch {
    fail("invalid_lease_response");
  }
  const signatureVerified = verifySignature(
    "RSA-SHA256",
    Buffer.from(payload.bytes),
    config.leasePublicKey,
    signatureBytes,
  );
  return {
    version201: fields.get("lic_ver") === "201",
    expectedKeyIdMatch: fields.get("key-id") === config.fixture.expectedLeaseKeyId,
    fixtureScopeMatch: signatureVerified,
    signatureVerified,
    validFrom: fields.get("valid-from") ?? "",
    validTo: fields.get("valid-to") ?? "",
  };
}

async function sendLease({ config, operation, body, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${config.origin}/v1/${operation}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.accountToken}`,
        "content-type": "application/json",
      },
      body,
      redirect: "error",
      signal: controller.signal,
    });
    return await readBoundedResponse(response, controller, config);
  } catch (error) {
    if (error instanceof LeaseDrillError) throw error;
    fail(controller.signal.aborted ? "remote_request_timeout" : "remote_request_failed");
  } finally {
    clearTimeout(timeout);
  }
}

function baseEvidence(commit, protectedInputsValidated = false) {
  return {
    schema_version: "licensecc.staging-lease-readiness.v1",
    check: "staging_account_token_device_proof_lease_signing",
    environment: "staging",
    candidate_commit_sha: commit ?? null,
    target: "redacted",
    fixture: "protected_synthetic",
    request_profile: {
      account_token_present: protectedInputsValidated,
      device_proof_present: protectedInputsValidated,
      lease_public_key_validated: protectedInputsValidated,
      payload: "redacted",
    },
  };
}

function utcDate(epochSeconds) {
  if (
    !Number.isSafeInteger(epochSeconds) || epochSeconds < 0 ||
    epochSeconds > MAX_UNIX_SECONDS_FOR_ISO_DATE
  ) {
    return null;
  }
  return new Date(epochSeconds * 1_000).toISOString().slice(0, 10);
}

function safeResult(result, requestNowMs) {
  const lease = result.lease;
  const serverDate = utcDate(result.serverTime);
  const envelopeValidToDate = utcDate(result.validToEpoch);
  const serverTimePresent = serverDate !== null;
  const renewByPresent = Number.isSafeInteger(result.renewBy) && result.renewBy >= 0;
  const validToPresent = envelopeValidToDate !== null;
  return {
    status: result.status,
    ok: result.ok,
    code: result.code,
    lease_v201: lease?.version201 === true,
    expected_lease_key_id_match: lease?.expectedKeyIdMatch === true,
    fixture_scope_match: lease?.fixtureScopeMatch === true,
    lease_signature_cryptographically_verified: lease?.signatureVerified === true,
    server_time_present: serverTimePresent,
    renew_by_present: renewByPresent,
    valid_to_present: validToPresent,
    envelope_ordering_valid:
      serverTimePresent && renewByPresent && validToPresent &&
      result.serverTime < result.renewBy && result.renewBy <= result.validToEpoch,
    server_clock_within_request_skew:
      serverTimePresent && Math.abs(result.serverTime - Math.floor(requestNowMs / 1_000)) <= MAX_SERVER_CLOCK_SKEW_SECONDS,
    signed_validity_window_matches_envelope:
      serverDate !== null && envelopeValidToDate !== null &&
      typeof lease?.validFrom === "string" && typeof lease.validTo === "string" &&
      lease.validFrom <= serverDate && serverDate <= lease.validTo && lease.validTo === envelopeValidToDate,
  };
}

export async function runStagingLeaseDrill({
  env = process.env,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  nonceFactory = () => randomBytes(32).toString("hex"),
  proofSigner,
  requestTimeoutMs = MAX_TIMEOUT_MS,
} = {}) {
  let config;
  try {
    config = parseStagingLeaseEnvironment(env);
    if (typeof fetchImpl !== "function" || !Number.isSafeInteger(nowMs) || nowMs <= 0) fail("invalid_runtime_input");
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > MAX_TIMEOUT_MS) fail("invalid_runtime_input");
    const signer = proofSigner ?? await prepareSigner(config);
    const results = {};
    for (const [index, operation] of ["activate", "renew"].entries()) {
      const nonce = nonceFactory(operation);
      if (typeof nonce !== "string" || !HEX_64.test(nonce)) fail("invalid_nonce");
      const operationNow = nowMs + index;
      const timestamp = Math.floor(operationNow / 1_000);
      const signature = await signer({ nonce, timestamp, operation });
      if (typeof signature !== "string" || signature.length > 512 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(signature)) {
        fail("device_signature_failed");
      }
      const signatureBytes = Buffer.from(signature, "base64");
      if (signatureBytes.byteLength !== 64 || signatureBytes.toString("base64") !== signature) fail("device_signature_failed");
      const body = requestBody(config, operation, operationNow, nonce, signature);
      results[operation] = await sendLease({ config, operation, body, fetchImpl, timeoutMs: requestTimeoutMs });
    }
    const activate = safeResult(results.activate, nowMs);
    const renew = safeResult(results.renew, nowMs + 1);
    const checks = [activate, renew].every((result) =>
      result.status === 200 && result.ok && result.code === "lease_issued" && result.lease_v201 &&
      result.expected_lease_key_id_match && result.fixture_scope_match && result.lease_signature_cryptographically_verified &&
      result.server_time_present && result.renew_by_present && result.valid_to_present &&
      result.envelope_ordering_valid && result.server_clock_within_request_skew &&
      result.signed_validity_window_matches_envelope);
    return {
      ok: checks,
      evidence: {
        ...baseEvidence(config.commit, true),
        activate,
        renew,
        semantics: {
          account_token_authorization: "authorized_fixture_tuple_exercised",
          presented_device_proof: "verified_even_when_topology_mode_is_off",
          lease_signing: "cryptographically_verified_with_expected_public_key",
        },
        verdict: checks ? "pass" : "fail",
        ...(checks ? {} : { failure_code: "unexpected_drill_result" }),
      },
    };
  } catch (error) {
    return {
      ok: false,
      evidence: {
        ...baseEvidence(config?.commit),
        verdict: "fail",
        failure_code: error instanceof LeaseDrillError ? error.code : "staging_lease_drill_failed",
      },
    };
  }
}

async function main() {
  const result = process.argv.length === 2
    ? await runStagingLeaseDrill()
    : await runStagingLeaseDrill({ env: {} });
  process.stdout.write(`${JSON.stringify(result.evidence)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ ...baseEvidence(null), verdict: "fail", failure_code: "staging_lease_drill_failed" })}\n`);
    process.exitCode = 1;
  });
}
