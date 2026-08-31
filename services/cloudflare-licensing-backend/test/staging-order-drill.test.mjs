import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseStagingOrderEnvironment,
  runStagingOrderDrill,
} from "../scripts/staging-order-drill.mjs";

const SECRET = Buffer.alloc(32, 0x42).toString("base64");
const COMMIT = "a1".repeat(20);
const FIXTURE = {
  subscription_id: "synthetic_subscription_sentinel",
  project: "SYNTHETIC_PROJECT",
  feature: "SYNTHETIC",
  customer_id: "synthetic_customer_sentinel",
};

function validEnvironment(overrides = {}) {
  return {
    LICENSECC_STAGING_ORDER_DRILL_URL: "https://backend.staging.licensecc.dev",
    LICENSECC_STAGING_ORDER_DRILL_KEY_ID: "staging-order-key-sentinel",
    LICENSECC_STAGING_ORDER_DRILL_SECRET_B64: SECRET,
    LICENSECC_STAGING_ORDER_DRILL_FIXTURE_JSON: JSON.stringify(FIXTURE),
    LICENSECC_STAGING_ORDER_DRILL_RUN_ID: "123456789",
    LICENSECC_STAGING_ORDER_DRILL_RUN_ATTEMPT: "2",
    LICENSECC_STAGING_ORDER_DRILL_COMMIT: COMMIT,
    ...overrides,
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("protected staging inputs are environment-only, canonical, bounded, and staging-scoped", () => {
  const parsed = parseStagingOrderEnvironment(validEnvironment());
  assert.equal(parsed.origin, "https://backend.staging.licensecc.dev");
  assert.equal(parsed.commit, COMMIT);
  const invalidCases = [
    { LICENSECC_STAGING_ORDER_DRILL_URL: "http://backend.staging.licensecc.dev" },
    { LICENSECC_STAGING_ORDER_DRILL_URL: "https://backend.production.licensecc.dev" },
    { LICENSECC_STAGING_ORDER_DRILL_URL: "https://user@backend.staging.licensecc.dev" },
    { LICENSECC_STAGING_ORDER_DRILL_URL: "https://backend.staging.licensecc.dev/path" },
    { LICENSECC_STAGING_ORDER_DRILL_URL: "https://backend.staging.licensecc.dev?target=secret" },
    { LICENSECC_STAGING_ORDER_DRILL_KEY_ID: "bad key" },
    { LICENSECC_STAGING_ORDER_DRILL_SECRET_B64: Buffer.alloc(31).toString("base64") },
    { LICENSECC_STAGING_ORDER_DRILL_SECRET_B64: SECRET.slice(0, -1) },
    { LICENSECC_STAGING_ORDER_DRILL_RUN_ID: "0" },
    { LICENSECC_STAGING_ORDER_DRILL_RUN_ATTEMPT: "01" },
    { LICENSECC_STAGING_ORDER_DRILL_COMMIT: "f".repeat(39) },
    { LICENSECC_STAGING_ORDER_DRILL_FIXTURE_JSON: JSON.stringify({ ...FIXTURE, email: "not-allowed@example.invalid" }) },
    { LICENSECC_STAGING_ORDER_DRILL_FIXTURE_JSON: JSON.stringify({ ...FIXTURE, feature: "too-long-feature" }) },
  ];
  for (const overrides of invalidCases) {
    assert.throws(() => parseStagingOrderEnvironment(validEnvironment(overrides)), /invalid_protected_input/u);
  }
});

test("drill proves exact replay rejection and a fresh-signature cached logical retry without leaking data", async () => {
  const calls = [];
  const responseSentinel = "response-fingerprint-license-payload-sentinel";
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return jsonResponse({
        ok: true,
        code: "applied",
        license_fingerprint: responseSentinel,
        entitlement: { customer_id: FIXTURE.customer_id, license_id: responseSentinel },
        raw_payload: options.body,
      }, 200);
    }
    if (calls.length === 2) {
      return jsonResponse({ ok: false, code: "replayed", payload: responseSentinel }, 401);
    }
    return jsonResponse({
      ok: true,
      code: "applied",
      cached_payload: responseSentinel,
      raw_payload: options.body,
    }, 200);
  };

  const result = await runStagingOrderDrill({
    env: validEnvironment(),
    fetchImpl,
    nowMs: 1_800_000_000_123,
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.drill_verdict, "pass");
  assert.equal(result.evidence.readiness_coverage, "partial");
  assert.equal(result.evidence.promotion_eligible, false);
  assert.deepEqual(result.evidence.signed_positive_order, { status: 200, ok: true, code: "applied" });
  assert.deepEqual(result.evidence.same_event_duplicate, {
    status: 401,
    ok: false,
    code: "replayed",
    semantics: "exact_signed_request_replay_rejected",
  });
  assert.deepEqual(result.evidence.fresh_signature_logical_retry, {
    status: 200,
    ok: true,
    code: "applied",
    semantics: "same_event_durable_cached_result",
  });
  assert.deepEqual(result.evidence.application_cached_idempotency, {
    status: "exercised_remotely",
    reason_code: "fresh_signed_same_event_returned_cached_result",
  });
  assert.deepEqual(result.evidence.crash_redrive, {
    status: "blocked_external_drill",
    reason_code: "no_safe_remote_accept_apply_fault_injection",
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://backend.staging.licensecc.dev/v1/orders");
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[0].url, calls[2].url);
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal(calls[0].options.body, calls[2].options.body);
  assert.deepEqual(calls[0].options.headers, calls[1].options.headers);
  assert.notDeepEqual(calls[0].options.headers, calls[2].options.headers);
  assert.equal(
    Number(calls[2].options.headers["X-LCC-Timestamp"]),
    Number(calls[0].options.headers["X-LCC-Timestamp"]) + 1,
  );
  assert.notEqual(calls[0].options.headers["X-LCC-Signature"], calls[2].options.headers["X-LCC-Signature"]);
  assert.equal(calls[0].options.redirect, "error");
  assert.match(calls[0].options.headers["X-LCC-Signature"], /^[A-Za-z0-9+/]+={0,2}$/u);
  const submitted = JSON.parse(calls[0].options.body);
  assert.equal(submitted.subscription_id, FIXTURE.subscription_id);
  assert.equal(submitted.customer.id, FIXTURE.customer_id);
  assert.equal(submitted.order_epoch, 1_800_000_000_123);
  assert.match(submitted.event_id, /^lcc-staging-drill-123456789-2-/u);

  const serialized = JSON.stringify(result.evidence);
  for (const forbidden of [
    validEnvironment().LICENSECC_STAGING_ORDER_DRILL_URL,
    validEnvironment().LICENSECC_STAGING_ORDER_DRILL_KEY_ID,
    SECRET,
    FIXTURE.subscription_id,
    FIXTURE.project,
    FIXTURE.feature,
    FIXTURE.customer_id,
    responseSentinel,
    calls[0].options.body,
  ]) {
    assert.equal(serialized.includes(forbidden), false, `evidence must redact ${forbidden.slice(0, 24)}`);
  }
});

test("unexpected positive, exact-replay, or fresh-retry outcomes fail the scoped drill", async () => {
  for (const responses of [
    [jsonResponse({ ok: true, code: "superseded" }, 200)],
    [jsonResponse({ ok: true, code: "applied" }, 200), jsonResponse({ ok: true, code: "applied" }, 200)],
    [
      jsonResponse({ ok: true, code: "applied" }, 200),
      jsonResponse({ ok: false, code: "replayed" }, 401),
      jsonResponse({ ok: false, code: "write_failed" }, 503),
    ],
  ]) {
    let index = 0;
    const result = await runStagingOrderDrill({
      env: validEnvironment(),
      fetchImpl: async () => responses[index++],
      nowMs: 1_800_000_000_123,
    });
    assert.equal(result.ok, false);
    assert.equal(result.evidence.drill_verdict, "fail");
    assert.equal(result.evidence.failure_code, "unexpected_drill_result");
    assert.equal(index, responses.length);
  }
});

test("response size and request time are bounded with generic, redacted failure evidence", async () => {
  const oversizedSentinel = "private-response-payload-sentinel";
  const oversized = await runStagingOrderDrill({
    env: validEnvironment(),
    fetchImpl: async () => new Response(oversizedSentinel, {
      status: 200,
      headers: { "content-length": "32769" },
    }),
    nowMs: 1_800_000_000_123,
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.evidence.failure_code, "remote_response_too_large");
  assert.doesNotMatch(JSON.stringify(oversized.evidence), new RegExp(oversizedSentinel, "u"));

  const timedOut = await runStagingOrderDrill({
    env: validEnvironment(),
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("secret timeout diagnostic")), { once: true });
    }),
    nowMs: 1_800_000_000_123,
    requestTimeoutMs: 25,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.evidence.failure_code, "remote_request_timeout");
  assert.doesNotMatch(JSON.stringify(timedOut.evidence), /secret timeout diagnostic/u);
});

test("invalid protected inputs fail before any request and are not echoed", async () => {
  let calls = 0;
  const secretSentinel = "customer-license-fixture-secret-sentinel";
  const result = await runStagingOrderDrill({
    env: validEnvironment({ LICENSECC_STAGING_ORDER_DRILL_FIXTURE_JSON: secretSentinel }),
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ ok: true, code: "applied" }, 200);
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.evidence.failure_code, "invalid_protected_input");
  assert.doesNotMatch(JSON.stringify(result.evidence), new RegExp(secretSentinel, "u"));
});
