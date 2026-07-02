-- Metered-quota policy carry (audit R6.3 completion). Policy templates already carry the capacity
-- knobs (pool_size / max_active_devices / max_borrow_sec) that stampFromPolicy applies to a stamped
-- entitlement. Add the metering quota to the same template surface so an operator can define a
-- "metered" policy and every entitlement stamped from it inherits the per-period consumption quota
-- (meterUsage then enforces it). Defaults mirror the entitlements columns (0 = unlimited/count-only,
-- 30d period), so existing policies keep metering dark.
ALTER TABLE entitlement_policies ADD COLUMN meter_quota INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entitlement_policies ADD COLUMN meter_period_sec INTEGER NOT NULL DEFAULT 2592000;
