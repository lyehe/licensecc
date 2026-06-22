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
  valid_from INTEGER NULL,
  valid_until INTEGER NULL,
  notes TEXT NOT NULL DEFAULT '',
  customer_id TEXT NULL,
  license_id TEXT NULL,
  max_active_devices INTEGER NOT NULL DEFAULT 1,
  lease_seconds INTEGER NOT NULL DEFAULT 2592000,
  rebind_window_sec INTEGER NOT NULL DEFAULT 7776000,
  pool_size INTEGER NOT NULL DEFAULT 0,
  heartbeat_grace_sec INTEGER NOT NULL DEFAULT 900,
  max_borrow_sec INTEGER NOT NULL DEFAULT 0,
  allow_overdraft INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project, feature, license_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_entitlements_status
  ON entitlements(status);

CREATE INDEX IF NOT EXISTS idx_entitlements_project_feature_status
  ON entitlements(project, feature, status);

CREATE INDEX IF NOT EXISTS idx_entitlements_valid_until
  ON entitlements(valid_until);

CREATE INDEX IF NOT EXISTS idx_entitlements_customer
  ON entitlements(customer_id);

CREATE INDEX IF NOT EXISTS idx_entitlements_license
  ON entitlements(license_id);

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

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customers_email
  ON customers(email);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  customer_id TEXT NULL,
  project TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_licenses_customer
  ON licenses(customer_id);

CREATE INDEX IF NOT EXISTS idx_licenses_project
  ON licenses(project);

CREATE TABLE IF NOT EXISTS entitlement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  device_hash TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL CHECK (event_type IN ('create', 'update', 'disable', 'reenable', 'revoke', 'upsert', 'revoked-override')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'disabled')),
  revocation_seq INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source TEXT NOT NULL DEFAULT 'admin',
  request_id TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  prev_json TEXT NOT NULL DEFAULT '',
  next_json TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entitlement_events_lookup
  ON entitlement_events(project, feature, license_fingerprint, created_at);

CREATE INDEX IF NOT EXISTS idx_entitlement_events_actor
  ON entitlement_events(actor, created_at);

CREATE INDEX IF NOT EXISTS idx_entitlement_events_request
  ON entitlement_events(request_id);

CREATE TABLE IF NOT EXISTS mutation_idempotency (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_created_at
  ON mutation_idempotency(created_at);

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  namespace TEXT NOT NULL,
  rate_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, rate_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_expires_at
  ON rate_limit_counters(expires_at);

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

CREATE INDEX IF NOT EXISTS idx_lease_issuance_entitlement
  ON lease_issuance(project, feature, license_fingerprint, issued_at);

CREATE INDEX IF NOT EXISTS idx_lease_issuance_issued_at
  ON lease_issuance(issued_at);

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

CREATE INDEX IF NOT EXISTS idx_seat_checkouts_live
  ON seat_checkouts(project, feature, license_fingerprint, heartbeat_deadline);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('checkout', 'release', 'reclaim', 'denied')),
  seat_id TEXT NULL,
  device_key_id TEXT NULL,
  reason TEXT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_events_window
  ON usage_events(project, feature, license_fingerprint, ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_ts
  ON usage_events(ts);
