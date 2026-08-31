import { randomBytes, webcrypto } from "node:crypto";
import {
  ONLINE_REQUEST_PROOF_PURPOSE,
  REQUEST_PROOF_ALGORITHM,
  REQUEST_PROOF_VERSION,
  canonicalRequestProofPayload,
} from "../src/device/request_proof.mjs";

const HEX_40 = /^[0-9a-f]{40}$/i;
const HEX_64 = /^[0-9a-f]{64}$/i;
const DEVICE_KEY_ID = /^sha256:[0-9a-f]{64}$/;
const PROOF_NAME = /^[A-Za-z0-9_.:-]+$/;
const SAFE_EXPECTATIONS = new Set(["allow", "deny", "rate-limit"]);
const RESPONSE_CATEGORIES = Object.freeze([
  "allowed",
  "expected_deny",
  "rate_limited",
  "unexpected_client_response",
  "unexpected_server_error",
  "timeout",
  "transport_error",
  "response_too_large",
  "invalid_response",
  "harness_error",
]);

const MODE_CONTRACTS = Object.freeze({
  burst: Object.freeze({ multiplier: 2, minimumDurationMs: 30 * 60 * 1_000, acceptanceEligible: true }),
  soak: Object.freeze({ multiplier: 1, minimumDurationMs: 4 * 60 * 60 * 1_000, acceptanceEligible: true }),
  rehearsal: Object.freeze({ multiplier: 1, minimumDurationMs: 100, acceptanceEligible: false }),
});

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REHEARSAL_DURATION_MS = 5_000;
const MAX_REHEARSAL_DURATION_MS = 60_000;
const MAX_ACCEPTANCE_DURATION_MS = 8 * 60 * 60 * 1_000;
const MAX_PEAK_RPS = 5_000;
const MAX_CONCURRENCY = 512;
const MAX_TIMEOUT_MS = 60_000;
const MAX_REQUEST_BODY_BYTES = 4_096;
const MAX_RESPONSE_BODY_BYTES = 65_536;
const AVAILABILITY_THRESHOLD_PERCENT = 99.9;
const EXPECTED_RESULT_THRESHOLD_PERCENT = 99.9;
const P95_THRESHOLD_MS = 500;
const P99_THRESHOLD_MS = 1_000;
const SERVER_ERROR_THRESHOLD_PERCENT = 0.1;
const SCHEMA_VERSION = "licensecc.public-verifier-capacity.evidence.v1";
const REDACTED = "<redacted>";
const PRIVATE_KEY_BEGIN = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
const PRIVATE_KEY_END = ["-----END ", "PRIVATE KEY-----"].join("");

class CapacityHarnessError extends Error {
  constructor(code) {
    super(code);
    this.name = "CapacityHarnessError";
  }
}

function fail(code) {
  throw new CapacityHarnessError(code);
}

function parseOptionMap(argv) {
  const allowed = new Set([
    "--mode",
    "--url",
    "--peak-rps",
    "--max-concurrency",
    "--duration-seconds",
    "--timeout-ms",
    "--project",
    "--feature",
    "--fingerprint",
    "--device-hash",
    "--expected-result",
    "--environment",
    "--commit-sha",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      fail("unexpected_positional_argument");
    }
    const equalsAt = token.indexOf("=");
    const name = equalsAt === -1 ? token : token.slice(0, equalsAt);
    if (!allowed.has(name)) {
      fail("unknown_option");
    }
    if (values.has(name)) {
      fail("duplicate_option");
    }
    let value;
    if (equalsAt !== -1) {
      value = token.slice(equalsAt + 1);
    } else {
      value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail("option_value_required");
      }
      index += 1;
    }
    if (value === "") {
      fail("option_value_required");
    }
    values.set(name, value);
  }
  return values;
}

function option(values, name, env, envName, fallback) {
  return values.get(name) ?? env[envName] ?? fallback;
}

function parseFiniteNumber(value, code, { minimum, maximum, integer = false }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (integer && !Number.isInteger(parsed))) {
    fail(code);
  }
  return parsed;
}

function safeLabel(value, maximum, code) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes("=") ||
    value.includes("\0")
  ) {
    fail(code);
  }
  return value;
}

function normalizeUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    fail("url_required");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("url_invalid");
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    fail("url_must_be_https_or_localhost");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    fail("url_credentials_forbidden");
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function normalizeOptionalHash(value, code) {
  if (value === undefined || value === "") {
    return "";
  }
  if (!HEX_64.test(value)) {
    fail(code);
  }
  return value.toLowerCase();
}

function createRunSpec(input) {
  const modeContract = MODE_CONTRACTS[input.mode];
  if (modeContract === undefined) {
    fail("mode_must_be_burst_soak_or_rehearsal");
  }
  const peakRps = parseFiniteNumber(input.peakRps, "peak_rps_out_of_range", {
    minimum: 0.001,
    maximum: MAX_PEAK_RPS,
  });
  const targetRps = peakRps * modeContract.multiplier;
  const maxConcurrency = parseFiniteNumber(input.maxConcurrency, "max_concurrency_out_of_range", {
    minimum: 1,
    maximum: MAX_CONCURRENCY,
    integer: true,
  });
  const defaultDurationMs = input.mode === "rehearsal" ? DEFAULT_REHEARSAL_DURATION_MS : modeContract.minimumDurationMs;
  const maximumDurationMs = input.mode === "rehearsal" ? MAX_REHEARSAL_DURATION_MS : MAX_ACCEPTANCE_DURATION_MS;
  const durationMs = parseFiniteNumber(input.durationMs ?? defaultDurationMs, "duration_out_of_range", {
    minimum: modeContract.minimumDurationMs,
    maximum: maximumDurationMs,
  });
  const timeoutMs = parseFiniteNumber(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeout_ms_out_of_range", {
    minimum: 1,
    maximum: MAX_TIMEOUT_MS,
    integer: true,
  });
  const expectedResult = input.expectedResult ?? "allow";
  if (!SAFE_EXPECTATIONS.has(expectedResult)) {
    fail("expected_result_must_be_allow_deny_or_rate_limit");
  }
  if (modeContract.acceptanceEligible && expectedResult !== "allow") {
    fail("acceptance_runs_must_expect_allow");
  }
  const fingerprint = normalizeOptionalHash(input.fingerprint, "fingerprint_must_be_64_hex");
  if (fingerprint === "") {
    fail("fingerprint_required");
  }
  const deviceHash = normalizeOptionalHash(input.deviceHash, "device_hash_must_be_64_hex");
  const environment = input.environment ?? (input.mode === "rehearsal" ? "local-rehearsal" : undefined);
  if (environment === undefined) {
    fail("environment_required_for_acceptance");
  }
  safeLabel(environment, 80, "environment_invalid");
  let commitSha = input.commitSha ?? (input.mode === "rehearsal" ? "rehearsal-not-a-release" : undefined);
  if (commitSha === undefined) {
    fail("commit_sha_required_for_acceptance");
  }
  if (modeContract.acceptanceEligible) {
    if (!HEX_40.test(commitSha)) {
      fail("commit_sha_must_be_40_hex");
    }
    commitSha = commitSha.toLowerCase();
  } else if (commitSha.length > 80 || commitSha.includes("\n") || commitSha.includes("\r")) {
    fail("commit_sha_invalid");
  }
  const devicePrivateKeyPem = input.devicePrivateKeyPem ?? "";
  const deviceKeyId = input.deviceKeyId ?? "";
  if ((devicePrivateKeyPem === "") !== (deviceKeyId === "")) {
    fail("device_proof_key_pair_required");
  }
  if (
    typeof devicePrivateKeyPem !== "string" ||
    devicePrivateKeyPem.length > 16_384 ||
    (devicePrivateKeyPem !== "" && !devicePrivateKeyPem.includes(PRIVATE_KEY_BEGIN))
  ) {
    fail("device_private_key_invalid");
  }
  if (deviceKeyId !== "" && !DEVICE_KEY_ID.test(deviceKeyId)) {
    fail("device_key_id_invalid");
  }
  const project = safeLabel(input.project ?? "DEFAULT", 127, "project_invalid");
  const feature = safeLabel(input.feature ?? "DEFAULT", 15, "feature_invalid");
  if (devicePrivateKeyPem !== "" && (!PROOF_NAME.test(project) || !PROOF_NAME.test(feature))) {
    fail("device_proof_name_invalid");
  }
  const plannedRequests = Math.ceil((targetRps * durationMs) / 1_000);
  if (plannedRequests < 1 || plannedRequests > 500_000_000) {
    fail("planned_request_count_out_of_range");
  }
  return Object.freeze({
    mode: input.mode,
    acceptanceEligible: modeContract.acceptanceEligible,
    multiplier: modeContract.multiplier,
    minimumDurationMs: modeContract.minimumDurationMs,
    durationMs,
    peakRps,
    targetRps,
    maxConcurrency,
    timeoutMs,
    expectedResult,
    url: normalizeUrl(input.url),
    project,
    feature,
    fingerprint,
    deviceHash,
    environment,
    commitSha,
    devicePrivateKeyPem,
    deviceKeyId,
    plannedRequests,
    maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
    maxResponseBodyBytes: MAX_RESPONSE_BODY_BYTES,
  });
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const values = parseOptionMap(argv);
  const mode = option(values, "--mode", env, "LICENSECC_CAPACITY_MODE");
  const durationSeconds = option(values, "--duration-seconds", env, "LICENSECC_CAPACITY_DURATION_SECONDS");
  return createRunSpec({
    mode,
    url: option(values, "--url", env, "LICENSECC_CAPACITY_URL"),
    peakRps: option(values, "--peak-rps", env, "LICENSECC_CAPACITY_PEAK_RPS"),
    maxConcurrency: option(values, "--max-concurrency", env, "LICENSECC_CAPACITY_MAX_CONCURRENCY"),
    durationMs: durationSeconds === undefined
      ? undefined
      : parseFiniteNumber(durationSeconds, "duration_seconds_out_of_range", {
          minimum: 0.1,
          maximum: MAX_ACCEPTANCE_DURATION_MS / 1_000,
        }) * 1_000,
    timeoutMs: option(values, "--timeout-ms", env, "LICENSECC_CAPACITY_TIMEOUT_MS"),
    project: option(values, "--project", env, "LICENSECC_CAPACITY_PROJECT", "DEFAULT"),
    feature: option(values, "--feature", env, "LICENSECC_CAPACITY_FEATURE", "DEFAULT"),
    fingerprint: option(values, "--fingerprint", env, "LICENSECC_CAPACITY_FINGERPRINT"),
    deviceHash: option(values, "--device-hash", env, "LICENSECC_CAPACITY_DEVICE_HASH", ""),
    expectedResult: option(values, "--expected-result", env, "LICENSECC_CAPACITY_EXPECTED_RESULT", "allow"),
    environment: option(values, "--environment", env, "LICENSECC_CAPACITY_ENVIRONMENT"),
    commitSha: option(values, "--commit-sha", env, "LICENSECC_RELEASE_COMMIT", env.GITHUB_SHA),
    devicePrivateKeyPem: env.LICENSECC_CAPACITY_DEVICE_PRIVATE_KEY_PKCS8_PEM,
    deviceKeyId: env.LICENSECC_CAPACITY_DEVICE_KEY_ID,
  });
}

