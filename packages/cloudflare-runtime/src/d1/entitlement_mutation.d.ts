import type {
  DeviceStatus,
  EntitlementCapacity,
  EntitlementDeviceRecord,
  EntitlementEventType,
  EntitlementInput,
  EntitlementKey,
  EntitlementPatch,
  EntitlementRecord,
  EntitlementStatus,
} from "@licensecc/licensing-domain/entitlements/contracts";

export type {
  DeviceStatus,
  EntitlementCapacity,
  EntitlementDeviceRecord,
  EntitlementEventType,
  EntitlementInput,
  EntitlementKey,
  EntitlementPatch,
  EntitlementRecord,
  EntitlementStatus,
} from "@licensecc/licensing-domain/entitlements/contracts";

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

export const ENTITLEMENT_COLUMNS: string;
export const REVOCATION_SEQ_BUMP: string;

export { decodeEntitlementId, effectiveLicenseMode, entitlementId, entitlementMatchesInput, syncEventType, withId } from "@licensecc/licensing-domain/entitlements/contracts";

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
  extraStatements?: D1PreparedStatementLike[],
  options?: { allowNoWrite?: boolean },
): Promise<MutationResult<EntitlementRecord> | null>;

export function createEntitlement(
  env: MutationEnv,
  input: EntitlementInput,
  ctx: MutationContext,
  reason?: string,
  eventTypeOverride?: EntitlementEventType,
  idempotency?: IdempotencyCommit | null,
  extraStatements?: D1PreparedStatementLike[],
): Promise<MutationResult<EntitlementRecord> | null>;

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

export function listEntitlementDevices(env: MutationEnv, key: EntitlementKey): Promise<EntitlementDeviceRecord[]>;
export function transitionEntitlementDevice(
  env: MutationEnv,
  key: EntitlementKey,
  deviceKeyId: string,
  deviceStatus: DeviceStatus,
  reason: string,
  ctx: MutationContext,
  idempotency: IdempotencyCommit | null,
): Promise<MutationResult<EntitlementRecord> | null>;
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
