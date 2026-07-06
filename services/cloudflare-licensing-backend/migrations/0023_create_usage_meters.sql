-- Metered consumption + quota (audit R6.3). Entitlements cap CONCURRENCY (pool_size) and DEVICES
-- (max_active_devices) but not CONSUMPTION. usage_meters counts units consumed per entitlement per
-- rolling billing period; POST /v1/meter increments it and enforces meter_quota when it is > 0
-- (0 = unlimited / count-only). meter_period_sec is the period length (default 30d). The counter is
-- account-isolated like seats; a quota is set via the admin/order path (the defaults leave it off,
-- so metering ships dark as pure usage accounting until an operator opts a feature into a quota).
ALTER TABLE entitlements ADD COLUMN meter_quota INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entitlements ADD COLUMN meter_period_sec INTEGER NOT NULL DEFAULT 2592000;

CREATE TABLE IF NOT EXISTS usage_meters (
  project             TEXT    NOT NULL,
  feature             TEXT    NOT NULL,
  license_fingerprint TEXT    NOT NULL,
  period_start        INTEGER NOT NULL,
  units_consumed      INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (project, feature, license_fingerprint, period_start)
);

CREATE INDEX IF NOT EXISTS idx_usage_meters_entitlement
  ON usage_meters(project, feature, license_fingerprint);
