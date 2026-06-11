declare const Buffer:
  | {
      from(value: string | ArrayBuffer | Uint8Array, encoding?: string): {
        toString(encoding: string): string;
      };
    }
  | undefined;

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
}

export interface RateLimitBindingLike {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1DatabaseLike;
  VERIFY_RATE_LIMITER?: RateLimitBindingLike;
  ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: string;
  ONLINE_SIGNING_KEY_ID: string;
  MAX_ASSERTION_TTL_SECONDS?: string;
  MAX_CACHE_TTL_SECONDS?: string;
  LOG_RATE_LIMIT_DECISIONS?: string;
  D1_RATE_LIMIT_ENABLED?: string;
  D1_RATE_LIMIT_LIMIT?: string;
  D1_RATE_LIMIT_PERIOD_SECONDS?: string;
  D1_CLIENT_RATE_LIMIT_LIMIT?: string;
  D1_CLIENT_RATE_LIMIT_PERIOD_SECONDS?: string;
  D1_ENTITLEMENT_RATE_LIMIT_LIMIT?: string;
  D1_ENTITLEMENT_RATE_LIMIT_PERIOD_SECONDS?: string;
  D1_GLOBAL_RATE_LIMIT_ENABLED?: string;
  D1_GLOBAL_RATE_LIMIT_LIMIT?: string;
  D1_GLOBAL_RATE_LIMIT_PERIOD_SECONDS?: string;
}

export interface VerifyRequest {
  project: string;
  feature: string;
  license_fingerprint: string;
  device_hash?: string;
  nonce: string;
  client_version?: string;
  client_hardening?: number;
}

interface EntitlementRow {
  project: string;
  feature: string;
  license_fingerprint: string;
  device_hash: string;
  status: "active" | "revoked" | "disabled";
  assertion_ttl_seconds: number;
  cache_ttl_seconds: number;
  revocation_seq: number;
  valid_from?: number | null;
  valid_until?: number | null;
}

export interface AssertionClaims {
  purpose: string;
  version: string;
  alg: string;
  keyId: string;
  project: string;
  feature: string;
  licenseFingerprint: string;
  deviceHash: string;
  nonce: string;
  status: "ok" | "denied";
  issuedAt: number;
  expiresAt: number;
  cacheUntil: number;
  revocationSeq: number;
}

interface RateLimitDecision {
  limited: boolean;
  source?: "cloudflare-client" | "d1-client" | "d1-entitlement" | "d1-global";
}

const PURPOSE = "licensecc-online-assertion";
const VERSION = "1";
const ALGORITHM = "rsa-pkcs1-sha256";
const MAX_BODY_BYTES = 4096;
// Mirrors the C++ ABI buffer limits LCC_API_ONLINE_PROJECT_SIZE (127) and LCC_API_FEATURE_NAME_SIZE (15) in include/licensecc/datatypes.h; keep in sync.
const MAX_PROJECT_SIZE = 127;
const MAX_FEATURE_SIZE = 15;
// client_hardening is request telemetry only (a bitset of the client's self-reported
// hardening posture). It is bounded but NEVER influences the allow/deny decision and is
// never folded into the signed assertion, since a client can spoof its own posture.
const MAX_CLIENT_HARDENING = 0xffff;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const textEncoder = new TextEncoder();

let cachedSigningKey:
  | {
      cacheKey: string;
      keyPromise: Promise<CryptoKey>;
    }
  | undefined;
let signingKeyImportCount = 0;

export function resetSigningKeyCacheForTests(): void {
  cachedSigningKey = undefined;
  signingKeyImportCount = 0;
}

export function signingKeyImportCountForTests(): number {
  return signingKeyImportCount;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function parsePositiveInt(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

function envFlag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function safeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("=") || value.includes("\0")) {
    return null;
  }
  return value;
}

function requestId(request: Request): string {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}

function clientIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp !== null && cfIp !== "") {
    return cfIp;
  }
  return "unknown";
}

