import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeUrl,
  parseArgs,
  runDrill,
  verifyBody,
} from "../scripts/public-verifier-drill.mjs";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("public verifier drill parses safe defaults and redacts URL input", () => {
  const options = parseArgs([
    "--url",
    "https://verifier.example.workers.dev/",
    "--fingerprint",
    "a".repeat(64),
    "--expect-rate-limit",
  ]);
  assert.equal(options.url, "https://verifier.example.workers.dev");
  assert.equal(options.project, "DEFAULT");
  assert.equal(options.feature, "DEFAULT");
  assert.equal(options.expectRateLimit, true);
  assert.equal(options.recoveryWaitMs, 65_000);
  assert.equal(options.burstCount, 25);
  assert.equal(normalizeUrl("http://127.0.0.1:4173/"), "http://127.0.0.1:4173");
  assert.throws(() => normalizeUrl("http://example.com"), /url_must_be_https_or_localhost/);
  assert.throws(() => parseArgs(["--url", "https://verifier.example", "--fingerprint", "z".repeat(64)]), /fingerprint_must_be_64_hex/);
});

test("public verifier drill accepts npm config and stripped positional arguments", () => {
  const npmConfigOptions = parseArgs([], {
    npm_config_url: "https://verifier.example.workers.dev",
    npm_config_project: "PROJECT",
    npm_config_feature: "FEATURE",
    npm_config_fingerprint: "e".repeat(64),
    npm_config_burst_count: "2",
    npm_config_timeout_ms: "3",
    npm_config_expect_rate_limit: "true",
    npm_config_recovery_wait_ms: "4",
    npm_config_json: "true",
  });
  assert.equal(npmConfigOptions.url, "https://verifier.example.workers.dev");
  assert.equal(npmConfigOptions.project, "PROJECT");
  assert.equal(npmConfigOptions.feature, "FEATURE");
  assert.equal(npmConfigOptions.fingerprint, "e".repeat(64));
  assert.equal(npmConfigOptions.burstCount, 2);
  assert.equal(npmConfigOptions.timeoutMs, 3);
  assert.equal(npmConfigOptions.expectRateLimit, true);
  assert.equal(npmConfigOptions.recoveryWaitMs, 4);
  assert.equal(npmConfigOptions.json, true);

  const positionalOptions = parseArgs([
    "https://verifier.example.workers.dev",
    "5",
    "6",
  ], {});
  assert.equal(positionalOptions.url, "https://verifier.example.workers.dev");
  assert.equal(positionalOptions.burstCount, 5);
  assert.equal(positionalOptions.timeoutMs, 6);

  const strippedNpmOptions = parseArgs([
    "https://verifier.example.workers.dev",
    "7",
  ], {
    npm_config_url: "true",
    npm_config_burst_count: "true",
  });
  assert.equal(strippedNpmOptions.url, "https://verifier.example.workers.dev");
  assert.equal(strippedNpmOptions.burstCount, 7);
});

test("public verifier drill accepts equals-form command-line options", () => {
  const options = parseArgs([
    "--url=https://verifier.example.workers.dev",
    `--fingerprint=${"f".repeat(64)}`,
    "--burst-count=7",
    "--timeout-ms=8",
    "--expect-rate-limit=true",
    "--recovery-wait-ms=9",
    "--json=true",
  ], {});
  assert.equal(options.url, "https://verifier.example.workers.dev");
  assert.equal(options.fingerprint, "f".repeat(64));
  assert.equal(options.burstCount, 7);
  assert.equal(options.timeoutMs, 8);
  assert.equal(options.expectRateLimit, true);
  assert.equal(options.recoveryWaitMs, 9);
  assert.equal(options.json, true);
});

test("public verifier drill builds valid request bodies without reusing nonces", () => {
  const options = parseArgs(["--url", "https://verifier.example", "--fingerprint", "b".repeat(64)]);
  const first = verifyBody(options);
  const second = verifyBody(options);
  assert.equal(first.project, "DEFAULT");
  assert.equal(first.feature, "DEFAULT");
  assert.equal(first.license_fingerprint, "b".repeat(64));
  assert.equal(first.nonce.length, 64);
  assert.notEqual(first.nonce, second.nonce);
});

test("public verifier drill accepts malformed rejection, unsigned denial, rate limit, and recovery", async () => {
  const calls = [];
  const options = parseArgs([
    "--url",
    "https://verifier.example",
    "--fingerprint",
    "c".repeat(64),
    "--burst-count",
    "3",
    "--expect-rate-limit",
    "--recovery-wait-ms",
    "1",
  ]);
  const responses = [
    jsonResponse(400, { ok: false, code: "invalid_request" }),
    jsonResponse(200, { ok: false, code: "entitlement_denied", server_time: 1000 }),
    jsonResponse(200, { ok: false, code: "entitlement_denied", server_time: 1000 }),
    jsonResponse(429, { ok: false, code: "rate_limited" }),
    jsonResponse(429, { ok: false, code: "rate_limited" }),
    jsonResponse(200, { ok: false, code: "entitlement_denied", server_time: 1065 }),
  ];
  const summary = await runDrill(options, {
    async fetchImpl(url, init) {
      calls.push({ url, body: JSON.parse(init.body) });
      return responses.shift();
    },
    async sleepImpl(ms) {
      assert.equal(ms, 1);
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.target, "<redacted-verifier-url>");
  assert.equal(summary.unknown_denial.assertion_present, false);
  assert.equal(summary.burst.attempts, 3);
  assert.equal(summary.burst.rate_limited_count, 2);
  assert.equal(summary.burst.first_rate_limited_at, 2);
  assert.equal(summary.recovery.status, 200);
  assert.equal(JSON.stringify(summary).includes("https://verifier.example"), false);
  assert.equal(calls.every((call) => call.url === "https://verifier.example/v1/verify"), true);
});

test("public verifier drill fails closed when expected limiter is not observed", async () => {
  const options = parseArgs([
    "--url",
    "https://verifier.example",
    "--fingerprint",
    "d".repeat(64),
    "--burst-count",
    "2",
    "--expect-rate-limit",
    "--recovery-wait-ms",
    "0",
  ]);
  const responses = [
    jsonResponse(400, { ok: false, code: "invalid_request" }),
    jsonResponse(200, { ok: false, code: "entitlement_denied", server_time: 1000 }),
    jsonResponse(200, { ok: false, code: "entitlement_denied", server_time: 1000 }),
    jsonResponse(200, { ok: false, code: "entitlement_denied", server_time: 1000 }),
  ];
  const summary = await runDrill(options, {
    async fetchImpl() {
      return responses.shift();
    },
  });
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.failures, ["rate_limit_not_observed"]);
});
