-- Replay defense for device request-proofs. One row per consumed
-- (project, feature, license_fingerprint, device_key_id, nonce). A row's presence
-- means that nonce was already spent for that device within the skew window, so a
-- replay of the same signed request body must be denied. Rows are short-lived:
-- expires_at = consumed_at + 2 * skew window, swept opportunistically (mirrors
-- rate_limit_counters in migration 0002).
CREATE TABLE IF NOT EXISTS request_proof_nonces (
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  device_key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  request_timestamp INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project, feature, license_fingerprint, device_key_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_request_proof_nonces_expires_at
  ON request_proof_nonces(expires_at);