function shortHex(value: string | undefined): string | undefined {
  if (value === undefined || value === "") {
    return value;
  }
  if (value.length <= 16) {
    return "[redacted]";
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

type LogSeverity = "info" | "warn" | "error";

function logEvent(severity: LogSeverity, event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ event, ...fields });
  if (severity === "error") {
    console.error(line);
    return;
  }
  if (severity === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

function entitlementRateLimitKey(verifyRequest: VerifyRequest): string {
  return `${verifyRequest.project}:${verifyRequest.feature}:${verifyRequest.license_fingerprint}`;
}

function clientRateLimitKey(request: Request): string {
  return `client:${clientIp(request)}`;
}

function logRateLimitDecisions(env: Env): boolean {
  return env.LOG_RATE_LIMIT_DECISIONS === "1" || env.LOG_RATE_LIMIT_DECISIONS === "true";
}

function d1RateLimitEnabled(env: Env): boolean {
  return envFlag(env.D1_RATE_LIMIT_ENABLED);
}

function fixedWindowStart(nowSeconds: number, periodSeconds: number): number {
  return Math.floor(nowSeconds / periodSeconds) * periodSeconds;
}

async function checkD1RateLimitTier(
  env: Env,
  namespace: string,
  key: string,
  nowSeconds: number,
  limitValue: string | undefined,
  periodValue: string | undefined,
  source: RateLimitDecision["source"],
): Promise<RateLimitDecision> {
  if (!d1RateLimitEnabled(env)) {
    return { limited: false };
  }
  const limit = parsePositiveInt(limitValue ?? env.D1_RATE_LIMIT_LIMIT, 20, 10000);
  const periodSeconds = parsePositiveInt(periodValue ?? env.D1_RATE_LIMIT_PERIOD_SECONDS, 60, 3600);
  const windowStart = fixedWindowStart(nowSeconds, periodSeconds);
  const expiresAt = windowStart + periodSeconds * 2;
  const row = await env.DB.prepare(
    "INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(namespace, rate_key, window_start) DO UPDATE SET request_count = request_count + 1, expires_at = excluded.expires_at, updated_at = excluded.updated_at RETURNING request_count",
  )
    .bind(namespace, key, windowStart, expiresAt, nowSeconds)
    .first<{ request_count: number }>();
  const requestCount = Number(row?.request_count ?? 0);
  if (requestCount === 1) {
    await env.DB.prepare("DELETE FROM rate_limit_counters WHERE expires_at < ?").bind(nowSeconds).run();
  }
  return { limited: requestCount > limit, source: requestCount > limit ? source : undefined };
}

function logRateLimitTier(
  env: Env,
  requestIdValue: string,
  request: Request,
  verifyRequest: VerifyRequest,
  source: NonNullable<RateLimitDecision["source"]>,
  success: boolean,
): void {
  if (logRateLimitDecisions(env)) {
    logEvent("info", "verify.rate_limit_decision", {
      request_id: requestIdValue,
      source,
      project: verifyRequest.project,
      feature: verifyRequest.feature,
      license_fingerprint: shortHex(verifyRequest.license_fingerprint),
      client_ip: clientIp(request),
      success,
    });
  }
}

async function checkRateLimit(
  request: Request,
  env: Env,
  verifyRequest: VerifyRequest,
  requestIdValue: string,
  nowSeconds: number,
): Promise<RateLimitDecision> {
  const clientKey = clientRateLimitKey(request);
  if (env.VERIFY_RATE_LIMITER !== undefined) {
    const result = await env.VERIFY_RATE_LIMITER.limit({ key: clientKey });
    logRateLimitTier(env, requestIdValue, request, verifyRequest, "cloudflare-client", result.success);
    if (!result.success) {
      return { limited: true, source: "cloudflare-client" };
    }
  }
  const useD1RateLimit = d1RateLimitEnabled(env);
  const clientDecision = await checkD1RateLimitTier(
    env,
    "verify-v1-client",
    clientKey,
    nowSeconds,
    env.D1_CLIENT_RATE_LIMIT_LIMIT,
    env.D1_CLIENT_RATE_LIMIT_PERIOD_SECONDS,
    "d1-client",
  );
  if (useD1RateLimit) {
    logRateLimitTier(env, requestIdValue, request, verifyRequest, "d1-client", !clientDecision.limited);
  }
  if (clientDecision.limited) {
    return clientDecision;
  }

  const entitlementDecision = await checkD1RateLimitTier(
    env,
    "verify-v1-entitlement",
    entitlementRateLimitKey(verifyRequest),
    nowSeconds,
    env.D1_ENTITLEMENT_RATE_LIMIT_LIMIT,
    env.D1_ENTITLEMENT_RATE_LIMIT_PERIOD_SECONDS,
    "d1-entitlement",
  );
  if (useD1RateLimit) {
    logRateLimitTier(env, requestIdValue, request, verifyRequest, "d1-entitlement", !entitlementDecision.limited);
  }
  if (entitlementDecision.limited) {
    return entitlementDecision;
  }

  if (envFlag(env.D1_GLOBAL_RATE_LIMIT_ENABLED)) {
    const globalDecision = await checkD1RateLimitTier(
      env,
      "verify-v1-global",
      "global",
      nowSeconds,
      env.D1_GLOBAL_RATE_LIMIT_LIMIT,
      env.D1_GLOBAL_RATE_LIMIT_PERIOD_SECONDS,
      "d1-global",
    );
    if (useD1RateLimit) {
      logRateLimitTier(env, requestIdValue, request, verifyRequest, "d1-global", !globalDecision.limited);
    }
    return globalDecision;
  }
  return { limited: false };
}

export function validateVerifyRequest(value: unknown): VerifyRequest | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const project = safeString(input.project, MAX_PROJECT_SIZE);
  const feature = safeString(input.feature, MAX_FEATURE_SIZE);
  const licenseFingerprint =
    typeof input.license_fingerprint === "string" && HEX_64.test(input.license_fingerprint)
      ? input.license_fingerprint
      : null;
  const deviceHash =
    input.device_hash === undefined || input.device_hash === ""
      ? ""
      : typeof input.device_hash === "string" && HEX_64.test(input.device_hash)
        ? input.device_hash
        : null;
  const nonce = typeof input.nonce === "string" && HEX_64.test(input.nonce) ? input.nonce : null;
  const clientHardening =
    input.client_hardening === undefined
      ? 0
      : typeof input.client_hardening === "number" &&
          Number.isInteger(input.client_hardening) &&
          input.client_hardening >= 0 &&
          input.client_hardening <= MAX_CLIENT_HARDENING
        ? input.client_hardening
        : null;
  if (
    project === null ||
    feature === null ||
    licenseFingerprint === null ||
    deviceHash === null ||
    nonce === null ||
    clientHardening === null
  ) {
    return null;
  }
  return {
    project,
    feature,
    license_fingerprint: licenseFingerprint,
    device_hash: deviceHash,
    nonce,
    client_version: typeof input.client_version === "string" ? input.client_version.slice(0, 64) : undefined,
    client_hardening: clientHardening,
  };
}

function canonicalPayload(claims: AssertionClaims): string {
  return (
    `purpose=${claims.purpose}\n` +
    `version=${claims.version}\n` +
    `alg=${claims.alg}\n` +
    `key-id=${claims.keyId}\n` +
    `project=${claims.project}\n` +
    `feature=${claims.feature}\n` +
    `license-fingerprint=${claims.licenseFingerprint}\n` +
    `device-hash=${claims.deviceHash}\n` +
    `nonce=${claims.nonce}\n` +
    `status=${claims.status}\n` +
    `issued-at=${claims.issuedAt}\n` +
    `expires-at=${claims.expiresAt}\n` +
    `cache-until=${claims.cacheUntil}\n` +
    `revocation-seq=${claims.revocationSeq}\n`
  );
}

export function canonicalPayloadForTests(claims: AssertionClaims): string {
  return canonicalPayload(claims);
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  throw new Error("base64 encoder unavailable");
}

function bytesFromBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64") as unknown as ArrayBuffer);
  }
  throw new Error("base64 decoder unavailable");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bytes = bytesFromBase64(body);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function importSigningKey(pem: string): Promise<CryptoKey> {
  ++signingKeyImportCount;
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function signingCacheKey(env: Env): string {
  return `${env.ONLINE_SIGNING_KEY_ID}\n${env.ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM}`;
}

async function signingKeyFor(env: Env): Promise<CryptoKey> {
  const cacheKey = signingCacheKey(env);
  if (cachedSigningKey === undefined || cachedSigningKey.cacheKey !== cacheKey) {
    cachedSigningKey = {
      cacheKey,
      keyPromise: importSigningKey(env.ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM),
    };
  }
  return cachedSigningKey.keyPromise;
}

export async function signAssertion(claims: AssertionClaims, env: Env): Promise<string> {
  const payload = canonicalPayload(claims);
  const key = await signingKeyFor(env);
  const payloadBytes = textEncoder.encode(payload);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    payloadBytes,
  );
  return `lccoa1.${base64FromBytes(payloadBytes)}.${base64FromBytes(new Uint8Array(signature))}`;
}

