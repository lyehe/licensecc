-- Operations back-office Slice 2 (D9/D10): real per-customer account_token credentials +
-- account isolation, replacing the shared LEASE_ISSUE_BEARER placeholder.
-- Design: docs/superpowers/plans/2026-06-24-slice2-account-token-blueprint.md.
--
-- Tokens are stored as a KEYED HMAC (versioned by pepper_key_id), never plaintext and
-- never sha256(token+pepper). token_prefix is display-only and is NEVER a WHERE selector.

CREATE TABLE IF NOT EXISTS account_tokens (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  token_hmac TEXT NOT NULL,
  pepper_key_id TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  scopes_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'disabled')),
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NULL,
  replaced_by TEXT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (replaced_by) REFERENCES account_tokens(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_tokens_hmac ON account_tokens(token_hmac);
CREATE INDEX IF NOT EXISTS idx_account_tokens_customer ON account_tokens(customer_id);
CREATE INDEX IF NOT EXISTS idx_account_tokens_status ON account_tokens(status);

-- Per-customer monotonic revocation floor. Bumped on every revoke / revoke-customer / merge so a
-- replica-stale 'active' row is rejected once a process has seen a higher seq (within-isolate
-- optimization; the resolver also strong-reads when D1 Sessions are available).
CREATE TABLE IF NOT EXISTS account_token_revocations (
  customer_id TEXT PRIMARY KEY,
  revocation_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- Per-token audit. Separate table (not entitlement_events) so no CHECK migration on that table.
CREATE TABLE IF NOT EXISTS account_token_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_token_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('issue', 'rotate', 'revoke', 'revoke-customer', 'repepper', 'merge')),
  actor TEXT NOT NULL DEFAULT '',
  actor_type TEXT NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source TEXT NOT NULL DEFAULT 'admin',
  reason TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_token_events_token ON account_token_events(account_token_id);
CREATE INDEX IF NOT EXISTS idx_account_token_events_customer ON account_token_events(customer_id);

-- C3 backfill: link the trivially-derivable case (entitlement -> license -> customer). Entitlements
-- that remain NULL after this are the operator worklist (CLI `account-token link --list-orphans`);
-- under ACCOUNT_TOKEN_MODE=required a NULL-customer entitlement is fail-closed (no token can act on it).
UPDATE entitlements
SET customer_id = (SELECT l.customer_id FROM licenses l WHERE l.id = entitlements.license_id),
    updated_at = unixepoch()
WHERE customer_id IS NULL
  AND license_id IS NOT NULL
  AND (SELECT l.customer_id FROM licenses l WHERE l.id = entitlements.license_id) IS NOT NULL;
