import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const DEFAULT_PROJECT = "DEFAULT";
const DEFAULT_FEATURE = "DEFAULT";
const DEFAULT_BURST_COUNT = 25;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RECOVERY_WAIT_MS = 65_000;
const MAX_BURST_COUNT = 100;
const MAX_RECOVERY_WAIT_MS = 180_000;

function usage(exitCode = 2) {
  console.error(`usage:
  node scripts/public-verifier-drill.mjs --url <verifier-worker-url> [--project DEFAULT] [--feature DEFAULT] [--fingerprint <64-hex>] [--burst-count 25] [--expect-rate-limit] [--rotate-fingerprint] [--recovery-wait-ms 65000] [--json]

Runs a bounded public verifier staging drill. It validates malformed request
rejection, unsigned unknown-entitlement denial, and optionally verifies a
controlled burst reaches the public rate limiter and recovers after the
configured wait. With --rotate-fingerprint each burst request uses a fresh
license fingerprint, so the flood is forced onto the client-network tier
(shared client:<ip> key) rather than the entitlement tier — proving a
rotating-fingerprint abuser from one source cannot bypass the limiter. Output
is redacted and does not print assertions.`);
  process.exit(exitCode);
}

function hasFlag(args, name) {
  return args.includes(name) || args.some((arg) => arg === `${name}=true`);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index !== -1) {
    return args[index + 1];
  }
  const prefix = `${name}=`;
  const assignment = args.find((arg) => arg.startsWith(prefix));
  return assignment === undefined ? undefined : assignment.slice(prefix.length);
}

function npmConfigName(name) {
  return `npm_config_${name.replace(/^--/, "").replaceAll("-", "_")}`;
}

function npmConfigValue(env, name) {
  return env[npmConfigName(name)];
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function configFlag(args, env, name) {
  return hasFlag(args, name) || truthy(npmConfigValue(env, name));
}

function positionalArgs(args) {
  const valueOptions = new Set([
    "--url",
    "--project",
    "--feature",
    "--fingerprint",
    "--burst-count",
    "--timeout-ms",
    "--recovery-wait-ms",
  ]);
  const values = [];
  for (let index = 0; index < args.length; ++index) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      if (valueOptions.has(arg)) {
        index += 1;
      }
      continue;
    }
    values.push(arg);
  }
  return values;
}

