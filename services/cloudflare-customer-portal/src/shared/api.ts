// Shared portal API types. Re-export the backend entitlement types so the portal Worker + (future)
// React UI share ONE shape with the licensing backend; add the portal-specific envelope.
export type {
  EntitlementStatus,
  EntitlementRecord,
} from "@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation";

export interface ApiEnvelope<T> {
  ok: boolean;
  code: string;
  request_id: string;
  data?: T;
}

// What the portal exposes to its own browser app (never the backend bearer; cookie only).
export interface PortalMe {
  customer_id: string;
}

export interface PortalEntitlementSummary {
  id: string;
  project: string;
  feature: string;
  license_fingerprint: string;
  status: string;
  valid_from: number | null;
  valid_until: number | null;
  license_mode: "trial" | "node_locked" | "floating";
  pool_size: number;
  max_active_devices: number;
  max_borrow_sec: number;
  heartbeat_grace_sec: number;
  policy_id: string | null;
}
