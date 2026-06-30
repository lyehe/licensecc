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
  last_applied_order_seq INTEGER NOT NULL DEFAULT 0,
  last_applied_order_epoch INTEGER NOT NULL DEFAULT 0,
  policy_id TEXT NULL,
  is_trial INTEGER NOT NULL DEFAULT 0,
  trial_expiration_basis TEXT NULL,
  trial_duration_sec INTEGER NOT NULL DEFAULT 0,
  trial_one_per_device INTEGER NOT NULL DEFAULT 0,
  trial_require_device_proof INTEGER NOT NULL DEFAULT 0,
  trial_started_at INTEGER NULL,
  trial_device_hash TEXT NULL,
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
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  external_ref TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email
  ON customers(lower(email))
  WHERE email <> '';

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

CREATE TABLE IF NOT EXISTS orders (
  subscription_id     TEXT NOT NULL,
  project             TEXT NOT NULL,
  feature             TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  customer_id         TEXT NULL,
  license_id          TEXT NULL,
  last_seq            INTEGER NOT NULL DEFAULT 0,
  order_epoch         INTEGER NOT NULL DEFAULT 0,
  fingerprint_origin  TEXT NOT NULL DEFAULT 'derived' CHECK (fingerprint_origin IN ('derived', 'supplied')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, project, feature)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_fp_unique
  ON orders(project, feature, license_fingerprint);

CREATE TABLE IF NOT EXISTS order_events (
  event_id        TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  project         TEXT NOT NULL,
  feature         TEXT NOT NULL,
  order_epoch     INTEGER NOT NULL,
  seq             INTEGER NOT NULL,
  intent          TEXT NOT NULL,
  key_id          TEXT NOT NULL,
  payload_digest  TEXT NOT NULL,
  raw_payload     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('accepted', 'processed', 'superseded', 'rejected')),
  result_json     TEXT NOT NULL DEFAULT '',
  received_at     INTEGER NOT NULL,
  processed_at    INTEGER NULL,
  PRIMARY KEY (event_id)
);

CREATE INDEX IF NOT EXISTS idx_order_events_sub_seq
  ON order_events(subscription_id, project, feature, order_epoch, seq);

CREATE INDEX IF NOT EXISTS idx_order_events_unprocessed
  ON order_events(subscription_id, project, feature, status);

CREATE TABLE IF NOT EXISTS order_ingest_nonces (
  key_id      TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (key_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_order_ingest_nonces_expires_at
  ON order_ingest_nonces(expires_at);

CREATE TABLE IF NOT EXISTS account_tokens (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  token_hmac TEXT NOT NULL,
  pepper_key_id TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  scopes_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'disabled')),
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NULL,
  replaced_by TEXT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (replaced_by) REFERENCES account_tokens(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_tokens_hmac ON account_tokens(token_hmac);
CREATE INDEX IF NOT EXISTS idx_account_tokens_customer ON account_tokens(customer_id);
CREATE INDEX IF NOT EXISTS idx_account_tokens_status ON account_tokens(status);

CREATE TABLE IF NOT EXISTS account_token_revocations (
  customer_id TEXT PRIMARY KEY,
  revocation_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account_token_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_token_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('issue', 'rotate', 'revoke', 'revoke-customer', 'repepper', 'merge')),
  actor TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source TEXT NOT NULL DEFAULT 'admin',
  reason TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_token_events_token ON account_token_events(account_token_id);
CREATE INDEX IF NOT EXISTS idx_account_token_events_customer ON account_token_events(customer_id);

CREATE TABLE IF NOT EXISTS portal_otp (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  email_lower   TEXT NOT NULL,
  secret_hmac   TEXT NOT NULL,
  code_hmac     TEXT NOT NULL,
  pepper_key_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  consumed_at   INTEGER NULL,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_otp_secret ON portal_otp(secret_hmac);
CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_otp_code ON portal_otp(code_hmac);
CREATE INDEX IF NOT EXISTS idx_portal_otp_expires ON portal_otp(expires_at);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT NOT NULL,
  session_hmac     TEXT NOT NULL,
  pepper_key_id    TEXT NOT NULL,
  account_token_id TEXT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  user_agent       TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  last_used_at     INTEGER NULL,
  expires_at       INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (account_token_id) REFERENCES account_tokens(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_sessions_hmac ON portal_sessions(session_hmac);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_customer ON portal_sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_expires ON portal_sessions(expires_at);

CREATE TABLE IF NOT EXISTS portal_bootstrap_events (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  email_lower TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_bootstrap_customer ON portal_bootstrap_events(customer_id);

CREATE TABLE IF NOT EXISTS customer_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN ('disable', 'reenable')),
  prev_status TEXT NOT NULL,
  next_status TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT '',
  actor_type  TEXT NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source      TEXT NOT NULL DEFAULT 'admin',
  reason      TEXT NOT NULL DEFAULT '',
  request_id  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_customer_events_customer ON customer_events(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS entitlement_policies (
  id                          TEXT PRIMARY KEY,
  project                     TEXT NOT NULL,
  name                        TEXT NOT NULL,
  type                        TEXT NOT NULL CHECK (type IN ('trial', 'node_locked', 'floating', 'subscription')),
  status                      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  valid_from_offset_sec       INTEGER NULL,
  duration_sec                INTEGER NULL,
  assertion_ttl_seconds       INTEGER NOT NULL DEFAULT 300,
  pool_size                   INTEGER NOT NULL DEFAULT 0,
  max_active_devices          INTEGER NOT NULL DEFAULT 1,
  max_borrow_sec              INTEGER NOT NULL DEFAULT 0,
  expiry_strategy             TEXT NOT NULL DEFAULT 'fixed_window' CHECK (expiry_strategy IN ('fixed_window', 'non_expiring')),
  trial_expiration_basis      TEXT NOT NULL DEFAULT 'from_issue' CHECK (trial_expiration_basis IN ('from_issue', 'from_first_activation', 'from_first_use')),
  trial_duration_sec          INTEGER NOT NULL DEFAULT 0,
  trial_one_per_device        INTEGER NOT NULL DEFAULT 0,
  trial_require_device_proof  INTEGER NOT NULL DEFAULT 0,
  notes                       TEXT NOT NULL DEFAULT '',
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_policies_name ON entitlement_policies(project, lower(name));

CREATE TABLE IF NOT EXISTS policy_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id   TEXT NOT NULL,
  project     TEXT NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN ('create', 'update', 'disable', 'reenable')),
  actor       TEXT NOT NULL DEFAULT '',
  actor_type  TEXT NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source      TEXT NOT NULL DEFAULT 'admin',
  reason      TEXT NOT NULL DEFAULT '',
  request_id  TEXT NOT NULL DEFAULT '',
  prev_json   TEXT NOT NULL DEFAULT '',
  next_json   TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES entitlement_policies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_policy_events_policy ON policy_events(policy_id, created_at DESC);
