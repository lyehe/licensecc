-- Operator test sends reach a real receiver, so they are audited like disable/reenable:
-- actor, request id and the receiver's status class. SQLite cannot widen a CHECK in place,
-- so the table is rebuilt with the same columns, rows and index.
DROP INDEX IF EXISTS idx_webhook_events_endpoint;
CREATE TABLE webhook_events_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN ('disable', 'reenable', 'test_send')),
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
INSERT INTO webhook_events_new SELECT id, endpoint_id, event_type, prev_status, next_status, actor, actor_type, source, reason, request_id, created_at FROM webhook_events;
DROP TABLE webhook_events;
ALTER TABLE webhook_events_new RENAME TO webhook_events;
CREATE INDEX IF NOT EXISTS idx_webhook_events_endpoint ON webhook_events(endpoint_id, created_at DESC);
