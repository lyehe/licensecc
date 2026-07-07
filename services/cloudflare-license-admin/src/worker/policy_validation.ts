import type {
  ExpiryStrategy,
  PolicyInput,
  PolicyPatch,
  PolicyType,
  TrialExpirationBasis,
} from "../shared/api";

const MAX_PROJECT_SIZE = 127;
const MAX_NOTES_SIZE = 1000;
const MAX_NAME_SIZE = 127;
// A generous-but-bounded ceiling for the policy duration/offset/borrow integers
// (~100 years in seconds). Keeps validators from accepting absurd or overflow values.
const MAX_DURATION_SECONDS = 3_153_600_000;
const INVALID = Symbol("invalid");

const POLICY_TYPES: ReadonlyArray<PolicyType> = ["trial", "node_locked", "floating", "subscription"];
const EXPIRY_STRATEGIES: ReadonlyArray<ExpiryStrategy> = ["fixed_window", "non_expiring"];
const TRIAL_BASES: ReadonlyArray<TrialExpirationBasis> = ["from_issue", "from_first_activation", "from_first_use"];

function safeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return null;
  }
  return value;
}

function safeNotes(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_NOTES_SIZE) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return null;
  }
  return value;
}

function boundedInt(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

// A nullable bounded integer: undefined -> keep default; null -> SQL NULL; otherwise an
// integer in [min,max]. `undefined`-sentinel signals "invalid" (distinct from a valid null).
function nullableBoundedInt(value: unknown, min: number, max: number): number | null | typeof INVALID {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return INVALID;
  }
  return value;
}

export function policyTypeCapacityIsValid(type: PolicyType, poolSize: number): boolean {
  if (type === "node_locked") {
    return poolSize === 0;
  }
  if (type === "floating") {
    return poolSize > 0;
  }
  return true;
}

// Resolve the per-policy default columns. Each is "undefined -> default; else validate".
// Returns null on ANY invalid field so the caller emits a single 400 invalid_request.
function readPolicyColumns(input: Record<string, unknown>): {
  valid_from_offset_sec: number | null;
  duration_sec: number | null;
  assertion_ttl_seconds: number;
  pool_size: number;
  max_active_devices: number;
  max_borrow_sec: number;
  meter_quota: number;
  meter_period_sec: number;
  expiry_strategy: ExpiryStrategy;
  trial_expiration_basis: TrialExpirationBasis;
  trial_duration_sec: number;
  trial_one_per_device: number;
  trial_require_device_proof: number;
} | null {
  const validFromOffset = input.valid_from_offset_sec === undefined ? null : nullableBoundedInt(input.valid_from_offset_sec, -MAX_DURATION_SECONDS, MAX_DURATION_SECONDS);
  const duration = input.duration_sec === undefined ? null : nullableBoundedInt(input.duration_sec, 0, MAX_DURATION_SECONDS);
  const assertionTtl = boundedInt(input.assertion_ttl_seconds ?? 300, 1, 3600);
  const poolSize = boundedInt(input.pool_size ?? 0, 0, 1_000_000);
  const maxActiveDevices = boundedInt(input.max_active_devices ?? 1, 0, 1_000_000);
  const maxBorrow = boundedInt(input.max_borrow_sec ?? 0, 0, MAX_DURATION_SECONDS);
  const meterQuota = boundedInt(input.meter_quota ?? 0, 0, 1_000_000_000);
  const meterPeriodSec = boundedInt(input.meter_period_sec ?? 2592000, 0, MAX_DURATION_SECONDS);
  const expiryStrategy = input.expiry_strategy === undefined ? "fixed_window" : input.expiry_strategy;
  const trialBasis = input.trial_expiration_basis === undefined ? "from_issue" : input.trial_expiration_basis;
  const trialDuration = boundedInt(input.trial_duration_sec ?? 0, 0, MAX_DURATION_SECONDS);
  const trialOnePerDevice = boundedInt(input.trial_one_per_device ?? 0, 0, 1);
  const trialRequireProof = boundedInt(input.trial_require_device_proof ?? 0, 0, 1);
  if (
    validFromOffset === INVALID || duration === INVALID || assertionTtl === undefined ||
    poolSize === undefined || maxActiveDevices === undefined || maxBorrow === undefined ||
    meterQuota === undefined || meterPeriodSec === undefined ||
    !EXPIRY_STRATEGIES.includes(expiryStrategy as ExpiryStrategy) ||
    !TRIAL_BASES.includes(trialBasis as TrialExpirationBasis) ||
    trialDuration === undefined || trialOnePerDevice === undefined || trialRequireProof === undefined
  ) {
    return null;
  }
  return {
    valid_from_offset_sec: validFromOffset,
    duration_sec: duration,
    assertion_ttl_seconds: assertionTtl,
    pool_size: poolSize,
    max_active_devices: maxActiveDevices,
    max_borrow_sec: maxBorrow,
    meter_quota: meterQuota,
    meter_period_sec: meterPeriodSec,
    expiry_strategy: expiryStrategy as ExpiryStrategy,
    trial_expiration_basis: trialBasis as TrialExpirationBasis,
    trial_duration_sec: trialDuration,
    trial_one_per_device: trialOnePerDevice,
    trial_require_device_proof: trialRequireProof,
  };
}

