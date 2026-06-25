import {
  buildV201CanonicalPayload,
  buildLeaseLicenseText,
  leaseCanonicalFields,
  utcDateFromEpoch,
} from "./lease/canonical_payload.mjs";
import {
  LEASE_ISSUANCE_ATOMIC_SQL,
  SEAT_CHECKOUT_ATOMIC_SQL,
  leaseIssuanceSqlOwned,
  seatCheckoutSqlOwned,
  seatHeartbeatSqlOwned,
  seatReleaseSqlOwned,
} from "./lease/issuance_sql.mjs";
import { summarizeUsage } from "./lease/usage_report.mjs";
// Slice 1 order-ingest (POST /v1/orders): signed, exactly-once subscription fulfillment.
// order_ingest.mjs is untyped Worker-safe JS (imported as a loose module surface).
import { handleOrderIngest } from "./fulfillment/order_ingest.mjs";
// Slice 2 account-token isolation (Stage 3): per-customer credential + the per-endpoint gate.
import { accountAuth, constantTimeEqual, readBearer } from "./auth/account_auth.mjs";

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
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  // F4: D1 Sessions strong read ("first-primary") so an emergency-revoked token is never served
  // from a stale replica. Feature-detected at runtime (older bindings lack it).
  withSession?(mode?: string): D1DatabaseLike;
}

// Minimal Workers ExecutionContext surface (we only use waitUntil to keep the throttled
// last_used_at write + lazy re-pepper off the response path on the hot endpoints).
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

// Slice 2 isolation binding: the account-token mode + the authenticated customer_id threaded
// from accountAuth() into the mutating SQL. In `off` mode customerId is null (legacy bearer):
// the handlers MUST take the ORIGINAL non-owned SQL path, because the `*Owned` builders bind
// `e.customer_id = ?` and `NULL = null` is never true — an owned query in off mode would match
// no entitlement and break every lease/seat. Only `soft`/`required` use the `*Owned` builders.
export interface IsolationBinding {
  mode: "off" | "soft" | "required";
  customerId: string | null;
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
  REQUEST_SIGNATURE_MODE?: string;
  REQUEST_SIGNATURE_MAX_SKEW_SECONDS?: string;
  // Lease platform (/v1/activate, /v1/renew). The HOT lease key is distinct from the
  // online assertion key and from the cold-root project key (design doc D2/D6).
  LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM?: string;
  LEASE_SIGNING_KEY_ID?: string;
  LEASE_ISSUE_BEARER?: string; // phase-1 placeholder authn; replaced by account_token (phase 2)
  LEASE_SKEW_DAYS?: string; // signed valid-from backdate, default 2
  // Device-proof (ECDSA relay-resistance) gate for lease/seat issuance: off | required.
  // A presented proof is always verified; "required" denies issuance without one. Default off
  // for back-compat; production sets "required" to make the hardware lock actually bind.
  DEVICE_PROOF_MODE?: string;
  // Slice 1 order-ingest (POST /v1/orders): the signed, exactly-once subscription
  // fulfillment inbox. ORDER_HMAC_SECRETS is a JSON map {key_id: base64-secret} (each
  // secret >= 32 bytes); the map / audience are asserted non-empty at verify time
  // (fail-closed). ORDER_INGEST_MODE: required (default) | soft (observe-only) | off
  // (dev-only). ORDER_MAX_SKEW_SECONDS default 300 (cap 3600). ORDER_INGEST_AUDIENCE
  // (e.g. "prod"/"staging") is folded into the signed bytes to block cross-env replay.
  ORDER_HMAC_SECRETS?: string;
  ORDER_INGEST_MODE?: string;
  ORDER_MAX_SKEW_SECONDS?: string;
  ORDER_INGEST_AUDIENCE?: string;
  // Slice 2 account-token isolation (D9/D10). ACCOUNT_TOKEN_PEPPERS is a JSON map
  // {id: base64 >= 32B} (fail-closed; null => 503 on the 6 scoped paths). MODE mirrors
  // REQUEST_SIGNATURE_MODE: off (runtime default; legacy bearer + shadow-eval) | soft (token
  // required, NULL-owner allowed+logged, populated-mismatch denied) | required (production;
  // NULL/mismatch denied). EMERGENCY_OPERATOR_BEARER gates the SEPARATE /v1/emergency/* break-glass route
  // ONLY (never the 6 scoped paths); unset = closed.
  ACCOUNT_TOKEN_PEPPERS?: string;
  ACCOUNT_TOKEN_ACTIVE_PEPPER_ID?: string;
  ACCOUNT_TOKEN_MODE?: string;
  ACCOUNT_TOKEN_LAST_USED_THROTTLE_SEC?: string;
  EMERGENCY_OPERATOR_BEARER?: string;
}

export interface VerifyRequest {
  project: string;
  feature: string;
  license_fingerprint: string;
  device_hash?: string;
  nonce: string;
  client_version?: string;
  client_hardening?: number;
  request_proof?: RequestProof;
}

