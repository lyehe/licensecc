ALTER TABLE entitlements ADD COLUMN valid_from INTEGER NULL;
ALTER TABLE entitlements ADD COLUMN valid_until INTEGER NULL;
ALTER TABLE entitlements ADD COLUMN notes TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_entitlements_project_feature_status
  ON entitlements(project, feature, status);

CREATE INDEX IF NOT EXISTS idx_entitlements_valid_until
  ON entitlements(valid_until);
