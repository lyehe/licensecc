// Types for the shared entitlement-mutation core (entitlement_mutation.mjs).
// Co-located so the admin's tsc resolves them via the backend package's
// `exports` map `types` condition without needing `allowJs`.

export interface EntitlementKey {
  project: string;
  feature: string;
  license_fingerprint: string;
}

// Canonical home for the entitlement data types. The admin's src/shared/api.ts
// re-exports these so there is exactly ONE definition shared across packages.
export type EntitlementStatus = "active" | "disabled" | "revoked";

export interface EntitlementRecord {
  id: string;
  project: string;
  feature: string;
  license_fingerprint: string;
  device_hash: string;
  status: EntitlementStatus;
  assertion_ttl_seconds: number;
  revocation_seq: number;
  valid_from: number | null;
  valid_until: number | null;
  notes: string;
  customer_id: string | null;
  license_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface EntitlementInput {
  project: string;
  feature: string;
  license_fingerprint: string;
  device_hash?: string;
  status?: EntitlementStatus;
  assertion_ttl_seconds?: number;
  valid_from?: number | null;
  valid_until?: number | null;
  notes?: string;
  customer_id?: string | null;
  license_id?: string | null;
}

export interface EntitlementPatch {
  device_hash?: string;
  assertion_ttl_seconds?: number;
  valid_from?: number | null;
  valid_until?: number | null;
  notes?: string;
  customer_id?: string | null;
  license_id?: string | null;
}

// Narrowed D1 + mutation-context surface the mutation core needs. Structurally
// compatible with the admin Worker's full Env (it has `DB: D1DatabaseLike`).
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch?(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

export interface MutationEnv {
  DB: D1DatabaseLike;
}

export interface Actor {
  subject: string;
  email: string;
  role: "reader" | "admin";
  actorType: "access" | "dev" | "sync";
}

export interface MutationContext {
  requestId: string;
  actor: Actor;
  ip: string;
  idempotencyKey: string | null;
  source: "admin" | "sync";
}

export interface IdempotencyCommit {
  scope: string;
  responseCode: string;
}

export interface MutationResult<T> {
  data: T;
  idempotencyRecorded: boolean;
}

export type EntitlementEventType = "create" | "update" | "disable" | "reenable" | "revoke";

// Subset of capacity columns that setEntitlementCapacity may write. Any subset is
// accepted; unknown keys and non-finite/negative values are ignored.
export interface EntitlementCapacity {
  max_active_devices?: number;
  lease_seconds?: number;
  rebind_window_sec?: number;
  pool_size?: number;
  heartbeat_grace_sec?: number;
  max_borrow_sec?: number;
  allow_overdraft?: number;
}

// Shared SQL fragments (single source of truth) the order-ingest apply path reuses
// to build its OWN floor-guarded entitlement statements without re-coupling the
// admin mutators.
export const ENTITLEMENT_COLUMNS: string;
export const REVOCATION_SEQ_BUMP: string;

export function entitlementId(project: string, feature: string, licenseFingerprint: string): string;
export function decodeEntitlementId(id: string): EntitlementKey | null;

export function withId(row: Omit<EntitlementRecord, "id"> & { cache_ttl_seconds?: number }): EntitlementRecord;
export function entitlementSelectSql(where: string): string;
export function findEntitlement(env: MutationEnv, key: EntitlementKey): Promise<EntitlementRecord | null>;

export function idempotencyFromCurrentStatement(
  env: MutationEnv,
  ctx: MutationContext,
  key: EntitlementKey,
  idempotency: IdempotencyCommit | null,
  now: number,
): D1PreparedStatementLike | null;

export function eventFromCurrentStatement(
  env: MutationEnv,
  ctx: MutationContext,
  eventType: EntitlementEventType,
  key: EntitlementKey,
  prev: EntitlementRecord | null,
  reason: string,
  now: number,
): D1PreparedStatementLike;

export function batchReturnedRow<T>(result: unknown): T | null;

export function writeEntitlementWithAudit(
  env: MutationEnv,
  key: EntitlementKey,
  writeStatement: D1PreparedStatementLike,
  ctx: MutationContext,
  eventType: EntitlementEventType,
  prev: EntitlementRecord | null,
  reason: string,
  now: number,
  idempotency: IdempotencyCommit | null,
  // Extra statements committed in the SAME batch/transaction as the entitlement
  // write + audit event (default []). The order-ingest apply path passes its
  // in-batch order_events processed-mark here so mutation + mark are atomic.
  extraStatements?: D1PreparedStatementLike[],
): Promise<MutationResult<EntitlementRecord>>;

export function createEntitlement(
  env: MutationEnv,
  input: EntitlementInput,
  ctx: MutationContext,
  reason?: string,
  eventTypeOverride?: EntitlementEventType,
  idempotency?: IdempotencyCommit | null,
  // Extra statements committed in the SAME atomic batch as the INSERT (default []).
  // The admin policy-stamp path passes the capacity/trial side-write here so the row +
  // its frozen policy state commit together; the INSERT SQL is unchanged.
  extraStatements?: D1PreparedStatementLike[],
): Promise<MutationResult<EntitlementRecord>>;

export function patchEntitlement(
  env: MutationEnv,
  key: EntitlementKey,
  patch: EntitlementPatch,
  ctx: MutationContext,
  idempotency: IdempotencyCommit | null,
): Promise<MutationResult<EntitlementRecord> | null>;

export function transitionEntitlement(
  env: MutationEnv,
  key: EntitlementKey,
  status: EntitlementStatus,
  eventType: "disable" | "reenable" | "revoke",
  reason: string,
  ctx: MutationContext,
  idempotency: IdempotencyCommit | null,
): Promise<MutationResult<EntitlementRecord> | null>;

export function entitlementMatchesInput(row: EntitlementRecord, input: EntitlementInput): boolean;

export function syncEventType(prev: EntitlementRecord | null, targetStatus: EntitlementStatus): EntitlementEventType;

export function syncEntitlement(
  env: MutationEnv,
  input: EntitlementInput,
  reason: string,
  ctx: MutationContext,
  idempotency: IdempotencyCommit | null,
): Promise<MutationResult<EntitlementRecord> | null>;

export function setEntitlementCapacity(
  env: MutationEnv,
  key: EntitlementKey,
  capacity: EntitlementCapacity,
  ctx: MutationContext,
  idempotency?: IdempotencyCommit | null,
): Promise<MutationResult<EntitlementRecord> | null>;
