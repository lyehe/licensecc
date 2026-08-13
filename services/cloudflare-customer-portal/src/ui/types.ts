export interface PortalMe {
  customer_id: string;
}

export interface EntitlementRow {
  id: string;
  project: string;
  feature: string;
  status: string;
  license_fingerprint?: string;
  valid_from: number | null;
  valid_until: number | null;
  license_mode: "trial" | "node_locked" | "floating";
  pool_size: number;
  max_active_devices: number;
  max_borrow_sec: number;
  heartbeat_grace_sec: number;
  policy_id: string | null;
}

export interface DeviceRow {
  project: string;
  feature: string;
  license_fingerprint: string;
  device_key_id: string;
  created_at: number;
}

export interface UsageRow {
  project: string;
  feature: string;
  event_type: string;
  count: number;
}

export type PortalTab = "entitlements" | "devices" | "usage" | "download";
export type SeatOperation = "checkout" | "heartbeat" | "release";

export interface SeatActionResult {
  succeeded: boolean;
  refreshFailed: boolean;
}

export interface StatusMessage {
  code: string;
  request_id: string;
  ok: boolean;
}
