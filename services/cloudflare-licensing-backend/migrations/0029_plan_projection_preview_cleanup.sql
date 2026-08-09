-- Bound lazy retention work for server-persisted preview capabilities. Expiry
-- already has an index from 0028; consumed previews need a complementary
-- partial index so later Preview requests can discard sensitive snapshots
-- without an unbounded table scan.

CREATE INDEX IF NOT EXISTS idx_license_plan_projection_previews_consumed
  ON license_plan_projection_previews(consumed_at)
  WHERE consumed_at IS NOT NULL;
