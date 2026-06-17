// db-postgres.mjs
//
// Drop-in PostgreSQL / Supabase adapter implementing the SAME tiny DB surface the
// licensing Worker consumes (D1DatabaseLike / D1PreparedStatementLike). Backed by
// `postgres.js` (the `postgres` npm package), a single long-lived connection pool.
//
// Surface the Worker actually uses (verified against src/index.ts -- nothing else exists):
//   db.prepare(sql)            -> a statement object
//   stmt.bind(...values)       -> chainable; returns the statement
//   stmt.first<T>()            -> Promise<T | null>     (row or null)
//   stmt.run()                 -> Promise<unknown>      (return value ignored by callers)
// We ALSO provide stmt.all() (Promise<T[]>) as requested, for tooling/CLI parity even
// though the verify path never calls it. There is NO .batch / .meta / .changes / .results.
//
// CONTRACT the Worker depends on (see index.ts try/catch at lines ~720 and ~826):
//   * A real query failure MUST reject/throw an Error  -> mapped to d1_error / HTTP 500.
//   * An empty result set MUST resolve to null (first) / [] (all), NOT throw
//     -> that is the legitimate "no row" / "unknown_device" / "no entitlement" outcome.
// postgres.js already rejects its query promise on SQL/connection errors and returns an
// empty result array for zero rows, so we map result[0] -> (row ?? null) and let errors
// propagate. We do NOT swallow errors anywhere.
//
// BIGINT (int8) HANDLING -- a faithfulness hardening, not a behavior change:
//   postgres.js returns BIGINT (int8, OID 20) columns as JavaScript STRINGS by default
//   (to avoid silently truncating values above Number.MAX_SAFE_INTEGER). schema.pg.sql
//   widens revocation_seq, assertion_ttl_seconds, cache_ttl_seconds, request_count,
//   valid_from/valid_until (and the epoch/counter columns) to BIGINT. The Worker's verify
//   path happens to survive string int8s only by incidental coercion downstream:
//     - request_count via Number(row?.request_count ?? 0)            (index.ts:308)
//     - valid_from/valid_until via boundedTime()'s Number(value)     (index.ts:625)
//     - assertion_ttl_seconds/cache_ttl_seconds via Math.min/Math.max (index.ts:850,853)
//     - revocation_seq is NEVER compared numerically: it is only string-interpolated into
//       the canonical assertion payload (`revocation-seq=${claims.revocationSeq}`,
//       index.ts:493) and logged -- so a string '0' yields byte-identical signed text.
//   That "survives by coincidence" is fragile. We remove the fragility by installing an
//   int8 type parser so BIGINT columns arrive as JS numbers, matching D1/better-sqlite3
//   (which returns INTEGER columns as numbers). All widened columns here hold unix seconds
//   or small counters/sequences -- comfortably within Number.MAX_SAFE_INTEGER (2^53-1,
//   year ~285616 in unix seconds) -- so Number is exact and faithful. If a value ever
//   exceeded the safe range we keep it as a string rather than silently truncate, so the
//   parser is strictly safer than postgres.js's default for this schema, never worse.
//
// PLACEHOLDER POLICY (chosen and consistent): callers MUST pass Postgres-native numbered
// placeholders ($1, $2, ...). We do NOT translate `?` -> `$n`. Rationale:
//   - The ground-truth statements have been ported to $1..$n in statements.pg.sql, so the
//     Worker's DB strings are updated alongside this adapter (this is a data-layer port,
//     not a runtime SQL rewriter).
//   - A naive `?`->`$n` rewriter is unsafe: it would also rewrite `?` inside string
//     literals. Requiring $n keeps the adapter a thin, predictable pass-through.
// The compiled Worker (src/index.ts), however, emits D1/SQLite SQL: `?` placeholders AND a
// bare self-referential ON CONFLICT counter update (`request_count = request_count + 1`).
// To run the UNMODIFIED Worker on Postgres, pass `{ workerSql: true }` to
// createPostgresDatabase(): the adapter translates the Worker's verify-path statements to
// PG at prepare() time (see translateWorkerSqlToPg below). The CLI keeps the default (no
// translation) -- pg-sql.mjs already emits native PG SQL ($n, qualified upsert).
//
// WHY postgres.js (raw SQL) and NOT @supabase/supabase-js (PostgREST query builder):
//   The load-bearing statement is the rate-limit counter upsert:
//       INSERT ... ON CONFLICT (...) DO UPDATE SET request_count = request_count + 1 ... RETURNING request_count
//   That is an atomic read-modify-write expressed as a single SQL statement. The PostgREST
//   builder behind @supabase/supabase-js cannot express `request_count = request_count + 1`
//   (a column-relative update) in an upsert -- .upsert() can only set literal/known values,
//   so an increment requires read-then-write (a race) or a separate RPC/stored function.
//   It also cannot cleanly express `ON CONFLICT ... DO UPDATE ... WHERE <guard>` or the
//   `RETURNING request_count` we read via .first(). postgres.js runs the exact SQL verbatim,
//   preserving the atomic semantics the rate limiter relies on. We therefore use raw SQL.
//
// USAGE (wire into the Worker / Node host):
//   import { createPostgresDatabase } from "./db-postgres.mjs";
//   const DB = createPostgresDatabase(process.env.DATABASE_URL); // one pool at startup
//   const env = { DB, /* ...other Env fields... */ };
//   // env.DB is a D1DatabaseLike; handleVerify(request, env) works unchanged.