function parsePositiveInt(value, fallback, maximum, label) {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${label}_must_be_an_integer_between_0_and_${maximum}`);
  }
  return parsed;
}

function normalizeUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("url_required");
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("url_must_be_https_or_localhost");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    usage(0);
  }
  const positional = positionalArgs(argv);
  const url = normalizeUrl(
    argValue(argv, "--url") ??
    positional[0] ??
    npmConfigValue(env, "--url") ??
    env.LICENSECC_VERIFIER_URL,
  );
  const project = argValue(argv, "--project") ?? npmConfigValue(env, "--project") ?? DEFAULT_PROJECT;
  const feature = argValue(argv, "--feature") ?? npmConfigValue(env, "--feature") ?? DEFAULT_FEATURE;
  const fingerprint = argValue(argv, "--fingerprint") ??
    npmConfigValue(env, "--fingerprint") ??
    randomBytes(32).toString("hex");
  if (!HEX_64.test(fingerprint)) {
    throw new Error("fingerprint_must_be_64_hex");
  }
  const expectRateLimit = configFlag(argv, env, "--expect-rate-limit");
  const burstCount = parsePositiveInt(
    argValue(argv, "--burst-count") ?? positional[1] ?? npmConfigValue(env, "--burst-count"),
    DEFAULT_BURST_COUNT,
    MAX_BURST_COUNT,
    "burst_count",
  );
  const timeoutMs = parsePositiveInt(
    argValue(argv, "--timeout-ms") ?? positional[2] ?? npmConfigValue(env, "--timeout-ms"),
    DEFAULT_TIMEOUT_MS,
    60_000,
    "timeout_ms",
  );
  const defaultRecoveryWait = expectRateLimit ? DEFAULT_RECOVERY_WAIT_MS : 0;
  const recoveryWaitMs = parsePositiveInt(
    argValue(argv, "--recovery-wait-ms") ?? npmConfigValue(env, "--recovery-wait-ms"),
    defaultRecoveryWait,
    MAX_RECOVERY_WAIT_MS,
    "recovery_wait_ms",
  );
  return {
    url,
    project,
    feature,
    fingerprint,
    burstCount,
    expectRateLimit,
    rotateFingerprint: configFlag(argv, env, "--rotate-fingerprint"),
    recoveryWaitMs,
    timeoutMs,
    json: configFlag(argv, env, "--json"),
  };
}

function randomNonce() {
  return randomBytes(32).toString("hex");
}

function verifyBody(options, overrides = {}) {
  return {
    project: options.project,
    feature: options.feature,
    license_fingerprint: options.fingerprint,
    device_hash: "",
    nonce: randomNonce(),
    client_version: "licensecc-public-verifier-drill/1",
    ...overrides,
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { non_json_body: text.slice(0, 120) };
  }
}

async function postVerify(options, body, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl(`${options.url}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const parsed = await readJsonResponse(response);
    return {
      status: response.status,
      ok: parsed.ok,
      code: parsed.code,
      assertion_present: typeof parsed.assertion === "string" && parsed.assertion !== "",
      server_time_present: Number.isInteger(parsed.server_time),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evaluateMalformed(result) {
  return result.status === 400 && result.ok === false && result.code === "invalid_request";
}

function evaluateUnsignedDenial(result) {
  return result.status === 200 &&
    result.ok === false &&
    result.code === "entitlement_denied" &&
    result.assertion_present === false;
}

function evaluateRateLimit(result) {
  return result.status === 429 && result.ok === false && result.code === "rate_limited";
}

async function runDrill(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleepImpl = dependencies.sleepImpl ?? sleep;
  const malformed = await postVerify(options, verifyBody(options, { license_fingerprint: "not-hex" }), fetchImpl);
  const unknownDenial = await postVerify(options, verifyBody(options), fetchImpl);
  const burst = [];
  for (let index = 0; index < options.burstCount; ++index) {
    // --rotate-fingerprint sends a distinct fingerprint per request so the burst cannot trip the
    // entitlement tier (keyed by project:feature:fingerprint); only the shared client:<ip> tier can stop it.
    const overrides = options.rotateFingerprint ? { license_fingerprint: randomBytes(32).toString("hex") } : {};
    burst.push(await postVerify(options, verifyBody(options, overrides), fetchImpl));
    if (evaluateRateLimit(burst.at(-1)) && !options.expectRateLimit) {
      break;
    }
  }
  const firstRateLimitedAt = burst.findIndex(evaluateRateLimit);
  let recovery;
  if (options.expectRateLimit && firstRateLimitedAt !== -1 && options.recoveryWaitMs > 0) {
    await sleepImpl(options.recoveryWaitMs);
    recovery = await postVerify(options, verifyBody(options, {
      license_fingerprint: randomBytes(32).toString("hex"),
    }), fetchImpl);
  }
  const failures = [];
  if (!evaluateMalformed(malformed)) {
    failures.push("malformed_request_not_rejected");
  }
  if (!evaluateUnsignedDenial(unknownDenial)) {
    failures.push("unknown_entitlement_not_unsigned_denial");
  }
  if (options.expectRateLimit && firstRateLimitedAt === -1) {
    // Distinct code by mode: a rotating-fingerprint flood that is NOT limited proves the client/global tier
    // failed to bite (distinct entitlement keys cannot have tripped the entitlement tier).
    failures.push(options.rotateFingerprint ? "rotating_fingerprint_flood_not_rate_limited" : "rate_limit_not_observed");
  }
  if (recovery !== undefined && evaluateRateLimit(recovery)) {
    failures.push("recovery_request_still_rate_limited");
  }
  return {
    ok: failures.length === 0,
    target: "<redacted-verifier-url>",
    project: options.project,
    feature: options.feature,
    fingerprint: `${options.fingerprint.slice(0, 8)}...${options.fingerprint.slice(-8)}`,
    rotate_fingerprint: Boolean(options.rotateFingerprint),
    malformed,
    unknown_denial: unknownDenial,
    burst: {
      attempts: burst.length,
      rate_limited_count: burst.filter(evaluateRateLimit).length,
      first_rate_limited_at: firstRateLimitedAt === -1 ? null : firstRateLimitedAt + 1,
      statuses: [...new Set(burst.map((item) => item.status))].sort((a, b) => a - b),
    },
    recovery: recovery === undefined ? null : recovery,
    failures,
  };
}

async function main() {
  try {
    const options = parseArgs();
    const summary = await runDrill(options);
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`public verifier drill ${summary.ok ? "passed" : "failed"}`);
      console.log(JSON.stringify(summary, null, 2));
    }
    if (!summary.ok) {
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

export {
  evaluateMalformed,
  evaluateRateLimit,
  evaluateUnsignedDenial,
  normalizeUrl,
  parseArgs,
  runDrill,
  verifyBody,
};
