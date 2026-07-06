// Types for the policy stamp mechanics (policy.mjs). Co-located so the admin Worker's tsc resolves
// them via the backend package's `exports` map without `allowJs`.
import type { D1DatabaseLike, D1PreparedStatementLike, EntitlementInput, EntitlementKey } from "./entitlement_mutation";

export type PolicyType = "trial" | "node_locked" | "floating" | "subscription";
export type PolicyStatus = "active" | "disabled";
export type ExpiryStrategy = "fixed_window" | "non_expiring";
export type TrialExpirationBasis = "from_issue" | "from_first_activation" | "from_first_use";

export interface Policy {
  id: string;
  project: string;
  name: string;
  type: PolicyType;
  status: PolicyStatus;
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
  notes: string;
  created_at: number;
  updated_at: number;
}

export interface PolicyStampOverrides {
  project: string;
  feature: string;
  license_fingerprint: string;
  device_hash?: string;
  assertion_ttl_seconds?: number;
  valid_from?: number | null;
  valid_until?: number | null;
  notes?: string;
  customer_id?: string | null;
  license_id?: string | null;
  pool_size?: number;
  max_active_devices?: number;
  max_borrow_sec?: number;
  meter_quota?: number;
  meter_period_sec?: number;
}

export interface PolicyCapacity {
  pool_size: number;
  max_active_devices: number;
  max_borrow_sec: number;
  meter_quota: number;
  meter_period_sec: number;
}

export interface PolicyTrialState {
  is_trial: number;
  trial_expiration_basis: TrialExpirationBasis | null;
  trial_duration_sec: number;
  trial_one_per_device: number;
  trial_require_device_proof: number;
}

export interface PolicyStamp {
  input: EntitlementInput;
  capacity: PolicyCapacity;
  trial: PolicyTrialState;
}

export function stampFromPolicy(policy: Policy, overrides: PolicyStampOverrides, now: number): PolicyStamp;

export function buildPolicyStampStatement(
  env: { DB: D1DatabaseLike },
  key: EntitlementKey,
  policyId: string,
  capacity: PolicyCapacity,
  trial: PolicyTrialState,
): D1PreparedStatementLike;
