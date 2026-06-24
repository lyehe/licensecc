-- Operations back-office Slice 1: signed, exactly-once order-ingest (POST /v1/orders).
-- Design: docs/superpowers/plans/2026-06-23-operations-back-office-architecture.md (Slice 1).
--
--   orders               = the subscription -> license_fingerprint identity home (D6)
--                          plus the per-subscription monotonic ACCEPT cursor
--                          (order_epoch, last_seq). A fingerprint belongs to exactly
--                          one subscription per (project, feature) -- the UNIQUE index
--                          below is the cross-tenant-hijack guard.
--   order_events         = the inbox: global dedup on the provider event_id, crash-safe
--                          redrive (raw_payload + status), and the cached HTTP result.
--   order_ingest_nonces  = HMAC in-skew replay/flood guard (clone of 0009's nonce table).
--
-- entitlements gains the APPLY-time monotonic floor (last_applied_order_epoch/_seq) so a
-- stale or replayed order can never regress a newer already-applied state; the apply
-- upsert is guarded on this floor and commits its processed-mark in the same transaction.

CREATE TABLE IF NOT EXISTS orders (
  subscription_id     TEXT NOT NULL,
  project             TEXT NOT NULL,
  feature             TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  customer_id         TEXT NULL,
  license_id          TEXT NULL,
  last_seq            INTEGER NOT NULL DEFAULT 0,
  order_epoch         INTEGER NOT NULL DEFAULT 0,
  fingerprint_origin  TEXT NOT NULL DEFAULT 'derived' CHECK (fingerprint_origin IN ('derived', 'supplied')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, project, feature)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_fp_unique
  ON orders(project, feature, license_fingerprint);

CREATE TABLE IF NOT EXISTS order_events (
  event_id        TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  project         TEXT NOT NULL,
  feature         TEXT NOT NULL,
  order_epoch     INTEGER NOT NULL,
  seq             INTEGER NOT NULL,
  intent          TEXT NOT NULL,
  key_id          TEXT NOT NULL,
  payload_digest  TEXT NOT NULL,
  raw_payload     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('accepted', 'processed', 'superseded', 'rejected')),
  result_json     TEXT NOT NULL DEFAULT '',
  received_at     INTEGER NOT NULL,
  processed_at    INTEGER NULL,
  PRIMARY KEY (event_id)
);

CREATE INDEX IF NOT EXISTS idx_order_events_sub_seq
  ON order_events(subscription_id, project, feature, order_epoch, seq);

CREATE INDEX IF NOT EXISTS idx_order_events_unprocessed
  ON order_events(subscription_id, project, feature, status);

CREATE TABLE IF NOT EXISTS order_ingest_nonces (
  key_id      TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (key_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_order_ingest_nonces_expires_at
  ON order_ingest_nonces(expires_at);

ALTER TABLE entitlements ADD COLUMN last_applied_order_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entitlements ADD COLUMN last_applied_order_epoch INTEGER NOT NULL DEFAULT 0;
