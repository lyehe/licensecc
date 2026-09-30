// Types for portable policy stamp mechanics.
import type { EntitlementInput } from "./contracts";

export type PolicyType = "trial" | "node_locked" | "subscription";
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
  max_active_devices: number;
  expiry_strategy: ExpiryStrategy;
  trial_expiration_basis: TrialExpirationBasis;
  trial_duration_sec: number;
  trial_one_per_device: number;
  notes: string;
  created_at: number;
  updated_at: number;
}

export interface PolicyStampOverrides {
  project: string;
  feature: string;
  license_fingerprint: string;
  valid_from?: number | null;
  valid_until?: number | null;
  notes?: string;
  customer_id?: string | null;
  license_id?: string | null;
  max_active_devices?: number;
}

/** A protected grant takes only its device limit from a policy. */
export interface PolicyCapacity {
  max_active_devices: number;
}

export interface PolicyTrialState {
  is_trial: number;
  trial_expiration_basis: TrialExpirationBasis | null;
  trial_duration_sec: number;
  trial_one_per_device: number;
}

export interface PolicyStamp {
  input: EntitlementInput;
  capacity: PolicyCapacity;
  trial: PolicyTrialState;
}

export declare const POLICY_TYPES: readonly ["trial", "node_locked", "subscription"];

export function stampFromPolicy(policy: Policy, overrides: PolicyStampOverrides, now: number): PolicyStamp;
