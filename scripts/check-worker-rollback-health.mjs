import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const serviceOrder = Object.freeze(["backend", "admin", "portal", "backup"]);
const allowedFlags = new Set([
  "--environment",
  "--backend-url",
  "--admin-url",
  "--portal-url",
  "--backup-url",
]);
const maxAccessJwtBytes = 16 * 1024;
const healthBodyLimit = 16 * 1024;
const summaryBodyLimit = 256 * 1024;
const openApiBodyLimit = 1024 * 1024;
const requestTimeoutMilliseconds = 10_000;

export class SafeRollbackHealthError extends Error {
  constructor(code, { service, check, evidence } = {}) {
    super(code);
    this.name = "SafeRollbackHealthError";
    this.code = code;
    this.service = service;
    this.check = check;
    this.evidence = evidence;
  }
}

function fail(code, service, check) {
  throw new SafeRollbackHealthError(code, { service, check });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function isPlaceholderHostname(hostname) {
  return hostname === "localhost" || hostname.endsWith(".localhost") ||
    /(?:^|\.)example\.(?:com|net|org)$/u.test(hostname) ||
    /\.(?:example|invalid|test)$/u.test(hostname);
}

function canonicalHttpsOrigin(value, service) {
  if (typeof value !== "string" || value === "" || value !== value.trim() || hasControlCharacters(value)) {
    fail("INVALID_CANONICAL_ORIGIN", service, "target");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("INVALID_CANONICAL_ORIGIN", service, "target");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value.replace(/\/$/u, "") ||
    isPlaceholderHostname(parsed.hostname.toLowerCase())
  ) {
    fail("INVALID_CANONICAL_ORIGIN", service, "target");
  }
  return parsed.origin;
}

function validatedAdminAccessJwt(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    Buffer.byteLength(value, "utf8") > maxAccessJwtBytes ||
    hasControlCharacters(value)
  ) {
    fail("MISSING_ADMIN_ACCESS_CREDENTIAL", "admin", "authenticated_summary");
  }
  return value;
}

export function parseRollbackHealthArguments(argv, environment = process.env) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) fail("INVALID_ARGUMENTS");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowedFlags.has(flag)) fail("UNKNOWN_ARGUMENT");
    if (values.has(flag)) fail("DUPLICATE_ARGUMENT");
    if (typeof value !== "string" || value === "") fail("MISSING_ARGUMENT_VALUE");
    values.set(flag, value);
  }

  const targetEnvironment = values.get("--environment");
  if (targetEnvironment !== "staging" && targetEnvironment !== "production") {
    fail("INVALID_ENVIRONMENT");
  }
  const commit = environment.GITHUB_SHA;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/iu.test(commit)) {
    fail("INVALID_COMMIT_IDENTITY");
  }

  const origins = Object.fromEntries(serviceOrder.map((service) => [
    service,
    canonicalHttpsOrigin(values.get(`--${service}-url`), service),
  ]));
  if (new Set(Object.values(origins)).size !== serviceOrder.length) {
    fail("DUPLICATE_SERVICE_ORIGIN", undefined, "target");
  }

  return Object.freeze({
    environment: targetEnvironment,
    exactCommitSha: commit.toLowerCase(),
    origins: Object.freeze(origins),
    adminAccessJwt: validatedAdminAccessJwt(environment.LICENSECC_ACCESS_JWT),
  });
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    // The result already fails closed; cancellation cannot change the verdict.
  }
}

