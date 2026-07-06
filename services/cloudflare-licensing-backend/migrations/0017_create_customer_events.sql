-- Operations back-office Slice 4 (operator console): append-only audit for the customer
-- kill-switch. Design: docs/superpowers/plans/2026-06-24-slice4-operator-console-blueprint.md.
-- Toggling customers.status to 'disabled' instantly severs that customer's account-token auth
-- (resolveAccountToken JOINs customers c ON c.status='active') and portal login — the operator
-- suspension lever. Every transition is logged here (mirrors entitlement_events / account_token_events:
-- append-only, actor + actor_type + source + reason + request_id, never mutated).

CREATE TABLE IF NOT EXISTS customer_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN ('disable', 'reenable')),
  prev_status TEXT NOT NULL,
  next_status TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT '',
  actor_type  TEXT NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source      TEXT NOT NULL DEFAULT 'admin',
  reason      TEXT NOT NULL DEFAULT '',
  request_id  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_customer_events_customer ON customer_events(customer_id, created_at DESC);
