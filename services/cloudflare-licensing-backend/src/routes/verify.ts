import { accountAuth } from "../auth/account_auth.mjs";
import { parseDeviceProofMode, parseRequestSignatureMode } from "../security_modes.mjs";
import { json, readTextBody, requestId, clientIp, safeString } from "@licensecc/cloudflare-runtime/http/kit";
import type {
  AssertionClaims,
  AccountOperation,
  EntitlementDeviceRow,
  EntitlementRow,
  Env,
  ExecutionContextLike,
  IsolationBinding,
  RateLimitDecision,
  RequestProof,
  RequestProofEvaluation,
  RequestSignatureMode,
  VerifyRequest,
} from "../env.js";
import { logEvent, type LogSeverity } from "../observability/index.js";
import { VERIFY_SQL } from "../db/verify-statements.mjs";

declare const Buffer:
  | {
      from(value: string | ArrayBuffer | Uint8Array, encoding?: string): {
        toString(encoding: string): string;
      };
    }
  | undefined;






export const PURPOSE = "licensecc-online-assertion";
const REQUEST_PROOF_PURPOSE = "licensecc-online-request";
// Per-operation proof audiences: a proof is signed over its operation, so a proof minted for
// /v1/verify is NOT signature-valid at lease/seat issuance (and vice versa). Closes the
// missing-audience confused-deputy flaw. /v1/verify keeps REQUEST_PROOF_PURPOSE unchanged.
export const LEASE_PROOF_PURPOSE = "licensecc-lease-request";
export const SEAT_PROOF_PURPOSE = "licensecc-seat-request";
export const VERSION = "1";
export const ALGORITHM = "rsa-pkcs1-sha256";
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

export async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; code: "body_too_large" | "invalid_request"; status: number }> {
  const body = await readTextBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return { ok: false, code: "body_too_large", status: 413 };
  }
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch {
    return { ok: false, code: "invalid_request", status: 400 };
  }
}

export async function resolveIsolation(
  request: Request,
  env: Env,
  operation: AccountOperation,
  project: string,
  feature: string,
  now: number,
  ctx?: ExecutionContextLike,
  override?: IsolationBinding,
): Promise<IsolationBinding | { ok: false; code: string; status: number }> {
  if (override !== undefined) {
    return override;
  }
  const auth = await accountAuth(request, env, operation, project, feature, now, ctx);
  if (!auth.ok) {
    return { ok: false, code: auth.code, status: typeof auth.status === "number" ? auth.status : 401 };
  }
  if (auth.mode !== "off" && auth.mode !== "soft" && auth.mode !== "required") {
    return { ok: false, code: "config_error", status: 503 };
  }
  return { mode: auth.mode, customerId: auth.customerId };
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

function safeBase64(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !BASE64.test(value)) {
    return null;
  }
  return value;
}

export function safeDeviceKeyId(value: unknown): string | null {
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

function shortHex(value: string | undefined): string | undefined {
  if (value === undefined || value === "") {
    return value;
  }
  if (value.length <= 16) {
    return "[redacted]";
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
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
function requestSignatureMode(env: Env): RequestSignatureMode | null {
  const parsed = parseRequestSignatureMode(env);
  return parsed.valid ? (parsed.mode as RequestSignatureMode) : null;
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
  const row = await env.DB.prepare(VERIFY_SQL.rateLimitUpsert)
    .bind(namespace, key, windowStart, expiresAt, nowSeconds)
    .first<{ request_count: number }>();
  const requestCount = Number(row?.request_count ?? 0);
  if (requestCount === 1) {
    await env.DB.prepare(VERIFY_SQL.rateLimitCleanup).bind(nowSeconds).run();
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

export function base64FromBytes(bytes: Uint8Array): string {
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

export async function importSigningKey(pem: string): Promise<CryptoKey> {
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
  return env.DB.prepare(VERIFY_SQL.entitlementLookup)
    .bind(request.project, request.feature, request.license_fingerprint)
    .first<EntitlementRow>();
}

async function lookupEntitlementDevice(env: Env, request: VerifyRequest): Promise<EntitlementDeviceRow | null> {
  if (request.request_proof === undefined) {
    return null;
  }
  return env.DB.prepare(VERIFY_SQL.entitlementDeviceLookup)
    .bind(request.project, request.feature, request.license_fingerprint, request.request_proof.device_key_id)
    .first<EntitlementDeviceRow>();
}

export function boundedTime(value: number | null | undefined): number | null {
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

export function clampToValidUntil(row: { valid_until?: number | null }, timestamp: number): number {
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
    const row = await env.DB.prepare(VERIFY_SQL.requestProofNonceConsume)
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
      await env.DB.prepare(VERIFY_SQL.requestProofNonceCleanup).bind(nowSeconds).run();
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
  mode: RequestSignatureMode,
): Promise<RequestProofEvaluation> {
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
export function parseRequestProofFields(
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

function deviceProofMode(env: Env): "off" | "required" | null {
  const parsed = parseDeviceProofMode(env);
  return parsed.valid ? (parsed.mode as "off" | "required") : null;
}

// Lease/seat device-proof gate (relay-resistance / anti-cloning). A presented proof is ALWAYS
// verified (proving possession of the non-exportable device key binds the issuance to that
// device); proof is REQUIRED only when DEVICE_PROOF_MODE=required. Reuses the /v1/verify core.
export async function checkDeviceProof(
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
): Promise<{ ok: boolean; code?: string; proven: boolean }> {
  const mode = deviceProofMode(env);
  if (mode === null) return { ok: false, code: "config_error", proven: false };
  if (proof === undefined) {
    if (mode === "required") return { ok: false, code: "device_proof_required", proven: false };
    return { ok: true, proven: false };
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
  // `proven` is true ONLY when the ECDSA proof actually verified (device known+active, signature
  // valid, nonce fresh). The trial device-lock keys on this to require/bind a real device key.
  return evaluation.result === "valid"
    ? { ok: true, proven: true }
    : { ok: false, code: "device_proof_invalid", proven: false };
}

export async function handleVerify(request: Request, env: Env): Promise<Response> {
  const mode = requestSignatureMode(env);
  if (mode === null) {
    return json({ ok: false, code: "config_error" }, 503);
  }
  const id = requestId(request);
  const body = await readTextBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    logEvent("warn", "verify.body_too_large", { request_id: id });
    return json({ ok: false, code: "body_too_large" }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
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

  const proofEvaluation = await evaluateRequestProof(env, verifyRequest, now, mode);
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
    // device-hash is an ECHO, not a server attestation (audit R2.4): the C++ verifier checks the
    // assertion's device-hash against the client's OWN sent value (expected.device_hash =
    // request.device_hash), so it must equal what the caller sent. When binding is satisfied via the
    // proven-ECDSA-device path with a non-matching self-asserted hash, the echoed value is the
    // caller's own claim (not an attacker escalation -- it attests nothing the caller didn't already
    // hold). Signing the entitlement's bound hash instead would break that echo-check for the proof
    // path; making device-hash a server attestation is a coordinated signed-token-semantics change
    // (version bump + golden-vector regen), deferred per the ABI landmine, not a server-only edit.
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

export function requireString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
