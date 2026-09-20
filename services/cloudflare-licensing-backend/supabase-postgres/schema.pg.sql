-- schema.pg.sql
--
-- Fresh/disposable PostgreSQL bootstrap for the fenced verifier adapter.
-- Ground truth: services/cloudflare-licensing-backend/schema.sql (SQLite/D1), generated
--   from migrations 0001 through 0039 inclusive (currently ending at
--   0039_bound_lease_cleanup.sql). The D1 migration history remains authoritative.
--
-- Apply this consolidated snapshot only to an empty, disposable PostgreSQL database. It is
-- NOT a PostgreSQL migration history or an upgrade path. IF NOT EXISTS only avoids duplicate-
-- object errors; it cannot alter stale columns, constraints, indexes, or triggers in an
-- existing database. This snapshot is also NOT a full production replacement for the D1
-- backend; the runtime route fence and supported surface are documented in README.md.
--
-- scripts/check-pg-parity.py reviews table/column types, nullability/defaults, PK/unique/FK/
-- CHECK constraints, explicit indexes, generated audit/event ids, and source-generation
-- triggers against the final D1 snapshot.
--
-- Reviewed dialect rules enforced by check-pg-parity.py:
--   * INTEGER PRIMARY KEY AUTOINCREMENT          -> BIGINT GENERATED ALWAYS AS IDENTITY
--   * INTEGER                                      -> BIGINT for epochs, counters, sequences,
--       capacities, durations, and generated ids. The five reviewed 0/1 flag columns remain
--       INTEGER: entitlements.is_trial, entitlements.trial_one_per_device,
--       entitlements.trial_require_device_proof,
--       entitlement_policies.trial_one_per_device, and
--       entitlement_policies.trial_require_device_proof.
--     NOTE: postgres.js returns BIGINT (int8, OID 20) columns as JavaScript STRINGS by
--       default. The Worker's verify path survives that coincidentally (every BIGINT read
--       is numerically coerced downstream -- see db-postgres.mjs), but the adapter now
--       installs an int8 type parser so these columns arrive as numbers. See db-postgres.mjs.
--   * CHECK (col IN (...)) enums                 -> kept as text CHECK expressions rather
--       than native ENUM types, including the final values introduced by D1 migrations
--       0006 and 0007.
--   * TEXT NOT NULL DEFAULT ''                   -> kept as-is.
--   * metadata_json TEXT NOT NULL DEFAULT '{}'   -> kept as TEXT (jsonb is an option;
--       see the commented jsonb variant next to each occurrence). Kept TEXT to stay
--       byte-for-byte compatible with the existing admin/CLI tooling that writes/reads
--       these columns as opaque JSON strings.
--   * composite TEXT primary keys                -> ported verbatim.
--   * composite FOREIGN KEY ... ON DELETE CASCADE -> ported verbatim.
--   * three SQLite row triggers per generation source -> one PostgreSQL statement trigger
--       covering INSERT OR UPDATE OR DELETE; generation is an invalidation token, not a row
--       counter.
--
-- pgcrypto is required because the admin/CLI statements port `lower(hex(randomblob(8)))`
-- to `encode(gen_random_bytes(8),'hex')` (see statements.pg.sql). gen_random_bytes lives
-- in pgcrypto. (On Supabase pgcrypto is preinstalled; this is idempotent.)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================================================
-- entitlements  (migrations 0001 + 0003 validity columns + 0004 customer/license cols)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS entitlements (
  authority_revision BIGINT NOT NULL DEFAULT 0 CHECK (authority_revision = CAST(authority_revision AS BIGINT) AND authority_revision BETWEEN 0 AND 9007199254740991),
  enforcement_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (enforcement_mode IN ('legacy', 'device_bound_v1')),
  project               TEXT    NOT NULL,
  feature               TEXT    NOT NULL,
  license_fingerprint   TEXT    NOT NULL,
  device_hash           TEXT    NOT NULL DEFAULT '',
  status                TEXT    NOT NULL CHECK (status IN ('active', 'revoked', 'disabled')),
  assertion_ttl_seconds BIGINT  NOT NULL DEFAULT 300,
  cache_ttl_seconds     BIGINT  NOT NULL DEFAULT 3600,
  revocation_seq        BIGINT  NOT NULL DEFAULT 0,
  created_at            BIGINT  NOT NULL,
  updated_at            BIGINT  NOT NULL,
  valid_from            BIGINT  NULL,
  valid_until           BIGINT  NULL,
  notes                 TEXT    NOT NULL DEFAULT '',
  customer_id           TEXT    NULL,
  license_id            TEXT    NULL,
  max_active_devices    BIGINT  NOT NULL DEFAULT 1,        -- migration 0010 (lease rebind ceiling)
  lease_seconds         BIGINT  NOT NULL DEFAULT 2592000,
  rebind_window_sec     BIGINT  NOT NULL DEFAULT 7776000,
  pool_size             BIGINT  NOT NULL DEFAULT 0,         -- migration 0011 (floating)
  heartbeat_grace_sec   BIGINT  NOT NULL DEFAULT 900,
  max_borrow_sec        BIGINT  NOT NULL DEFAULT 0,
  allow_overdraft       BIGINT  NOT NULL DEFAULT 0,
  last_applied_order_seq   BIGINT NOT NULL DEFAULT 0,  -- migration 0014
  last_applied_order_epoch BIGINT NOT NULL DEFAULT 0,  -- migration 0014
  policy_id                  TEXT    NULL,                 -- migration 0018 (policy provenance, advisory, no FK)
  is_trial                   INTEGER NOT NULL DEFAULT 0,
  trial_expiration_basis     TEXT    NULL,
  trial_duration_sec         BIGINT  NOT NULL DEFAULT 0,
  trial_one_per_device       INTEGER NOT NULL DEFAULT 0,
  trial_require_device_proof INTEGER NOT NULL DEFAULT 0,
  trial_started_at           BIGINT  NULL,
  trial_device_hash          TEXT    NULL,
  meter_quota                BIGINT  NOT NULL DEFAULT 0,        -- migration 0023 (metered consumption)
  meter_period_sec           BIGINT  NOT NULL DEFAULT 2592000,
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

-- Migration 0030: plan-projection identity fence across legacy/unmanaged rows.
CREATE INDEX IF NOT EXISTS idx_entitlements_project_license_fingerprint
  ON entitlements(project, license_id, license_fingerprint);

-- =====================================================================================
-- entitlement_devices  (migration 0008) -- per-entitlement ECDSA device keys.
-- Composite FK back to entitlements with ON DELETE CASCADE, ported verbatim.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS entitlement_devices (
  project                    TEXT   NOT NULL,
  feature                    TEXT   NOT NULL,
  license_fingerprint        TEXT   NOT NULL,
  device_key_id              TEXT   NOT NULL,
  public_key_spki_der_base64 TEXT   NOT NULL,
  status                     TEXT   NOT NULL CHECK (status IN ('active', 'revoked', 'disabled')),
  created_at                 BIGINT NOT NULL,
  updated_at                 BIGINT NOT NULL,
  last_seen_at               BIGINT NULL,
  notes                      TEXT   NOT NULL DEFAULT '',
  PRIMARY KEY (project, feature, license_fingerprint, device_key_id),
  FOREIGN KEY (project, feature, license_fingerprint)
    REFERENCES entitlements(project, feature, license_fingerprint)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entitlement_devices_status
  ON entitlement_devices(status);

CREATE INDEX IF NOT EXISTS idx_entitlement_devices_entitlement
  ON entitlement_devices(project, feature, license_fingerprint);

-- =====================================================================================
-- customers  (migration 0004; 0013 = status + external_ref + UNIQUE email)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS customers (
  authority_revision BIGINT NOT NULL DEFAULT 0 CHECK (authority_revision = CAST(authority_revision AS BIGINT) AND authority_revision BETWEEN 0 AND 9007199254740991),
  id            TEXT   PRIMARY KEY,
  name          TEXT   NOT NULL,
  email         TEXT   NOT NULL DEFAULT '',
  metadata_json TEXT   NOT NULL DEFAULT '{}',   -- jsonb option: metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  status        TEXT   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),  -- migration 0013
  external_ref  TEXT   NOT NULL DEFAULT ''                                                  -- migration 0013
);

-- Partial unique index: email is optional (defaults ''), so blanks must not
-- collide. Keyed on lower(email) for CASE-INSENSITIVE uniqueness (matches the
-- SQLite migration 0013).
--
-- NOTE: this is a fresh/disposable bootstrap snapshot, and there is no PostgreSQL
-- migration runner in this repository. An existing database will not acquire the
-- migration-0013 shape by reapplying this file. Discard and recreate disposable test
-- state; no manual or production PostgreSQL upgrade procedure is supported here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email
  ON customers(lower(email))
  WHERE email <> '';

-- =====================================================================================
-- licenses  (migration 0004)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS licenses (
  id            TEXT   PRIMARY KEY,
  customer_id   TEXT   NULL,
  project       TEXT   NOT NULL,
  label         TEXT   NOT NULL DEFAULT '',
  metadata_json TEXT   NOT NULL DEFAULT '{}',   -- jsonb option: metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_licenses_customer
  ON licenses(customer_id);

CREATE INDEX IF NOT EXISTS idx_licenses_project
  ON licenses(project);

-- =====================================================================================
-- entitlement_events  (migration 0005 rebuild + 0006 sync actor_type + 0007 revoked-override)
-- The CHECK enum lists below already include the values added by 0006 ('sync') and
-- 0007 ('revoked-override'), matching the final ground-truth schema.sql.
--
-- SQLite: id INTEGER PRIMARY KEY AUTOINCREMENT  ->  Postgres identity column.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS entitlement_events (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project             TEXT   NOT NULL,
  feature             TEXT   NOT NULL,
  license_fingerprint TEXT   NOT NULL,
  device_hash         TEXT   NOT NULL DEFAULT '',
  event_type          TEXT   NOT NULL CHECK (event_type IN ('create', 'update', 'disable', 'reenable', 'revoke', 'upsert', 'revoked-override')),
  status              TEXT   NOT NULL CHECK (status IN ('active', 'revoked', 'disabled')),
  revocation_seq      BIGINT NOT NULL,
  detail              TEXT   NOT NULL DEFAULT '',
  actor               TEXT   NOT NULL DEFAULT '',
  actor_type          TEXT   NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source              TEXT   NOT NULL DEFAULT 'admin',
  request_id          TEXT   NOT NULL DEFAULT '',
  ip                  TEXT   NOT NULL DEFAULT '',
  prev_json           TEXT   NOT NULL DEFAULT '',   -- jsonb option possible, but kept TEXT (can be empty string '')
  next_json           TEXT   NOT NULL DEFAULT '',   -- jsonb option possible, but kept TEXT (can be empty string '')
  reason              TEXT   NOT NULL DEFAULT '',
  idempotency_key     TEXT   NULL,
  created_at          BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entitlement_events_lookup
  ON entitlement_events(project, feature, license_fingerprint, created_at);

CREATE INDEX IF NOT EXISTS idx_entitlement_events_actor
  ON entitlement_events(actor, created_at);

CREATE INDEX IF NOT EXISTS idx_entitlement_events_request
  ON entitlement_events(request_id);

-- =====================================================================================
-- mutation_idempotency  (migration 0004)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS mutation_idempotency (
  scope           TEXT   NOT NULL,
  idempotency_key TEXT   NOT NULL,
  response_json   TEXT   NOT NULL,             -- jsonb option: response_json JSONB NOT NULL
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_created_at
  ON mutation_idempotency(created_at);

-- =====================================================================================
-- rate_limit_counters  (migration 0002)
--
-- CRITICAL: the verify-path upsert targets ON CONFLICT(namespace, rate_key, window_start).
-- That triple MUST be a UNIQUE or PRIMARY KEY constraint for `ON CONFLICT (...)` to bind
-- an arbiter index in Postgres -- otherwise the upsert raises
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification".
-- The composite PRIMARY KEY below provides exactly that arbiter. Do not drop it.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  namespace     TEXT   NOT NULL,
  rate_key      TEXT   NOT NULL,
  window_start  BIGINT NOT NULL,
  request_count BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (namespace, rate_key, window_start)   -- <- ON CONFLICT arbiter for the rate-limit upsert
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_expires_at
  ON rate_limit_counters(expires_at);

CREATE TABLE IF NOT EXISTS request_proof_nonces (
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  device_key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  request_timestamp BIGINT NOT NULL,
  consumed_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (project, feature, license_fingerprint, device_key_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_request_proof_nonces_expires_at
  ON request_proof_nonces(expires_at);

-- Lease platform (migration 0010). SQLite INTEGER PRIMARY KEY AUTOINCREMENT ->
-- BIGINT GENERATED ALWAYS AS IDENTITY. Append-only; backs the atomic device-rebind cap.
CREATE TABLE IF NOT EXISTS lease_issuance (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project             TEXT NOT NULL,
  feature             TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  device_key_id       TEXT NOT NULL,
  lease_key_id        TEXT NOT NULL,
  issued_at           BIGINT NOT NULL,
  valid_from          BIGINT NOT NULL,
  valid_to            BIGINT NOT NULL,
  request_id          TEXT NULL,
  FOREIGN KEY (project, feature, license_fingerprint)
    REFERENCES entitlements(project, feature, license_fingerprint) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lease_issuance_entitlement
  ON lease_issuance(project, feature, license_fingerprint, issued_at);

CREATE INDEX IF NOT EXISTS idx_lease_issuance_issued_at
  ON lease_issuance(issued_at);

-- Floating / concurrent licensing (migration 0011). One row per held seat; a LIVE seat is
-- a row with heartbeat_deadline > now. The atomic checkout counts live seats < pool_size.
CREATE TABLE IF NOT EXISTS seat_checkouts (
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  client_instance_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'borrowed')),
  checked_out_at BIGINT NOT NULL,
  heartbeat_deadline BIGINT NOT NULL,
  PRIMARY KEY (project, feature, license_fingerprint, seat_id),
  FOREIGN KEY (project, feature, license_fingerprint)
    REFERENCES entitlements(project, feature, license_fingerprint) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_seat_checkouts_live
  ON seat_checkouts(project, feature, license_fingerprint, heartbeat_deadline);

-- Usage reporting (migration 0012). Append-only event log for peak/denial/adoption analytics.
CREATE TABLE IF NOT EXISTS usage_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('checkout', 'release', 'reclaim', 'denied')),
  seat_id TEXT NULL,
  device_key_id TEXT NULL,
  reason TEXT NULL,
  ts BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_events_window
  ON usage_events(project, feature, license_fingerprint, ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_ts
  ON usage_events(ts);

-- =====================================================================================
-- order-ingest  (migration 0014; Slice 1 — POST /v1/orders)
-- NOTE: the order-ingest RUNTIME (entitlement-pg.mjs) is D1-first; these tables are
-- the schema port so a fresh Postgres provision has them. The PG runtime apply path
-- for orders is a tracked follow-up.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS orders (
  subscription_id     TEXT   NOT NULL,
  project             TEXT   NOT NULL,
  feature             TEXT   NOT NULL,
  license_fingerprint TEXT   NOT NULL,
  customer_id         TEXT   NULL,
  license_id          TEXT   NULL,
  last_seq            BIGINT NOT NULL DEFAULT 0,
  order_epoch         BIGINT NOT NULL DEFAULT 0,
  fingerprint_origin  TEXT   NOT NULL DEFAULT 'derived' CHECK (fingerprint_origin IN ('derived', 'supplied')),
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  PRIMARY KEY (subscription_id, project, feature)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_fp_unique
  ON orders(project, feature, license_fingerprint);

CREATE TABLE IF NOT EXISTS order_events (
  event_id        TEXT   NOT NULL,
  subscription_id TEXT   NOT NULL,
  project         TEXT   NOT NULL,
  feature         TEXT   NOT NULL,
  order_epoch     BIGINT NOT NULL,
  seq             BIGINT NOT NULL,
  intent          TEXT   NOT NULL,
  key_id          TEXT   NOT NULL,
  payload_digest  TEXT   NOT NULL,
  raw_payload     TEXT   NOT NULL,
  status          TEXT   NOT NULL CHECK (status IN ('accepted', 'processed', 'superseded', 'rejected')),
  result_json     TEXT   NOT NULL DEFAULT '',
  received_at     BIGINT NOT NULL,
  processed_at    BIGINT NULL,
  PRIMARY KEY (event_id)
);

CREATE INDEX IF NOT EXISTS idx_order_events_sub_seq
  ON order_events(subscription_id, project, feature, order_epoch, seq);

CREATE INDEX IF NOT EXISTS idx_order_events_unprocessed
  ON order_events(subscription_id, project, feature, status);

CREATE TABLE IF NOT EXISTS order_ingest_nonces (
  key_id      TEXT   NOT NULL,
  event_id    TEXT   NOT NULL,
  timestamp   BIGINT NOT NULL,
  consumed_at BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  PRIMARY KEY (key_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_order_ingest_nonces_expires_at
  ON order_ingest_nonces(expires_at);

-- =====================================================================================
-- account tokens  (migration 0015; Slice 2 — per-customer credentials + isolation)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS account_tokens (
  id            TEXT   PRIMARY KEY,
  customer_id   TEXT   NOT NULL,
  token_hmac    TEXT   NOT NULL,
  pepper_key_id TEXT   NOT NULL,
  token_prefix  TEXT   NOT NULL,
  name          TEXT   NOT NULL DEFAULT '',
  scopes_json   TEXT   NOT NULL DEFAULT '{}',
  status        TEXT   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'disabled')),
  expires_at    BIGINT NOT NULL,
  last_used_at  BIGINT NULL,
  replaced_by   TEXT   NULL,
  created_by    TEXT   NOT NULL DEFAULT '',
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (replaced_by) REFERENCES account_tokens(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_tokens_hmac ON account_tokens(token_hmac);
CREATE INDEX IF NOT EXISTS idx_account_tokens_customer ON account_tokens(customer_id);
CREATE INDEX IF NOT EXISTS idx_account_tokens_status ON account_tokens(status);

CREATE TABLE IF NOT EXISTS account_token_revocations (
  customer_id    TEXT   PRIMARY KEY,
  revocation_seq BIGINT NOT NULL DEFAULT 0,
  updated_at     BIGINT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account_token_events (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_token_id TEXT   NOT NULL,
  customer_id      TEXT   NOT NULL,
  event_type       TEXT   NOT NULL CHECK (event_type IN ('issue', 'rotate', 'revoke', 'revoke-customer', 'repepper', 'merge')),
  actor            TEXT   NOT NULL DEFAULT '',
  actor_type       TEXT   NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source           TEXT   NOT NULL DEFAULT 'admin',
  reason           TEXT   NOT NULL DEFAULT '',
  request_id       TEXT   NOT NULL DEFAULT '',
  created_at       BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_token_events_token ON account_token_events(account_token_id);
CREATE INDEX IF NOT EXISTS idx_account_token_events_customer ON account_token_events(customer_id);

-- =====================================================================================
-- customer portal auth  (migration 0016; Slice 3 — email-OTP / magic-link + sessions)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS portal_otp (
  id            TEXT   PRIMARY KEY,
  customer_id   TEXT   NOT NULL,
  email_lower   TEXT   NOT NULL,
  secret_hmac   TEXT   NOT NULL,
  code_hmac     TEXT   NOT NULL,
  pepper_key_id TEXT   NOT NULL,
  attempt_count BIGINT NOT NULL DEFAULT 0,
  consumed_at   BIGINT NULL,
  expires_at    BIGINT NOT NULL,
  created_at    BIGINT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_otp_secret ON portal_otp(secret_hmac);
CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_otp_code ON portal_otp(code_hmac);
CREATE INDEX IF NOT EXISTS idx_portal_otp_expires ON portal_otp(expires_at);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id               TEXT   PRIMARY KEY,
  customer_id      TEXT   NOT NULL,
  session_hmac     TEXT   NOT NULL,
  pepper_key_id    TEXT   NOT NULL,
  account_token_id TEXT   NULL,
  status           TEXT   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  user_agent       TEXT   NOT NULL DEFAULT '',
  created_at       BIGINT NOT NULL,
  last_used_at     BIGINT NULL,
  expires_at       BIGINT NOT NULL,
  auth_method      TEXT NOT NULL DEFAULT 'legacy' CHECK (auth_method IN ('legacy', 'otp', 'oauth', 'password')),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (account_token_id) REFERENCES account_tokens(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_sessions_hmac ON portal_sessions(session_hmac);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_customer ON portal_sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_expires ON portal_sessions(expires_at);

CREATE TABLE IF NOT EXISTS portal_bootstrap_events (
  id          TEXT   PRIMARY KEY,
  customer_id TEXT   NOT NULL,
  email_lower TEXT   NOT NULL,
  actor       TEXT   NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_bootstrap_customer ON portal_bootstrap_events(customer_id);

CREATE TABLE IF NOT EXISTS customer_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id TEXT   NOT NULL,
  event_type  TEXT   NOT NULL CHECK (event_type IN ('disable', 'reenable')),
  prev_status TEXT   NOT NULL,
  next_status TEXT   NOT NULL,
  actor       TEXT   NOT NULL DEFAULT '',
  actor_type  TEXT   NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source      TEXT   NOT NULL DEFAULT 'admin',
  reason      TEXT   NOT NULL DEFAULT '',
  request_id  TEXT   NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_customer_events_customer ON customer_events(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS entitlement_policies (
  id                          TEXT    PRIMARY KEY,
  project                     TEXT    NOT NULL,
  name                        TEXT    NOT NULL,
  type                        TEXT    NOT NULL CHECK (type IN ('trial', 'node_locked', 'floating', 'subscription')),
  status                      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  valid_from_offset_sec       BIGINT  NULL,
  duration_sec                BIGINT  NULL,
  assertion_ttl_seconds       BIGINT  NOT NULL DEFAULT 300,
  pool_size                   BIGINT  NOT NULL DEFAULT 0,
  max_active_devices          BIGINT  NOT NULL DEFAULT 1,
  max_borrow_sec              BIGINT  NOT NULL DEFAULT 0,
  expiry_strategy             TEXT    NOT NULL DEFAULT 'fixed_window' CHECK (expiry_strategy IN ('fixed_window', 'non_expiring')),
  trial_expiration_basis      TEXT    NOT NULL DEFAULT 'from_issue' CHECK (trial_expiration_basis IN ('from_issue', 'from_first_activation', 'from_first_use')),
  trial_duration_sec          BIGINT  NOT NULL DEFAULT 0,
  trial_one_per_device        INTEGER NOT NULL DEFAULT 0,
  trial_require_device_proof  INTEGER NOT NULL DEFAULT 0,
  notes                       TEXT    NOT NULL DEFAULT '',
  created_at                  BIGINT  NOT NULL,
  updated_at                  BIGINT  NOT NULL,
  meter_quota                 BIGINT  NOT NULL DEFAULT 0,
  meter_period_sec            BIGINT  NOT NULL DEFAULT 2592000
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_policies_name ON entitlement_policies(project, lower(name));

CREATE TABLE IF NOT EXISTS policy_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  policy_id   TEXT    NOT NULL,
  project     TEXT    NOT NULL,
  event_type  TEXT    NOT NULL CHECK (event_type IN ('create', 'update', 'disable', 'reenable')),
  actor       TEXT    NOT NULL DEFAULT '',
  actor_type  TEXT    NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source      TEXT    NOT NULL DEFAULT 'admin',
  reason      TEXT    NOT NULL DEFAULT '',
  request_id  TEXT    NOT NULL DEFAULT '',
  prev_json   TEXT    NOT NULL DEFAULT '',
  next_json   TEXT    NOT NULL DEFAULT '',
  created_at  BIGINT  NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES entitlement_policies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_policy_events_policy ON policy_events(policy_id, created_at DESC);

-- =====================================================================================
-- webhook dispatch  (migration 0020 — read-side cron-drained transactional outbox)
--   * INTEGER PRIMARY KEY AUTOINCREMENT -> BIGINT GENERATED ALWAYS AS IDENTITY
--   * epoch columns (created_at/updated_at/next_attempt_at/delivered_at) -> BIGINT
--   * counter columns (event_id/attempts/last_status/last_id) -> BIGINT (64-bit-intent)
-- The dispatcher itself runs only in the D1/SQLite Worker cron; this is the parity port.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id          TEXT   PRIMARY KEY,
  url         TEXT   NOT NULL,
  event_types TEXT   NOT NULL DEFAULT '',
  status      TEXT   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  description TEXT   NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  scope_project     TEXT,   -- migration 0021 (per-tenant webhook scope; NULL = global)
  scope_customer_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_status ON webhook_endpoints(status);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_id     TEXT   NOT NULL,
  event_source    TEXT   NOT NULL CHECK (event_source IN ('entitlement', 'customer', 'order')),
  event_id        BIGINT NOT NULL,
  event_type      TEXT   NOT NULL DEFAULT '',
  payload_json    TEXT   NOT NULL DEFAULT '',
  status          TEXT   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        BIGINT NOT NULL DEFAULT 0,
  last_status     BIGINT NOT NULL DEFAULT 0,
  last_error      TEXT   NOT NULL DEFAULT '',
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL,
  delivered_at    BIGINT NULL,
  UNIQUE (endpoint_id, event_source, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS webhook_cursor (
  event_source TEXT   PRIMARY KEY,
  last_id      BIGINT NOT NULL DEFAULT 0,
  updated_at   BIGINT NOT NULL
);

-- Append-only audit for the webhook-endpoint kill-switch (migration 0027; mirrors customer_events).
CREATE TABLE IF NOT EXISTS webhook_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_id TEXT   NOT NULL,
  event_type  TEXT   NOT NULL CHECK (event_type IN ('disable', 'reenable')),
  prev_status TEXT   NOT NULL,
  next_status TEXT   NOT NULL,
  actor       TEXT   NOT NULL DEFAULT '',
  actor_type  TEXT   NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source      TEXT   NOT NULL DEFAULT 'admin',
  reason      TEXT   NOT NULL DEFAULT '',
  request_id  TEXT   NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_endpoint ON webhook_events(endpoint_id, created_at DESC);

-- =====================================================================================
-- audit_digests  (migration 0022) -- tamper-evident hash chain over entitlement_events.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS audit_digests (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source      TEXT   NOT NULL,
  up_to_id    BIGINT NOT NULL,
  event_count BIGINT NOT NULL,
  prev_digest TEXT   NOT NULL DEFAULT '',
  digest      TEXT   NOT NULL,
  created_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_digests_source ON audit_digests(source, id);

-- =====================================================================================
-- usage_meters  (migration 0023) -- metered consumption per entitlement per billing period.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS usage_meters (
  project             TEXT   NOT NULL,
  feature             TEXT   NOT NULL,
  license_fingerprint TEXT   NOT NULL,
  period_start        BIGINT NOT NULL,
  units_consumed      BIGINT NOT NULL DEFAULT 0,
  updated_at          BIGINT NOT NULL,
  PRIMARY KEY (project, feature, license_fingerprint, period_start)
);

CREATE INDEX IF NOT EXISTS idx_usage_meters_entitlement
  ON usage_meters(project, feature, license_fingerprint);

-- =====================================================================================
-- catalog plans  (migration 0025) -- product catalog projected into concrete entitlements.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS catalog_features (
  id          TEXT   PRIMARY KEY,
  project     TEXT   NOT NULL,
  feature_key TEXT   NOT NULL,
  name        TEXT   NOT NULL,
  description TEXT   NOT NULL DEFAULT '',
  category    TEXT   NOT NULL DEFAULT '',
  status      TEXT   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  UNIQUE (project, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_catalog_features_project_status
  ON catalog_features(project, status);

CREATE TABLE IF NOT EXISTS catalog_plans (
  id          TEXT   PRIMARY KEY,
  project     TEXT   NOT NULL,
  plan_key    TEXT   NOT NULL,
  name        TEXT   NOT NULL,
  status      TEXT   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version     BIGINT NOT NULL DEFAULT 1,
  description TEXT   NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  UNIQUE (project, plan_key),
  UNIQUE (project, id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_plans_project_status
  ON catalog_plans(project, status);

CREATE TABLE IF NOT EXISTS catalog_plan_features (
  project               TEXT   NOT NULL,
  plan_id               TEXT   NOT NULL,
  feature_key           TEXT   NOT NULL,
  feature_inclusion     TEXT   NOT NULL DEFAULT 'included' CHECK (feature_inclusion IN ('included', 'addon')),
  addon_key             TEXT   NULL,
  policy_id             TEXT   NULL,
  status                TEXT   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  display_order         BIGINT NOT NULL DEFAULT 0,
  assertion_ttl_seconds BIGINT NULL,
  pool_size             BIGINT NULL,
  max_active_devices    BIGINT NULL,
  max_borrow_sec        BIGINT NULL,
  meter_quota           BIGINT NULL,
  meter_period_sec      BIGINT NULL,
  created_at            BIGINT NOT NULL,
  updated_at            BIGINT NOT NULL,
  PRIMARY KEY (plan_id, feature_key),
  FOREIGN KEY (project, plan_id) REFERENCES catalog_plans(project, id) ON DELETE CASCADE,
  FOREIGN KEY (project, feature_key) REFERENCES catalog_features(project, feature_key) ON DELETE CASCADE,
  FOREIGN KEY (policy_id) REFERENCES entitlement_policies(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_plan_features_project
  ON catalog_plan_features(project, plan_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_plan_features_addon
  ON catalog_plan_features(plan_id, addon_key)
  WHERE addon_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS license_plan_assignments (
  license_id          TEXT   NOT NULL,
  project             TEXT   NOT NULL,
  plan_id             TEXT   NOT NULL,
  license_fingerprint TEXT   NOT NULL,
  customer_id         TEXT   NULL,
  status              TEXT   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked')),
  support_until       BIGINT NULL,
  addons_json         TEXT   NOT NULL DEFAULT '[]',
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  PRIMARY KEY (license_id, project),
  FOREIGN KEY (project, plan_id) REFERENCES catalog_plans(project, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_license_plan_assignments_customer
  ON license_plan_assignments(customer_id);

CREATE INDEX IF NOT EXISTS idx_license_plan_assignments_plan
  ON license_plan_assignments(project, plan_id, status);

-- Migration 0032: append-only assignment history for plan projection. Catalog
-- events cannot encode this entity because their constrained grammar covers
-- only feature/plan/plan_feature records. No FK to the current assignment:
-- this audit history must survive retirement of the current row.
CREATE TABLE IF NOT EXISTS license_plan_assignment_events (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  license_id          TEXT   NOT NULL,
  project             TEXT   NOT NULL,
  plan_id             TEXT   NOT NULL,
  license_fingerprint TEXT   NOT NULL,
  event_type          TEXT   NOT NULL CHECK (event_type IN ('create', 'update')),
  actor               TEXT   NOT NULL DEFAULT '',
  actor_type          TEXT   NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source              TEXT   NOT NULL DEFAULT 'admin',
  request_id          TEXT   NOT NULL DEFAULT '',
  prev_json           TEXT   NOT NULL DEFAULT '',
  next_json           TEXT   NOT NULL DEFAULT '',
  reason              TEXT   NOT NULL DEFAULT '',
  idempotency_key     TEXT   NULL,
  created_at          BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_license_plan_assignment_events_assignment
  ON license_plan_assignment_events(license_id, project, id DESC);

CREATE TABLE IF NOT EXISTS catalog_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type TEXT   NOT NULL CHECK (entity_type IN ('feature', 'plan', 'plan_feature')),
  entity_id   TEXT   NOT NULL,
  project     TEXT   NOT NULL,
  event_type  TEXT   NOT NULL CHECK (event_type IN ('create', 'update', 'disable', 'reenable')),
  actor       TEXT   NOT NULL DEFAULT '',
  actor_type  TEXT   NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source      TEXT   NOT NULL DEFAULT 'admin',
  reason      TEXT   NOT NULL DEFAULT '',
  request_id  TEXT   NOT NULL DEFAULT '',
  prev_json   TEXT   NOT NULL DEFAULT '',
  next_json   TEXT   NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_events_entity
  ON catalog_events(entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_events_project
  ON catalog_events(project, created_at DESC);

-- =====================================================================================
-- server-bound plan-projection previews  (migration 0028)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS license_plan_projection_generations (
  scope       TEXT   PRIMARY KEY CHECK (scope = 'catalog'),
  generation  BIGINT NOT NULL DEFAULT 0,
  updated_at  BIGINT NOT NULL DEFAULT 0
);

INSERT INTO license_plan_projection_generations (scope, generation, updated_at)
VALUES ('catalog', 0, 0)
ON CONFLICT (scope) DO NOTHING;

CREATE TABLE IF NOT EXISTS license_plan_projection_previews (
  id                    TEXT   PRIMARY KEY,
  actor_subject         TEXT   NOT NULL,
  source_generation     BIGINT NOT NULL,
  normalized_input_json TEXT   NOT NULL,
  projection_json       TEXT   NOT NULL,
  actions_json          TEXT   NOT NULL,
  effective_at          BIGINT NOT NULL,
  expires_at            BIGINT NOT NULL,
  claim_token           TEXT   NULL,
  claimed_at            BIGINT NULL,
  consumed_at           BIGINT NULL,
  applied_response_json TEXT   NULL,
  created_at            BIGINT NOT NULL
);

-- Migration 0032: lazy cleanup is one bounded expiry range. Consumed previews
-- retain their original five-minute expiration, so a separate consumed index
-- would only encourage an unbounded OR/sort plan.
DROP INDEX IF EXISTS idx_license_plan_projection_previews_expiry;
DROP INDEX IF EXISTS idx_license_plan_projection_previews_consumed;
CREATE INDEX IF NOT EXISTS idx_license_plan_projection_previews_expiry_id
  ON license_plan_projection_previews(expires_at, id);

-- =====================================================================================
-- server-bound catalog-import previews  (migration 0031)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS catalog_import_previews (
  id                       TEXT   PRIMARY KEY,
  actor_subject            TEXT   NOT NULL,
  source_generation        BIGINT NOT NULL,
  normalized_manifest_json TEXT   NOT NULL,
  manifest_digest          TEXT   NOT NULL,
  preview_json             TEXT   NOT NULL,
  actions_json             TEXT   NOT NULL,
  effective_at             BIGINT NOT NULL,
  expires_at               BIGINT NOT NULL,
  claim_token              TEXT   NULL,
  claimed_at               BIGINT NULL,
  consumed_at              BIGINT NULL,
  applied_response_json    TEXT   NULL,
  created_at               BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_import_previews_expiry
  ON catalog_import_previews(expires_at);

CREATE INDEX IF NOT EXISTS idx_catalog_import_previews_consumed
  ON catalog_import_previews(consumed_at)
  WHERE consumed_at IS NOT NULL;

-- Keep the Postgres port semantically aligned with D1's conservative source
-- generation, even though the current production protocol is D1-backed.
-- Protected-device state (0036); runtime mutations remain D1-only.
CREATE TABLE device_bound_devices (
  id TEXT NOT NULL PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  project TEXT NOT NULL,
  key_id TEXT NOT NULL UNIQUE,
  public_key_spki TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  provider_reported TEXT NOT NULL DEFAULT '',
  assurance TEXT NOT NULL DEFAULT 'proof_verified' CHECK (assurance IN ('proof_verified', 'hardware_attested')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision = CAST(revision AS BIGINT) AND revision BETWEEN 0 AND 9007199254740991),
  created_at BIGINT NOT NULL CHECK (created_at = CAST(created_at AS BIGINT) AND created_at BETWEEN 0 AND 9007199254740991),
  last_proof_at BIGINT NOT NULL CHECK (last_proof_at = CAST(last_proof_at AS BIGINT) AND last_proof_at BETWEEN 0 AND 9007199254740991)
);
CREATE INDEX idx_bound_devices_customer ON device_bound_devices(customer_id, project, id);

CREATE TABLE device_bound_authorizations (
  handle_hash TEXT NOT NULL PRIMARY KEY,
  client_id TEXT NOT NULL,
  project TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key_spki TEXT NOT NULL,
  device_label TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL,
  client_state TEXT NOT NULL,
  pkce_challenge TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'consumed', 'denied')),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision = CAST(revision AS BIGINT) AND revision BETWEEN 0 AND 9007199254740991),
  customer_id TEXT REFERENCES customers(id),
  feature TEXT,
  license_fingerprint TEXT,
  code_hash TEXT,
  code_expires_at BIGINT CHECK (code_expires_at = CAST(code_expires_at AS BIGINT) AND code_expires_at BETWEEN 0 AND 9007199254740991),
  approval_ciphertext TEXT,
  created_at BIGINT NOT NULL CHECK (created_at = CAST(created_at AS BIGINT) AND created_at BETWEEN 0 AND 9007199254740991),
  expires_at BIGINT NOT NULL CHECK (expires_at = CAST(expires_at AS BIGINT) AND expires_at > created_at AND expires_at <= 9007199254740991),
  consumed_invocation_id TEXT,
  consumed_operation_id TEXT,
  recovery_until BIGINT CHECK (recovery_until = CAST(recovery_until AS BIGINT) AND recovery_until BETWEEN 0 AND 9007199254740991),
  CHECK (
    (status IN ('pending','denied') AND customer_id IS NULL AND feature IS NULL
      AND license_fingerprint IS NULL AND code_hash IS NULL AND code_expires_at IS NULL
      AND approval_ciphertext IS NULL)
    OR (status IN ('approved','consumed') AND customer_id IS NOT NULL AND feature IS NOT NULL
      AND license_fingerprint IS NOT NULL AND code_hash IS NOT NULL AND code_expires_at IS NOT NULL
      AND code_expires_at >= created_at AND code_expires_at <= expires_at)
  ),
  CHECK (
    (status != 'consumed' AND consumed_invocation_id IS NULL AND consumed_operation_id IS NULL AND recovery_until IS NULL)
    OR (status = 'consumed' AND consumed_invocation_id IS NOT NULL AND consumed_operation_id IS NOT NULL
      AND recovery_until IS NOT NULL AND recovery_until > created_at AND approval_ciphertext IS NULL)
  )
);
CREATE INDEX idx_bound_authorizations_expiry ON device_bound_authorizations(expires_at);

CREATE TABLE device_bound_bindings (
  id TEXT NOT NULL PRIMARY KEY,
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES device_bound_devices(id),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retiring', 'released')),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation = CAST(generation AS BIGINT) AND generation BETWEEN 1 AND 9007199254740991),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision = CAST(revision AS BIGINT) AND revision BETWEEN 0 AND 9007199254740991),
  hold_until BIGINT NOT NULL DEFAULT 0 CHECK (hold_until = CAST(hold_until AS BIGINT) AND hold_until BETWEEN 0 AND 9007199254740991),
  created_at BIGINT NOT NULL CHECK (created_at = CAST(created_at AS BIGINT) AND created_at BETWEEN 0 AND 9007199254740991),
  updated_at BIGINT NOT NULL CHECK (updated_at = CAST(updated_at AS BIGINT) AND updated_at BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (project, feature, license_fingerprint) REFERENCES entitlements(project, feature, license_fingerprint)
);
CREATE UNIQUE INDEX idx_bound_bindings_active_device
  ON device_bound_bindings(project, feature, license_fingerprint, device_id) WHERE state = 'active';
CREATE INDEX idx_bound_bindings_capacity ON device_bound_bindings(project, feature, license_fingerprint, state, hold_until);
CREATE INDEX idx_bound_bindings_device ON device_bound_bindings(device_id, state);

CREATE TABLE device_bound_challenges (
  id TEXT NOT NULL PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('exchange', 'renew')),
  subject_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL CHECK (created_at = CAST(created_at AS BIGINT) AND created_at BETWEEN 0 AND 9007199254740991),
  expires_at BIGINT NOT NULL CHECK (expires_at = CAST(expires_at AS BIGINT) AND expires_at > created_at AND expires_at <= 9007199254740991),
  consumed_invocation_id TEXT
);
CREATE INDEX idx_bound_challenges_expiry ON device_bound_challenges(expires_at);

-- A fresh invocation identity prevents a cached operation from authorizing a
-- second execution of dependent writes. No raw code, verifier or proof is kept.
CREATE TABLE device_bound_operations (
  key_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('exchange', 'renew', 'retire')),
  operation_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  binding_id TEXT NOT NULL,
  lease_id TEXT,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'complete')),
  response_json TEXT NOT NULL,
  committed_at BIGINT NOT NULL CHECK (committed_at = CAST(committed_at AS BIGINT) AND committed_at BETWEEN 0 AND 9007199254740991),
  retain_until BIGINT NOT NULL CHECK (retain_until = CAST(retain_until AS BIGINT) AND retain_until > committed_at AND retain_until <= 9007199254740991),
  PRIMARY KEY (key_id, purpose, operation_id)
);
CREATE INDEX idx_bound_operations_retention ON device_bound_operations(retain_until);

CREATE TABLE device_bound_leases (
  id TEXT NOT NULL PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES device_bound_bindings(id),
  generation BIGINT NOT NULL CHECK (generation = CAST(generation AS BIGINT) AND generation BETWEEN 1 AND 9007199254740991),
  entitlement_revision BIGINT NOT NULL CHECK (entitlement_revision = CAST(entitlement_revision AS BIGINT) AND entitlement_revision BETWEEN 0 AND 9007199254740991),
  invocation_id TEXT NOT NULL UNIQUE,
  issued_at BIGINT NOT NULL CHECK (issued_at = CAST(issued_at AS BIGINT) AND issued_at BETWEEN 0 AND 9007199254740991),
  expires_at BIGINT NOT NULL CHECK (expires_at = CAST(expires_at AS BIGINT) AND expires_at > issued_at AND expires_at - issued_at <= 86400),
  accept_until BIGINT NOT NULL CHECK (accept_until = CAST(accept_until AS BIGINT) AND accept_until = expires_at + 120 AND accept_until <= 9007199254740991),
  token TEXT NOT NULL
);
CREATE INDEX idx_bound_leases_binding_expiry ON device_bound_leases(binding_id, accept_until);

CREATE TABLE device_bound_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invocation_id TEXT NOT NULL UNIQUE,
  binding_id TEXT NOT NULL REFERENCES device_bound_bindings(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('exchange', 'renew', 'retire')),
  actor TEXT NOT NULL,
  occurred_at BIGINT NOT NULL CHECK (occurred_at = CAST(occurred_at AS BIGINT) AND occurred_at BETWEEN 0 AND 9007199254740991)
);
CREATE INDEX idx_bound_events_customer ON device_bound_events(customer_id, id);

-- Used only inside a batch and deleted before commit. A failing CHECK forces
-- the complete transaction to roll back, including a zero-row authorization.
CREATE TABLE device_bound_commit_checks (
  invocation_id TEXT NOT NULL PRIMARY KEY,
  ok BIGINT NOT NULL CHECK (ok = 1)
);



CREATE OR REPLACE FUNCTION bump_license_plan_projection_generation()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
  WHERE scope = 'catalog';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_license_plan_projection_generation_catalog_features ON catalog_features;
CREATE TRIGGER bump_license_plan_projection_generation_catalog_features
AFTER INSERT OR UPDATE OR DELETE ON catalog_features
FOR EACH STATEMENT EXECUTE FUNCTION bump_license_plan_projection_generation();

DROP TRIGGER IF EXISTS bump_license_plan_projection_generation_catalog_plans ON catalog_plans;
CREATE TRIGGER bump_license_plan_projection_generation_catalog_plans
AFTER INSERT OR UPDATE OR DELETE ON catalog_plans
FOR EACH STATEMENT EXECUTE FUNCTION bump_license_plan_projection_generation();

DROP TRIGGER IF EXISTS bump_license_plan_projection_generation_catalog_plan_features ON catalog_plan_features;
CREATE TRIGGER bump_license_plan_projection_generation_catalog_plan_features
AFTER INSERT OR UPDATE OR DELETE ON catalog_plan_features
FOR EACH STATEMENT EXECUTE FUNCTION bump_license_plan_projection_generation();

DROP TRIGGER IF EXISTS bump_license_plan_projection_generation_entitlement_policies ON entitlement_policies;
CREATE TRIGGER bump_license_plan_projection_generation_entitlement_policies
AFTER INSERT OR UPDATE OR DELETE ON entitlement_policies
FOR EACH STATEMENT EXECUTE FUNCTION bump_license_plan_projection_generation();

DROP TRIGGER IF EXISTS bump_license_plan_projection_generation_entitlements ON entitlements;
CREATE TRIGGER bump_license_plan_projection_generation_entitlements
AFTER INSERT OR UPDATE OR DELETE ON entitlements
FOR EACH STATEMENT EXECUTE FUNCTION bump_license_plan_projection_generation();

DROP TRIGGER IF EXISTS bump_license_plan_projection_generation_assignments ON license_plan_assignments;
CREATE TRIGGER bump_license_plan_projection_generation_assignments
AFTER INSERT OR UPDATE OR DELETE ON license_plan_assignments
FOR EACH STATEMENT EXECUTE FUNCTION bump_license_plan_projection_generation();

-- Fresh-bootstrap parity for portal OAuth (runtime remains D1-only).
-- Provider subjects are immutable identities. Email is contact data, never an account-link key.
CREATE TABLE portal_identities (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  subject TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  email TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (customer_id, provider)
);

CREATE TABLE portal_oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  link_session_id TEXT REFERENCES portal_sessions(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX idx_portal_oauth_states_expires ON portal_oauth_states(expires_at);

-- Login email is an unverified identifier, not a claim to customers.email or licenses.
CREATE TABLE portal_passwords (
  customer_id TEXT PRIMARY KEY NOT NULL REFERENCES customers(id),
  email_lower TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entitlements_customer_project ON entitlements(customer_id, project, feature, license_fingerprint);

-- Exact row-trigger port checked by bound_trigger_contract.py.
CREATE OR REPLACE FUNCTION tr_bound_attempt_approval_immutable_fn() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('approved','consumed') AND (NEW.customer_id IS DISTINCT FROM OLD.customer_id
  OR NEW.feature IS DISTINCT FROM OLD.feature OR NEW.license_fingerprint IS DISTINCT FROM OLD.license_fingerprint
  OR NEW.code_hash IS DISTINCT FROM OLD.code_hash OR NEW.code_expires_at IS DISTINCT FROM OLD.code_expires_at) THEN
    RAISE EXCEPTION 'authorization_approval_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_attempt_approval_immutable BEFORE UPDATE OF customer_id,feature,license_fingerprint,code_hash,code_expires_at ON device_bound_authorizations
FOR EACH ROW EXECUTE FUNCTION tr_bound_attempt_approval_immutable_fn();

CREATE OR REPLACE FUNCTION tr_bound_attempt_consumption_immutable_fn() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status='consumed' AND (NEW.consumed_invocation_id IS DISTINCT FROM OLD.consumed_invocation_id
  OR NEW.consumed_operation_id IS DISTINCT FROM OLD.consumed_operation_id OR NEW.recovery_until IS DISTINCT FROM OLD.recovery_until) THEN
    RAISE EXCEPTION 'authorization_consumption_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_attempt_consumption_immutable BEFORE UPDATE OF consumed_invocation_id,consumed_operation_id,recovery_until ON device_bound_authorizations
FOR EACH ROW EXECUTE FUNCTION tr_bound_attempt_consumption_immutable_fn();

CREATE OR REPLACE FUNCTION tr_bound_attempt_intent_immutable_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.handle_hash IS DISTINCT FROM OLD.handle_hash OR NEW.client_id IS DISTINCT FROM OLD.client_id
  OR NEW.project IS DISTINCT FROM OLD.project OR NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.public_key_spki IS DISTINCT FROM OLD.public_key_spki
  OR NEW.redirect_uri IS DISTINCT FROM OLD.redirect_uri OR NEW.client_state IS DISTINCT FROM OLD.client_state
  OR NEW.pkce_challenge IS DISTINCT FROM OLD.pkce_challenge OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'authorization_intent_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_attempt_intent_immutable BEFORE UPDATE OF handle_hash,client_id,project,key_id,public_key_spki,redirect_uri,client_state,pkce_challenge,created_at,expires_at ON device_bound_authorizations
FOR EACH ROW EXECUTE FUNCTION tr_bound_attempt_intent_immutable_fn();

CREATE OR REPLACE FUNCTION tr_bound_attempt_revision_no_reset_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'authorization_revision_cannot_shrink';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_attempt_revision_no_reset BEFORE UPDATE OF revision ON device_bound_authorizations
FOR EACH ROW EXECUTE FUNCTION tr_bound_attempt_revision_no_reset_fn();

CREATE OR REPLACE FUNCTION tr_bound_attempt_terminal_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status != OLD.status AND NOT ((OLD.status='pending' AND NEW.status IN ('approved','denied'))
  OR (OLD.status='approved' AND NEW.status='consumed')) THEN
    RAISE EXCEPTION 'authorization_transition_invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_attempt_terminal BEFORE UPDATE OF status ON device_bound_authorizations
FOR EACH ROW EXECUTE FUNCTION tr_bound_attempt_terminal_fn();

CREATE OR REPLACE FUNCTION tr_bound_binding_hold_monotonic_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.hold_until < OLD.hold_until THEN
    RAISE EXCEPTION 'binding_hold_cannot_shrink';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_binding_hold_monotonic BEFORE UPDATE OF hold_until ON device_bound_bindings
FOR EACH ROW EXECUTE FUNCTION tr_bound_binding_hold_monotonic_fn();

CREATE OR REPLACE FUNCTION tr_bound_binding_identity_immutable_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project IS DISTINCT FROM OLD.project OR NEW.feature IS DISTINCT FROM OLD.feature
  OR NEW.license_fingerprint IS DISTINCT FROM OLD.license_fingerprint OR NEW.device_id IS DISTINCT FROM OLD.device_id THEN
    RAISE EXCEPTION 'binding_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_binding_identity_immutable BEFORE UPDATE OF id, project, feature, license_fingerprint, device_id ON device_bound_bindings
FOR EACH ROW EXECUTE FUNCTION tr_bound_binding_identity_immutable_fn();

CREATE OR REPLACE FUNCTION tr_bound_binding_keep_tombstone_fn() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'binding_tombstone_required';
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_binding_keep_tombstone BEFORE DELETE ON device_bound_bindings
FOR EACH ROW EXECUTE FUNCTION tr_bound_binding_keep_tombstone_fn();

CREATE OR REPLACE FUNCTION tr_bound_binding_no_early_release_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.state = 'released' AND (OLD.state = 'active' OR OLD.hold_until > FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::BIGINT) THEN
    RAISE EXCEPTION 'binding_hold_active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_binding_no_early_release BEFORE UPDATE OF state ON device_bound_bindings
FOR EACH ROW EXECUTE FUNCTION tr_bound_binding_no_early_release_fn();

CREATE OR REPLACE FUNCTION tr_bound_binding_no_resurrection_fn() RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.state = 'retiring' AND NEW.state = 'active') OR (OLD.state = 'released' AND NEW.state != 'released') THEN
    RAISE EXCEPTION 'binding_retirement_terminal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_binding_no_resurrection BEFORE UPDATE OF state ON device_bound_bindings
FOR EACH ROW EXECUTE FUNCTION tr_bound_binding_no_resurrection_fn();

CREATE OR REPLACE FUNCTION tr_bound_binding_revision_no_reset_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.revision < OLD.revision OR NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'binding_revision_cannot_shrink';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_binding_revision_no_reset BEFORE UPDATE OF revision,generation ON device_bound_bindings
FOR EACH ROW EXECUTE FUNCTION tr_bound_binding_revision_no_reset_fn();

CREATE OR REPLACE FUNCTION tr_bound_capacity_decrease_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.enforcement_mode = 'device_bound_v1' AND NEW.max_active_devices < (
  SELECT COUNT(*) FROM device_bound_bindings b WHERE b.project = OLD.project
  AND b.feature = OLD.feature AND b.license_fingerprint = OLD.license_fingerprint
  AND (b.state = 'active' OR (b.state = 'retiring' AND b.hold_until > FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::BIGINT))
) THEN
    RAISE EXCEPTION 'capacity_in_use';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_capacity_decrease BEFORE UPDATE OF max_active_devices ON entitlements
FOR EACH ROW EXECUTE FUNCTION tr_bound_capacity_decrease_fn();

CREATE OR REPLACE FUNCTION tr_bound_challenge_immutable_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
  OR NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.nonce_hash IS DISTINCT FROM OLD.nonce_hash
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  OR OLD.consumed_invocation_id IS NOT NULL OR NEW.consumed_invocation_id IS NULL THEN
    RAISE EXCEPTION 'challenge_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_challenge_immutable BEFORE UPDATE ON device_bound_challenges
FOR EACH ROW EXECUTE FUNCTION tr_bound_challenge_immutable_fn();

CREATE OR REPLACE FUNCTION tr_bound_customer_revision_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE customers SET authority_revision=OLD.authority_revision+1 WHERE id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_customer_revision AFTER UPDATE OF status ON customers
FOR EACH ROW EXECUTE FUNCTION tr_bound_customer_revision_fn();

CREATE OR REPLACE FUNCTION tr_bound_customer_revision_no_reset_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.authority_revision < OLD.authority_revision THEN
    RAISE EXCEPTION 'authority_revision_cannot_shrink';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_customer_revision_no_reset BEFORE UPDATE OF authority_revision ON customers
FOR EACH ROW EXECUTE FUNCTION tr_bound_customer_revision_no_reset_fn();

CREATE OR REPLACE FUNCTION tr_bound_device_disable_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status != OLD.status THEN
    UPDATE device_bound_devices SET revision=OLD.revision+1 WHERE id=NEW.id;
  UPDATE device_bound_bindings SET state='retiring',generation=generation+1,revision=revision+1,updated_at=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::BIGINT
    WHERE device_id=NEW.id AND state='active' AND NEW.status='disabled';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_device_disable AFTER UPDATE OF status ON device_bound_devices
FOR EACH ROW EXECUTE FUNCTION tr_bound_device_disable_fn();

CREATE OR REPLACE FUNCTION tr_bound_device_identity_immutable_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.project IS DISTINCT FROM OLD.project
  OR NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.public_key_spki IS DISTINCT FROM OLD.public_key_spki THEN
    RAISE EXCEPTION 'device_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_device_identity_immutable BEFORE UPDATE OF id, customer_id, project, key_id, public_key_spki ON device_bound_devices
FOR EACH ROW EXECUTE FUNCTION tr_bound_device_identity_immutable_fn();

CREATE OR REPLACE FUNCTION tr_bound_device_keep_tombstone_fn() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'device_tombstone_required';
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_device_keep_tombstone BEFORE DELETE ON device_bound_devices
FOR EACH ROW EXECUTE FUNCTION tr_bound_device_keep_tombstone_fn();

CREATE OR REPLACE FUNCTION tr_bound_device_revision_no_reset_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'device_revision_cannot_shrink';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_device_revision_no_reset BEFORE UPDATE OF revision ON device_bound_devices
FOR EACH ROW EXECUTE FUNCTION tr_bound_device_revision_no_reset_fn();

CREATE OR REPLACE FUNCTION tr_bound_entitlement_revision_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
  OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
  OR NEW.max_active_devices IS DISTINCT FROM OLD.max_active_devices OR NEW.lease_seconds IS DISTINCT FROM OLD.lease_seconds
  OR NEW.enforcement_mode IS DISTINCT FROM OLD.enforcement_mode OR NEW.revocation_seq IS DISTINCT FROM OLD.revocation_seq
  OR NEW.pool_size IS DISTINCT FROM OLD.pool_size OR NEW.is_trial IS DISTINCT FROM OLD.is_trial
  OR NEW.trial_started_at IS DISTINCT FROM OLD.trial_started_at OR NEW.trial_duration_sec IS DISTINCT FROM OLD.trial_duration_sec
  OR NEW.trial_expiration_basis IS DISTINCT FROM OLD.trial_expiration_basis
  OR NEW.trial_one_per_device IS DISTINCT FROM OLD.trial_one_per_device
  OR NEW.trial_require_device_proof IS DISTINCT FROM OLD.trial_require_device_proof
  OR NEW.trial_device_hash IS DISTINCT FROM OLD.trial_device_hash THEN
    UPDATE entitlements SET authority_revision = OLD.authority_revision + 1
  WHERE project = NEW.project AND feature = NEW.feature AND license_fingerprint = NEW.license_fingerprint;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_entitlement_revision AFTER UPDATE ON entitlements
FOR EACH ROW EXECUTE FUNCTION tr_bound_entitlement_revision_fn();

CREATE OR REPLACE FUNCTION tr_bound_entitlement_revision_no_reset_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.authority_revision < OLD.authority_revision THEN
    RAISE EXCEPTION 'authority_revision_cannot_shrink';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_entitlement_revision_no_reset BEFORE UPDATE OF authority_revision ON entitlements
FOR EACH ROW EXECUTE FUNCTION tr_bound_entitlement_revision_no_reset_fn();

CREATE OR REPLACE FUNCTION tr_bound_mode_no_downgrade_fn() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.enforcement_mode = 'device_bound_v1' AND NEW.enforcement_mode != OLD.enforcement_mode THEN
    RAISE EXCEPTION 'protected_mode_downgrade';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_mode_no_downgrade BEFORE UPDATE OF enforcement_mode ON entitlements
FOR EACH ROW EXECUTE FUNCTION tr_bound_mode_no_downgrade_fn();

CREATE OR REPLACE FUNCTION tr_bound_mode_requires_migration_fn() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.enforcement_mode = 'legacy' AND NEW.enforcement_mode = 'device_bound_v1' THEN
    RAISE EXCEPTION 'protected_mode_migration_required';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_mode_requires_migration BEFORE UPDATE OF enforcement_mode ON entitlements
FOR EACH ROW EXECUTE FUNCTION tr_bound_mode_requires_migration_fn();

CREATE OR REPLACE FUNCTION tr_bound_operation_immutable_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.key_id IS DISTINCT FROM OLD.key_id OR NEW.purpose IS DISTINCT FROM OLD.purpose
  OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.invocation_id IS DISTINCT FROM OLD.invocation_id
  OR NEW.request_digest IS DISTINCT FROM OLD.request_digest OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
  OR NEW.binding_id IS DISTINCT FROM OLD.binding_id OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
  OR NEW.committed_at IS DISTINCT FROM OLD.committed_at OR NEW.retain_until IS DISTINCT FROM OLD.retain_until
  OR NOT (
    (OLD.status='prepared' AND NEW.status='complete' AND NEW.response_json=OLD.response_json)
    OR (OLD.status='complete' AND NEW.status='complete' AND OLD.retain_until<=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::BIGINT AND NEW.response_json='')
  ) THEN
    RAISE EXCEPTION 'operation_result_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_operation_immutable BEFORE UPDATE ON device_bound_operations
FOR EACH ROW EXECUTE FUNCTION tr_bound_operation_immutable_fn();

CREATE OR REPLACE FUNCTION tr_bound_owner_change_fn() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id AND EXISTS (
  SELECT 1 FROM device_bound_bindings b WHERE b.project = OLD.project
  AND b.feature = OLD.feature AND b.license_fingerprint = OLD.license_fingerprint
  AND (b.state = 'active' OR (b.state = 'retiring' AND b.hold_until > FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::BIGINT))
) THEN
    RAISE EXCEPTION 'capacity_in_use';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_owner_change BEFORE UPDATE OF customer_id ON entitlements
FOR EACH ROW EXECUTE FUNCTION tr_bound_owner_change_fn();

CREATE OR REPLACE FUNCTION tr_bound_reject_legacy_device_insert_fn() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM entitlements e WHERE e.project = NEW.project AND e.feature = NEW.feature
  AND e.license_fingerprint = NEW.license_fingerprint AND e.enforcement_mode = 'device_bound_v1') THEN
    RAISE EXCEPTION 'legacy_protocol_disabled';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_reject_legacy_device_insert BEFORE INSERT ON entitlement_devices
FOR EACH ROW EXECUTE FUNCTION tr_bound_reject_legacy_device_insert_fn();

CREATE OR REPLACE FUNCTION tr_bound_reject_legacy_device_update_fn() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM entitlements e WHERE e.project = NEW.project AND e.feature = NEW.feature
  AND e.license_fingerprint = NEW.license_fingerprint AND e.enforcement_mode = 'device_bound_v1') THEN
    RAISE EXCEPTION 'legacy_protocol_disabled';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_reject_legacy_device_update BEFORE UPDATE ON entitlement_devices
FOR EACH ROW EXECUTE FUNCTION tr_bound_reject_legacy_device_update_fn();

CREATE OR REPLACE FUNCTION tr_bound_reject_legacy_lease_fn() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM entitlements e WHERE e.project = NEW.project AND e.feature = NEW.feature
  AND e.license_fingerprint = NEW.license_fingerprint AND e.enforcement_mode = 'device_bound_v1') THEN
    RAISE EXCEPTION 'legacy_protocol_disabled';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_reject_legacy_lease BEFORE INSERT ON lease_issuance
FOR EACH ROW EXECUTE FUNCTION tr_bound_reject_legacy_lease_fn();

CREATE OR REPLACE FUNCTION tr_bound_reject_legacy_seat_insert_fn() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM entitlements e WHERE e.project = NEW.project AND e.feature = NEW.feature
  AND e.license_fingerprint = NEW.license_fingerprint AND e.enforcement_mode = 'device_bound_v1') THEN
    RAISE EXCEPTION 'legacy_protocol_disabled';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_reject_legacy_seat_insert BEFORE INSERT ON seat_checkouts
FOR EACH ROW EXECUTE FUNCTION tr_bound_reject_legacy_seat_insert_fn();

CREATE OR REPLACE FUNCTION tr_bound_reject_legacy_seat_update_fn() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM entitlements e WHERE e.project = NEW.project AND e.feature = NEW.feature
  AND e.license_fingerprint = NEW.license_fingerprint AND e.enforcement_mode = 'device_bound_v1') THEN
    RAISE EXCEPTION 'legacy_protocol_disabled';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_reject_legacy_seat_update BEFORE UPDATE ON seat_checkouts
FOR EACH ROW EXECUTE FUNCTION tr_bound_reject_legacy_seat_update_fn();

CREATE INDEX idx_bound_approval_cleanup ON device_bound_authorizations(code_expires_at) WHERE approval_ciphertext IS NOT NULL;
CREATE OR REPLACE FUNCTION tr_bound_operation_tombstone_fn() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'operation_tombstone_required';
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_operation_tombstone BEFORE DELETE ON device_bound_operations
FOR EACH ROW EXECUTE FUNCTION tr_bound_operation_tombstone_fn();
CREATE INDEX idx_bound_operation_payload_cleanup ON device_bound_operations(retain_until) WHERE status='complete' AND response_json<>'';
CREATE OR REPLACE FUNCTION tr_bound_operation_no_replace_fn() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM device_bound_operations o WHERE
  (o.key_id=NEW.key_id AND o.purpose=NEW.purpose AND o.operation_id=NEW.operation_id)
  OR o.invocation_id=NEW.invocation_id) THEN
    RAISE EXCEPTION 'operation_tombstone_required';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER tr_bound_operation_no_replace BEFORE INSERT ON device_bound_operations
FOR EACH ROW EXECUTE FUNCTION tr_bound_operation_no_replace_fn();
CREATE INDEX idx_bound_consumed_attempt_cleanup ON device_bound_authorizations(recovery_until) WHERE status='consumed';
CREATE INDEX idx_bound_lease_cleanup ON device_bound_leases(accept_until);

CREATE INDEX idx_bound_unconsumed_attempt_cleanup ON device_bound_authorizations(expires_at)
WHERE status IN ('pending','approved','denied');
