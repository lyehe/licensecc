import type { DbDatabaseLike, DbPreparedStatementLike } from "@licensecc/cloudflare-runtime/d1/contract";

export type D1PreparedStatementLike = DbPreparedStatementLike;
export type D1DatabaseLike = DbDatabaseLike;

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

export type AccountOperation = "activate" | "renew" | "checkout" | "heartbeat" | "release" | "report";


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
  // Webhook dispatcher (cron-drained read-side outbox). WEBHOOK_SIGNING_SECRETS is a JSON map
  // {keyId: base64-secret} (each secret >= 32 bytes), mirroring ORDER_HMAC_SECRETS; the active
  // WEBHOOK_SIGNING_KEY_ID names which key signs deliveries. Fail-closed: with no usable secret /
  // missing active key the dispatcher logs + skips delivery (never sends unsigned). No per-endpoint
  // secret is ever stored in D1.
  WEBHOOK_SIGNING_SECRETS?: string;
  WEBHOOK_SIGNING_KEY_ID?: string;
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

export interface EntitlementRow {
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

export interface EntitlementDeviceRow {
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

export interface RateLimitDecision {
  limited: boolean;
  source?: "cloudflare-client" | "d1-client" | "d1-entitlement" | "d1-global";
}

export type RequestSignatureMode = "off" | "soft" | "required";

export interface RequestProofEvaluation {
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