function defaultNonceFactory() {
  return randomBytes(32).toString("hex");
}

function pemToDer(pem) {
  const normalized = pem.trim();
  if (!normalized.startsWith(PRIVATE_KEY_BEGIN) || !normalized.endsWith(PRIVATE_KEY_END)) {
    fail("device_private_key_invalid");
  }
  const body = normalized.slice(PRIVATE_KEY_BEGIN.length, -PRIVATE_KEY_END.length);
  if (!/^\s+[A-Za-z0-9+/=\s]+?\s+$/u.test(body)) {
    fail("device_private_key_invalid");
  }
  const encoded = body.replace(/\s+/g, "");
  if (encoded.length === 0 || encoded.length % 4 !== 0) {
    fail("device_private_key_invalid");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) {
    fail("device_private_key_invalid");
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function prepareRequestProofSigner(spec) {
  if (spec.devicePrivateKeyPem === "") {
    return null;
  }
  let privateKey;
  try {
    privateKey = await webcrypto.subtle.importKey(
      "pkcs8",
      pemToDer(spec.devicePrivateKeyPem),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    fail("device_private_key_invalid");
  }
  return async (fields) => {
    const payload = canonicalRequestProofPayload({
      purpose: ONLINE_REQUEST_PROOF_PURPOSE,
      version: REQUEST_PROOF_VERSION,
      algorithm: REQUEST_PROOF_ALGORITHM,
      project: spec.project,
      feature: spec.feature,
      licenseFingerprint: spec.fingerprint,
      deviceHash: spec.deviceHash,
      nonce: fields.nonce,
      requestTimestamp: fields.requestTimestamp,
      clientHardening: 0,
      deviceKeyId: spec.deviceKeyId,
    });
    const signature = new Uint8Array(
      await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        new TextEncoder().encode(payload),
      ),
    );
    if (signature.byteLength !== 64) {
      fail("device_signature_invalid");
    }
    return {
      request_signature_version: REQUEST_PROOF_VERSION,
      device_key_id: spec.deviceKeyId,
      request_timestamp: fields.requestTimestamp,
      request_signature_algorithm: REQUEST_PROOF_ALGORITHM,
      request_signature: Buffer.from(signature).toString("base64"),
    };
  };
}

async function createVerifyRequest(spec, dependencies = {}) {
  const nonceFactory = dependencies.nonceFactory ?? defaultNonceFactory;
  const nonce = nonceFactory();
  if (typeof nonce !== "string" || !HEX_64.test(nonce)) {
    fail("nonce_factory_returned_invalid_nonce");
  }
  const payload = {
    project: spec.project,
    feature: spec.feature,
    license_fingerprint: spec.fingerprint,
    device_hash: spec.deviceHash,
    nonce: nonce.toLowerCase(),
    client_version: "licensecc-capacity-harness/1",
  };
  if (spec.devicePrivateKeyPem !== "") {
    if (typeof dependencies.proofSigner !== "function") {
      fail("request_proof_signer_required");
    }
    const epochNow = dependencies.epochNow ?? (() => Date.now());
    const requestTimestamp = Math.floor(epochNow() / 1_000);
    if (!Number.isSafeInteger(requestTimestamp) || requestTimestamp < 0) {
      fail("request_timestamp_invalid");
    }
    payload.client_hardening = 0;
    Object.assign(payload, await dependencies.proofSigner({ nonce: payload.nonce, requestTimestamp }));
  }
  const body = JSON.stringify(payload);
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > spec.maxRequestBodyBytes) {
    fail("request_body_too_large");
  }
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
  };
  return {
    url: `${spec.url}/v1/verify`,
    init: { method: "POST", headers, body, redirect: "error" },
    bodyBytes,
  };
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort after the evidence-safe size bound has fired.
  }
}

