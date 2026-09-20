-- Login email is an unverified identifier, not a claim to customers.email or licenses.
CREATE TABLE portal_passwords (
  customer_id TEXT PRIMARY KEY NOT NULL REFERENCES customers(id),
  email_lower TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE portal_sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'legacy'
  CHECK (auth_method IN ('legacy', 'otp', 'oauth', 'password'));
