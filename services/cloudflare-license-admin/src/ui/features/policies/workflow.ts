import type { ExpiryStrategy, PolicyInput, PolicyType, TrialExpirationBasis } from "../../../shared/api";

export interface PolicyFilter {
  project: string;
  type: string;
  status: string;
}

export type PolicyAction = "disable" | "reenable";

export interface PolicyFormState {
  project: string;
  name: string;
  type: PolicyType;
  valid_from_offset_sec: string;
  duration_sec: string;
  assertion_ttl_seconds: number;
  pool_size: number;
  max_active_devices: number;
  max_borrow_sec: number;
  meter_quota: number;
  meter_period_sec: number;
  expiry_strategy: ExpiryStrategy;
  trial_expiration_basis: TrialExpirationBasis;
  trial_duration_sec: number;
  trial_one_per_device: boolean;
  trial_require_device_proof: boolean;
  notes: string;
}

export const emptyPolicyForm: PolicyFormState = {
  project: "DEFAULT",
  name: "",
  type: "trial",
  valid_from_offset_sec: "",
  duration_sec: "",
  assertion_ttl_seconds: 300,
  pool_size: 0,
  max_active_devices: 1,
  max_borrow_sec: 0,
  meter_quota: 0,
  meter_period_sec: 2592000,
  expiry_strategy: "fixed_window",
  trial_expiration_basis: "from_issue",
  trial_duration_sec: 0,
  trial_one_per_device: false,
  trial_require_device_proof: false,
  notes: "",
};

export function policiesPath(filter: PolicyFilter): string {
  const params = new URLSearchParams();
  if (filter.project !== "") params.set("project", filter.project);
  if (filter.type !== "") params.set("type", filter.type);
  if (filter.status !== "") params.set("status", filter.status);
  return `/api/admin/policies${params.size === 0 ? "" : `?${params.toString()}`}`;
}

export function policyPath(id: string): string {
  return `/api/admin/policies/${encodeURIComponent(id)}`;
}

export function policyTransitionPath(id: string, action: PolicyAction): string {
  return `/api/admin/policies/${encodeURIComponent(id)}/${action}`;
}

export function canRunPolicyAction(status: string, action: PolicyAction): boolean {
  return action === "disable" ? status === "active" : status === "disabled";
}

export function disablePolicyConfirm(policy: { name: string; type: string }): string {
  return `Disable policy "${policy.name}" (${policy.type}). New entitlements can no longer be stamped from it; already-stamped entitlements are frozen and unaffected.`;
}

export function normalizePolicyForm(form: PolicyFormState): PolicyInput {
  if (form.type === "floating" && form.pool_size < 1) {
    throw new Error("floating_pool_size_must_be_at_least_1");
  }
  if (form.type === "node_locked" && form.pool_size !== 0) {
    throw new Error("node_locked_pool_size_must_be_0");
  }
  return {
    project: form.project,
    name: form.name,
    type: form.type,
    valid_from_offset_sec: parseOptionalBoundedInteger(
      form.valid_from_offset_sec, "valid_from_offset_sec", -MAX_POLICY_DURATION_SECONDS, MAX_POLICY_DURATION_SECONDS,
    ),
    duration_sec: parseOptionalBoundedInteger(form.duration_sec, "duration_sec", 0, MAX_POLICY_DURATION_SECONDS),
    assertion_ttl_seconds: parseBoundedInteger(form.assertion_ttl_seconds, "assertion_ttl_seconds", 1, 3600),
    pool_size: parseBoundedInteger(form.pool_size, "pool_size", 0, 1_000_000),
    max_active_devices: parseBoundedInteger(form.max_active_devices, "max_active_devices", 0, 1_000_000),
    max_borrow_sec: parseBoundedInteger(form.max_borrow_sec, "max_borrow_sec", 0, MAX_POLICY_DURATION_SECONDS),
    meter_quota: parseBoundedInteger(form.meter_quota, "meter_quota", 0, 1_000_000_000),
    meter_period_sec: parseBoundedInteger(form.meter_period_sec, "meter_period_sec", 0, MAX_POLICY_DURATION_SECONDS),
    expiry_strategy: form.expiry_strategy,
    trial_expiration_basis: form.trial_expiration_basis,
    trial_duration_sec: parseBoundedInteger(form.trial_duration_sec, "trial_duration_sec", 0, MAX_POLICY_DURATION_SECONDS),
    trial_one_per_device: form.trial_one_per_device ? 1 : 0,
    trial_require_device_proof: form.trial_require_device_proof ? 1 : 0,
    notes: parseNotes(form.notes),
  };
}

const MAX_POLICY_DURATION_SECONDS = 3_153_600_000;

function parseBoundedInteger(value: number, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}_must_be_between_${min}_and_${max}`);
  }
  return parsed;
}

function parseOptionalBoundedInteger(value: string, label: string, min: number, max: number): number | null {
  if (value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}_must_be_between_${min}_and_${max}`);
  }
  return parsed;
}

function parseNotes(value: string): string {
  if (value.length > 1000 || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error("notes_must_be_at_most_1000_chars");
  }
  return value;
}
