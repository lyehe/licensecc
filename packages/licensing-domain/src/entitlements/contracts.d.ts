export interface EntitlementKey {
  project: string;
  feature: string;
  license_fingerprint: string;
}

export type EntitlementStatus = "active" | "disabled" | "revoked";
/** A grant is protected, so it is a trial or node-locked. */
export type LicenseMode = "trial" | "node_locked";
export type EntitlementEventType = "create" | "update" | "disable" | "reenable" | "revoke";

export interface EntitlementRecord {
  id: string;
  project: string;
  feature: string;
  license_fingerprint: string;
  status: EntitlementStatus;
  revocation_seq: number;
  valid_from: number | null;
  valid_until: number | null;
  notes: string;
  /** Every grant has an owner: entitlements.customer_id is NOT NULL. */
  customer_id: string;
  license_id: string | null;
  policy_id: string | null;
  is_trial: number;
  trial_expiration_basis: string | null;
  trial_duration_sec: number;
  trial_one_per_device: number;
  trial_started_at: number | null;
  trial_device_key_id: string | null;
  max_active_devices: number;
  lease_seconds: number;
  license_mode: LicenseMode;
  created_at: number;
  updated_at: number;
}

export interface EntitlementInput {
  project: string;
  feature: string;
  license_fingerprint: string;
  status?: EntitlementStatus;
  valid_from?: number | null;
  valid_until?: number | null;
  notes?: string;
  /** The owning customer. A write naming none is refused (invalid_patch). */
  customer_id: string;
  license_id?: string | null;
}

export interface EntitlementPatch {
  valid_from?: number | null;
  valid_until?: number | null;
  notes?: string;
  /** Moves the grant to another customer; the owner can never be cleared. */
  customer_id?: string;
  license_id?: string | null;
}

export interface EntitlementCapacity {
  max_active_devices?: number;
  lease_seconds?: number;
}

export function entitlementId(project: string, feature: string, licenseFingerprint: string): string;
export function decodeEntitlementId(id: string): EntitlementKey | null;
export function withId(row: Omit<EntitlementRecord, "id" | "license_mode">): EntitlementRecord;
export function effectiveLicenseMode(row: Partial<EntitlementRecord>): LicenseMode;
export function entitlementMatchesInput(row: EntitlementRecord, input: EntitlementInput): boolean;
export function syncEventType(prev: EntitlementRecord | null, targetStatus: EntitlementStatus): EntitlementEventType;
