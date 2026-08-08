export interface EntitlementKey {
  project: string;
  feature: string;
  license_fingerprint: string;
}

export type EntitlementStatus = "active" | "disabled" | "revoked";
export type LicenseMode = "trial" | "node_locked" | "floating";
export type DeviceStatus = "active" | "revoked" | "disabled";
export type EntitlementEventType = "create" | "update" | "disable" | "reenable" | "revoke";

export interface EntitlementDeviceRecord {
  project: string;
  feature: string;
  license_fingerprint: string;
  device_key_id: string;
  status: DeviceStatus;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  notes: string;
}

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
  policy_id: string | null;
  is_trial: number;
  trial_expiration_basis: string | null;
  trial_duration_sec: number;
  trial_one_per_device: number;
  trial_require_device_proof: number;
  trial_started_at: number | null;
  trial_device_hash: string | null;
  max_active_devices: number;
  lease_seconds: number;
  rebind_window_sec: number;
  pool_size: number;
  heartbeat_grace_sec: number;
  max_borrow_sec: number;
  allow_overdraft: number;
  meter_quota: number;
  meter_period_sec: number;
  license_mode: LicenseMode;
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

export interface EntitlementCapacity {
  max_active_devices?: number;
  lease_seconds?: number;
  rebind_window_sec?: number;
  pool_size?: number;
  heartbeat_grace_sec?: number;
  max_borrow_sec?: number;
  allow_overdraft?: number;
  meter_quota?: number;
  meter_period_sec?: number;
}

export function entitlementId(project: string, feature: string, licenseFingerprint: string): string;
export function decodeEntitlementId(id: string): EntitlementKey | null;
export function withId(row: Omit<EntitlementRecord, "id" | "license_mode"> & { cache_ttl_seconds?: number }): EntitlementRecord;
export function effectiveLicenseMode(row: Partial<EntitlementRecord>): LicenseMode;
export function entitlementMatchesInput(row: EntitlementRecord, input: EntitlementInput): boolean;
export function syncEventType(prev: EntitlementRecord | null, targetStatus: EntitlementStatus): EntitlementEventType;