async function readBoundedText(response, maximumBytes) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await cancelBody(response);
    fail("response_body_too_large");
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) {
      break;
    }
    total += item.value.byteLength;
    if (total > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // The bound is already enforced; a cancellation failure is not evidence payload.
      }
      fail("response_body_too_large");
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function classifyHttpResponse(status, payload) {
  if (
    status === 200 &&
    payload !== null &&
    payload.ok === true &&
    typeof payload.assertion === "string" &&
    payload.assertion.length > 0
  ) {
    return "allowed";
  }
  if (
    status === 200 &&
    payload !== null &&
    payload.ok === false &&
    payload.code === "entitlement_denied" &&
    typeof payload.assertion !== "string"
  ) {
    return "expected_deny";
  }
  if (status === 429 && payload !== null && payload.ok === false && payload.code === "rate_limited") {
    return "rate_limited";
  }
  if (status >= 500 && status <= 599) {
    return "unexpected_server_error";
  }
  if (status >= 400 && status <= 499) {
    return "unexpected_client_response";
  }
  return "invalid_response";
}

async function executeVerifyRequest(spec, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  let request;
  try {
    request = await createVerifyRequest(spec, dependencies);
  } catch {
    return { category: "harness_error", status: null, latencyMs: 0 };
  }
  const startedAt = monotonicNow();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), spec.timeoutMs);
  let status = null;
  try {
    const response = await fetchImpl(request.url, { ...request.init, signal: controller.signal });
    status = response.status;
    const text = await readBoundedText(response, spec.maxResponseBodyBytes);
    let payload = null;
    try {
      const parsed = JSON.parse(text);
      payload = typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
      payload = null;
    }
    return {
      category: classifyHttpResponse(status, payload),
      status,
      latencyMs: Math.max(0, monotonicNow() - startedAt),
    };
  } catch (error) {
    let category = "transport_error";
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      category = "timeout";
    } else if (error instanceof CapacityHarnessError && error.message === "response_body_too_large") {
      category = "response_too_large";
    } else if (error instanceof CapacityHarnessError) {
      category = "harness_error";
    }
    return {
      category,
      status,
      latencyMs: Math.max(0, monotonicNow() - startedAt),
    };
  } finally {
    clearTimeout(timeout);
  }
}