export interface RequestProof {
  version: 1;
  device_key_id: string;
  request_timestamp: number;
  algorithm: "ecdsa-p256-sha256";
  signature: string;
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

interface EntitlementDeviceRow {
  device_key_id: string;
  public_key_spki_der_base64: string;
  status: "active" | "revoked" | "disabled";
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

type RequestSignatureMode = "off" | "soft" | "required";

interface RequestProofEvaluation {
  mode: RequestSignatureMode;
  result:
    | "not_configured"
    | "missing"
    | "valid"
    | "stale_timestamp"
    | "unknown_device"
    | "disabled_device"
    | "invalid_signature"
    | "malformed_public_key"
    | "replayed_nonce"
    | "d1_error";
  detail?: string;
  device_key_id?: string;
}

const PURPOSE = "licensecc-online-assertion";
const REQUEST_PROOF_PURPOSE = "licensecc-online-request";
// Per-operation proof audiences: a proof is signed over its operation, so a proof minted for
// /v1/verify is NOT signature-valid at lease/seat issuance (and vice versa). Closes the
// missing-audience confused-deputy flaw. /v1/verify keeps REQUEST_PROOF_PURPOSE unchanged.
const LEASE_PROOF_PURPOSE = "licensecc-lease-request";
const SEAT_PROOF_PURPOSE = "licensecc-seat-request";
const VERSION = "1";
const ALGORITHM = "rsa-pkcs1-sha256";
const REQUEST_PROOF_VERSION: RequestProof["version"] = 1;
const REQUEST_PROOF_ALGORITHM: RequestProof["algorithm"] = "ecdsa-p256-sha256";
const MAX_BODY_BYTES = 4096;
// Mirrors the C++ ABI buffer limits LCC_API_ONLINE_PROJECT_SIZE (127) and LCC_API_FEATURE_NAME_SIZE (15) in include/licensecc/datatypes.h; keep in sync.
const MAX_PROJECT_SIZE = 127;
const MAX_FEATURE_SIZE = 15;
// client_hardening is request telemetry only (a bitset of the client's self-reported
// hardening posture). It is bounded but NEVER influences the allow/deny decision and is
// never folded into the signed assertion, since a client can spoof its own posture.
const MAX_CLIENT_HARDENING = 0xffff;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const DEVICE_KEY_ID = /^sha256:[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
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

function safeBase64(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !BASE64.test(value)) {
    return null;
  }
  return value;
}

function safeDeviceKeyId(value: unknown): string | null {
  return typeof value === "string" && DEVICE_KEY_ID.test(value) ? value : null;
}

function safeUnixSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return value;
}

function shortKeyId(value: string | undefined): string | undefined {
  if (value === undefined || value === "") {
    return value;
  }
  const prefix = "sha256:";
  if (value.startsWith(prefix) && value.length > prefix.length + 16) {
    const digest = value.slice(prefix.length);
    return `${prefix}${digest.slice(0, 8)}...${digest.slice(-8)}`;
  }
  return "[redacted]";
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

// Production deployments MUST set REQUEST_SIGNATURE_MODE = "required" (see
// wrangler.example.toml) so missing/invalid/replayed request proofs are denied. The
// runtime fallback stays "off" only so an unconfigured dev Worker does not silently
// reject legacy clients. Roll out off -> soft (observe) -> required.
function requestSignatureMode(env: Env): RequestSignatureMode {
  if (env.REQUEST_SIGNATURE_MODE === "soft" || env.REQUEST_SIGNATURE_MODE === "required") {
    return env.REQUEST_SIGNATURE_MODE;
  }
  return "off";
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
  const proofFields = [
    input.request_signature_version,
    input.device_key_id,
    input.request_timestamp,
    input.request_signature_algorithm,
    input.request_signature,
  ];
  const hasProof = proofFields.some((field) => field !== undefined);
  const deviceKeyId = safeDeviceKeyId(input.device_key_id);
  const requestTimestamp = safeUnixSeconds(input.request_timestamp);
  const requestSignature = safeBase64(input.request_signature, 512);
  const requestProof: RequestProof | undefined =
    hasProof &&
    input.request_signature_version === REQUEST_PROOF_VERSION &&
    deviceKeyId !== null &&
    requestTimestamp !== null &&
    input.request_signature_algorithm === REQUEST_PROOF_ALGORITHM &&
    requestSignature !== null
      ? {
          version: REQUEST_PROOF_VERSION,
          device_key_id: deviceKeyId,
          request_timestamp: requestTimestamp,
          algorithm: REQUEST_PROOF_ALGORITHM,
          signature: requestSignature,
        }
      : undefined;
  if (
    project === null ||
    feature === null ||
    licenseFingerprint === null ||
    deviceHash === null ||
    nonce === null ||
    clientHardening === null ||
    (hasProof && requestProof === undefined)
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
    request_proof: requestProof,
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

function canonicalRequestProofPayload(request: VerifyRequest, purpose: string = REQUEST_PROOF_PURPOSE): string {
  if (request.request_proof === undefined) {
    throw new Error("request proof is missing");
  }
  return (
    `purpose=${purpose}\n` +
    `version=${request.request_proof.version}\n` +
    `alg=${request.request_proof.algorithm}\n` +
    `project=${request.project}\n` +
    `feature=${request.feature}\n` +
    `license-fingerprint=${request.license_fingerprint}\n` +
    `device-hash=${request.device_hash ?? ""}\n` +
    `nonce=${request.nonce}\n` +
    `request-timestamp=${request.request_proof.request_timestamp}\n` +
    `client-hardening=${request.client_hardening ?? 0}\n` +
    `device-key-id=${request.request_proof.device_key_id}\n`
  );
}

export function canonicalRequestProofPayloadForTests(request: VerifyRequest, purpose?: string): string {
  return canonicalRequestProofPayload(request, purpose);
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

async function importDevicePublicKey(spkiBase64: string): Promise<CryptoKey> {
  const bytes = bytesFromBase64(spkiBase64);
  const keyData = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return crypto.subtle.importKey("spki", keyData, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
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

async function lookupEntitlementDevice(env: Env, request: VerifyRequest): Promise<EntitlementDeviceRow | null> {
  if (request.request_proof === undefined) {
    return null;
  }
  return env.DB.prepare(
    "SELECT device_key_id, public_key_spki_der_base64, status FROM entitlement_devices WHERE project = ? AND feature = ? AND license_fingerprint = ? AND device_key_id = ? LIMIT 1",
  )
    .bind(request.project, request.feature, request.license_fingerprint, request.request_proof.device_key_id)
    .first<EntitlementDeviceRow>();
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

function proofFailureCode(evaluation: RequestProofEvaluation): string {
  switch (evaluation.result) {
    case "missing":
      return "request_proof_required";
    case "stale_timestamp":
      return "request_proof_stale";
    case "unknown_device":
    case "disabled_device":
    case "invalid_signature":
    case "malformed_public_key":
    case "replayed_nonce":
      return "request_proof_invalid";
    default:
      return "verification_error";
  }
}

function logRequestProofDecision(
  severity: LogSeverity,
  requestIdValue: string,
  verifyRequest: VerifyRequest,
  evaluation: RequestProofEvaluation,
): void {
  logEvent(severity, "verify.request_proof", {
    request_id: requestIdValue,
    mode: evaluation.mode,
    result: evaluation.result,
    project: verifyRequest.project,
    feature: verifyRequest.feature,
    license_fingerprint: shortHex(verifyRequest.license_fingerprint),
    device_hash: shortHex(verifyRequest.device_hash),
    device_key_id: shortKeyId(evaluation.device_key_id ?? verifyRequest.request_proof?.device_key_id),
    detail: evaluation.detail,
  });
}

async function verifyRequestSignature(publicKeySpkiDerBase64: string, payload: string, signatureBase64: string): Promise<boolean> {
  const key = await importDevicePublicKey(publicKeySpkiDerBase64);
  const signature = bytesFromBase64(signatureBase64);
  const signatureData = signature.buffer.slice(
    signature.byteOffset,
    signature.byteOffset + signature.byteLength,
  ) as ArrayBuffer;
  const payloadBytes = textEncoder.encode(payload);
  const payloadData = payloadBytes.buffer.slice(
    payloadBytes.byteOffset,
    payloadBytes.byteOffset + payloadBytes.byteLength,
  ) as ArrayBuffer;
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signatureData, payloadData);
}

// Returns "fresh" if this is the first time the nonce is consumed for this device,
// "replayed" if it was already consumed within the skew window, or "error" if the
// store is unavailable. The caller MUST treat "error" as deny (fail closed). The
// INSERT ... ON CONFLICT DO NOTHING RETURNING is the race-free primitive: the first
// request for a (project, feature, fingerprint, device_key_id, nonce) gets a row back;
// a concurrent or later replay gets null.
async function consumeRequestProofNonce(
  env: Env,
  request: VerifyRequest,
  proof: RequestProof,
  nowSeconds: number,
  skewSeconds: number,
): Promise<"fresh" | "replayed" | "error"> {
  // A replay can only land inside the accepted skew window on either side of the
  // signed request-timestamp, so keep the row until the window certainly closes.
  const expiresAt = nowSeconds + skewSeconds * 2;
  try {
    const row = await env.DB.prepare(
      "INSERT INTO request_proof_nonces (project, feature, license_fingerprint, device_key_id, nonce, request_timestamp, consumed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project, feature, license_fingerprint, device_key_id, nonce) DO NOTHING RETURNING nonce",
    )
      .bind(
        request.project,
        request.feature,
        request.license_fingerprint,
        proof.device_key_id,
        request.nonce,
        proof.request_timestamp,
        nowSeconds,
        expiresAt,
      )
      .first<{ nonce: string }>();
    if (row === null) {
      return "replayed";
    }
    // Opportunistic sweep (mirrors checkD1RateLimitTier). Best-effort; a sweep
    // failure must not turn a fresh nonce into a denial, so swallow it.
    try {
      await env.DB.prepare("DELETE FROM request_proof_nonces WHERE expires_at < ?").bind(nowSeconds).run();
    } catch {
      // ignore: cleanup is not load-bearing for correctness
    }
    return "fresh";
  } catch {
    // Store unavailable: fail closed. Never allow a request we cannot dedupe.
    return "error";
  }
}

// Verify a device proof: skew, device lookup + status, ECDSA signature over the canonical
// payload, and nonce replay-defense. Returns the result WITHOUT the global-mode wrapper so it can
// be reused by the lease/seat paths (which gate proof PRESENCE differently from /v1/verify).
async function evaluateProofForRequest(
  env: Env,
  verifyRequest: VerifyRequest,
  proof: RequestProof,
  nowSeconds: number,
  purpose: string,
): Promise<Omit<RequestProofEvaluation, "mode">> {
  const maxSkewSeconds = parsePositiveInt(env.REQUEST_SIGNATURE_MAX_SKEW_SECONDS, 300, 3600);
  if (Math.abs(nowSeconds - proof.request_timestamp) > maxSkewSeconds) {
    return {
      result: "stale_timestamp",
      detail: "request proof timestamp is outside the accepted skew window",
      device_key_id: proof.device_key_id,
    };
  }

  let device: EntitlementDeviceRow | null;
  try {
    device = await lookupEntitlementDevice(env, verifyRequest);
  } catch (error) {
    return {
      result: "d1_error",
      detail: error instanceof Error ? error.message : "device lookup failed",
      device_key_id: proof.device_key_id,
    };
  }
  if (device === null) {
    return {
      result: "unknown_device",
      detail: "device key is not registered for this entitlement",
      device_key_id: proof.device_key_id,
    };
  }
  if (device.status !== "active") {
    return { result: "disabled_device", detail: "device key is not active", device_key_id: proof.device_key_id };
  }

  let valid: boolean;
  try {
    valid = await verifyRequestSignature(
      device.public_key_spki_der_base64,
      canonicalRequestProofPayload(verifyRequest, purpose),
      proof.signature,
    );
  } catch (error) {
    return {
      result: "malformed_public_key",
      detail: error instanceof Error ? error.message : "request proof verification failed",
      device_key_id: proof.device_key_id,
    };
  }
  if (!valid) {
    return { result: "invalid_signature", detail: "request proof signature did not verify", device_key_id: proof.device_key_id };
  }

  // Signature, skew, and device are good. Now spend the nonce. This is the relay defense: a
  // replay of this exact signed body finds the nonce already consumed.
  const nonceState = await consumeRequestProofNonce(env, verifyRequest, proof, nowSeconds, maxSkewSeconds);
  if (nonceState === "error") {
    // Fail CLOSED: a replay store we cannot reach denies, never allows.
    return { result: "d1_error", detail: "request proof nonce store is unavailable", device_key_id: proof.device_key_id };
  }
  if (nonceState === "replayed") {
    return { result: "replayed_nonce", detail: "request proof nonce was already consumed", device_key_id: proof.device_key_id };
  }
  return { result: "valid", device_key_id: proof.device_key_id };
}

async function evaluateRequestProof(
  env: Env,
  verifyRequest: VerifyRequest,
  nowSeconds: number,
): Promise<RequestProofEvaluation> {
  const mode = requestSignatureMode(env);
  if (mode === "off") {
    return { mode, result: "not_configured" };
  }
  const proof = verifyRequest.request_proof;
  if (proof === undefined) {
    return { mode, result: "missing", detail: "request proof is not present" };
  }
  return { mode, ...(await evaluateProofForRequest(env, verifyRequest, proof, nowSeconds, REQUEST_PROOF_PURPOSE)) };
}

// Parse the flat request-proof fields shared by /v1/verify, lease, and seat requests. The proof's
// device key is the request's own device_key_id (already parsed). Returns { invalid: true } when
// some proof fields are present but malformed, so the caller can reject rather than silently drop.
function parseRequestProofFields(
  input: Record<string, unknown>,
  deviceKeyId: string | null,
): { proof?: RequestProof; invalid: boolean } {
  const present = [
    input.request_signature_version,
    input.request_timestamp,
    input.request_signature_algorithm,
    input.request_signature,
  ].some((field) => field !== undefined);
  if (!present) return { invalid: false };
  const requestTimestamp = safeUnixSeconds(input.request_timestamp);
  const requestSignature = safeBase64(input.request_signature, 512);
  if (
    input.request_signature_version === REQUEST_PROOF_VERSION &&
    deviceKeyId !== null &&
    requestTimestamp !== null &&
    input.request_signature_algorithm === REQUEST_PROOF_ALGORITHM &&
    requestSignature !== null
  ) {
    return {
      invalid: false,
      proof: {
        version: REQUEST_PROOF_VERSION,
        device_key_id: deviceKeyId,
        request_timestamp: requestTimestamp,
        algorithm: REQUEST_PROOF_ALGORITHM,
        signature: requestSignature,
      },
    };
  }
  return { invalid: true };
}

function deviceProofMode(env: Env): "off" | "required" {
  return env.DEVICE_PROOF_MODE === "required" ? "required" : "off";
}

// Lease/seat device-proof gate (relay-resistance / anti-cloning). A presented proof is ALWAYS
// verified (proving possession of the non-exportable device key binds the issuance to that
// device); proof is REQUIRED only when DEVICE_PROOF_MODE=required. Reuses the /v1/verify core.
async function checkDeviceProof(
  env: Env,
  fields: {
    project: string;
    feature: string;
    license_fingerprint: string;
    device_hash: string;
    nonce: string;
    client_hardening?: number;
  },
  proof: RequestProof | undefined,
  now: number,
  purpose: string,
): Promise<{ ok: boolean; code?: string }> {
  if (proof === undefined) {
    if (deviceProofMode(env) === "required") return { ok: false, code: "device_proof_required" };
    return { ok: true };
  }
  const verifyRequest: VerifyRequest = {
    project: fields.project,
    feature: fields.feature,
    license_fingerprint: fields.license_fingerprint,
    device_hash: fields.device_hash,
    nonce: fields.nonce,
    client_hardening: fields.client_hardening,
    request_proof: proof,
  };
  const evaluation = await evaluateProofForRequest(env, verifyRequest, proof, now, purpose);
  return evaluation.result === "valid" ? { ok: true } : { ok: false, code: "device_proof_invalid" };
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

  const proofEvaluation = await evaluateRequestProof(env, verifyRequest, now);
  if (proofEvaluation.result !== "not_configured") {
    const severity: LogSeverity =
      proofEvaluation.result === "valid" ? "info" : proofEvaluation.result === "d1_error" ? "error" : "warn";
    logRequestProofDecision(severity, id, verifyRequest, proofEvaluation);
  }
  if (proofEvaluation.mode === "required" && proofEvaluation.result !== "valid") {
    if (proofEvaluation.result === "d1_error") {
      return json({ ok: false, code: "verification_error" }, 500);
    }
    return json({ ok: false, code: proofFailureCode(proofEvaluation), server_time: now });
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
  // Binding is satisfied by EITHER the (unchanged) plaintext device_hash match, OR --
  // additionally -- a cryptographically verified device key in required mode. The plaintext
  // clause is request-controlled and intentionally left as-is for back-compat; the new clause
  // lets a proven ECDSA device satisfy binding even when the self-asserted device_hash does
  // not match. This LOOSENS the accept condition (adds an accept path); it removes nothing.
  const proofVerified = proofEvaluation.result === "valid";
  const deviceHashSatisfied =
    row !== null &&
    (row.device_hash === "" ||
      row.device_hash === verifyRequest.device_hash ||
      (proofVerified && proofEvaluation.mode === "required"));
  const activeRow =
    row !== null && row.status === "active" && entitlementWithinValidity(row, now) && deviceHashSatisfied
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
      request_signature_mode: proofEvaluation.mode,
      request_proof: proofEvaluation.result,
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
    request_signature_mode: proofEvaluation.mode,
    request_proof: proofEvaluation.result,
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

// ============================ Lease platform (activate / renew) ============================
//
// Sliding-window, hardware-bound, signed v201 leases (design doc 2026-06-21). The Worker
// is the public edge: it authenticates, checks the entitlement, CLAMPS the lease expiry to
// the subscription end (so a cancelled/expired subscription cannot be over-issued), enforces
// the device-rebind cap ATOMICALLY (no check-then-insert TOCTOU), then signs a lease with
// the HOT lease key. The device-key ECDSA *proof* (relay-resistance) is the documented next
// layer, wired to the existing entitlement_devices + request_proof_nonces machinery.

const LEASE_DEFAULT_SKEW_DAYS = 2;
const LEASE_DEFAULT_SECONDS = 2592000;

interface LeaseEntitlementRow {
  status: string;
  valid_from: number | null;
  valid_until: number | null;
  max_active_devices: number;
  lease_seconds: number;
  rebind_window_sec: number;
}

interface LeaseIssueBody {
  project: string;
  feature: string;
  license_fingerprint: string;
  device_key_id: string;
  hw_id?: string; // client-signature (XXXX-XXXX-XXXX) for the .lic offline HW binding
  client_signature_source_strength?: string;
  start_version?: string;
  end_version?: string;
  request_id?: string; // idempotency key
  nonce?: string; // required when a device proof is present (canonical payload + replay dedup)
  request_proof?: RequestProof;
}

let cachedLeaseSigningKey: { cacheKey: string; keyPromise: Promise<CryptoKey> } | undefined;

async function leaseSigningKeyFor(env: Env): Promise<CryptoKey> {
  const pem = env.LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM ?? "";
  const cacheKey = `${env.LEASE_SIGNING_KEY_ID ?? ""}\n${pem}`;
  if (cachedLeaseSigningKey === undefined || cachedLeaseSigningKey.cacheKey !== cacheKey) {
    cachedLeaseSigningKey = { cacheKey, keyPromise: importSigningKey(pem) };
  }
  return cachedLeaseSigningKey.keyPromise;
}

export function resetLeaseSigningKeyCacheForTests(): void {
  cachedLeaseSigningKey = undefined;
}

async function signLeaseLicense(fields: Record<string, string | undefined>, env: Env): Promise<string> {
  const payload = buildV201CanonicalPayload(fields);
  const key = await leaseSigningKeyFor(env);
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, payload.bytes);
  return buildLeaseLicenseText(fields, base64FromBytes(new Uint8Array(signature)));
}

function requireString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseLeaseBody(raw: unknown): LeaseIssueBody | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const project = requireString(value.project);
  const feature = requireString(value.feature);
  const licenseFingerprint = requireString(value.license_fingerprint);
  const deviceKeyId = requireString(value.device_key_id);
  if (project === null || feature === null || licenseFingerprint === null || deviceKeyId === null) return null;
  const body: LeaseIssueBody = {
    project,
    feature,
    license_fingerprint: licenseFingerprint,
    device_key_id: deviceKeyId,
  };
  if (typeof value.hw_id === "string" && value.hw_id.length > 0) body.hw_id = value.hw_id;
  if (typeof value.client_signature_source_strength === "string") {
    body.client_signature_source_strength = value.client_signature_source_strength;
  }
  if (typeof value.start_version === "string") body.start_version = value.start_version;
  if (typeof value.end_version === "string") body.end_version = value.end_version;
  if (typeof value.request_id === "string" && value.request_id.length > 0) body.request_id = value.request_id;
  if (typeof value.nonce === "string" && value.nonce.length > 0) body.nonce = value.nonce;
  const proofResult = parseRequestProofFields(value, deviceKeyId);
  if (proofResult.invalid) return null; // proof fields present but malformed -> reject
  if (proofResult.proof !== undefined) {
    if (body.nonce === undefined) return null; // a lease proof needs a nonce
    body.request_proof = proofResult.proof;
  }
  return body;
}

function leaseWithinValidity(row: { valid_from: number | null; valid_until: number | null }, nowSeconds: number): boolean {
  const validFrom = boundedTime(row.valid_from);
  const validUntil = boundedTime(row.valid_until);
  if (validFrom !== null && nowSeconds < validFrom) return false;
  if (validUntil !== null && nowSeconds >= validUntil) return false;
  return true;
}

async function lookupLeaseEntitlement(env: Env, body: LeaseIssueBody): Promise<LeaseEntitlementRow | null> {
  return env.DB.prepare(
    "SELECT status, valid_from, valid_until, max_active_devices, lease_seconds, rebind_window_sec FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ? LIMIT 1",
  )
    .bind(body.project, body.feature, body.license_fingerprint)
    .first<LeaseEntitlementRow>();
}

// Atomic device-rebind cap. The INSERT lands only if the number of DISTINCT *other*
// devices issued within the rebind window is below max_active_devices, so a renew of an
// existing device always succeeds and a brand-new device is capped -- evaluated and written
// in ONE statement (no check-then-insert race). Returns the inserted row, or null when the
// cap would be exceeded. Mirrors the race-free consumeRequestProofNonce pattern.
async function atomicLeaseIssuance(
  env: Env,
  body: LeaseIssueBody,
  row: LeaseEntitlementRow,
  now: number,
  validFromEpoch: number,
  validToEpoch: number,
  leaseKeyId: string,
  isolation: IsolationBinding,
): Promise<boolean> {
  const windowStart = now - (row.rebind_window_sec > 0 ? row.rebind_window_sec : 0);
  const maxDevices = row.max_active_devices > 0 ? row.max_active_devices : 1;
  // Off mode (legacy bearer, customerId null): the ORIGINAL non-owned cap guard. An owned guard
  // would bind `e.customer_id = null` and match nothing, breaking issuance — so off must NOT use
  // the owned SQL. The 15-param bind order is the original LEASE_ISSUANCE_ATOMIC_SQL contract.
  if (isolation.mode === "off") {
    const inserted = await env.DB.prepare(LEASE_ISSUANCE_ATOMIC_SQL)
      .bind(
        body.project,
        body.feature,
        body.license_fingerprint,
        body.device_key_id,
        leaseKeyId,
        now,
        validFromEpoch,
        validToEpoch,
        body.request_id ?? null,
        body.project,
        body.feature,
        body.license_fingerprint,
        windowStart,
        body.device_key_id,
        maxDevices,
      )
      .first<{ id: number }>();
    return inserted !== null;
  }
  // soft / required: F2/F3 — the ownership EXISTS (customer_id + status='active' + validity) is
  // folded into the cap guard, so a revoke/expiry/wrong-owner between the pre-read and this write
  // cannot mint a lease. The signed lease derives from the guard-confirmed insert (RETURNING id),
  // not the advisory pre-read. The device-count subquery stays tuple-scoped.
  const inserted = await env.DB.prepare(leaseIssuanceSqlOwned(isolation.mode))
    .bind(
      body.project,
      body.feature,
      body.license_fingerprint,
      body.device_key_id,
      leaseKeyId,
      now,
      validFromEpoch,
      validToEpoch,
      body.request_id ?? null,
      body.project,
      body.feature,
      body.license_fingerprint,
      windowStart,
      body.device_key_id,
      maxDevices,
      // EXISTS ownership binds: project, feature, fingerprint, customer_id, now, now.
      body.project,
      body.feature,
      body.license_fingerprint,
      isolation.customerId,
      now,
      now,
    )
    .first<{ id: number }>();
  return inserted !== null;
}

// F1: idempotency MUST be scoped by the authenticated customer_id so a replay of customer B's
// request_id under customer A's token MISSES the cache (different scope) and falls through to the
// ownership guard, which denies. In off/bearer mode the customerId is null -> the legacy "lease"
// scope is preserved (no behavior change before the cutover).
function leaseIdempotencyScope(isolation: IsolationBinding): string {
  return isolation.customerId === null ? "lease" : `lease:${isolation.customerId}`;
}

async function getLeaseIdempotent(
  env: Env,
  requestId: string | undefined,
  isolation: IsolationBinding,
): Promise<unknown | null> {
  if (requestId === undefined) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT response_json FROM mutation_idempotency WHERE scope = ? AND idempotency_key = ? LIMIT 1",
    )
      .bind(leaseIdempotencyScope(isolation), requestId)
      .first<{ response_json: string }>();
    return row === null ? null : JSON.parse(row.response_json);
  } catch {
    return null; // best-effort; a missing idempotency hit just re-issues
  }
}

async function putLeaseIdempotent(
  env: Env,
  requestId: string | undefined,
  response: unknown,
  now: number,
  isolation: IsolationBinding,
): Promise<void> {
  if (requestId === undefined) return;
  try {
    await env.DB.prepare(
      "INSERT INTO mutation_idempotency (scope, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope, idempotency_key) DO NOTHING",
    )
      .bind(leaseIdempotencyScope(isolation), requestId, JSON.stringify(response), now)
      .run();
  } catch {
    // best-effort; idempotency is an optimization, not a correctness gate here
  }
}

async function handleLeaseIssue(
  request: Request,
  env: Env,
  operation: "activate" | "renew",
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);

  if (!env.LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM || !env.LEASE_SIGNING_KEY_ID) {
    return json({ ok: false, code: "lease_signing_unavailable" }, 503);
  }

  let body: LeaseIssueBody | null;
  try {
    body = parseLeaseBody(await request.json());
  } catch {
    body = null;
  }
  if (body === null) return json({ ok: false, code: "invalid_request" }, 400);

  // Per-customer account-token gate (replaces the legacy LEASE_ISSUE_BEARER check). The
  // returned customerId is bound into the mutating cap guard (off => null => legacy SQL path).
  const auth = await accountAuth(request, env, operation, body.project, body.feature, now, ctx);
  if (!auth.ok) return json({ ok: false, code: auth.code }, auth.status);
  const isolation: IsolationBinding = { mode: auth.mode, customerId: auth.customerId };

  let row: LeaseEntitlementRow | null;
  try {
    row = await lookupLeaseEntitlement(env, body);
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  if (row === null || row.status !== "active" || !leaseWithinValidity(row, now)) {
    return json({ ok: false, code: "no_active_entitlement" }, 403);
  }
  const validUntil = boundedTime(row.valid_until);
  if (validUntil !== null && validUntil <= now) {
    return json({ ok: false, code: "expired_subscription" }, 403);
  }

  // Idempotency AFTER the entitlement/status/expiry gate, so a captured request_id cannot re-serve
  // a lease for a now-revoked or -expired entitlement. (A cached hit is a benign return of the
  // device-bound lease already issued for this request_id; valid_to was clamped at issuance.)
  const cached = await getLeaseIdempotent(env, body.request_id, isolation);
  if (cached !== null) return json(cached);

  // Device-proof gate (relay-resistance / anti-cloning): a presented proof binds the lease to the
  // registered, non-exportable device key; required mode denies issuance without one.
  const leaseProof = await checkDeviceProof(
    env,
    { project: body.project, feature: body.feature, license_fingerprint: body.license_fingerprint, device_hash: "", nonce: body.nonce ?? "", client_hardening: 0 },
    body.request_proof,
    now,
    LEASE_PROOF_PURPOSE,
  );
  if (!leaseProof.ok) return json({ ok: false, code: leaseProof.code }, 403);

  // Clamp the lease expiry to the subscription end (the kill-switch). Mandatory signed
  // valid-from is backdated by SKEW_DAYS to absorb day-granularity skew.
  const leaseSeconds = row.lease_seconds > 0 ? row.lease_seconds : LEASE_DEFAULT_SECONDS;
  const validToEpoch = validUntil === null ? now + leaseSeconds : Math.min(now + leaseSeconds, validUntil);
  const skewDays = Number.parseInt(env.LEASE_SKEW_DAYS ?? "", 10);
  const effectiveSkewDays = Number.isInteger(skewDays) && skewDays >= 0 ? skewDays : LEASE_DEFAULT_SKEW_DAYS;
  const validFromEpoch = Math.max(0, now - effectiveSkewDays * 86400);

  let inserted: boolean;
  try {
    inserted = await atomicLeaseIssuance(env, body, row, now, validFromEpoch, validToEpoch, env.LEASE_SIGNING_KEY_ID, isolation);
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  if (!inserted) return json({ ok: false, code: "device_limit_exceeded" }, 403);

  const fields = leaseCanonicalFields({
    project: body.project,
    feature: body.feature,
    keyId: env.LEASE_SIGNING_KEY_ID,
    validFrom: utcDateFromEpoch(validFromEpoch),
    validTo: utcDateFromEpoch(validToEpoch),
    clientSignature: body.hw_id,
    clientSignatureSourceStrength: body.hw_id
      ? body.client_signature_source_strength ?? "strong-disk-serial-or-uuid"
      : undefined,
    startVersion: body.start_version,
    endVersion: body.end_version,
  });

  let lic: string;
  try {
    lic = await signLeaseLicense(fields, env);
  } catch (error) {
    logEvent("error", "lease.signing_error", {
      request_id: requestId(request),
      error: error instanceof Error ? error.message : "unknown signing error",
    });
    return json({ ok: false, code: "lease_signing_error" }, 500);
  }

  // renew_by is a SOFT anomaly signal (preserves offline-tolerance): a client that has not
  // re-issued by then is surfaced server-side, but valid_to remains the hard offline limit.
  const renewBy = now + Math.floor(leaseSeconds / 2);
  const response = { ok: true, lic, server_time: now, renew_by: renewBy, valid_to_epoch: validToEpoch };
  await putLeaseIdempotent(env, body.request_id, response, now, isolation);
  return json(response);
}

// ============================ Floating / concurrent licensing ============================
//
// A shared pool of N simultaneous seats per entitlement (design doc
// 2026-06-22-floating-concurrent-licensing.md). Online-required: the server is the live
// source of truth for who holds a seat. A held seat is a short-TTL lccoa1 assertion (the
// SAME token /v1/verify mints and the C++ online_verification already validates) that the
// client refreshes via heartbeat. Checkout is the race-free atomic cap counting LIVE seats;
// disconnected clients are reclaimed when their heartbeat deadline lapses. Borrowing is the
// bounded offline escape.

const SEAT_DEFAULT_GRACE_SEC = 900;

interface SeatEntitlementRow {
  status: string;
  valid_from: number | null;
  valid_until: number | null;
  pool_size: number;
  heartbeat_grace_sec: number;
  max_borrow_sec: number;
  allow_overdraft: number;
  revocation_seq: number;
}

interface SeatRequestBody {
  project: string;
  feature: string;
  license_fingerprint: string;
  client_instance_id: string;
  nonce: string;
  seat_id?: string;
  borrow_seconds?: number;
  device_key_id?: string; // registered ECDSA device key (for the optional device proof)
  request_proof?: RequestProof;
}

function parseSeatBody(raw: unknown, needSeatId: boolean): SeatRequestBody | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const project = requireString(value.project);
  const feature = requireString(value.feature);
  const fingerprint = requireString(value.license_fingerprint);
  const clientInstance = requireString(value.client_instance_id);
  const nonce = requireString(value.nonce);
  if (project === null || feature === null || fingerprint === null || clientInstance === null || nonce === null) {
    return null;
  }
  const body: SeatRequestBody = {
    project,
    feature,
    license_fingerprint: fingerprint,
    client_instance_id: clientInstance,
    nonce,
  };
  const seatId = requireString(value.seat_id);
  if (needSeatId) {
    if (seatId === null) return null;
    body.seat_id = seatId;
  } else if (seatId !== null) {
    body.seat_id = seatId;
  }
  if (typeof value.borrow_seconds === "number" && Number.isInteger(value.borrow_seconds) && value.borrow_seconds > 0) {
    body.borrow_seconds = value.borrow_seconds;
  }
  const deviceKeyId = safeDeviceKeyId(value.device_key_id);
  if (deviceKeyId !== null) body.device_key_id = deviceKeyId;
  const proofResult = parseRequestProofFields(value, deviceKeyId);
  if (proofResult.invalid) return null; // proof fields present but malformed -> reject
  if (proofResult.proof !== undefined) body.request_proof = proofResult.proof;
  return body;
}

async function lookupSeatEntitlement(env: Env, body: SeatRequestBody): Promise<SeatEntitlementRow | null> {
  return env.DB.prepare(
    "SELECT status, valid_from, valid_until, pool_size, heartbeat_grace_sec, max_borrow_sec, allow_overdraft, revocation_seq FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ? LIMIT 1",
  )
    .bind(body.project, body.feature, body.license_fingerprint)
    .first<SeatEntitlementRow>();
}

async function signSeatToken(
  env: Env,
  body: SeatRequestBody,
  row: SeatEntitlementRow,
  now: number,
  deadline: number,
): Promise<string> {
  const claims: AssertionClaims = {
    purpose: PURPOSE,
    version: VERSION,
    alg: ALGORITHM,
    keyId: env.ONLINE_SIGNING_KEY_ID,
    project: body.project,
    feature: body.feature,
    licenseFingerprint: body.license_fingerprint,
    deviceHash: "",
    nonce: body.nonce,
    status: "ok",
    issuedAt: now,
    expiresAt: deadline,
    cacheUntil: deadline,
    revocationSeq: row.revocation_seq ?? 0,
  };
  return signAssertion(claims, env);
}

// Seat signing-availability check. Authn is now the per-customer accountAuth() gate (account-token
// isolation), called separately by each seat handler so the customerId can be bound into the
// mutating seat SQL. The legacy LEASE_ISSUE_BEARER bearer is handled inside accountAuth (off mode).
function seatSigningUnavailable(env: Env): Response | null {
  if (!env.ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM || !env.ONLINE_SIGNING_KEY_ID) {
    return json({ ok: false, code: "seat_signing_unavailable" }, 503);
  }
  return null;
}

async function handleSeatCheckout(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const gate = seatSigningUnavailable(env);
  if (gate !== null) return gate;

  let body: SeatRequestBody | null;
  try {
    body = parseSeatBody(await request.json(), /*needSeatId=*/ false);
  } catch {
    body = null;
  }
  if (body === null) return json({ ok: false, code: "invalid_request" }, 400);

  const auth = await accountAuth(request, env, "checkout", body.project, body.feature, now, ctx);
  if (!auth.ok) return json({ ok: false, code: auth.code }, auth.status);
  const isolation: IsolationBinding = { mode: auth.mode, customerId: auth.customerId };

  let row: SeatEntitlementRow | null;
  try {
    row = await lookupSeatEntitlement(env, body);
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  if (row === null || row.status !== "active" || !leaseWithinValidity(row, now)) {
    return json({ ok: false, code: "no_active_entitlement" }, 403);
  }
  if (row.pool_size <= 0) return json({ ok: false, code: "floating_disabled" }, 403);

  // Device-proof gate (relay-resistance): a presented proof binds the seat to a registered device
  // key; required mode denies a seat without one. The seat nonce doubles as the proof nonce.
  const seatProof = await checkDeviceProof(
    env,
    { project: body.project, feature: body.feature, license_fingerprint: body.license_fingerprint, device_hash: "", nonce: body.nonce, client_hardening: 0 },
    body.request_proof,
    now,
    SEAT_PROOF_PURPOSE,
  );
  if (!seatProof.ok) return json({ ok: false, code: seatProof.code }, 403);

  // Live by default; borrow only when the entitlement permits it, bounded by max_borrow_sec.
  let mode = "live";
  const grace = row.heartbeat_grace_sec > 0 ? row.heartbeat_grace_sec : SEAT_DEFAULT_GRACE_SEC;
  let deadline = now + grace;
  if (body.borrow_seconds !== undefined) {
    if (row.max_borrow_sec <= 0) return json({ ok: false, code: "borrowing_disabled" }, 403);
    mode = "borrowed";
    deadline = now + Math.min(body.borrow_seconds, row.max_borrow_sec);
  }

  const ceiling = row.pool_size + (row.allow_overdraft > 0 ? row.allow_overdraft : 0);
  const seatId = crypto.randomUUID();
  let granted: boolean;
  try {
    // off => original pool guard (customerId null can't bind an owned EXISTS); soft/required =>
    // the owned guard folds the ownership EXISTS (customer_id + status='active' + validity) into
    // the SAME atomic pool-cap statement (the pool COUNT subquery stays tuple-scoped).
    const inserted =
      isolation.mode === "off"
        ? await env.DB.prepare(SEAT_CHECKOUT_ATOMIC_SQL)
            .bind(
              body.project,
              body.feature,
              body.license_fingerprint,
              seatId,
              body.client_instance_id,
              mode,
              now,
              deadline,
              body.project,
              body.feature,
              body.license_fingerprint,
              now,
              ceiling,
            )
            .first<{ seat_id: string }>()
        : await env.DB.prepare(seatCheckoutSqlOwned(isolation.mode))
            .bind(
              body.project,
              body.feature,
              body.license_fingerprint,
              seatId,
              body.client_instance_id,
              mode,
              now,
              deadline,
              body.project,
              body.feature,
              body.license_fingerprint,
              now,
              ceiling,
              // EXISTS ownership binds: project, feature, fingerprint, customer_id, now, now.
              body.project,
              body.feature,
              body.license_fingerprint,
              isolation.customerId,
              now,
              now,
            )
            .first<{ seat_id: string }>();
    granted = inserted !== null;
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  if (!granted) {
    await recordUsageEvent(env, {
      project: body.project,
      feature: body.feature,
      fingerprint: body.license_fingerprint,
      event_type: "denied",
      reason: "pool_exhausted",
      ts: now,
    });
    return json({ ok: false, code: "pool_exhausted" }, 409);
  }

  await recordUsageEvent(env, {
    project: body.project,
    feature: body.feature,
    fingerprint: body.license_fingerprint,
    event_type: "checkout",
    seat_id: seatId,
    // The PROVEN device key (present only with a verified proof), not the attacker-chosen
    // client_instance_id, so unique_devices counts cryptographically-verified devices.
    device_key_id: body.request_proof !== undefined ? body.device_key_id : undefined,
    ts: now,
  });

  // Lazy reclamation on the hot path; a Cron Trigger (scheduled, below) also sweeps so idle
  // entitlements with no further checkouts still get their seats reclaimed promptly.
  await sweepLapsedSeats(env, now);

  let assertion: string;
  try {
    assertion = await signSeatToken(env, body, row, now, deadline);
  } catch {
    return json({ ok: false, code: "seat_signing_error" }, 500);
  }
  return json({
    ok: true,
    assertion,
    seat_id: seatId,
    mode,
    server_time: now,
    expires_at: deadline,
    heartbeat_in: Math.max(1, Math.floor(grace / 3)),
  });
}

async function handleSeatHeartbeat(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const gate = seatSigningUnavailable(env);
  if (gate !== null) return gate;

  let body: SeatRequestBody | null;
  try {
    body = parseSeatBody(await request.json(), /*needSeatId=*/ true);
  } catch {
    body = null;
  }
  if (body === null || body.seat_id === undefined) return json({ ok: false, code: "invalid_request" }, 400);

  const auth = await accountAuth(request, env, "heartbeat", body.project, body.feature, now, ctx);
  if (!auth.ok) return json({ ok: false, code: auth.code }, auth.status);
  const isolation: IsolationBinding = { mode: auth.mode, customerId: auth.customerId };

  let row: SeatEntitlementRow | null;
  try {
    row = await lookupSeatEntitlement(env, body);
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  if (row === null || row.status !== "active" || !leaseWithinValidity(row, now)) {
    return json({ ok: false, code: "no_active_entitlement" }, 403);
  }

  const grace = row.heartbeat_grace_sec > 0 ? row.heartbeat_grace_sec : SEAT_DEFAULT_GRACE_SEC;
  const deadline = now + grace;
  // Refresh only a still-live, non-borrowed seat; a reclaimed/expired seat yields no row. off =>
  // original UPDATE; soft/required => the owned UPDATE adds an ownership EXISTS so A can never
  // heartbeat B's seat (bind order: deadline, project, feature, fingerprint, seat_id, now, customer_id).
  let refreshed: boolean;
  try {
    const updated =
      isolation.mode === "off"
        ? await env.DB.prepare(
            "UPDATE seat_checkouts SET heartbeat_deadline = ? WHERE project = ? AND feature = ? AND license_fingerprint = ? AND seat_id = ? AND mode = 'live' AND heartbeat_deadline > ? RETURNING seat_id",
          )
            .bind(deadline, body.project, body.feature, body.license_fingerprint, body.seat_id, now)
            .first<{ seat_id: string }>()
        : await env.DB.prepare(seatHeartbeatSqlOwned(isolation.mode))
            .bind(deadline, body.project, body.feature, body.license_fingerprint, body.seat_id, now, isolation.customerId)
            .first<{ seat_id: string }>();
    refreshed = updated !== null;
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  if (!refreshed) return json({ ok: false, code: "seat_reclaimed" }, 410);

  let assertion: string;
  try {
    assertion = await signSeatToken(env, body, row, now, deadline);
  } catch {
    return json({ ok: false, code: "seat_signing_error" }, 500);
  }
  return json({
    ok: true,
    assertion,
    server_time: now,
    expires_at: deadline,
    heartbeat_in: Math.max(1, Math.floor(grace / 3)),
  });
}

async function handleSeatRelease(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  let body: SeatRequestBody | null;
  try {
    body = parseSeatBody(await request.json(), /*needSeatId=*/ true);
  } catch {
    body = null;
  }
  if (body === null || body.seat_id === undefined) return json({ ok: false, code: "invalid_request" }, 400);

  const auth = await accountAuth(request, env, "release", body.project, body.feature, now, ctx);
  if (!auth.ok) return json({ ok: false, code: auth.code }, auth.status);
  const isolation: IsolationBinding = { mode: auth.mode, customerId: auth.customerId };

  let removed: boolean;
  try {
    // off => original DELETE; soft/required => the owned DELETE adds an ownership EXISTS so A can
    // never free B's seat (0 rows freed for a wrong/NULL owner; the {ok:true} stays idempotent).
    // Bind order: project, feature, fingerprint, seat_id, customer_id.
    const deleted =
      isolation.mode === "off"
        ? await env.DB.prepare(
            "DELETE FROM seat_checkouts WHERE project = ? AND feature = ? AND license_fingerprint = ? AND seat_id = ? RETURNING seat_id",
          )
            .bind(body.project, body.feature, body.license_fingerprint, body.seat_id)
            .first<{ seat_id: string }>()
        : await env.DB.prepare(seatReleaseSqlOwned(isolation.mode))
            .bind(body.project, body.feature, body.license_fingerprint, body.seat_id, isolation.customerId)
            .first<{ seat_id: string }>();
    removed = deleted !== null;
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  // Only record a release that actually freed a seat. A seat already reclaimed by the sweep (the
  // routine lapse-then-release-on-shutdown lifecycle) must NOT emit a second end event -- that
  // phantom -1 undercounts peak_concurrent. The HTTP response stays idempotent regardless.
  if (removed) {
    await recordUsageEvent(env, {
      project: body.project,
      feature: body.feature,
      fingerprint: body.license_fingerprint,
      event_type: "release",
      seat_id: body.seat_id,
      ts: now,
    });
  }
  return json({ ok: true, server_time: now });
}

// ============================ Usage reporting (analytics) ============================
//
// An append-only usage_events log (the FlexNet "report log") that the peak-concurrent /
// denial-rate / adoption analytics aggregate over. Capture is best-effort: analytics must
// never fail a license operation. The aggregations are pure (src/lease/usage_report.mjs).

const USAGE_EVENT_RETENTION_SEC = 90 * 24 * 60 * 60; // reports cover up to 90d; longer => rollups
const USAGE_REPORT_MAX_ROWS = 100000; // honest cap: beyond this a window report is flagged truncated
const LEASE_ISSUANCE_RETENTION_SEC = 180 * 24 * 60 * 60; // > max rebind_window_sec so the rebind cap keeps its rows

async function recordUsageEvent(
  env: Env,
  e: {
    project: string;
    feature: string;
    fingerprint: string;
    event_type: "checkout" | "release" | "reclaim" | "denied";
    seat_id?: string;
    device_key_id?: string;
    reason?: string;
    ts: number;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO usage_events (project, feature, license_fingerprint, event_type, seat_id, device_key_id, reason, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(e.project, e.feature, e.fingerprint, e.event_type, e.seat_id ?? null, e.device_key_id ?? null, e.reason ?? null, e.ts)
      .run();
  } catch (error) {
    // Best-effort: a missed analytics row must never break licensing -- but make the drop
    // observable so a silent peak_concurrent undercount is detectable in logs.
    logEvent("warn", "usage.record_dropped", {
      project: e.project,
      feature: e.feature,
      event_type: e.event_type,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

// Sweep lapsed seats (heartbeat_deadline < now): delete them and record a 'reclaim' at the ACTUAL
// deadline (when concurrency dropped), each under its own entitlement. Used lazily on the checkout
// hot path and by the scheduled (cron) handler so idle entitlements still reclaim promptly.
async function sweepLapsedSeats(env: Env, now: number): Promise<void> {
  try {
    const swept = await env.DB.prepare(
      "DELETE FROM seat_checkouts WHERE heartbeat_deadline < ? RETURNING project, feature, license_fingerprint, seat_id, heartbeat_deadline",
    )
      .bind(now)
      .all<{ project: string; feature: string; license_fingerprint: string; seat_id: string; heartbeat_deadline: number }>();
    for (const reclaimed of swept.results ?? []) {
      await recordUsageEvent(env, {
        project: reclaimed.project,
        feature: reclaimed.feature,
        fingerprint: reclaimed.license_fingerprint,
        event_type: "reclaim",
        seat_id: reclaimed.seat_id,
        ts: Number(reclaimed.heartbeat_deadline),
      });
    }
  } catch {
    // best-effort: reclamation is not load-bearing for any single request
  }
}

interface UsageRow {
  event_type: string;
  seat_id: string | null;
  device_key_id: string | null;
  ts: number;
}

// Live seats at instant t (for a windowed report's baseline): checkouts minus ends before t.
// The ownership EXISTS (soft/required) gates the baseline on the SAME entitlement-ownership
// conjunct as the report read, so a foreign/NULL-owner entitlement contributes nothing to A's
// baseline. off => the original tuple-scoped reads (customerId null can't bind an owned EXISTS).
async function liveSeatsAt(
  env: Env,
  project: string,
  feature: string,
  fingerprint: string,
  t: number,
  isolation: IsolationBinding,
): Promise<number> {
  try {
    // Distinct seats checked out before t minus distinct seats ended before t = seats still open
    // at t. EXCEPT dedups by seat_id, so a seat with both a reclaim AND a release (a double-end)
    // is subtracted once, not twice (which would silently deflate the baseline -> peak).
    const ownership =
      isolation.mode === "off"
        ? ""
        : "AND EXISTS (SELECT 1 FROM entitlements e WHERE e.project = usage_events.project AND e.feature = usage_events.feature " +
          "AND e.license_fingerprint = usage_events.license_fingerprint AND " +
          (isolation.mode === "soft" ? "(e.customer_id = ? OR e.customer_id IS NULL)" : "e.customer_id = ?") +
          ") ";
    const sql =
      "SELECT COUNT(*) AS baseline FROM (" +
      `SELECT seat_id FROM usage_events WHERE project = ? AND feature = ? AND license_fingerprint = ? AND seat_id IS NOT NULL AND event_type = 'checkout' AND ts < ? ${ownership}` +
      "EXCEPT " +
      `SELECT seat_id FROM usage_events WHERE project = ? AND feature = ? AND license_fingerprint = ? AND seat_id IS NOT NULL AND event_type IN ('release', 'reclaim') AND ts < ? ${ownership})`;
    const binds: unknown[] =
      isolation.mode === "off"
        ? [project, feature, fingerprint, t, project, feature, fingerprint, t]
        : [project, feature, fingerprint, t, isolation.customerId, project, feature, fingerprint, t, isolation.customerId];
    const row = await env.DB.prepare(sql).bind(...binds).first<{ baseline: number }>();
    return Math.max(0, Number(row?.baseline ?? 0));
  } catch {
    return 0;
  }
}

async function handleUsageReport(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
  const url = new URL(request.url);
  const project = url.searchParams.get("project");
  const feature = url.searchParams.get("feature");
  const fingerprint = url.searchParams.get("license_fingerprint");
  if (!project || !feature || !fingerprint) return json({ ok: false, code: "invalid_request" }, 400);

  const now = Math.floor(Date.now() / 1000);
  const auth = await accountAuth(request, env, "report", project, feature, now, ctx);
  if (!auth.ok) return json({ ok: false, code: auth.code }, auth.status);
  const isolation: IsolationBinding = { mode: auth.mode, customerId: auth.customerId };

  const fromParam = Number.parseInt(url.searchParams.get("from") ?? "", 10);
  const toParam = Number.parseInt(url.searchParams.get("to") ?? "", 10);
  const windowFrom = Number.isInteger(fromParam) && fromParam > 0 ? fromParam : 0;
  const windowTo = Number.isInteger(toParam) && toParam > 0 ? toParam : now;

  // off => the original tuple-scoped read; soft/required => fold the ownership EXISTS into the
  // usage_events read so a foreign/NULL-owner entitlement's events never surface in A's report.
  const reportOwnership =
    isolation.mode === "off"
      ? ""
      : "AND EXISTS (SELECT 1 FROM entitlements e WHERE e.project = usage_events.project AND e.feature = usage_events.feature " +
        "AND e.license_fingerprint = usage_events.license_fingerprint AND " +
        (isolation.mode === "soft" ? "(e.customer_id = ? OR e.customer_id IS NULL)" : "e.customer_id = ?") +
        ") ";
  const reportSql =
    `SELECT event_type, seat_id, device_key_id, ts FROM usage_events WHERE project = ? AND feature = ? AND license_fingerprint = ? AND ts >= ? AND ts <= ? ${reportOwnership}ORDER BY ts ASC LIMIT ?`;
  const reportBinds: unknown[] =
    isolation.mode === "off"
      ? [project, feature, fingerprint, windowFrom, windowTo, USAGE_REPORT_MAX_ROWS + 1]
      : [project, feature, fingerprint, windowFrom, windowTo, isolation.customerId, USAGE_REPORT_MAX_ROWS + 1];

  let rows: UsageRow[];
  try {
    const result = await env.DB.prepare(reportSql).bind(...reportBinds).all<UsageRow>();
    rows = result.results ?? [];
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  // Honest scale guard: if the window holds more events than the cap, the summary is over a
  // prefix only -- flag it rather than report a silently-wrong peak. (Rollups remove the cap.)
  const truncated = rows.length > USAGE_REPORT_MAX_ROWS;
  if (truncated) rows = rows.slice(0, USAGE_REPORT_MAX_ROWS);
  const baseline = windowFrom > 0 ? await liveSeatsAt(env, project, feature, fingerprint, windowFrom, isolation) : 0;
  const summary = summarizeUsage(rows, baseline);
  return json({ ok: true, project, feature, from: windowFrom, to: windowTo, server_time: now, truncated, ...summary });
}

// D10 break-glass dispatcher. Reachable ONLY at /v1/emergency/* (a path the 6 scoped routes can
// never produce), gated by a constant-time EMERGENCY_OPERATOR_BEARER compare. On a verified match
// it forces a NON-ISOLATED env (ACCOUNT_TOKEN_MODE=off, no LEASE_ISSUE_BEARER) so the underlying
// handler runs the legacy SQL path with customerId null — the operator override, not a customer's
// scoped credential — and logs the use loudly. The bearer is never logged (L10).
async function handleEmergencyRoute(
  request: Request,
  env: Env,
  url: URL,
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const configured = env.EMERGENCY_OPERATOR_BEARER;
  // Unset/empty => the route does not exist (no oracle): 404, same as any unknown path.
  if (configured === undefined || configured === "") return json({ ok: false, code: "not_found" }, 404);
  const raw = readBearer(request);
  const okBearer = raw !== null && (await constantTimeEqual(raw, configured));
  if (!okBearer) return json({ ok: false, code: "unauthorized" }, 401);

  // Strip the /v1/emergency prefix to recover the target scoped path.
  const target = url.pathname.slice("/v1/emergency".length); // e.g. "/v1/release"
  logEvent("warn", "account.emergency_override_used", {
    request_id: requestId(request),
    method: request.method,
    target,
    client_ip: clientIp(request),
  });

  // Force the non-isolated path: off mode (customerId null) and no legacy bearer re-check.
  const emergencyEnv: Env = { ...env, ACCOUNT_TOKEN_MODE: "off", LEASE_ISSUE_BEARER: "" };

  if (request.method === "POST" && (target === "/v1/activate" || target === "/v1/renew")) {
    return await handleLeaseIssue(request, emergencyEnv, target === "/v1/activate" ? "activate" : "renew", ctx);
  }
  if (request.method === "POST" && target === "/v1/checkout") {
    return await handleSeatCheckout(request, emergencyEnv, ctx);
  }
  if (request.method === "POST" && target === "/v1/heartbeat") {
    return await handleSeatHeartbeat(request, emergencyEnv, ctx);
  }
  if (request.method === "POST" && target === "/v1/release") {
    return await handleSeatRelease(request, emergencyEnv, ctx);
  }
  if (request.method === "GET" && target === "/v1/admin/report") {
    return await handleUsageReport(request, emergencyEnv, ctx);
  }
  return json({ ok: false, code: "not_found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "licensecc-online-verifier" });
      }
      if (request.method === "POST" && url.pathname === "/v1/verify") {
        return await handleVerify(request, env);
      }
      if (request.method === "POST" && url.pathname === "/v1/orders") {
        return await handleOrderIngest(request, env);
      }
      // D10 break-glass: a SEPARATE /v1/emergency/* route gated ONLY by EMERGENCY_OPERATOR_BEARER
      // (constant-time), never reachable from the 6 scoped paths. On match it dispatches the
      // corresponding handler with isolation FORCED off (non-isolated, customerId null) and logs
      // loudly. Unset bearer or a non-match => 404/401 (no oracle that the route exists).
      if (url.pathname.startsWith("/v1/emergency/")) {
        return await handleEmergencyRoute(request, env, url, ctx);
      }
      if (request.method === "POST" && (url.pathname === "/v1/activate" || url.pathname === "/v1/renew")) {
        return await handleLeaseIssue(request, env, url.pathname === "/v1/activate" ? "activate" : "renew", ctx);
      }
      if (request.method === "POST" && url.pathname === "/v1/checkout") {
        return await handleSeatCheckout(request, env, ctx);
      }
      if (request.method === "POST" && url.pathname === "/v1/heartbeat") {
        return await handleSeatHeartbeat(request, env, ctx);
      }
      if (request.method === "POST" && url.pathname === "/v1/release") {
        return await handleSeatRelease(request, env, ctx);
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/report") {
        return await handleUsageReport(request, env, ctx);
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

  // Cron Trigger: reclaim lapsed seats so idle entitlements still free seats and log their
  // reclaim (keeping peak_concurrent accurate without waiting for a later checkout), and enforce
  // retention on the append-only logs. Wire via [triggers] crons in wrangler.toml.
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await sweepLapsedSeats(env, now);
    try {
      await env.DB.prepare("DELETE FROM usage_events WHERE ts < ?").bind(now - USAGE_EVENT_RETENTION_SEC).run();
    } catch {
      // best-effort
    }
    try {
      await env.DB.prepare("DELETE FROM lease_issuance WHERE issued_at < ?").bind(now - LEASE_ISSUANCE_RETENTION_SEC).run();
    } catch {
      // best-effort
    }
  },
};
