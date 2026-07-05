-- Product catalog + plan projection metadata.
--
-- Plans are package definitions. Runtime authorization still reads concrete entitlement rows;
-- projecting a plan creates/updates those rows so checks never need to understand tier names.
CREATE TABLE IF NOT EXISTS catalog_features (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_catalog_features_project_status
  ON catalog_features(project, status);

CREATE TABLE IF NOT EXISTS catalog_plans (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project, plan_key),
  UNIQUE (project, id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_plans_project_status
  ON catalog_plans(project, status);

CREATE TABLE IF NOT EXISTS catalog_plan_features (
  project TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  feature_inclusion TEXT NOT NULL DEFAULT 'included' CHECK (feature_inclusion IN ('included', 'addon')),
  addon_key TEXT NULL,
  policy_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  display_order INTEGER NOT NULL DEFAULT 0,
  assertion_ttl_seconds INTEGER NULL,
  pool_size INTEGER NULL,
  max_active_devices INTEGER NULL,
  max_borrow_sec INTEGER NULL,
  meter_quota INTEGER NULL,
  meter_period_sec INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
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
  license_id TEXT NOT NULL,
  project TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  customer_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked')),
  support_until INTEGER NULL,
  addons_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (license_id, project),
  FOREIGN KEY (project, plan_id) REFERENCES catalog_plans(project, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_license_plan_assignments_customer
  ON license_plan_assignments(customer_id);

CREATE INDEX IF NOT EXISTS idx_license_plan_assignments_plan
  ON license_plan_assignments(project, plan_id, status);
