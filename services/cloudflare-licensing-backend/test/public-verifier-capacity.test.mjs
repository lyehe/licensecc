import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  buildEvidence,
  classifyHttpResponse,
  createRunSpec,
  createVerifyRequest,
  executeVerifyRequest,
  parseArgs,
  prepareRequestProofSigner,
  runCapacity,
} from "../scripts/public-verifier-capacity-lib.mjs";
import {
  ONLINE_REQUEST_PROOF_PURPOSE,
  REQUEST_PROOF_ALGORITHM,
  REQUEST_PROOF_VERSION,
  canonicalRequestProofPayload,
  deriveDeviceKeyId,
  verifyRequestProofSignature,
} from "../src/device/request_proof.mjs";

const FINGERPRINT = "a".repeat(64);
const COMMIT_SHA = "b".repeat(40);
const PRIVATE_KEY_BEGIN = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
const PRIVATE_KEY_END = ["-----END ", "PRIVATE KEY-----"].join("");

function baseInput(overrides = {}) {
  return {
    mode: "rehearsal",
    url: "https://verifier.example.workers.dev",
    peakRps: 10,
    maxConcurrency: 4,
    durationMs: 1_000,
    fingerprint: FINGERPRINT,
    environment: "local-test",
    ...overrides,
  };
}

function passingRun(spec, overrides = {}) {
  const completed = overrides.completed ?? spec.plannedRequests;
  return {
    elapsedMs: spec.durationMs,
    dispatched: completed,
    completed,
    missedDueToConcurrency: 0,
    maxObservedConcurrency: Math.min(spec.maxConcurrency, completed),
    maxSchedulerLagMs: 0.25,
    schedulerTickMs: 5,
    categoryCounts: {
      allowed: completed,
      expected_deny: 0,
      rate_limited: 0,
      unexpected_client_response: 0,
      unexpected_server_error: 0,
      timeout: 0,
      transport_error: 0,
      response_too_large: 0,
      invalid_response: 0,
      harness_error: 0,
    },
    statusCounts: { 200: completed },
    latency: { p50: 40, p95: 80, p99: 120, max: 150 },
    ...overrides,
  };
}

test("acceptance modes apply P multipliers and cannot be shortened", () => {
  const burst = createRunSpec(baseInput({
    mode: "burst",
    durationMs: 30 * 60 * 1_000,
    commitSha: COMMIT_SHA,
    environment: "staging",
  }));
  assert.equal(burst.acceptanceEligible, true);
  assert.equal(burst.targetRps, 20);
  assert.equal(burst.plannedRequests, 36_000);

  const soak = createRunSpec(baseInput({
    mode: "soak",
    durationMs: 4 * 60 * 60 * 1_000,
    commitSha: COMMIT_SHA,
    environment: "staging",
  }));
  assert.equal(soak.targetRps, 10);
  assert.equal(soak.plannedRequests, 144_000);

  assert.throws(
    () => createRunSpec(baseInput({ mode: "burst", durationMs: 1_799_999, commitSha: COMMIT_SHA })),
    /duration_out_of_range/,
  );
  assert.throws(
    () => createRunSpec(baseInput({ mode: "soak", durationMs: 14_399_999, commitSha: COMMIT_SHA })),
    /duration_out_of_range/,
  );
  assert.throws(
    () => createRunSpec(baseInput({ mode: "burst", durationMs: 1_800_000, commitSha: COMMIT_SHA, expectedResult: "deny" })),
    /acceptance_runs_must_expect_allow/,
  );
});

test("rehearsal stays short and explicitly non-promotable", () => {
  const spec = createRunSpec(baseInput({ durationMs: 100, expectedResult: "deny" }));
  assert.equal(spec.acceptanceEligible, false);
  assert.equal(spec.minimumDurationMs, 100);
  assert.equal(spec.expectedResult, "deny");
  assert.equal(createRunSpec(baseInput({ peakRps: 0.5, durationMs: 100 })).plannedRequests, 1);
  assert.throws(() => createRunSpec(baseInput({ durationMs: 60_001 })), /duration_out_of_range/);
});

test("argument parsing requires declared load and exact acceptance identity", () => {
  const parsed = parseArgs([], {
    LICENSECC_CAPACITY_MODE: "burst",
    LICENSECC_CAPACITY_URL: "https://verifier.example.workers.dev/",
    LICENSECC_CAPACITY_PEAK_RPS: "12.5",
    LICENSECC_CAPACITY_MAX_CONCURRENCY: "8",
    LICENSECC_CAPACITY_FINGERPRINT: FINGERPRINT,
    LICENSECC_CAPACITY_ENVIRONMENT: "staging",
    LICENSECC_RELEASE_COMMIT: COMMIT_SHA,
  });
  assert.equal(parsed.url, "https://verifier.example.workers.dev");
  assert.equal(parsed.peakRps, 12.5);
  assert.equal(parsed.targetRps, 25);
  assert.equal(parsed.maxConcurrency, 8);
  assert.throws(
    () => parseArgs(["--mode=rehearsal", "--url=https://verifier.example", `--fingerprint=${FINGERPRINT}`], {}),
    /peak_rps_out_of_range/,
  );
  assert.throws(() => parseArgs(["--secret=do-not-echo"], {}), /unknown_option/);
});

