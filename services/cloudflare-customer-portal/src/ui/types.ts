export interface PortalMe {
  customer_id: string;
  email: string | null;
}

export interface EntitlementRow {
  id: string;
  project: string;
  feature: string;
  status: string;
  license_fingerprint?: string;
  valid_from: number | null;
  valid_until: number | null;
  enforcement_mode: "device_bound_v1";
  license_mode: "trial" | "node_locked" | "floating";
  pool_size: number;
  max_active_devices: number;
  max_borrow_sec: number;
  heartbeat_grace_sec: number;
  policy_id: string | null;
  // When the rule that enforces the row ends its trial (epoch seconds, never after valid_until); null
  // for a license that is not a trial, a trial clock not started yet, or a trial with no end of its own.
  trial_ends_at: number | null;
  // True while the first activation has yet to start this trial's clock.
  trial_starts_on_activation: boolean;
}

export interface StatusMessage {
  code: string;
  request_id: string;
  ok: boolean;
  // The `retry-after` header seconds, when the response carried one; StatusLine uses it to
  // build "Too many attempts. Try again in {n} minutes." for a rate_limited code.
  retryAfter?: number;
}
