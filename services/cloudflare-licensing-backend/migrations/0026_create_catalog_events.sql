-- Product catalog lifecycle audit.
--
-- Catalog features/plans/plan-feature rows are operator-managed configuration.
-- Each create/update/disable/reenable is recorded here so plan definitions have
-- the same operational traceability as policies and entitlement transitions.
CREATE TABLE IF NOT EXISTS catalog_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('feature', 'plan', 'plan_feature')),
  entity_id   TEXT NOT NULL,
  project     TEXT NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN ('create', 'update', 'disable', 'reenable')),
  actor       TEXT NOT NULL DEFAULT '',
  actor_type  TEXT NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source      TEXT NOT NULL DEFAULT 'admin',
  reason      TEXT NOT NULL DEFAULT '',
  request_id  TEXT NOT NULL DEFAULT '',
  prev_json   TEXT NOT NULL DEFAULT '',
  next_json   TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalog_events_entity
  ON catalog_events(entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_events_project
  ON catalog_events(project, created_at DESC);
