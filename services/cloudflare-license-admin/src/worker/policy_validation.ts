import type {
  ExpiryStrategy,
  PolicyType,
  TrialExpirationBasis,
} from "../shared/api";
import { safeString } from "@licensecc/cloudflare-runtime/http/kit";
import { POLICY_TYPES } from "@licensecc/licensing-domain/entitlements/policy";

const MAX_PROJECT_SIZE = 127;
const MAX_NOTES_SIZE = 1000;
const MAX_NAME_SIZE = 127;
// A generous-but-bounded ceiling for the policy duration and offset integers
// (~100 years in seconds). Keeps validators from accepting absurd or overflow values.
const MAX_DURATION_SECONDS = 3_153_600_000;
const INVALID = Symbol("invalid");

const EXPIRY_STRATEGIES: ReadonlyArray<ExpiryStrategy> = ["fixed_window", "non_expiring"];
const TRIAL_BASES: ReadonlyArray<TrialExpirationBasis> = ["from_issue", "from_first_activation", "from_first_use"];

// A policy stamps a protected grant: its device limit, validity and trial rules. A body naming any
// other field (a seat pool, borrowing, a meter, an assertion TTL, device proof, or anything else)
// is refused whole, so a caller never believes a field it sent took effect.
//
// The PATCH writer updates exactly these columns, in this order, so a field this validator accepts
// can never be dropped by the writer. The type checks below keep the list and ValidPolicyPatch equal.
export const POLICY_PATCHABLE_FIELDS = [
  "valid_from_offset_sec", "duration_sec", "max_active_devices", "expiry_strategy",
  "trial_expiration_basis", "trial_duration_sec", "trial_one_per_device", "notes",
] as const satisfies ReadonlyArray<keyof ValidPolicyPatch>;
type UnlistedPatchField = Exclude<keyof ValidPolicyPatch, typeof POLICY_PATCHABLE_FIELDS[number]>;
const everyPatchFieldIsListed: [UnlistedPatchField] extends [never] ? true : never = true;
void everyPatchFieldIsListed;
const PATCHABLE_FIELDS: ReadonlySet<string> = new Set(POLICY_PATCHABLE_FIELDS);
const CREATE_FIELDS: ReadonlySet<string> = new Set(["project", "name", "type", ...PATCHABLE_FIELDS]);

/** The policy a create writes: every column but its identity takes the given value or the default. */
export interface ValidPolicyInput {
  project: string;
  name: string;
  type: PolicyType;
  notes: string;
  valid_from_offset_sec: number | null;
  duration_sec: number | null;
  max_active_devices: number;
  expiry_strategy: ExpiryStrategy;
  trial_expiration_basis: TrialExpirationBasis;
  trial_duration_sec: number;
  trial_one_per_device: number;
}

/** The columns a PATCH updates; project, name, type and status are never patchable. */
export type ValidPolicyPatch = Partial<Omit<ValidPolicyInput, "project" | "name" | "type">>;

function namesOnly(input: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(input).every((key) => allowed.has(key));
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

// Resolve the per-policy default columns. Each is "undefined -> default; else validate".
// Returns null on ANY invalid field so the caller emits a single 400 invalid_request.
function readPolicyColumns(input: Record<string, unknown>): Omit<ValidPolicyInput, "project" | "name" | "type" | "notes"> | null {
  const validFromOffset = input.valid_from_offset_sec === undefined ? null : nullableBoundedInt(input.valid_from_offset_sec, -MAX_DURATION_SECONDS, MAX_DURATION_SECONDS);
  const duration = input.duration_sec === undefined ? null : nullableBoundedInt(input.duration_sec, 0, MAX_DURATION_SECONDS);
  const maxActiveDevices = boundedInt(input.max_active_devices ?? 1, 0, 1_000_000);
  const expiryStrategy = input.expiry_strategy === undefined ? "fixed_window" : input.expiry_strategy;
  const trialBasis = input.trial_expiration_basis === undefined ? "from_issue" : input.trial_expiration_basis;
  const trialDuration = boundedInt(input.trial_duration_sec ?? 0, 0, MAX_DURATION_SECONDS);
  const trialOnePerDevice = boundedInt(input.trial_one_per_device ?? 0, 0, 1);
  if (
    validFromOffset === INVALID || duration === INVALID || maxActiveDevices === undefined ||
    !EXPIRY_STRATEGIES.includes(expiryStrategy as ExpiryStrategy) ||
    !TRIAL_BASES.includes(trialBasis as TrialExpirationBasis) ||
    trialDuration === undefined || trialOnePerDevice === undefined
  ) {
    return null;
  }
  return {
    valid_from_offset_sec: validFromOffset,
    duration_sec: duration,
    max_active_devices: maxActiveDevices,
    expiry_strategy: expiryStrategy as ExpiryStrategy,
    trial_expiration_basis: trialBasis as TrialExpirationBasis,
    trial_duration_sec: trialDuration,
    trial_one_per_device: trialOnePerDevice,
  };
}

export function validatePolicyInput(value: unknown): ValidPolicyInput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (!namesOnly(input, CREATE_FIELDS)) {
    return null;
  }
  const project = safeString(input.project, MAX_PROJECT_SIZE);
  const name = safeString(input.name, MAX_NAME_SIZE);
  const type = POLICY_TYPES.find((candidate) => candidate === input.type);
  const notes = input.notes === undefined ? "" : safeNotes(input.notes);
  const columns = readPolicyColumns(input);
  if (project === null || name === null || type === undefined || notes === null || columns === null) {
    return null;
  }
  return { project, name, type, notes, ...columns };
}

export function validatePolicyPatch(value: unknown): ValidPolicyPatch | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  // project/name/type/status are NOT patchable, so callers cannot believe they
  // changed identity or flipped status outside disable/reenable.
  if (!namesOnly(input, PATCHABLE_FIELDS)) {
    return null;
  }
  const patch: ValidPolicyPatch = {};
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
    ["max_active_devices", 0, 1_000_000],
    ["trial_duration_sec", 0, MAX_DURATION_SECONDS],
    ["trial_one_per_device", 0, 1],
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