test("realistic verify bodies use unique nonces, no cosmetic authorization, and remain bounded", async () => {
  const spec = createRunSpec(baseInput({ deviceHash: "c".repeat(64) }));
  let sequence = 0;
  const first = await createVerifyRequest(spec, { nonceFactory: () => String(sequence++).padStart(64, "0") });
  const second = await createVerifyRequest(spec, { nonceFactory: () => String(sequence++).padStart(64, "0") });
  const firstBody = JSON.parse(first.init.body);
  const secondBody = JSON.parse(second.init.body);
  assert.equal(first.url, "https://verifier.example.workers.dev/v1/verify");
  assert.equal(first.init.method, "POST");
  assert.equal(first.init.headers.authorization, undefined);
  assert.equal(firstBody.project, "DEFAULT");
  assert.equal(firstBody.feature, "DEFAULT");
  assert.equal(firstBody.license_fingerprint, FINGERPRINT);
  assert.equal(firstBody.device_hash, "c".repeat(64));
  assert.notEqual(firstBody.nonce, secondBody.nonce);
  assert.match(firstBody.nonce, /^[0-9a-f]{64}$/);
  assert.ok(first.bodyBytes <= 4_096);
  assert.equal(first.init.redirect, "error");
});

test("hardened requests sign the canonical proof without exposing private material", async () => {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const spki = new Uint8Array(await webcrypto.subtle.exportKey("spki", keyPair.publicKey));
  const privatePem = `${PRIVATE_KEY_BEGIN}\n${pkcs8.toString("base64").match(/.{1,64}/g).join("\n")}\n${PRIVATE_KEY_END}\n`;
  const deviceKeyId = await deriveDeviceKeyId(spki);
  const spec = createRunSpec(baseInput({
    devicePrivateKeyPem: privatePem,
    deviceKeyId,
    deviceHash: "c".repeat(64),
  }));
  const proofSigner = await prepareRequestProofSigner(spec);
  const request = await createVerifyRequest(spec, {
    proofSigner,
    nonceFactory: () => "d".repeat(64),
    epochNow: () => 1_800_000_000_000,
  });
  const body = JSON.parse(request.init.body);
  assert.equal(body.request_signature_version, REQUEST_PROOF_VERSION);
  assert.equal(body.device_key_id, deviceKeyId);
  assert.equal(body.request_timestamp, 1_800_000_000);
  assert.equal(body.request_signature_algorithm, REQUEST_PROOF_ALGORITHM);
  const canonical = canonicalRequestProofPayload({
    purpose: ONLINE_REQUEST_PROOF_PURPOSE,
    version: REQUEST_PROOF_VERSION,
    algorithm: REQUEST_PROOF_ALGORITHM,
    project: spec.project,
    feature: spec.feature,
    licenseFingerprint: spec.fingerprint,
    deviceHash: spec.deviceHash,
    nonce: body.nonce,
    requestTimestamp: body.request_timestamp,
    clientHardening: 0,
    deviceKeyId,
  });
  assert.equal(
    await verifyRequestProofSignature(
      canonical,
      Buffer.from(spki).toString("base64"),
      body.request_signature,
      deviceKeyId,
    ),
    true,
  );
  assert.equal(request.init.body.includes(privatePem), false);
});

test("HTTP responses classify allows, denials, limits, and unexpected failures separately", () => {
  assert.equal(classifyHttpResponse(200, { ok: true, assertion: "lccoa1.payload.signature" }), "allowed");
  assert.equal(classifyHttpResponse(200, { ok: false, code: "entitlement_denied" }), "expected_deny");
  assert.equal(classifyHttpResponse(429, { ok: false, code: "rate_limited" }), "rate_limited");
  assert.equal(classifyHttpResponse(503, { ok: false, code: "config_error" }), "unexpected_server_error");
  assert.equal(classifyHttpResponse(401, { ok: false, code: "unauthorized" }), "unexpected_client_response");
  assert.equal(classifyHttpResponse(200, { ok: true }), "invalid_response");
});

