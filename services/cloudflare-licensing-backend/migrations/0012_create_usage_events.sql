-- Usage reporting (design: usage analytics for floating + leases). An append-only event
-- log -- the FlexNet "report log" -- from which peak concurrent usage, denial rate, and
-- adoption are aggregated. Seat state (seat_checkouts) is mutated/deleted on release, so it
-- cannot answer "what was your peak last month"; this durable log can. Swept after retention;
-- long-term history comes from rollups computed over it.
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('checkout', 'release', 'reclaim', 'denied')),
  seat_id TEXT NULL,
  device_key_id TEXT NULL,
  reason TEXT NULL,
  ts INTEGER NOT NULL
);

-- Window scan for one feature, and the retention sweep.
CREATE INDEX IF NOT EXISTS idx_usage_events_window
  ON usage_events(project, feature, license_fingerprint, ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_ts
  ON usage_events(ts);