async function lookupEntitlement(env: Env, request: VerifyRequest): Promise<EntitlementRow | null> {
  return env.DB.prepare(
    "SELECT project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ? LIMIT 1",
  )
    .bind(request.project, request.feature, request.license_fingerprint)
    .first<EntitlementRow>();
}

function boundedTime(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function entitlementWithinValidity(row: EntitlementRow, nowSeconds: number): boolean {
  const validFrom = boundedTime(row.valid_from);
  const validUntil = boundedTime(row.valid_until);
  if (validFrom !== null && nowSeconds < validFrom) {
    return false;
  }
  if (validUntil !== null && nowSeconds >= validUntil) {
    return false;
  }
  return true;
}

function clampToValidUntil(row: EntitlementRow, timestamp: number): number {
  const validUntil = boundedTime(row.valid_until);
  return validUntil === null ? timestamp : Math.min(timestamp, validUntil);
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
  const id = requestId(request);
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    logEvent("warn", "verify.body_too_large", { request_id: id, content_length: contentLength });
    return json({ ok: false, code: "body_too_large" }, 413);
  }
  const bodyText = await request.text();
  if (textEncoder.encode(bodyText).byteLength > MAX_BODY_BYTES) {
    logEvent("warn", "verify.body_too_large", { request_id: id, content_length: bodyText.length });
    return json({ ok: false, code: "body_too_large" }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    logEvent("warn", "verify.invalid_json", { request_id: id });
    return json({ ok: false, code: "invalid_json" }, 400);
  }
  const verifyRequest = validateVerifyRequest(parsed);
  if (verifyRequest === null) {
    logEvent("warn", "verify.invalid_request", { request_id: id });
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const rateLimitDecision = await checkRateLimit(request, env, verifyRequest, id, now);
  if (rateLimitDecision.limited) {
    logEvent("warn", "verify.rate_limited", {
      request_id: id,
      source: rateLimitDecision.source ?? "unknown",
      project: verifyRequest.project,
      feature: verifyRequest.feature,
      license_fingerprint: shortHex(verifyRequest.license_fingerprint),
      device_hash: shortHex(verifyRequest.device_hash),
      client_ip: clientIp(request),
    });
    return json({ ok: false, code: "rate_limited" }, 429);
  }

  const d1Started = Date.now();
  let row: EntitlementRow | null;
  try {
    row = await lookupEntitlement(env, verifyRequest);
  } catch (error) {
    logEvent("error", "verify.d1_error", {
      request_id: id,
      project: verifyRequest.project,
      feature: verifyRequest.feature,
      license_fingerprint: shortHex(verifyRequest.license_fingerprint),
      error: error instanceof Error ? error.message : "unknown D1 error",
    });
    return json({ ok: false, code: "verification_error" }, 500);
  }
  const d1DurationMs = Date.now() - d1Started;
  const maxAssertionTtl = parsePositiveInt(env.MAX_ASSERTION_TTL_SECONDS, 300, 3600);
  const maxCacheTtl = parsePositiveInt(env.MAX_CACHE_TTL_SECONDS, 86400, 604800);
  const activeRow =
    row !== null &&
    row.status === "active" &&
    entitlementWithinValidity(row, now) &&
    (row.device_hash === "" || row.device_hash === verifyRequest.device_hash)
      ? row
      : null;
  const assertionTtl = activeRow !== null ? Math.min(activeRow.assertion_ttl_seconds, maxAssertionTtl) : 0;
  const expiresAt = activeRow !== null ? clampToValidUntil(activeRow, now + assertionTtl) : now;
  const cacheTtl =
    activeRow !== null ? Math.min(Math.max(activeRow.cache_ttl_seconds, assertionTtl), maxCacheTtl) : 0;
  const cacheUntil = activeRow !== null ? clampToValidUntil(activeRow, now + cacheTtl) : now;

  if (activeRow === null) {
    logEvent("warn", "verify.denied", {
      request_id: id,
      project: verifyRequest.project,
      feature: verifyRequest.feature,
      license_fingerprint: shortHex(verifyRequest.license_fingerprint),
      device_hash: shortHex(verifyRequest.device_hash),
      client_hardening: verifyRequest.client_hardening ?? 0,
      revocation_seq: row?.revocation_seq ?? 0,
      d1_duration_ms: d1DurationMs,
    });
    return json({
      ok: false,
      code: "entitlement_denied",
      server_time: now,
    });
  }

  const claims: AssertionClaims = {
    purpose: PURPOSE,
    version: VERSION,
    alg: ALGORITHM,
    keyId: env.ONLINE_SIGNING_KEY_ID,
    project: verifyRequest.project,
    feature: verifyRequest.feature,
    licenseFingerprint: verifyRequest.license_fingerprint,
    deviceHash: verifyRequest.device_hash ?? "",
    nonce: verifyRequest.nonce,
    status: "ok",
    issuedAt: now,
    expiresAt,
    cacheUntil,
    revocationSeq: row?.revocation_seq ?? 0,
  };

  let assertion: string;
  try {
    assertion = await signAssertion(claims, env);
  } catch (error) {
    logEvent("error", "verify.signing_error", {
      request_id: id,
      project: verifyRequest.project,
      feature: verifyRequest.feature,
      license_fingerprint: shortHex(verifyRequest.license_fingerprint),
      error: error instanceof Error ? error.message : "unknown signing error",
    });
    return json({ ok: false, code: "verification_error" }, 500);
  }

  logEvent("info", "verify.ok", {
    request_id: id,
    project: verifyRequest.project,
    feature: verifyRequest.feature,
    license_fingerprint: shortHex(verifyRequest.license_fingerprint),
    device_hash: shortHex(verifyRequest.device_hash),
    client_hardening: verifyRequest.client_hardening ?? 0,
    assertion_ttl_seconds: assertionTtl,
    revocation_seq: claims.revocationSeq,
    d1_duration_ms: d1DurationMs,
  });

  return json({
    ok: true,
    code: "entitlement_ok",
    assertion,
    server_time: now,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "licensecc-online-verifier" });
      }
      if (request.method === "POST" && url.pathname === "/v1/verify") {
        return await handleVerify(request, env);
      }
      return json({ ok: false, code: "not_found" }, 404);
    } catch (error) {
      logEvent("error", "verify.unhandled_error", {
        request_id: requestId(request),
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : "unknown Worker error",
      });
      return json({ ok: false, code: "verification_error" }, 500);
    }
  },
};
