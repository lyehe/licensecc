-- Provider subjects are immutable identities. Email is contact data, never an account-link key.
CREATE TABLE portal_identities (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  subject TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (customer_id, provider)
);

CREATE TABLE portal_oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  link_session_id TEXT REFERENCES portal_sessions(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_portal_oauth_states_expires ON portal_oauth_states(expires_at);
