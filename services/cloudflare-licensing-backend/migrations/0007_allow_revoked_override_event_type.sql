DROP INDEX IF EXISTS idx_entitlement_events_lookup;
DROP INDEX IF EXISTS idx_entitlement_events_actor;
DROP INDEX IF EXISTS idx_entitlement_events_request;

CREATE TABLE entitlement_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  device_hash TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL CHECK (event_type IN ('create', 'update', 'disable', 'reenable', 'revoke', 'upsert', 'revoked-override')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'disabled')),
  revocation_seq INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source TEXT NOT NULL DEFAULT 'admin',
  request_id TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  prev_json TEXT NOT NULL DEFAULT '',
  next_json TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO entitlement_events_new (
  id, project, feature, license_fingerprint, device_hash, event_type, status,
  revocation_seq, detail, actor, actor_type, source, request_id, ip, prev_json,
  next_json, reason, idempotency_key, created_at
)
SELECT
  id, project, feature, license_fingerprint, device_hash, event_type, status,
  revocation_seq, detail, actor, actor_type, source, request_id, ip, prev_json,
  next_json, reason, idempotency_key, created_at
FROM entitlement_events;

DROP TABLE entitlement_events;
ALTER TABLE entitlement_events_new RENAME TO entitlement_events;

CREATE INDEX IF NOT EXISTS idx_entitlement_events_lookup
  ON entitlement_events(project, feature, license_fingerprint, created_at);

CREATE INDEX IF NOT EXISTS idx_entitlement_events_actor
  ON entitlement_events(actor, created_at);

CREATE INDEX IF NOT EXISTS idx_entitlement_events_request
  ON entitlement_events(request_id);
