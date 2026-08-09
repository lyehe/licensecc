-- Server-bound plan-projection preview/apply protocol.
--
-- A preview captures a normalized input, the exact derived action set, and the
-- generation of every source table it read.  The generation is deliberately
-- conservative: a change to any catalog/policy/managed-entitlement dependency
-- invalidates every outstanding preview rather than risking an incorrect apply.

CREATE TABLE IF NOT EXISTS license_plan_projection_generations (
  scope TEXT PRIMARY KEY CHECK (scope = 'catalog'),
  generation INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO license_plan_projection_generations (scope, generation, updated_at)
VALUES ('catalog', 0, 0);

CREATE TABLE IF NOT EXISTS license_plan_projection_previews (
  id TEXT PRIMARY KEY,
  actor_subject TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  normalized_input_json TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  effective_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claim_token TEXT NULL,
  claimed_at INTEGER NULL,
  consumed_at INTEGER NULL,
  applied_response_json TEXT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_license_plan_projection_previews_expiry
  ON license_plan_projection_previews(expires_at);

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_catalog_features_insert
AFTER INSERT ON catalog_features
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_catalog_features_update
AFTER UPDATE ON catalog_features
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_catalog_features_delete
AFTER DELETE ON catalog_features
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_catalog_plans_insert
AFTER INSERT ON catalog_plans
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_catalog_plans_update
AFTER UPDATE ON catalog_plans
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_catalog_plans_delete
AFTER DELETE ON catalog_plans
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_catalog_plan_features_insert
AFTER INSERT ON catalog_plan_features
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_catalog_plan_features_update
AFTER UPDATE ON catalog_plan_features
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_catalog_plan_features_delete
AFTER DELETE ON catalog_plan_features
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_entitlement_policies_insert
AFTER INSERT ON entitlement_policies
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_entitlement_policies_update
AFTER UPDATE ON entitlement_policies
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_entitlement_policies_delete
AFTER DELETE ON entitlement_policies
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_entitlements_insert
AFTER INSERT ON entitlements
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_entitlements_update
AFTER UPDATE ON entitlements
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_entitlements_delete
AFTER DELETE ON entitlements
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_assignments_insert
AFTER INSERT ON license_plan_assignments
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_assignments_update
AFTER UPDATE ON license_plan_assignments
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;

CREATE TRIGGER IF NOT EXISTS bump_license_plan_projection_generation_assignments_delete
AFTER DELETE ON license_plan_assignments
BEGIN
  UPDATE license_plan_projection_generations
  SET generation = generation + 1,
      updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE scope = 'catalog';
END;