import postgres from "postgres";

// PostgreSQL type OID for BIGINT / int8. Used by the type parser below so BIGINT columns
// are returned as JS numbers (matching D1/SQLite) instead of postgres.js's default string.
const PG_OID_INT8 = 20;

/**
 * Parse a Postgres int8 (BIGINT) text value into a JS number when it is exactly
 * representable, else fall back to the original string. NEVER truncates silently:
 * out-of-safe-range magnitudes keep their string form (postgres.js's default), so this
 * parser is strictly safer than the default for this schema and never loses precision.
 * @param {string} value  the raw text value postgres.js hands us for an int8 column
 * @returns {number | string}
 */
function parseInt8(value) {
  // null is handled by postgres.js before the parser is invoked; value is always a string.
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value;
}

/**
 * Translate the UNMODIFIED Worker's D1/SQLite SQL to PostgreSQL. Enabled ONLY via
 * createPostgresDatabase(..., { workerSql: true }); the CLI (pg-sql.mjs) emits native PG SQL
 * and never triggers this. Two transforms, scoped to the Worker's verify-path statements:
 *   1. `?` positional placeholders -> `$1..$n` (the statements contain no `?` inside string
 *      literals, so a positional pass is safe; this is intentionally NOT a general parser).
 *   2. A bare self-referential ON CONFLICT update (`col = col + 1`) -> the table-qualified
 *      `col = <insert-target>.col + 1`. PostgreSQL rejects the bare form as ambiguous (the
 *      existing row AND `excluded` both expose the column); the qualified form is the
 *      existing row's value -- the atomic increment the rate limiter relies on. (D1/SQLite
 *      accepts the bare form, which is why the Worker uses it.)
 * @param {string} sql
 * @returns {string}
 */
