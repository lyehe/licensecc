CREATE TABLE IF NOT EXISTS entitlements (
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  device_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'disabled')),
  assertion_ttl_seconds INTEGER NOT NULL DEFAULT 300,
  cache_ttl_seconds INTEGER NOT NULL DEFAULT 3600,
  revocation_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, feature, license_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_entitlements_status
  ON entitlements(status);

CREATE TABLE IF NOT EXISTS entitlement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  device_hash TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL CHECK (event_type IN ('upsert', 'revoke', 'disable')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'disabled')),
  revocation_seq INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entitlement_events_lookup
  ON entitlement_events(project, feature, license_fingerprint, created_at);
