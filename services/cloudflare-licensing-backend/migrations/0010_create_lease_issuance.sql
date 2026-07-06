-- Lease platform (design doc docs/superpowers/plans/2026-06-21-lease-licensing-platform-architecture.md):
-- per-entitlement lease policy columns + an append-only lease issuance log.
--
--   max_active_devices  REBIND CEILING -- the number of DISTINCT devices a license
--                       may bind within rebind_window_sec. NOT a concurrent-seat cap:
--                       one valid lease grants unbounded offline concurrency on its
--                       bound device for its (clamped) validity window.
--   lease_seconds       offline budget -- a lease's validity-window length, clamped at
--                       issue time to the entitlement's valid_until (the kill-switch).
--   rebind_window_sec   rolling window over which max_active_devices is counted.
ALTER TABLE entitlements ADD COLUMN max_active_devices INTEGER NOT NULL DEFAULT 1;
ALTER TABLE entitlements ADD COLUMN lease_seconds INTEGER NOT NULL DEFAULT 2592000;
ALTER TABLE entitlements ADD COLUMN rebind_window_sec INTEGER NOT NULL DEFAULT 7776000;

-- Append-only issuance log. Backs (a) the atomic device-rebind cap
-- (COUNT(DISTINCT device_key_id) within the window) and (b) audit. Swept by
-- retention on issued_at. device_key_id is the bound ECDSA device, not a raw hw_id.
CREATE TABLE IF NOT EXISTS lease_issuance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  device_key_id TEXT NOT NULL,
  lease_key_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER NOT NULL,
  request_id TEXT NULL,
  FOREIGN KEY (project, feature, license_fingerprint)
    REFERENCES entitlements(project, feature, license_fingerprint) ON DELETE CASCADE
);

-- Hot path: COUNT(DISTINCT device_key_id) for one entitlement within the rebind window.
CREATE INDEX IF NOT EXISTS idx_lease_issuance_entitlement
  ON lease_issuance(project, feature, license_fingerprint, issued_at);
-- Retention sweep.
CREATE INDEX IF NOT EXISTS idx_lease_issuance_issued_at
  ON lease_issuance(issued_at);