async function readBoundedBytes(response, limit, service, check) {
  const declaredLength = response.headers?.get("content-length");
  if (declaredLength !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) || Number(declaredLength) > limit)) {
    await cancelBody(response);
    fail("RESPONSE_TOO_LARGE", service, check);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) fail("EMPTY_RESPONSE_BODY", service, check);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail("INVALID_RESPONSE_BODY", service, check);
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // The bounded reader has already rejected the response.
        }
        fail("RESPONSE_TOO_LARGE", service, check);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SafeRollbackHealthError) throw error;
    fail("RESPONSE_READ_FAILED", service, check);
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    Buffer.from(chunk).copy(bytes, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function getJson(fetchImpl, origin, path, { headers = {}, limit, service, check }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMilliseconds);
  try {
    let response;
    try {
      response = await fetchImpl(new URL(path, origin), {
        method: "GET",
        headers: { accept: "application/json", ...headers },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      fail("REQUEST_FAILED", service, check);
    }
    if (!response || typeof response.status !== "number" || !response.headers) {
      fail("INVALID_RESPONSE", service, check);
    }
    if (response.status !== 200) {
      await cancelBody(response);
      fail("UNEXPECTED_RESPONSE_STATUS", service, check);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/iu.test(contentType)) {
      await cancelBody(response);
      fail("INVALID_RESPONSE_CONTENT_TYPE", service, check);
    }
    const bytes = await readBoundedBytes(response, limit, service, check);
    let body;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      fail("INVALID_JSON_RESPONSE", service, check);
    }
    if (!isRecord(body)) fail("INVALID_JSON_RESPONSE", service, check);
    return Object.freeze({
      body,
      evidence: Object.freeze({
        request_method: "GET",
        redirect_policy: "reject",
        status: response.status,
        response_bytes: bytes.byteLength,
        response_sha256: digest(bytes),
      }),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function validateBackendHealth(result) {
  const warnings = result.body.config_warnings;
  if (
    result.body.ok !== true ||
    result.body.service !== "licensecc-online-verifier" ||
    result.body.account_token_mode !== "required" ||
    (warnings !== undefined && (!Array.isArray(warnings) || warnings.length !== 0))
  ) {
    fail("READINESS_CONTRACT_FAILED", "backend", "health");
  }
  return { ...result.evidence, code: "backend_ready" };
}

function validateAdminSummary(result) {
  if (result.body.ok !== true || result.body.code !== "summary") {
    fail("READINESS_CONTRACT_FAILED", "admin", "authenticated_summary");
  }
  return { ...result.evidence, code: "summary" };
}

function validatePortalHealth(result) {
  if (
    result.body.ok !== true ||
    result.body.code !== "healthy" ||
    !isRecord(result.body.data) ||
    result.body.data.account_token_mode_required !== true
  ) {
    fail("READINESS_CONTRACT_FAILED", "portal", "health");
  }
  return { ...result.evidence, code: "healthy" };
}

function validateBackupHealth(result) {
  if (result.body.ok !== true || result.body.code !== "backup_ready") {
    fail("READINESS_CONTRACT_FAILED", "backup", "health");
  }
  return { ...result.evidence, code: "backup_ready" };
}

function validateOpenApi(result, service) {
  if (
    result.body.openapi !== "3.1.0" ||
    !isRecord(result.body.info) ||
    typeof result.body.info.version !== "string" ||
    result.body.info.version === "" ||
    !isRecord(result.body.paths) ||
    Object.keys(result.body.paths).length === 0
  ) {
    fail("OPENAPI_CONTRACT_FAILED", service, "openapi");
  }
  return {
    ...result.evidence,
    code: "openapi_3_1",
    path_count: Object.keys(result.body.paths).length,
  };
}

function accessHeaders(token) {
  return {
    "cf-access-jwt-assertion": token,
    cookie: `CF_Authorization=${token}`,
  };
}

async function checkService(service, options, fetchImpl) {
  const origin = options.origins[service];
  const headers = service === "admin" ? accessHeaders(options.adminAccessJwt) : {};
  if (service === "backend") {
    const health = validateBackendHealth(await getJson(fetchImpl, origin, "/health", {
      headers, limit: healthBodyLimit, service, check: "health",
    }));
    const contract = validateOpenApi(await getJson(fetchImpl, origin, "/openapi.json", {
      headers, limit: openApiBodyLimit, service, check: "openapi",
    }), service);
    return { status: "succeeded", canonical_origin: "<redacted>", canonical_origin_sha256: digest(origin), health, contract };
  }
  if (service === "admin") {
    const health = validateAdminSummary(await getJson(fetchImpl, origin, "/api/admin/summary", {
      headers, limit: summaryBodyLimit, service, check: "authenticated_summary",
    }));
    const contract = validateOpenApi(await getJson(fetchImpl, origin, "/openapi.json", {
      headers, limit: openApiBodyLimit, service, check: "openapi",
    }), service);
    return { status: "succeeded", canonical_origin: "<redacted>", canonical_origin_sha256: digest(origin), health, contract };
  }
  if (service === "portal") {
    const health = validatePortalHealth(await getJson(fetchImpl, origin, "/health", {
      headers, limit: healthBodyLimit, service, check: "health",
    }));
    const contract = validateOpenApi(await getJson(fetchImpl, origin, "/openapi.json", {
      headers, limit: openApiBodyLimit, service, check: "openapi",
    }), service);
    return { status: "succeeded", canonical_origin: "<redacted>", canonical_origin_sha256: digest(origin), health, contract };
  }
  const health = validateBackupHealth(await getJson(fetchImpl, origin, "/health", {
    headers, limit: healthBodyLimit, service, check: "health",
  }));
  return {
    status: "succeeded",
    canonical_origin: "<redacted>",
    canonical_origin_sha256: digest(origin),
    health,
    contract: { ...health, code: "backup_ready_envelope" },
  };
}

function timestamp(milliseconds) {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) {
    fail("INVALID_CLOCK");
  }
  return new Date(milliseconds).toISOString();
}

export async function checkWorkerRollbackHealth(options, {
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const started = now();
  timestamp(started);
  const services = {};
  try {
    for (const service of serviceOrder) {
      services[service] = await checkService(service, options, fetchImpl);
    }
  } catch (error) {
    const safeError = error instanceof SafeRollbackHealthError
      ? error
      : new SafeRollbackHealthError("UNEXPECTED_FAILURE");
    const failedAt = now();
    const completed = Number.isFinite(failedAt) && failedAt >= started ? failedAt : started;
    safeError.evidence = {
      schema_version: 1,
      operation: "worker-rollback-postcheck",
      environment: options.environment,
      exact_commit_sha: options.exactCommitSha,
      status: "failed",
      storage_action: "none",
      started_at: timestamp(started),
      completed_at: timestamp(completed),
      elapsed_ms: completed - started,
      services,
      error: {
        code: safeError.code,
        ...(safeError.service ? { service: safeError.service } : {}),
        ...(safeError.check ? { check: safeError.check } : {}),
      },
    };
    throw safeError;
  }
  const completed = now();
  if (completed < started) fail("INVALID_CLOCK");
  return Object.freeze({
    schema_version: 1,
    operation: "worker-rollback-postcheck",
    environment: options.environment,
    exact_commit_sha: options.exactCommitSha,
    status: "succeeded",
    storage_action: "none",
    started_at: timestamp(started),
    completed_at: timestamp(completed),
    elapsed_ms: completed - started,
    services,
  });
}

export function safeRollbackHealthFailureEvidence(error) {
  const safeError = error instanceof SafeRollbackHealthError
    ? error
    : new SafeRollbackHealthError("UNEXPECTED_FAILURE");
  return safeError.evidence ?? {
    schema_version: 1,
    operation: "worker-rollback-postcheck",
    status: "failed",
    storage_action: "none",
    error: {
      code: safeError.code,
      ...(safeError.service ? { service: safeError.service } : {}),
      ...(safeError.check ? { check: safeError.check } : {}),
    },
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseRollbackHealthArguments(process.argv.slice(2));
    const evidence = await checkWorkerRollbackHealth(options);
    console.log(JSON.stringify(evidence));
  } catch (error) {
    console.log(JSON.stringify(safeRollbackHealthFailureEvidence(error)));
    process.exitCode = 1;
  }
}
