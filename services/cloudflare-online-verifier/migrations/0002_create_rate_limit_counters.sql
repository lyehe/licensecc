CREATE TABLE IF NOT EXISTS rate_limit_counters (
  namespace TEXT NOT NULL,
  rate_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, rate_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_expires_at
  ON rate_limit_counters(expires_at);
