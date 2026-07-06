// Node SQLite adapter for the licensecc D1-shaped DB contract.
//
// This module is Node-only and intentionally lives outside src/ so it is never bundled into
// Cloudflare Workers. It lets local hosts, scripts, and tests run against a plain SQLite file while
// preserving the Worker-facing D1 surface: prepare().bind().first/all/run, batch(), and withSession().

import { existsSync, rmSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

function normalizeParam(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function metaFromRun(info) {
  return {
    changes: Number(info?.changes ?? 0),
    last_row_id: Number(info?.lastInsertRowid ?? 0),
  };
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

export class SqlitePreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...values) {
    const next = new SqlitePreparedStatement(this.db, this.sql);
    next.params = values.map(normalizeParam);
    return next;
  }

  statement() {
    return this.db.prepare(this.sql);
  }

  async first() {
    try {
      const row = this.statement().get(...this.params);
      return row === undefined ? null : row;
    } catch (error) {
      throw asError(error);
    }
  }

  async all() {
    try {
      return {
        results: this.statement().all(...this.params),
        success: true,
        meta: { changes: 0, last_row_id: 0 },
      };
    } catch (error) {
      throw asError(error);
    }
  }

  async run() {
    try {
      return {
        success: true,
        meta: metaFromRun(this.statement().run(...this.params)),
      };
    } catch (error) {
      throw asError(error);
    }
  }
}

export class SqliteD1Adapter {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new SqlitePreparedStatement(this.db, sql);
  }

  withSession() {
    return this;
  }

  async batch(statements) {
    const out = [];
    this.db.exec("BEGIN");
    try {
      for (const statement of statements) {
        out.push(await statement.all());
      }
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw asError(error);
    }
  }
}

export function listMigrations(migrationsDir) {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
}

function ensureLedger(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (" +
      "name TEXT PRIMARY KEY, " +
      "applied_at INTEGER NOT NULL" +
      ")",
  );
}

function appliedSet(db) {
  return new Set(db.prepare("SELECT name FROM _migrations").all().map((row) => row.name));
}

export function applyMigrations(db, migrationsDir, options = {}) {
  const now = Math.floor(Date.now() / 1000);
  const migrations = listMigrations(migrationsDir);
  const applied = [];
  const skipped = [];

  db.exec("PRAGMA foreign_keys = OFF");
  ensureLedger(db);
  const already = options.force === true ? new Set() : appliedSet(db);
  const record = db.prepare("INSERT OR REPLACE INTO _migrations (name, applied_at) VALUES (?, ?)");

  try {
    for (const name of migrations) {
      if (already.has(name)) {
        skipped.push(name);
        continue;
      }
      const sql = readFileSync(join(migrationsDir, name), "utf8");
      db.exec("BEGIN");
      try {
        db.exec(sql);
        record.run(name, now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      applied.push(name);
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  return { applied, skipped };
}

export function openDatabase(path, options = {}) {
  const dbPath = path === ":memory:" ? path : resolve(path);
  if (options.reset === true && dbPath !== ":memory:" && existsSync(dbPath)) {
    rmSync(dbPath, { force: true });
  }
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath, { readOnly: options.readonly === true });
  if (options.readonly !== true) {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
  }
  return { db, adapter: new SqliteD1Adapter(db), path: dbPath };
}

export function createLocalSqliteDb(options = {}) {
  const migrationsDir = options.migrationsDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const opened = openDatabase(options.path ?? ":memory:", { reset: options.reset === true, readonly: options.readonly === true });
  if (options.migrate !== false && options.readonly !== true) {
    opened.migrations = applyMigrations(opened.db, migrationsDir);
  }
  return opened;
}

export default SqliteD1Adapter;
