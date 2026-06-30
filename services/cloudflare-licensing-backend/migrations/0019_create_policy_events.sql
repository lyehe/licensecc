-- Essential-features Workstream A: append-only audit for entitlement_policies lifecycle
-- (create/update/disable/reenable), mirroring entitlement_events / customer_events.

CREATE TABLE IF NOT EXISTS policy_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id   TEXT NOT NULL,
  project     TEXT NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN ('create', 'update', 'disable', 'reenable')),
  actor       TEXT NOT NULL DEFAULT '',
  actor_type  TEXT NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source      TEXT NOT NULL DEFAULT 'admin',
  reason      TEXT NOT NULL DEFAULT '',
  request_id  TEXT NOT NULL DEFAULT '',
  prev_json   TEXT NOT NULL DEFAULT '',
  next_json   TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES entitlement_policies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_policy_events_policy ON policy_events(policy_id, created_at DESC);
