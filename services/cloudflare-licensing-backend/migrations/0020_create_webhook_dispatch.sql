-- Webhook dispatcher: a strictly READ-SIDE, cron-drained transactional outbox over the EXISTING
-- audit tables (entitlement_events, customer_events, order_events). The dispatcher NEVER modifies
-- any mutator/event-write path; it only READS those logs, ENQUEUEs one delivery per (endpoint,
-- event) into webhook_deliveries (the UNIQUE makes a re-run a no-op = exactly-once), then DELIVERs
-- pending rows with an HMAC-signed POST + exponential backoff. Emission is UNMETERED: it runs ONLY
-- in scheduled() (the cron), never inline / waitUntil.
--
-- Signing keys live ONLY in a Worker-env map (WEBHOOK_SIGNING_SECRETS, JSON {keyId: base64secret}),
-- mirroring ORDER_HMAC_SECRETS — NO plaintext secret is ever stored in D1 (the repo forbids it).

-- event_types is a csv filter; '' = all event types.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id          TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  event_types TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  description TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_status ON webhook_endpoints(status);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id     TEXT NOT NULL,
  event_source    TEXT NOT NULL CHECK (event_source IN ('entitlement', 'customer', 'order')),
  event_id        INTEGER NOT NULL,
  event_type      TEXT NOT NULL DEFAULT '',
  payload_json    TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_status     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT NOT NULL DEFAULT '',
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER NULL,
  UNIQUE (endpoint_id, event_source, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries(status, next_attempt_at);

-- Per-source high-water mark of the LAST event id enqueued. The enqueue pass reads events with
-- id > last_id (bounded) and advances last_id to the max id it enqueued, so each event is offered
-- to every endpoint exactly once. (For order_events, whose PK is a TEXT event_id, the dispatcher
-- cursors on the implicit monotonic rowid — see src/webhooks/webhook.mjs.)
CREATE TABLE IF NOT EXISTS webhook_cursor (
  event_source TEXT PRIMARY KEY,
  last_id      INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
