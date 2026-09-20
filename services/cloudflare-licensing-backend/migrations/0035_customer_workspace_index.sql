-- Customer workspace pagination sorts by the canonical grant tuple. The
-- customer-only index requires sorting every grant even for a bounded page.
CREATE INDEX IF NOT EXISTS idx_entitlements_customer_project
  ON entitlements(customer_id, project, feature, license_fingerprint);