function translateWorkerSqlToPg(sql) {
  let i = 0;
  let out = sql.replace(/\?/g, () => `$${++i}`);
  const insertTarget = out.match(/INSERT\s+INTO\s+("?\w+"?)/i);
  if (insertTarget && /\bON\s+CONFLICT\b/i.test(out)) {
    out = out.replace(/\b(\w+)\s*=\s*\1\b/g, `$1 = ${insertTarget[1]}.$1`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Single long-lived connection pool, created once at startup (module-level singleton).
// Supabase note: for serverless / edge, point DATABASE_URL at the Supabase *pooler*
// (port 6543, transaction mode) and keep `prepare: false` so server-side prepared
// statements do not leak across pooled connections. For a long-running Node process you
// may use the direct connection (port 5432) and leave prepared statements enabled.
// ---------------------------------------------------------------------------------------
let sharedPool = null;

/**
 * Create (once) and return the shared postgres.js pool.
 * @param {string} connectionString  Supabase/Postgres connection URL.
 * @param {import("postgres").Options<{}>} [options]  Extra postgres.js options (merged).
 * @returns {ReturnType<typeof postgres>}
 */
export function createPool(connectionString, options = {}) {
  if (sharedPool) {
    return sharedPool;
  }
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error("createPool: a Postgres connection string is required");
  }
  const { types: callerTypes, ...restOptions } = options;
  sharedPool = postgres(connectionString, {
    max: 10,                  // pool size; one long-lived pool for the process
    idle_timeout: 30,         // seconds before idle connections are released
    connect_timeout: 10,      // seconds to establish a connection before throwing
    prepare: false,           // safe default for transaction-mode poolers (Supabase 6543)
    // onnotice: () => {},    // (uncomment to silence NOTICE chatter)
    // BIGINT (int8) -> JS number parser. Removes the latent "survives by coincidence"
    // fragility where the Worker would otherwise receive int8 columns as strings and rely
    // on incidental downstream Number()/Math.min coercion (see the BIGINT HANDLING note
    // above). Caller-supplied `types` are merged on top so this never overrides an explicit
    // override the caller passes in.
    types: {
      bigint: {
        to: PG_OID_INT8,
        from: [PG_OID_INT8],
        serialize: (v) => v.toString(),
        parse: parseInt8,
      },
      ...(callerTypes ?? {}),
    },
    ...restOptions,
  });
  return sharedPool;
}

/**
 * Close the shared pool (tests / graceful shutdown). Resets the singleton.
 * @returns {Promise<void>}
 */
export async function closePool() {
  if (sharedPool) {
    const pool = sharedPool;
    sharedPool = null;
    await pool.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------------------
// D1PreparedStatementLike implementation.
// `prepare(sql)` captures the SQL; `bind(...)` captures positional params; `first/all/run`
// execute via pool.unsafe(sql, params) -- postgres.js's parameterized raw-SQL entry point
// ($1..$n placeholders, values bound positionally, server-side escaping). Errors reject;
// zero rows -> null/[]. NOTE on .bind() re-entrancy: each prepare() returns a fresh
// statement instance, mirroring D1, so binding is per-statement and not shared.
// ---------------------------------------------------------------------------------------
class PostgresPreparedStatement {
  /**
   * @param {ReturnType<typeof postgres>} pool
   * @param {string} sql  SQL using $1..$n placeholders.
   */
  constructor(pool, sql, rewrite = false) {
    /** @private */ this._pool = pool;
    /** @private */ this._sql = rewrite ? translateWorkerSqlToPg(sql) : sql;
    /** @private */ this._params = [];
  }

  /**
   * Bind positional parameters for $1..$n. Chainable, like D1.
   * @param {...unknown} values
   * @returns {PostgresPreparedStatement}
   */
  bind(...values) {
    this._params = values;
    return this;
  }

  /**
   * Execute and return the first row, or null when there are no rows.
   * Mirrors D1's .first<T>() -> Promise<T | null>. Rejects on query failure.
   * @template T
   * @returns {Promise<T | null>}
   */
  async first() {
    // pool.unsafe(sql, params) returns a result array (postgres.js Result is array-like).
    const rows = await this._pool.unsafe(this._sql, this._params);
    return rows.length > 0 ? /** @type {any} */ (rows[0]) : null;
  }

  /**
   * Execute and return all rows as a plain array (never null). Provided for tooling/CLI
   * parity; the verify path does not use it. Rejects on query failure.
   * @template T
   * @returns {Promise<T[]>}
   */
  async all() {
    const rows = await this._pool.unsafe(this._sql, this._params);
    // Return a plain array copy so callers cannot mutate postgres.js internal state.
    return /** @type {any} */ (Array.from(rows));
  }

  /**
   * Execute for side effects. Return value is intentionally opaque (callers ignore it),
   * matching D1's .run(): Promise<unknown>. Rejects on query failure.
   * @returns {Promise<unknown>}
   */
  async run() {
    return this._pool.unsafe(this._sql, this._params);
  }
}

// ---------------------------------------------------------------------------------------
// D1DatabaseLike implementation: only .prepare(sql).
// ---------------------------------------------------------------------------------------
class PostgresDatabase {
  /**
   * @param {ReturnType<typeof postgres>} pool
   * @param {boolean} [workerSql]  translate the D1/SQLite Worker's SQL to PG (see above)
   */
  constructor(pool, workerSql = false) {
    /** @private */ this._pool = pool;
    /** @private */ this._rewrite = workerSql === true;
  }

  /**
   * @param {string} sql  SQL using $1..$n placeholders (or `?` when rewriteQuestionMarks).
   * @returns {PostgresPreparedStatement}
   */
  prepare(sql) {
    if (typeof sql !== "string") {
      throw new TypeError("prepare(sql): sql must be a string");
    }
    return new PostgresPreparedStatement(this._pool, sql, this._rewrite);
  }
}

/**
 * Build a D1DatabaseLike backed by a single long-lived postgres.js pool.
 * Call ONCE at startup and reuse the returned object for every request (env.DB).
 *
 * @param {string} connectionString  Supabase/Postgres connection URL.
 * @param {import("postgres").Options<{}> & { workerSql?: boolean }} [options]
 *        Extra postgres.js options, plus `workerSql` to translate the compiled Worker's
 *        D1/SQLite SQL to PostgreSQL (pass `true` when wiring the Worker via server.mjs).
 * @returns {{ prepare(sql: string): PostgresPreparedStatement }}
 */
export function createPostgresDatabase(connectionString, options = {}) {
  const { workerSql = false, ...poolOptions } = options;
  const pool = createPool(connectionString, poolOptions);
  return new PostgresDatabase(pool, workerSql);
}

export { PostgresDatabase, PostgresPreparedStatement };
