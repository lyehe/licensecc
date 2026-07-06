-- Operations back-office Slice 3: customer-portal email-OTP / magic-link + sessions.
-- Design: docs/superpowers/plans/2026-06-24-slice3-customer-portal-blueprint.md.
-- Owned by the backend migrations dir (one entitlements DB, no split-brain — the portal Worker
-- binds the SAME D1). Secrets are stored as keyed HMAC (pepper_key_id-versioned), NEVER plaintext
-- (mirrors account_tokens, 0015). Single-use via the atomic consumed_at claim (request_proof_nonces,
-- 0009). Short TTL, swept by scheduled().

CREATE TABLE IF NOT EXISTS portal_otp (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  email_lower   TEXT NOT NULL,
  secret_hmac   TEXT NOT NULL,
  code_hmac     TEXT NOT NULL,
  pepper_key_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  consumed_at   INTEGER NULL,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_otp_secret ON portal_otp(secret_hmac);
CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_otp_code ON portal_otp(code_hmac);
CREATE INDEX IF NOT EXISTS idx_portal_otp_expires ON portal_otp(expires_at);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT NOT NULL,
  session_hmac     TEXT NOT NULL,
  pepper_key_id    TEXT NOT NULL,
  account_token_id TEXT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  user_agent       TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  last_used_at     INTEGER NULL,
  expires_at       INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (account_token_id) REFERENCES account_tokens(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_sessions_hmac ON portal_sessions(session_hmac);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_customer ON portal_sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_expires ON portal_sessions(expires_at);

CREATE TABLE IF NOT EXISTS portal_bootstrap_events (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  email_lower TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_bootstrap_customer ON portal_bootstrap_events(customer_id);
