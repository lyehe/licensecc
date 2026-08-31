#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { signOrder } from "./order-sign.mjs";

const AUDIENCE = "licensecc-staging";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_FIXTURE_BYTES = 2 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const RESPONSE_CODE = /^[a-z][a-z0-9_]{0,39}$/u;
const ENV_KEYS = Object.freeze({
  url: "LICENSECC_STAGING_ORDER_DRILL_URL",
  keyId: "LICENSECC_STAGING_ORDER_DRILL_KEY_ID",
  secret: "LICENSECC_STAGING_ORDER_DRILL_SECRET_B64",
  fixture: "LICENSECC_STAGING_ORDER_DRILL_FIXTURE_JSON",
  runId: "LICENSECC_STAGING_ORDER_DRILL_RUN_ID",
  runAttempt: "LICENSECC_STAGING_ORDER_DRILL_RUN_ATTEMPT",
  commit: "LICENSECC_STAGING_ORDER_DRILL_COMMIT",
});

class DrillError extends Error {
  constructor(code) {
    super(code);
    this.name = "DrillError";
    this.code = code;
  }
}

function fail(code) {
  throw new DrillError(code);
}

function exactEnvironmentValue(env, name, maxLength) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.trim() !== value) {
    fail("invalid_protected_input");
  }
  return value;
}

function safeIdentifier(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength && SAFE_ID.test(value);
}

function parseCanonicalSecret(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail("invalid_protected_input");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength < 32 || decoded.byteLength > 128 || decoded.toString("base64") !== value) {
    fail("invalid_protected_input");
  }
  return value;
}

function parseStagingOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid_protected_input");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    fail("invalid_protected_input");
  }
  const labels = parsed.hostname.toLowerCase().split(".");
  if (!labels.includes("staging") || labels.some((label) => label.length === 0)) {
    fail("invalid_protected_input");
  }
  return parsed.origin;
}

function parsePositiveInteger(value, maxDigits) {
  if (!new RegExp(`^[1-9][0-9]{0,${maxDigits - 1}}$`, "u").test(value)) fail("invalid_protected_input");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail("invalid_protected_input");
  return value;
}

function parseFixture(value) {
  if (Buffer.byteLength(value, "utf8") > MAX_FIXTURE_BYTES) fail("invalid_protected_input");
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("invalid_protected_input");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("invalid_protected_input");
  const keys = Object.keys(parsed).sort();
  const expectedKeys = ["customer_id", "feature", "project", "subscription_id"];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) fail("invalid_protected_input");
  if (
    !safeIdentifier(parsed.subscription_id, 128) ||
    !safeIdentifier(parsed.project, 127) ||
    !safeIdentifier(parsed.feature, 15) ||
    !safeIdentifier(parsed.customer_id, 128)
  ) {
    fail("invalid_protected_input");
  }
  return Object.freeze({
    subscriptionId: parsed.subscription_id,
    project: parsed.project,
    feature: parsed.feature,
    customerId: parsed.customer_id,
  });
}

export function parseStagingOrderEnvironment(env) {
  if (env === null || typeof env !== "object") fail("invalid_protected_input");
  const origin = parseStagingOrigin(exactEnvironmentValue(env, ENV_KEYS.url, 512));
  const keyId = exactEnvironmentValue(env, ENV_KEYS.keyId, 64);
  if (!safeIdentifier(keyId, 64)) fail("invalid_protected_input");
  const secretB64 = parseCanonicalSecret(exactEnvironmentValue(env, ENV_KEYS.secret, 256));
  const fixture = parseFixture(exactEnvironmentValue(env, ENV_KEYS.fixture, MAX_FIXTURE_BYTES));
  const runId = parsePositiveInteger(exactEnvironmentValue(env, ENV_KEYS.runId, 20), 20);
  const runAttempt = parsePositiveInteger(exactEnvironmentValue(env, ENV_KEYS.runAttempt, 6), 6);
  const commit = exactEnvironmentValue(env, ENV_KEYS.commit, 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(commit)) fail("invalid_protected_input");
  return Object.freeze({ origin, keyId, secretB64, fixture, runId, runAttempt, commit });
}

function createOrder(config, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) fail("invalid_clock");
  const nowSeconds = Math.floor(nowMs / 1000);
  const eventId = `lcc-staging-drill-${config.runId}-${config.runAttempt}-${nowMs}`;
  if (eventId.length > 255) fail("invalid_protected_input");
  const order = {
    event_id: eventId,
    subscription_id: config.fixture.subscriptionId,
    project: config.fixture.project,
    feature: config.fixture.feature,
    intent: "subscription.active",
    seq: 1,
    order_epoch: nowMs,
    current_period_end: nowSeconds + 30 * 86_400,
    customer: { id: config.fixture.customerId },
  };
  const body = JSON.stringify(order);
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) fail("invalid_protected_input");
  return { body, nowSeconds };
}

