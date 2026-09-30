#!/usr/bin/env node
// Post-deploy smoke for protected licensing. It needs no credential and changes no
// licensing state: it proves the deployed backend reports protected readiness and
// that its protected challenge route answers an unknown enrollment attempt with the
// expected denial. Evidence is redacted: no origin, handle or response body.
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = "licensecc.protected-readiness-smoke.v1";
const SERVICE = "licensecc-online-verifier";
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const USAGE = "usage: node scripts/protected-readiness-smoke.mjs --url <canonical https backend origin>";

class SmokeFailure extends Error {
  constructor(code, check, status, details) {
    super(code);
    this.code = code;
    this.check = check;
    this.status = status;
    this.details = details;
  }
}

export function parseSmokeArguments(argv) {
  let value;
  if (argv.length === 1 && argv[0].startsWith("--url=")) value = argv[0].slice("--url=".length);
  else if (argv.length === 2 && argv[0] === "--url") value = argv[1];
  let url;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error(USAGE);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/"
      || url.search || url.hash || value.replace(/\/$/u, "") !== url.origin) {
    throw new Error(USAGE);
  }
  return { origin: url.origin };
}

async function boundedJson(response, check) {
  if (!/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel().catch(() => {});
    throw new SmokeFailure("INVALID_RESPONSE", check, response.status);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new SmokeFailure("INVALID_RESPONSE", check, response.status);
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new SmokeFailure("RESPONSE_TOO_LARGE", check, response.status);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (body !== null && typeof body === "object" && !Array.isArray(body)) return body;
  } catch { /* A malformed body is reported by its class only. */ }
  throw new SmokeFailure("INVALID_RESPONSE", check, response.status);
}

async function request(fetchImpl, url, init, check) {
  try {
    return await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new SmokeFailure("REQUEST_FAILED", check);
  }
}

export async function runProtectedReadinessSmoke({ origin }, { fetchImpl = fetch } = {}) {
  const health = await request(fetchImpl, `${origin}/health`, { method: "GET", headers: { accept: "application/json" } }, "health");
  const healthBody = await boundedJson(health, "health");
  if (health.status !== 200 || healthBody.ok !== true || healthBody.service !== SERVICE || healthBody.protected_device_ready !== true) {
    throw new SmokeFailure("PROTECTED_NOT_READY", "health", health.status);
  }
  // config_warnings is a names-only signal for a half-configured deploy (a missing
  // signer-scope map, an unbound edge limiter): a deploy that reports any must still fail
  // this gate, even though protected_device_ready stayed true. The evidence below carries
  // only the warning COUNT, never the warning text.
  const configWarnings = healthBody.config_warnings;
  if (configWarnings !== undefined && (!Array.isArray(configWarnings) || configWarnings.length !== 0)) {
    throw new SmokeFailure(
      "CONFIG_WARNINGS_PRESENT",
      "health",
      health.status,
      Array.isArray(configWarnings) ? { config_warning_count: configWarnings.length } : undefined,
    );
  }

  // Fresh random handles match no enrollment attempt, so the challenge route must
  // deny before creating anything. Any other answer means the protected route,
  // its configuration or its schema is not serving as deployed.
  const challengeBody = JSON.stringify({
    purpose: "exchange",
    attempt_handle: randomBytes(32).toString("base64url"),
    operation_id: randomBytes(32).toString("base64url"),
  });
  const challenge = await request(fetchImpl, `${origin}/v2/device-challenges`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: challengeBody,
  }, "unauthenticated_challenge");
  const denial = await boundedJson(challenge, "unauthenticated_challenge");
  if (challenge.status !== 404 || denial.ok !== false || denial.code !== "authorization_unavailable") {
    throw new SmokeFailure("UNEXPECTED_CHALLENGE_RESULT", "unauthenticated_challenge", challenge.status);
  }

  return {
    schema_version: SCHEMA_VERSION,
    status: "succeeded",
    backend_origin: "<redacted>",
    backend_origin_sha256: createHash("sha256").update(origin).digest("hex"),
    checks: {
      health: { request_method: "GET", status: 200, protected_device_ready: true },
      unauthenticated_challenge: { request_method: "POST", status: 404, code: "authorization_unavailable" },
    },
  };
}

export async function main(argv, { fetchImpl = fetch, stdout = process.stdout } = {}) {
  const write = (evidence) => stdout.write(JSON.stringify(evidence) + "\n");
  let options;
  try {
    options = parseSmokeArguments(argv);
  } catch {
    write({ schema_version: SCHEMA_VERSION, status: "failed", error: { code: "INVALID_ARGUMENTS" } });
    return 2;
  }
  try {
    write(await runProtectedReadinessSmoke(options, { fetchImpl }));
    return 0;
  } catch (error) {
    const failure = error instanceof SmokeFailure
      ? {
        code: error.code,
        check: error.check,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.details ?? {}),
      }
      : { code: "UNEXPECTED_FAILURE" };
    write({ schema_version: SCHEMA_VERSION, status: "failed", error: failure });
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