class LatencyHistogram {
  constructor(maximumMs) {
    this.maximumMs = Math.ceil(maximumMs);
    this.buckets = new Uint32Array(this.maximumMs + 2);
    this.count = 0;
    this.maximumObservedMs = 0;
  }

  record(value) {
    const normalized = Number.isFinite(value) ? Math.max(0, value) : this.maximumMs + 1;
    const bucket = Math.min(Math.ceil(normalized), this.maximumMs + 1);
    this.buckets[bucket] += 1;
    this.count += 1;
    this.maximumObservedMs = Math.max(this.maximumObservedMs, normalized);
  }

  percentile(percentile) {
    if (this.count === 0) {
      return null;
    }
    const rank = Math.max(1, Math.ceil(this.count * percentile));
    let seen = 0;
    for (let index = 0; index < this.buckets.length; index += 1) {
      seen += this.buckets[index];
      if (seen >= rank) {
        return index;
      }
    }
    return this.maximumMs + 1;
  }
}

function emptyCategoryCounts() {
  return Object.fromEntries(RESPONSE_CATEGORIES.map((category) => [category, 0]));
}

function normalizeResult(result, fallbackLatencyMs) {
  if (
    typeof result !== "object" ||
    result === null ||
    !RESPONSE_CATEGORIES.includes(result.category) ||
    !Number.isFinite(result.latencyMs) ||
    result.latencyMs < 0
  ) {
    return { category: "harness_error", status: null, latencyMs: Math.max(0, fallbackLatencyMs) };
  }
  return {
    category: result.category,
    status: Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : null,
    latencyMs: result.latencyMs,
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCapacity(spec, dependencies = {}) {
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const sleepImpl = dependencies.sleepImpl ?? defaultSleep;
  let proofSigner = dependencies.proofSigner;
  if (dependencies.requestImpl === undefined && proofSigner === undefined) {
    proofSigner = await prepareRequestProofSigner(spec);
  }
  const requestImpl = dependencies.requestImpl ?? ((value) => executeVerifyRequest(value, { ...dependencies, proofSigner }));
  const histogram = new LatencyHistogram(spec.timeoutMs);
  const categoryCounts = emptyCategoryCounts();
  const statusCounts = new Map();
  const active = new Set();
  const startedAt = monotonicNow();
  const scheduledEnd = startedAt + spec.durationMs;
  const intervalMs = 1_000 / spec.targetRps;
  const schedulerTickMs = Math.min(20, Math.max(1, (spec.maxConcurrency * 500) / spec.targetRps));
  let dispatched = 0;
  let completed = 0;
  let missedDueToConcurrency = 0;
  let maxObservedConcurrency = 0;
  let maxSchedulerLagMs = 0;
  let slot = 0;

  const launch = (sequence, dueAt) => {
    const launchedAt = monotonicNow();
    maxSchedulerLagMs = Math.max(maxSchedulerLagMs, Math.max(0, launchedAt - dueAt));
    dispatched += 1;
    let task;
    task = Promise.resolve()
      .then(() => requestImpl(spec, sequence))
      .then((result) => normalizeResult(result, monotonicNow() - launchedAt))
      .catch(() => ({ category: "harness_error", status: null, latencyMs: Math.max(0, monotonicNow() - launchedAt) }))
      .then((result) => {
        completed += 1;
        categoryCounts[result.category] += 1;
        histogram.record(result.latencyMs);
        if (result.status !== null) {
          statusCounts.set(result.status, (statusCounts.get(result.status) ?? 0) + 1);
        }
      })
      .finally(() => {
        active.delete(task);
      });
    active.add(task);
    maxObservedConcurrency = Math.max(maxObservedConcurrency, active.size);
  };

  while (slot < spec.plannedRequests) {
    const dueAt = startedAt + (slot * intervalMs);
    const now = monotonicNow();
    if (now + 0.001 < dueAt) {
      const untilDue = dueAt - now;
      await sleepImpl(intervalMs > schedulerTickMs ? untilDue : schedulerTickMs);
      await Promise.resolve();
      continue;
    }
    const latestDueSlot = Math.min(
      spec.plannedRequests,
      Math.floor(((now - startedAt) / intervalMs) + 1 + 1e-9),
    );
    while (slot < latestDueSlot) {
      const slotDueAt = startedAt + (slot * intervalMs);
      if (active.size >= spec.maxConcurrency) {
        missedDueToConcurrency += 1;
      } else {
        launch(slot, slotDueAt);
      }
      slot += 1;
    }
    await Promise.resolve();
  }

  const remainingDuration = scheduledEnd - monotonicNow();
  if (remainingDuration > 0) {
    await sleepImpl(remainingDuration);
  }
  await Promise.all([...active]);
  const finishedAt = monotonicNow();
  return {
    startedAt,
    finishedAt,
    elapsedMs: Math.max(spec.durationMs, finishedAt - startedAt),
    dispatched,
    completed,
    missedDueToConcurrency,
    maxObservedConcurrency,
    maxSchedulerLagMs,
    schedulerTickMs,
    categoryCounts,
    statusCounts: Object.fromEntries([...statusCounts.entries()].sort((left, right) => left[0] - right[0])),
    latency: {
      p50: histogram.percentile(0.5),
      p95: histogram.percentile(0.95),
      p99: histogram.percentile(0.99),
      max: histogram.count === 0 ? null : Math.ceil(histogram.maximumObservedMs),
    },
  };
}

function percent(numerator, denominator) {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function rounded(value, places = 3) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function expectedCategory(expectedResult) {
  if (expectedResult === "allow") {
    return "allowed";
  }
  if (expectedResult === "deny") {
    return "expected_deny";
  }
  return "rate_limited";
}

function buildEvidence(spec, run, generatedAt = new Date()) {
  const recognized = run.categoryCounts.allowed + run.categoryCounts.expected_deny + run.categoryCounts.rate_limited;
  const unexplained =
    run.categoryCounts.unexpected_client_response +
    run.categoryCounts.timeout +
    run.categoryCounts.transport_error +
    run.categoryCounts.response_too_large +
    run.categoryCounts.invalid_response +
    run.categoryCounts.harness_error;
  const availabilityPercent = percent(recognized, run.completed);
  const expectedResultPercent = percent(run.categoryCounts[expectedCategory(spec.expectedResult)], run.completed);
  const serverErrorPercent = percent(run.categoryCounts.unexpected_server_error, run.completed);
  const checks = [
    {
      id: "minimum_duration",
      pass: spec.durationMs >= spec.minimumDurationMs,
      observed_ms: spec.durationMs,
      threshold: `>=${spec.minimumDurationMs}`,
    },
    {
      id: "scheduled_load_completed",
      pass:
        run.dispatched === spec.plannedRequests &&
        run.completed === spec.plannedRequests &&
        run.missedDueToConcurrency === 0,
      observed: `${run.completed}/${spec.plannedRequests}`,
      threshold: "all_planned_requests",
    },
    {
      id: "availability",
      pass: availabilityPercent >= AVAILABILITY_THRESHOLD_PERCENT,
      observed_percent: rounded(availabilityPercent, 6),
      threshold: `>=${AVAILABILITY_THRESHOLD_PERCENT}`,
    },
    {
      id: "expected_result",
      pass: expectedResultPercent >= EXPECTED_RESULT_THRESHOLD_PERCENT,
      observed_percent: rounded(expectedResultPercent, 6),
      threshold: `>=${EXPECTED_RESULT_THRESHOLD_PERCENT}`,
    },
    {
      id: "latency_p95",
      pass: run.latency.p95 !== null && run.latency.p95 < P95_THRESHOLD_MS,
      observed_ms: run.latency.p95,
      threshold: `<${P95_THRESHOLD_MS}`,
    },
    {
      id: "latency_p99",
      pass: run.latency.p99 !== null && run.latency.p99 < P99_THRESHOLD_MS,
      observed_ms: run.latency.p99,
      threshold: `<${P99_THRESHOLD_MS}`,
    },
    {
      id: "unexpected_server_error_rate",
      pass: serverErrorPercent < SERVER_ERROR_THRESHOLD_PERCENT,
      observed_percent: rounded(serverErrorPercent, 6),
      threshold: `<${SERVER_ERROR_THRESHOLD_PERCENT}`,
    },
    {
      id: "unexplained_error_classes",
      pass: unexplained === 0,
      observed_count: unexplained,
      threshold: "0",
    },
  ];
  const failures = checks.filter((check) => !check.pass).map((check) => check.id);
  const objectivePass = failures.length === 0;
  const companionRuns = spec.mode === "burst"
    ? ["passing_soak_run"]
    : spec.mode === "soak"
      ? ["passing_burst_run"]
      : ["passing_burst_run", "passing_soak_run"];
  return {
    schema_version: SCHEMA_VERSION,
    gate: "PRD-05",
    evidence_scope: "public_verifier_capacity_run",
    gate_completion: "partial_evidence_only",
    generated_at_utc: generatedAt.toISOString(),
    tooling: {
      harness: "licensecc-public-verifier-capacity/1",
      node: process.version,
    },
    exact_commit_sha: spec.commitSha,
    operating_environment: spec.environment,
    run_type: spec.mode,
    acceptance_eligible: spec.acceptanceEligible,
    verdict: spec.acceptanceEligible
      ? (objectivePass ? "pass" : "fail")
      : (objectivePass ? "rehearsal_pass" : "rehearsal_fail"),
    target: REDACTED,
    request_profile: {
      method: "POST",
      path: "/v1/verify",
      project: REDACTED,
      feature: REDACTED,
      fingerprint: REDACTED,
      device_hash: spec.deviceHash === "" ? "not_supplied" : REDACTED,
      payload: REDACTED,
      request_proof_present: spec.devicePrivateKeyPem !== "",
      max_request_body_bytes: spec.maxRequestBodyBytes,
      max_response_body_bytes: spec.maxResponseBodyBytes,
      request_timeout_ms: spec.timeoutMs,
      expected_result: spec.expectedResult,
    },
    load: {
      declared_peak_rps_p: spec.peakRps,
      applied_multiplier: spec.multiplier,
      target_rps: spec.targetRps,
      configured_duration_ms: spec.durationMs,
      observed_elapsed_ms: rounded(run.elapsedMs, 3),
      minimum_duration_ms: spec.minimumDurationMs,
      max_concurrency: spec.maxConcurrency,
      scheduler_tick_ms: rounded(run.schedulerTickMs, 6),
      planned_requests: spec.plannedRequests,
      dispatched_requests: run.dispatched,
      completed_requests: run.completed,
      missed_due_to_concurrency: run.missedDueToConcurrency,
      max_observed_concurrency: run.maxObservedConcurrency,
      max_scheduler_lag_ms: rounded(run.maxSchedulerLagMs, 3),
      offered_throughput_rps: rounded(run.dispatched / (spec.durationMs / 1_000), 6),
      completion_throughput_rps: rounded(run.completed / (run.elapsedMs / 1_000), 6),
    },
    measurements: {
      latency_ms: run.latency,
      availability_percent: rounded(availabilityPercent, 6),
      expected_result_percent: rounded(expectedResultPercent, 6),
      unexpected_server_error_percent: rounded(serverErrorPercent, 6),
      classifications: { ...run.categoryCounts },
      http_status_counts: { ...run.statusCounts },
    },
    thresholds: {
      availability_percent: `>=${AVAILABILITY_THRESHOLD_PERCENT}`,
      expected_result_percent: `>=${EXPECTED_RESULT_THRESHOLD_PERCENT}`,
      latency_p95_ms: `<${P95_THRESHOLD_MS}`,
      latency_p99_ms: `<${P99_THRESHOLD_MS}`,
      unexpected_server_error_percent: `<${SERVER_ERROR_THRESHOLD_PERCENT}`,
      unexplained_error_classes: 0,
    },
    checks,
    failures,
    external_evidence_required: [
      ...companionRuns,
      "worker_resource_growth_review",
      "backup_freshness_and_integrity_review",
      "alert_path_exercises",
      "sensitive_log_inspection",
    ],
  };
}

export {
  CapacityHarnessError,
  MODE_CONTRACTS,
  RESPONSE_CATEGORIES,
  buildEvidence,
  classifyHttpResponse,
  createRunSpec,
  createVerifyRequest,
  executeVerifyRequest,
  normalizeUrl,
  parseArgs,
  prepareRequestProofSigner,
  runCapacity,
};
