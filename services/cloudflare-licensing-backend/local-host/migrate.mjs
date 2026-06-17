// migrate.mjs
//
// Applies the REAL Worker migrations (0001..0008) in order to a standard
// SQLite database file, producing a schema byte-for-byte equivalent to the
// final state asserted by the schema-parity contract (schema.sql ==
// migrations/0001..0008, enforced by scripts/check-schema-parity.py).
//
// We deliberately apply the migrations (not schema.sql) so the local DB is
// produced by the exact same DDL path wrangler uses for D1. schema.sql remains
// the source of truth for parity, but the migrations are what D1 actually runs.
//
// Usage:
//   node migrate.mjs <db-path>
//   node migrate.mjs app.db
//
// Idempotent: each migration is recorded in a `_migrations` ledger and skipped
// if already applied. All migration files are plain SQL (DDL + data-copy); none
// use wrangler dot-commands, so a single db.exec() per file is sufficient.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
// local-host/ lives inside the backend service dir; migrations are one level up.
const MIGRATIONS_DIR = resolve(__dirname, "..", "migrations");

function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort(); // zero-padded numeric prefixes sort lexicographically in order.
}

function ensureLedger(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (" +
      "  name TEXT PRIMARY KEY," +
      "  applied_at INTEGER NOT NULL" +
      ")",
  );
}

function appliedSet(db) {
  const rows = db.prepare("SELECT name FROM _migrations").all();
  return new Set(rows.map((r) => r.name));
}

function main() {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("usage: node migrate.mjs <db-path>");
    process.exit(2);
  }

  const db = new Database(resolve(dbPath));
  // During migrations, leave FK enforcement OFF: the table-rebuild migrations
  // (e.g. 0005) DROP/RENAME tables, which is the SQLite-recommended pattern and
  // requires foreign_keys to be off to be safe. There is no data yet on a fresh
  // DB, but this also makes re-running against a populated DB safe.
  db.pragma("foreign_keys = OFF");
  db.pragma("journal_mode = WAL");

  ensureLedger(db);
  const already = appliedSet(db);

  const record = db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");
  const now = Math.floor(Date.now() / 1000);

  let appliedCount = 0;
  for (const name of listMigrations()) {
    if (already.has(name)) {
      console.log(`skip   ${name} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      record.run(name, now);
    });
    apply();
    appliedCount += 1;
    console.log(`apply  ${name}`);
  }

  // Re-enable FK enforcement for any subsequent use of this handle.
  db.pragma("foreign_keys = ON");
  db.close();

  console.log(`done: ${appliedCount} migration(s) applied to ${resolve(dbPath)}`);
}

main();
