-- Append-only audit for the webhook-endpoint kill-switch (disable/reenable).
--
-- Until now webhook_endpoints had NO event log: disable/reenable were single-statement
-- RETURNING mutations that discarded any operator-supplied reason (the confirm modal even
-- skipped asking for one). Disabling an endpoint is a destructive operational action — it
-- stops NEW deliveries for that endpoint — so it deserves the same traceability as the
-- customer / policy / catalog kill-switches: actor + actor_type + source + reason + request_id,
-- append-only, never mutated. This mirrors customer_events (migration 0017) exactly.
CREATE TABLE IF NOT EXISTS webhook_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN ('disable', 'reenable')),
  prev_status TEXT NOT NULL,
  next_status TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT '',
  actor_type  TEXT NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source      TEXT NOT NULL DEFAULT 'admin',
  reason      TEXT NOT NULL DEFAULT '',
  request_id  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_endpoint ON webhook_events(endpoint_id, created_at DESC);
