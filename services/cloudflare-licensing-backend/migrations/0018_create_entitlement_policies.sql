-- Essential-features Workstream A (keystone): license-policy/template object + frozen trial state.
-- Design: docs/superpowers/plans/2026-06-25-essential-features-implementation-plan.md (Workstream A).
--
-- A policy is a reusable TEMPLATE an operator stamps into a new entitlement at create time. Stamping
-- is frozen: the entitlement copies the policy's defaults into its own row, and `entitlements.policy_id`
-- is ADVISORY provenance only (NO foreign key — disabling/deleting a policy never retroactively mutates
-- a stamped entitlement, and order-ingest's createEntitlement mirror must never break on a dangling id).
-- The trial_* columns on entitlements are the FROZEN trial config the lease hot path reads from the
-- SAME row (it never joins entitlement_policies).

-- Stamp defaults (valid_from_offset_sec/duration_sec drive the valid window; NULL offset = open
-- start, NULL duration = perpetual) plus the trial config (meaningful when type='trial'), frozen onto
-- the entitlement at stamp time. (Column comments kept OUTSIDE the CREATE so sqlite_master's stored
-- SQL matches schema.sql byte-for-byte under the parity checker.)
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

-- One policy name per project (case-insensitive), mirroring idx_customers_email's lower() discipline.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_policies_name ON entitlement_policies(project, lower(name));

-- Advisory policy provenance + frozen trial state on entitlements. Append-only ALTERs (like 0014's
-- floor columns); all nullable/defaulted so existing rows and the byte-identical createEntitlement
-- INSERT (which does not name these columns) are unaffected. NOT in ENTITLEMENT_COLUMNS — read by
-- dedicated SELECTs, same precedent as cache_ttl_seconds.
ALTER TABLE entitlements ADD COLUMN policy_id TEXT NULL;
ALTER TABLE entitlements ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entitlements ADD COLUMN trial_expiration_basis TEXT NULL;
ALTER TABLE entitlements ADD COLUMN trial_duration_sec INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entitlements ADD COLUMN trial_one_per_device INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entitlements ADD COLUMN trial_require_device_proof INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entitlements ADD COLUMN trial_started_at INTEGER NULL;
ALTER TABLE entitlements ADD COLUMN trial_device_hash TEXT NULL;
