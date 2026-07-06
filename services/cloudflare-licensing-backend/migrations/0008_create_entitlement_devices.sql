CREATE TABLE IF NOT EXISTS entitlement_devices (
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  device_key_id TEXT NOT NULL,
  public_key_spki_der_base64 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NULL,
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project, feature, license_fingerprint, device_key_id),
  FOREIGN KEY (project, feature, license_fingerprint)
    REFERENCES entitlements(project, feature, license_fingerprint)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entitlement_devices_status
  ON entitlement_devices(status);

CREATE INDEX IF NOT EXISTS idx_entitlement_devices_entitlement
  ON entitlement_devices(project, feature, license_fingerprint);