export function validatePolicyInput(value: unknown): PolicyInput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const project = safeString(input.project, MAX_PROJECT_SIZE);
  const name = safeString(input.name, MAX_NAME_SIZE);
  const type = input.type;
  const notes = input.notes === undefined ? "" : safeNotes(input.notes);
  const columns = readPolicyColumns(input);
  if (
    project === null || name === null || !POLICY_TYPES.includes(type as PolicyType) ||
    notes === null || columns === null ||
    !policyTypeCapacityIsValid(type as PolicyType, columns.pool_size)
  ) {
    return null;
  }
  return { project, name, type: type as PolicyType, notes, ...columns };
}

export function validatePolicyPatch(value: unknown): PolicyPatch | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  // project/name/type/status are NOT patchable, so callers cannot believe they
  // changed identity or flipped status outside disable/reenable.
  if (input.project !== undefined || input.name !== undefined || input.type !== undefined || input.status !== undefined) {
    return null;
  }
  const patch: PolicyPatch = {};
  if (input.valid_from_offset_sec !== undefined) {
    const v = nullableBoundedInt(input.valid_from_offset_sec, -MAX_DURATION_SECONDS, MAX_DURATION_SECONDS);
    if (v === INVALID) return null;
    patch.valid_from_offset_sec = v;
  }
  if (input.duration_sec !== undefined) {
    const v = nullableBoundedInt(input.duration_sec, 0, MAX_DURATION_SECONDS);
    if (v === INVALID) return null;
    patch.duration_sec = v;
  }
  for (const [field, min, max] of [
    ["assertion_ttl_seconds", 1, 3600],
    ["pool_size", 0, 1_000_000],
    ["max_active_devices", 0, 1_000_000],
    ["max_borrow_sec", 0, MAX_DURATION_SECONDS],
    ["meter_quota", 0, 1_000_000_000],
    ["meter_period_sec", 0, MAX_DURATION_SECONDS],
    ["trial_duration_sec", 0, MAX_DURATION_SECONDS],
    ["trial_one_per_device", 0, 1],
    ["trial_require_device_proof", 0, 1],
  ] as const) {
    if (input[field] !== undefined) {
      const v = boundedInt(input[field], min, max);
      if (v === undefined) return null;
      patch[field] = v;
    }
  }
  if (input.expiry_strategy !== undefined) {
    if (!EXPIRY_STRATEGIES.includes(input.expiry_strategy as ExpiryStrategy)) return null;
    patch.expiry_strategy = input.expiry_strategy as ExpiryStrategy;
  }
  if (input.trial_expiration_basis !== undefined) {
    if (!TRIAL_BASES.includes(input.trial_expiration_basis as TrialExpirationBasis)) return null;
    patch.trial_expiration_basis = input.trial_expiration_basis as TrialExpirationBasis;
  }
  if (input.notes !== undefined) {
    const notes = safeNotes(input.notes);
    if (notes === null) return null;
    patch.notes = notes;
  }
  return patch;
}
