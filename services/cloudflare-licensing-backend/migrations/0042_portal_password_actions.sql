-- Pending email ownership proofs. Raw tokens and proposed passwords are never stored.
-- customer_id is preallocated for registration, so it intentionally has no FK.
CREATE TABLE portal_password_actions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'reset')),
  email_lower TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  credential_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  claim TEXT,
  CHECK (expires_at > created_at),
  CHECK ((purpose = 'register' AND credential_hash IS NULL) OR (purpose = 'reset' AND credential_hash IS NOT NULL))
);
CREATE INDEX idx_portal_password_actions_expiry ON portal_password_actions(expires_at);
