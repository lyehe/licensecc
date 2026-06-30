-- schema.pg.sql
--
-- PostgreSQL / Supabase port of the licensecc licensing backend schema.
-- Ground truth: services/cloudflare-licensing-backend/schema.sql (SQLite/D1, built from
--   migrations/0001..0008). This is a faithful 1:1 port: every table, column, default,
--   CHECK enum, composite primary key, index, and the composite ON DELETE CASCADE FK are
--   preserved. The ONLY behavioral differences are the documented type/identity changes
--   required by Postgres (see header notes per change).
--
-- Port rules applied (verbatim from the task contract):
--   * INTEGER PRIMARY KEY AUTOINCREMENT          -> BIGINT GENERATED ALWAYS AS IDENTITY
--   * epoch / counter INTEGER columns            -> BIGINT  (32-bit unix seconds overflow
--       in 2038; counters/seq are 64-bit-intent). Widened columns:
--         created_at, updated_at, valid_from, valid_until, last_seen_at,
--         window_start, expires_at, revocation_seq, request_count,
--         assertion_ttl_seconds, cache_ttl_seconds.
--     NOTE: postgres.js returns BIGINT (int8, OID 20) columns as JavaScript STRINGS by
--       default. The Worker's verify path survives that coincidentally (every BIGINT read
--       is numerically coerced downstream -- see db-postgres.mjs), but the adapter now
--       installs an int8 type parser so these columns arrive as numbers. See db-postgres.mjs.
--   * CHECK (col IN (...)) enums                 -> kept verbatim (NOT converted to native
--       ENUM types, so migrations 0006/0007 that widened the enum lists stay trivial to
--       reproduce as ALTER ... DROP/ADD CONSTRAINT, exactly like the SQLite rebuilds).
--   * TEXT NOT NULL DEFAULT ''                   -> kept as-is.
--   * metadata_json TEXT NOT NULL DEFAULT '{}'   -> kept as TEXT (jsonb is an option;
--       see the commented jsonb variant next to each occurrence). Kept TEXT to stay
--       byte-for-byte compatible with the existing admin/CLI tooling that writes/reads
--       these columns as opaque JSON strings.
--   * composite TEXT primary keys                -> ported verbatim.
--   * composite FOREIGN KEY ... ON DELETE CASCADE -> ported verbatim.
--
-- pgcrypto is required because the admin/CLI statements port `lower(hex(randomblob(8)))`
-- to `encode(gen_random_bytes(8),'hex')` (see statements.pg.sql). gen_random_bytes lives
-- in pgcrypto. (On Supabase pgcrypto is preinstalled; this is idempotent.)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================================================
-- entitlements  (migrations 0001 + 0003 validity columns + 0004 customer/license cols)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS entitlements (
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
-- NOTE: this file is a FRESH-PROVISION snapshot (all CREATE ... IF NOT EXISTS);
-- there is no Postgres migration runner in this repo (D1/SQLite is the
-- production ground truth, migrations/ is its source of truth). An EXISTING
-- Postgres deployment will NOT pick up the migration-0013 changes from re-applying
-- this snapshot — run the upgrade DDL manually:
--   ALTER TABLE customers ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'));
--   ALTER TABLE customers ADD COLUMN IF NOT EXISTS external_ref TEXT NOT NULL DEFAULT '';
--   DROP INDEX IF EXISTS idx_customers_email;
--   CREATE UNIQUE INDEX idx_customers_email ON customers(lower(email)) WHERE email <> '';
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
  updated_at                  BIGINT  NOT NULL
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
  updated_at  BIGINT NOT NULL
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
