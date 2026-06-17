// db-sqlite.mjs
//
// A standard-SQLite (better-sqlite3) adapter that implements the SAME tiny
// surface the licensecc Worker expects from its `DB` binding, so the Worker's
// security code (src/index.ts) runs OFF Cloudflare with ZERO changes.
//
// The contract the Worker actually uses (verbatim from src/index.ts, lines 9-17):
//
//   export interface D1PreparedStatementLike {
//     bind(...values: unknown[]): D1PreparedStatementLike;
//     first<T = unknown>(): Promise<T | null>;
//     run(): Promise<unknown>;
//   }
//   export interface D1DatabaseLike {
//     prepare(sql: string): D1PreparedStatementLike;
//   }
//
// The verify path issues exactly four statements:
//   1. INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING request_count   -> .first()
//   2. DELETE FROM rate_limit_counters WHERE expires_at < ?               -> .run()
//   3. SELECT ... FROM entitlements ... LIMIT 1                           -> .first()
//   4. SELECT ... FROM entitlement_devices ... LIMIT 1                    -> .first()
//
// Contract notes that are load-bearing for the Worker's try/catch behaviour:
//   * .first() resolves to the row object, or `null` when there is no row.
//     `null` is the legitimate "no entitlement / unknown device" outcome and is
//     NOT an error. (index.ts lines 720-738, 826-849.)
//   * On a REAL query failure, the promise must REJECT (throw an Error) so the
//     Worker's catch maps it to HTTP 500 `verification_error`.
//   * .run() return value is never inspected by the Worker. `.all()` /
//     `.meta` / `.changes` / `.last_row_id` are NOT read anywhere in index.ts.
//     We still expose `.all()` and `.meta` (minimal) for completeness so the
//     same adapter can back the admin/CLI tooling if reused.
//
// better-sqlite3 is synchronous; we wrap every result in Promise.resolve(...)
// to honour the async D1 contract the Worker awaits.

import Database from "better-sqlite3";

class SqlitePreparedStatement {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {string} sql
   */
  constructor(db, sql) {
    this._db = db;
    this._sql = sql;
    this._params = [];
    // Prepare lazily inside the result methods so that a SQL-compile error
    // surfaces as a REJECTED promise from .first()/.all()/.run() (matching D1's
    // throw-on-failure contract) rather than synchronously at .prepare() time.
  }

  /**
   * Chainable bind, exactly like D1. Returns `this` (a D1PreparedStatementLike).
   * @param  {...unknown} values
   * @returns {SqlitePreparedStatement}
   */
  bind(...values) {
    // D1/SQLite bind positional params. better-sqlite3 rejects `undefined`
    // bind values; the Worker only ever binds defined scalars to the four
    // verify statements, but normalize defensively to keep the throw-surface
    // limited to genuine query failures.
    this._params = values.map((v) => (v === undefined ? null : v));
    return this;
  }

  /** @returns {import("better-sqlite3").Statement} */
  _statement() {
    return this._db.prepare(this._sql);
  }

  /**
   * Resolve to the first row, or null when there is no row.
   * REJECTS on a real query/compile error.
   * @template T
   * @returns {Promise<T | null>}
   */
  first() {
    try {
      const stmt = this._statement();
      // The Worker only calls .first() on SELECTs and on the `INSERT ... ON
      // CONFLICT ... RETURNING request_count` upsert — both DO return data, so
      // .get() is the right call. better-sqlite3's `reader` flag is true for
      // SELECT and for RETURNING statements and false for a plain INSERT/DELETE;
      // we branch on it. As a version-independent safety net, if .get() ever
      // throws the specific "does not return data" error (a non-returning
      // statement reached .first()), we fall back to .run() and yield null,
      // preserving "no row" semantics instead of surfacing a spurious error.
      if (stmt.reader) {
        const row = stmt.get(...this._params);
        return Promise.resolve(row === undefined ? null : row);
      }
      try {
        const row = stmt.get(...this._params);
        return Promise.resolve(row === undefined ? null : row);
      } catch (getError) {
        if (getError instanceof TypeError && /does not return data/i.test(getError.message)) {
          stmt.run(...this._params);
          return Promise.resolve(null);
        }
        throw getError;
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * D1 `.all()` shape: { results, success, meta }. The Worker's verify path
   * never calls this; provided so the adapter can back other tooling.
   * REJECTS on a real query error.
   * @returns {Promise<{ results: unknown[], success: true, meta: { changes: number, last_row_id: number } }>}
   */
  all() {
    try {
      const stmt = this._statement();
      if (stmt.reader) {
        const results = stmt.all(...this._params);
        return Promise.resolve({
          results,
          success: true,
          meta: { changes: 0, last_row_id: 0 },
        });
      }
      const info = stmt.run(...this._params);
      return Promise.resolve({
        results: [],
        success: true,
        meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Execute a write. The Worker ignores the return value of .run(); we still
   * return a D1-shaped object ({ success, meta }) for parity with other tooling.
   * REJECTS on a real query error.
   * @returns {Promise<{ success: true, meta: { changes: number, last_row_id: number } }>}
   */
  run() {
    try {
      const stmt = this._statement();
      const info = stmt.run(...this._params);
      return Promise.resolve({
        success: true,
        meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export class SqliteD1Adapter {
  /**
   * @param {import("better-sqlite3").Database} db an open better-sqlite3 handle
   */
  constructor(db) {
    this._db = db;
  }

  /**
   * @param {string} sql
   * @returns {SqlitePreparedStatement}
   */
  prepare(sql) {
    return new SqlitePreparedStatement(this._db, sql);
  }
}

/**
 * Open a better-sqlite3 database file and return both the raw handle and a
 * D1-shaped adapter over it. Sets the PRAGMAs the host relies on.
 *
 * @param {string} path filesystem path to the SQLite database
 * @param {{ readonly?: boolean }} [options]
 * @returns {{ db: import("better-sqlite3").Database, adapter: SqliteD1Adapter }}
 */
export function openDatabase(path, options = {}) {
  const db = new Database(path, { readonly: options.readonly === true });
  // Enforce the schema's FK relationships (entitlement_devices -> entitlements).
  db.pragma("foreign_keys = ON");
  // WAL: concurrent reads + a single writer; matches a small online verifier.
  db.pragma("journal_mode = WAL");
  return { db, adapter: new SqliteD1Adapter(db) };
}

export default SqliteD1Adapter;