async function readBoundedJson(response, controller) {
  if (typeof response?.status !== "number" || response.status < 100 || response.status > 599 || response.body === null) {
    fail("invalid_remote_response");
  }
  const declaredLength = Number(response.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
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
      if (!(value instanceof Uint8Array)) fail("invalid_remote_response");
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        controller.abort();
        void reader.cancel();
        fail("remote_response_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DrillError) throw error;
    fail("remote_request_failed");
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
  if (typeof parsed.ok !== "boolean" || typeof parsed.code !== "string" || !RESPONSE_CODE.test(parsed.code)) {
    fail("invalid_remote_response");
  }
  return Object.freeze({ status: response.status, ok: parsed.ok, code: parsed.code });
}

async function sendBounded(fetchImpl, url, body, headers, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      redirect: "error",
      signal: controller.signal,
    });
    return await readBoundedJson(response, controller);
  } catch (error) {
    if (error instanceof DrillError) throw error;
    fail(controller.signal.aborted ? "remote_request_timeout" : "remote_request_failed");
  } finally {
    clearTimeout(timeout);
  }
}

function baseEvidence(commit) {
  return {
    schema_version: "licensecc.staging-order-idempotency.v1",
    check: "staging_signed_order_replay_and_idempotency",
    environment: "staging",
    candidate_commit_sha: commit ?? null,
    target: "redacted",
    fixture: "protected_synthetic",
    readiness_coverage: "partial",
    promotion_eligible: false,
    application_cached_idempotency: {
      status: "not_completed",
      reason_code: "fresh_signed_logical_retry_not_confirmed",
    },
    crash_redrive: {
      status: "blocked_external_drill",
      reason_code: "no_safe_remote_accept_apply_fault_injection",
    },
  };
}

export async function runStagingOrderDrill({
  env = process.env,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  let config;
  try {
    config = parseStagingOrderEnvironment(env);
    if (typeof fetchImpl !== "function") fail("remote_request_unavailable");
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > REQUEST_TIMEOUT_MS) {
      fail("invalid_request_bound");
    }
    const order = createOrder(config, nowMs);
    const signed = await signOrder({
      keyId: config.keyId,
      secretB64: config.secretB64,
      audience: AUDIENCE,
      body: order.body,
      timestamp: order.nowSeconds,
    });
    const url = `${config.origin}/v1/orders`;
    const positive = await sendBounded(fetchImpl, url, order.body, signed.headers, requestTimeoutMs);
    if (!(positive.status === 200 && positive.ok === true && positive.code === "applied")) {
      return {
        ok: false,
        evidence: {
          ...baseEvidence(config.commit),
          signed_positive_order: positive,
          drill_verdict: "fail",
          failure_code: "unexpected_drill_result",
        },
      };
    }
    const duplicate = await sendBounded(fetchImpl, url, order.body, signed.headers, requestTimeoutMs);
    if (!(duplicate.status === 401 && duplicate.ok === false && duplicate.code === "replayed")) {
      return {
        ok: false,
        evidence: {
          ...baseEvidence(config.commit),
          signed_positive_order: positive,
          same_event_duplicate: { ...duplicate, semantics: "exact_signed_request_replay_rejected" },
          drill_verdict: "fail",
          failure_code: "unexpected_drill_result",
        },
      };
    }
    const freshSigned = await signOrder({
      keyId: config.keyId,
      secretB64: config.secretB64,
      audience: AUDIENCE,
      body: order.body,
      timestamp: order.nowSeconds + 1,
    });
    const logicalRetry = await sendBounded(fetchImpl, url, order.body, freshSigned.headers, requestTimeoutMs);
    const ok = logicalRetry.status === 200 && logicalRetry.ok === true && logicalRetry.code === "applied";
    return {
      ok,
      evidence: {
        ...baseEvidence(config.commit),
        signed_positive_order: positive,
        same_event_duplicate: { ...duplicate, semantics: "exact_signed_request_replay_rejected" },
        fresh_signature_logical_retry: {
          ...logicalRetry,
          semantics: "same_event_durable_cached_result",
        },
        application_cached_idempotency: ok
          ? {
              status: "exercised_remotely",
              reason_code: "fresh_signed_same_event_returned_cached_result",
            }
          : {
              status: "failed",
              reason_code: "fresh_signed_logical_retry_unexpected_result",
            },
        drill_verdict: ok ? "pass" : "fail",
        ...(ok ? {} : { failure_code: "unexpected_drill_result" }),
      },
    };
  } catch (error) {
    const failureCode = error instanceof DrillError ? error.code : "staging_order_drill_failed";
    return {
      ok: false,
      evidence: {
        ...baseEvidence(config?.commit),
        drill_verdict: "fail",
        failure_code: failureCode,
      },
    };
  }
}

async function main() {
  if (process.argv.length !== 2) {
    const result = await runStagingOrderDrill({ env: {} });
    process.stdout.write(`${JSON.stringify(result.evidence)}\n`);
    process.exitCode = 1;
    return;
  }
  const result = await runStagingOrderDrill();
  process.stdout.write(`${JSON.stringify(result.evidence)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({
      ...baseEvidence(null),
      drill_verdict: "fail",
      failure_code: "staging_order_drill_failed",
    })}\n`);
    process.exitCode = 1;
  });
}
