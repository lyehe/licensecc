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

export interface EntitlementEvent {
  id: number;
  project: string;
  feature: string;
  license_fingerprint: string;
  event_type: "create" | "update" | "disable" | "reenable" | "revoke" | "upsert";
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

export interface EntitlementSyncInput extends EntitlementInput {
  reason?: string;
}
