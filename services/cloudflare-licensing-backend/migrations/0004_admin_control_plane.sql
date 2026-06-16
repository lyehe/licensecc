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

ALTER TABLE entitlements ADD COLUMN customer_id TEXT NULL;
ALTER TABLE entitlements ADD COLUMN license_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_entitlements_customer
  ON entitlements(customer_id);

CREATE INDEX IF NOT EXISTS idx_entitlements_license
  ON entitlements(license_id);

CREATE TABLE IF NOT EXISTS mutation_idempotency (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_created_at
  ON mutation_idempotency(created_at);
