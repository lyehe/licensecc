-- Floating / concurrent licensing (design doc 2026-06-22-floating-concurrent-licensing.md):
-- a shared pool of N simultaneous seats per entitlement, online-required, with heartbeat
-- reclamation and optional offline borrowing.
--
--   pool_size            simultaneous-use cap. 0 disables floating for the entitlement.
--   heartbeat_grace_sec  a live seat must heartbeat within this window or be reclaimed.
--   max_borrow_sec       max offline borrow window. 0 disables borrowing.
--   allow_overdraft      0 = hard cap; 1 = permit a configured margin over pool_size.
ALTER TABLE entitlements ADD COLUMN pool_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entitlements ADD COLUMN heartbeat_grace_sec INTEGER NOT NULL DEFAULT 900;
ALTER TABLE entitlements ADD COLUMN max_borrow_sec INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entitlements ADD COLUMN allow_overdraft INTEGER NOT NULL DEFAULT 0;

-- One row per held seat. A LIVE seat is a row with heartbeat_deadline > now; expired rows
-- are squatters reclaimed by the lazy sweep on checkout (mirrors request_proof_nonces).
CREATE TABLE IF NOT EXISTS seat_checkouts (
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  client_instance_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'borrowed')),
  checked_out_at INTEGER NOT NULL,
  heartbeat_deadline INTEGER NOT NULL,
  PRIMARY KEY (project, feature, license_fingerprint, seat_id),
  FOREIGN KEY (project, feature, license_fingerprint)
    REFERENCES entitlements(project, feature, license_fingerprint) ON DELETE CASCADE
);

-- Hot path: COUNT(*) of live seats for one entitlement, and the reclamation sweep.
CREATE INDEX IF NOT EXISTS idx_seat_checkouts_live
  ON seat_checkouts(project, feature, license_fingerprint, heartbeat_deadline);
