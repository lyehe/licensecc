// Canonical definitions for these four entitlement data types now live in the
// shared mutation core's .d.ts so the admin Worker and the licensing backend
// share ONE shape. Re-exported here so existing `../shared/api` import sites are
// unchanged.
export type {
  EntitlementStatus,
  EntitlementRecord,
  EntitlementInput,
  EntitlementPatch,
} from "@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation";

import type { EntitlementStatus, EntitlementInput, EntitlementEventType } from "@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation";

export interface EntitlementEvent {
  id: number;
  project: string;
  feature: string;
  license_fingerprint: string;
  event_type: EntitlementEventType | "upsert" | "revoked-override";
  status: EntitlementStatus;
  revocation_seq: number;
  actor: string;
  actor_type: string;
  source: string;
  request_id: string;
  reason: string;
  created_at: number;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  code: string;
  request_id: string;
  data?: T;
}

export interface EntitlementSyncInput extends EntitlementInput {
  reason?: string;
}

// ── License-policy templates (Stage 3) ───────────────────────────────────────
// Mirrors entitlement_policies (migration 0018) + the policy.mjs stamp shape. A
// policy is a frozen stamp-time template: stamping copies the defaults onto a new
// entitlement (which is thereafter its own source of truth). The canonical Policy /
// stamp types live in the backend package's policy.d.ts; these re-declare only the
// admin-facing CRUD request/response shapes.
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
  expiry_strategy: ExpiryStrategy;
  trial_expiration_basis: TrialExpirationBasis;
  trial_duration_sec: number;
  trial_one_per_device: number;
  trial_require_device_proof: number;
  notes: string;
  created_at: number;
  updated_at: number;
}

// Create body. project/name/type are required; everything else takes the column default.
export interface PolicyInput {
  project: string;
  name: string;
  type: PolicyType;
  valid_from_offset_sec?: number | null;
  duration_sec?: number | null;
  assertion_ttl_seconds?: number;
  pool_size?: number;
  max_active_devices?: number;
  max_borrow_sec?: number;
  expiry_strategy?: ExpiryStrategy;
  trial_expiration_basis?: TrialExpirationBasis;
  trial_duration_sec?: number;
  trial_one_per_device?: number;
  trial_require_device_proof?: number;
  notes?: string;
}

// Patch body. project/name/type/status are NOT patchable (name/type are frozen
// identity; status flips only through disable/reenable). All fields optional.
export interface PolicyPatch {
  valid_from_offset_sec?: number | null;
  duration_sec?: number | null;
  assertion_ttl_seconds?: number;
  pool_size?: number;
  max_active_devices?: number;
  max_borrow_sec?: number;
  expiry_strategy?: ExpiryStrategy;
  trial_expiration_basis?: TrialExpirationBasis;
  trial_duration_sec?: number;
  trial_one_per_device?: number;
  trial_require_device_proof?: number;
  notes?: string;
}

// Optional frozen-trial + provenance columns surfaced on an entitlement record that
// was stamped from a policy. Read by dedicated SELECTs (not part of ENTITLEMENT_COLUMNS).
export interface EntitlementTrialFields {
  policy_id?: string | null;
  is_trial?: number;
  trial_expiration_basis?: TrialExpirationBasis | null;
  trial_duration_sec?: number;
  trial_one_per_device?: number;
  trial_require_device_proof?: number;
  trial_started_at?: number | null;
  trial_device_hash?: string | null;
}
