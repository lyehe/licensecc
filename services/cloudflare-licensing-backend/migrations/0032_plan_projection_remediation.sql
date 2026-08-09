-- 0031 is reserved for the concurrently landing catalog-import protocol.
--
-- Projection preview capabilities are consumed within their fixed five-minute
-- lifetime, so one `(expires_at, id)` range serves lazy retention for both
-- expired and consumed rows. Do not reintroduce an OR over independent
-- indexes here: it defeats the bounded range plan below.
DROP INDEX IF EXISTS idx_license_plan_projection_previews_consumed;
DROP INDEX IF EXISTS idx_license_plan_projection_previews_expiry;

CREATE INDEX IF NOT EXISTS idx_license_plan_projection_previews_expiry_id
  ON license_plan_projection_previews(expires_at, id);

-- Catalog events cannot represent a license-plan assignment (their constrained
-- entity/event grammars cover feature/plan/plan_feature only). Keep a separate
-- append-only history so assignment-only plan projection transitions are as
-- durable and attributable as concrete entitlement mutations. There is no FK
-- to the current assignment because this is a historical record, not a child
-- that should disappear if an assignment is retired.
CREATE TABLE IF NOT EXISTS license_plan_assignment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id TEXT NOT NULL,
  project TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('create', 'update')),
  actor TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source TEXT NOT NULL DEFAULT 'admin',
  request_id TEXT NOT NULL DEFAULT '',
  prev_json TEXT NOT NULL DEFAULT '',
  next_json TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_license_plan_assignment_events_assignment
  ON license_plan_assignment_events(license_id, project, id DESC);
