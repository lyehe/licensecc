-- The plan-projection identity fence must inspect every entitlement sharing a
-- (project, license_id), including legacy/unmanaged rows. Keep that bounded
-- during Preview and the first atomic Apply claim.

CREATE INDEX IF NOT EXISTS idx_entitlements_project_license_fingerprint
  ON entitlements(project, license_id, license_fingerprint);
