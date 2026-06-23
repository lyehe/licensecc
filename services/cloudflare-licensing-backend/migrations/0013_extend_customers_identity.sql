-- Operations back-office Slice 0: extend `customers` into the one identity table.
-- Adds account status + the operator/CRM external reference, and makes email a
-- UNIQUE key so a portal magic-link / OTP login resolves to exactly one customer.
--
-- `customers` is empty scaffolding today (no code path writes it yet), so the
-- unique index cannot collide with existing rows. The index is PARTIAL on
-- `email <> ''` because `email` defaults to '' (NOT NULL DEFAULT '') — multiple
-- customers may legitimately have no email, and those blanks must not collide.
--
-- Implemented as a table REBUILD rather than ALTER ADD COLUMN so the serialized
-- CREATE TABLE in sqlite_schema stays clean (no ALTER text-splice artifacts) and
-- matches the hand-written schema.sql snapshot byte-for-byte under the parity
-- checker's normalization. The data copy is defensive; the table is empty today.

CREATE TABLE customers_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  external_ref TEXT NOT NULL DEFAULT ''
);

INSERT INTO customers_new (id, name, email, metadata_json, created_at, updated_at)
  SELECT id, name, email, metadata_json, created_at, updated_at FROM customers;

DROP TABLE customers;
ALTER TABLE customers_new RENAME TO customers;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email
  ON customers(email)
  WHERE email <> '';