test("request execution bounds response bodies and never returns response payloads", async () => {
  const spec = createRunSpec(baseInput());
  let observedBody;
  let now = 100;
  const allowed = await executeVerifyRequest(spec, {
    monotonicNow: () => now,
    nonceFactory: () => "d".repeat(64),
    async fetchImpl(_url, init) {
      observedBody = JSON.parse(init.body);
      now += 37;
      return new Response(JSON.stringify({ ok: true, assertion: "sensitive-signed-assertion" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(allowed, { category: "allowed", status: 200, latencyMs: 37 });
  assert.equal(observedBody.license_fingerprint, FINGERPRINT);
  assert.equal(Object.hasOwn(allowed, "payload"), false);

  const oversized = await executeVerifyRequest(spec, {
    async fetchImpl() {
      return new Response("x", { status: 200, headers: { "content-length": "65537" } });
    },
  });
  assert.equal(oversized.category, "response_too_large");
});

test("request execution reports timeouts and transport failures without error text", async () => {
  const spec = createRunSpec(baseInput({ timeoutMs: 5 }));
  const timedOut = await executeVerifyRequest(spec, {
    fetchImpl(_url, init) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("sensitive timeout detail");
          error.name = "AbortError";
          reject(error);
        });
      });
    },
  });
  assert.equal(timedOut.category, "timeout");
  assert.equal(Object.hasOwn(timedOut, "error"), false);

  const transport = await executeVerifyRequest(spec, {
    async fetchImpl() {
      throw new Error("sensitive transport detail");
    },
  });
  assert.equal(transport.category, "transport_error");
  assert.equal(JSON.stringify(transport).includes("sensitive"), false);
});

test("the open-loop scheduler offers every planned slot with an injected clock", async () => {
  const spec = createRunSpec(baseInput({ peakRps: 10, maxConcurrency: 10, durationMs: 1_000 }));
  let now = 0;
  const sequences = [];
  const run = await runCapacity(spec, {
    monotonicNow: () => now,
    async sleepImpl(ms) {
      now += ms;
    },
    async requestImpl(_value, sequence) {
      sequences.push(sequence);
      return { category: "allowed", status: 200, latencyMs: 42 };
    },
  });
  assert.equal(spec.plannedRequests, 10);
  assert.deepEqual(sequences, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(run.dispatched, 10);
  assert.equal(run.completed, 10);
  assert.equal(run.missedDueToConcurrency, 0);
  assert.ok(run.maxObservedConcurrency <= 10);
  assert.deepEqual(run.latency, { p50: 42, p95: 42, p99: 42, max: 42 });
});

test("concurrency saturation drops scheduled slots instead of queuing without bound", async () => {
  const spec = createRunSpec(baseInput({ peakRps: 100, maxConcurrency: 1, durationMs: 100 }));
  const run = await runCapacity(spec, {
    async requestImpl() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { category: "allowed", status: 200, latencyMs: 25 };
    },
  });
  assert.equal(run.maxObservedConcurrency, 1);
  assert.ok(run.missedDueToConcurrency > 0);
  assert.ok(run.dispatched < spec.plannedRequests);
  const evidence = buildEvidence(spec, run, new Date("2026-08-30T00:00:00Z"));
  assert.ok(evidence.failures.includes("scheduled_load_completed"));
});

test("objective boundaries are strict at 500 ms, 1 second, and 0.1 percent", () => {
  const spec = createRunSpec(baseInput({ peakRps: 1, durationMs: 1_000 }));
  const categories = passingRun(spec).categoryCounts;
  categories.allowed = 999;
  categories.unexpected_server_error = 1;
  const evidence = buildEvidence(spec, passingRun(spec, {
    completed: 1_000,
    dispatched: 1_000,
    categoryCounts: categories,
    statusCounts: { 200: 999, 503: 1 },
    latency: { p50: 40, p95: 500, p99: 1_000, max: 1_000 },
  }), new Date("2026-08-30T00:00:00Z"));
  assert.equal(evidence.measurements.unexpected_server_error_percent, 0.1);
  assert.deepEqual(
    evidence.failures.filter((failure) => failure !== "scheduled_load_completed"),
    ["latency_p95", "latency_p99", "unexpected_server_error_rate"],
  );
});

test("evidence redacts the target, identity, proof key, and payload", () => {
  const spec = createRunSpec(baseInput({
    url: "https://sensitive-target.example",
    project: "SENSITIVE_PROJECT",
    feature: "SECRET_FEATURE",
    fingerprint: "e".repeat(64),
    deviceHash: "f".repeat(64),
    devicePrivateKeyPem: `${PRIVATE_KEY_BEGIN}\nPRIVATE-SECRET\n${PRIVATE_KEY_END}`,
    deviceKeyId: `sha256:${"1".repeat(64)}`,
  }));
  const evidence = buildEvidence(spec, passingRun(spec), new Date("2026-08-30T00:00:00Z"));
  const serialized = JSON.stringify(evidence);
  assert.equal(evidence.verdict, "rehearsal_pass");
  assert.equal(evidence.schema_version, "licensecc.public-verifier-capacity.evidence.v1");
  assert.equal(evidence.gate_completion, "partial_evidence_only");
  assert.ok(evidence.external_evidence_required.includes("passing_burst_run"));
  assert.equal(evidence.acceptance_eligible, false);
  assert.equal(evidence.target, "<redacted>");
  assert.equal(serialized.includes("sensitive-target"), false);
  assert.equal(serialized.includes("SENSITIVE_PROJECT"), false);
  assert.equal(serialized.includes("SECRET_FEATURE"), false);
  assert.equal(serialized.includes("e".repeat(64)), false);
  assert.equal(serialized.includes("f".repeat(64)), false);
  assert.equal("authorization_present" in evidence.request_profile, false);
  assert.equal(serialized.includes("PRIVATE-SECRET"), false);
  assert.equal(serialized.includes(`sha256:${"1".repeat(64)}`), false);
  assert.equal(evidence.request_profile.payload, "<redacted>");
  assert.equal(evidence.request_profile.request_proof_present, true);
});
