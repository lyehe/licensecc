import type { DbDatabaseLike, DbPreparedStatementLike } from "@licensecc/cloudflare-runtime/d1/contract";

export type D1PreparedStatementLike = DbPreparedStatementLike;
export type D1DatabaseLike = DbDatabaseLike;

// Minimal Workers ExecutionContext surface passed to the route and scheduled handlers.
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface RateLimitBindingLike {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

// `wrangler types` intentionally emits literal values from the checked example
// config. Keep those strings broad at the service boundary: deployed mode
// values may differ, while resource bindings retain their generated types.
type WidenWranglerStringBindings<Bindings extends object> = {
  [Binding in keyof Bindings]: Bindings[Binding] extends string ? string : Bindings[Binding];
};

type WithRuntimeNarrowing<Generated extends object, Runtime extends object> = Omit<Generated, keyof Runtime> & Runtime;

type IncompatibleGeneratedBindings<Generated extends object, Runtime extends object> = {
  [Binding in keyof Generated & keyof Runtime]: Generated[Binding] extends Runtime[Binding] ? never : Binding;
}[keyof Generated & keyof Runtime];

type AssertNoIncompatibleGeneratedBindings<Bindings extends never> = Bindings;

// Naming every checked binding here makes a Wrangler rename/removal fail the
// Worker typecheck instead of silently falling back to this service contract.
type WranglerBindings = Pick<Cloudflare.Env,
  | "DB"
  | "BOUND_REGISTRATION_RATE_LIMITER"
  | "BOUND_SESSION_RATE_LIMITER"
  | "ORDER_INGEST_AUDIENCE"
  | "ORDER_MAX_SKEW_SECONDS"
>;

interface RuntimeEnv {
  DB: D1DatabaseLike;
  // Optional Cloudflare edge limiters in front of the protected routes: registration
  // (POST /v2/device-authorizations) and session traffic (challenge, exchange, renew).
  // The fixed D1 budgets apply whether or not they are bound.
  BOUND_REGISTRATION_RATE_LIMITER?: RateLimitBindingLike;
  BOUND_SESSION_RATE_LIMITER?: RateLimitBindingLike;
  // Protected-device global fuse (requests/minute); default 1000, range 100..1000000.
  BOUND_GLOBAL_RATE_LIMIT?: string;
  // Protected device v2: explicit registry/issuer and independently purposed
  // RSA-3072 signer. Missing configuration fails closed; there is no fallback key.
  BOUND_DEVICE_CONFIG?: string;
  BOUND_APPROVAL_ENCRYPTION_KEYS?: string;
  BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM?: string;
  BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM?: string;
  // Slice 1 order-ingest (POST /v1/orders): the signed, exactly-once subscription
  // fulfillment inbox, always enforced (HMAC verify + signer-scope authz; no rollout
  // selector). ORDER_HMAC_SECRETS is a JSON map {key_id: base64-secret} (each secret
  // >= 32 bytes); the map / audience are asserted non-empty at verify time (fail-closed).
  // ORDER_MAX_SKEW_SECONDS default 300 (cap 3600). ORDER_INGEST_AUDIENCE (e.g.
  // "prod"/"staging") is folded into the signed bytes to block cross-env replay.
  ORDER_HMAC_SECRETS?: string;
  ORDER_MAX_SKEW_SECONDS?: string;
  ORDER_INGEST_AUDIENCE?: string;
  // Mandatory authorization binding for order-HMAC signer keys: each key id must
  // declare its allowed project/customer scope. Missing or malformed is a fail-closed
  // config error; a signer outside its declared scope is refused.
  ORDER_SIGNER_SCOPES?: string;
  // Webhook dispatcher (cron-drained read-side outbox). WEBHOOK_SIGNING_SECRETS is a JSON map
  // {keyId: base64-secret} (each secret >= 32 bytes), mirroring ORDER_HMAC_SECRETS; the active
  // WEBHOOK_SIGNING_KEY_ID names which key signs deliveries. Fail-closed: with no usable secret /
  // missing active key the dispatcher logs + skips delivery (never sends unsigned). No per-endpoint
  // secret is ever stored in D1.
  WEBHOOK_SIGNING_SECRETS?: string;
  WEBHOOK_SIGNING_KEY_ID?: string;
}

type GeneratedBindingsMatchRuntime = AssertNoIncompatibleGeneratedBindings<
  IncompatibleGeneratedBindings<WidenWranglerStringBindings<WranglerBindings>, RuntimeEnv>
>;

export type Env = WithRuntimeNarrowing<WidenWranglerStringBindings<WranglerBindings>, RuntimeEnv>;
