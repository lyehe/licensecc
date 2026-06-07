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
  event_type TEXT NOT NULL CHECK (event_type IN ('create', 'update', 'disable', 'reenable', 'revoke', 'upsert')),
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
