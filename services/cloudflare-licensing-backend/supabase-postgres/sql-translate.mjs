// sql-translate.mjs
//
// Pure (no-dependency) translation of the UNMODIFIED Worker's D1/SQLite SQL to PostgreSQL.
// Lives in its own module so it is unit-testable without the `postgres` driver. Used by
// db-postgres.mjs's adapter only when constructed with { workerSql: true }; the CLI path
// (pg-sql.mjs) already emits native PG SQL and never calls this.
//
// Two transforms, scoped to the Worker's verify-path statements (it is NOT a general SQL
// parser): (1) `?` -> `$1..$n`, skipping `?` inside single-quoted string literals; and
// (2) a bare self-referential ON CONFLICT counter update (`col = col + 1`) -> table-qualified
// (`col = <insert-target>.col + 1`), scoped to the DO UPDATE SET clause, because PostgreSQL
// rejects the bare form there as ambiguous (existing row vs `excluded`).

/**
 * @param {string} sql  D1/SQLite SQL emitted by the compiled Worker.
 * @returns {string}    PostgreSQL-compatible SQL.
 */
export function translateWorkerSqlToPg(sql) {
  // 1. `?` -> `$1..$n`, SKIPPING `?` inside single-quoted string literals (so a literal `?`
  //    in a value is never turned into a placeholder). `''` is the SQL escape for a quote
  //    inside a string and keeps us in-string.
  let i = 0;
  let out = "";
  let inString = false;
  for (let k = 0; k < sql.length; k++) {
    const ch = sql[k];
    if (ch === "'") {
      if (inString && sql[k + 1] === "'") { out += "''"; k++; continue; } // escaped quote, stay in-string
      inString = !inString;
      out += ch;
    } else if (ch === "?" && !inString) {
      out += "$" + String(++i);
    } else {
      out += ch;
    }
  }
  // 2. Qualify a bare self-referential update (`col = col ...`) with the insert-target table,
  //    SCOPED to the `ON CONFLICT ... DO UPDATE SET` clause only (up to WHERE/RETURNING/end),
  //    so a `col = col` appearing anywhere else (a WHERE predicate, a value) is never touched.
  const insertTarget = out.match(/INSERT\s+INTO\s+("?\w+"?)/i);
  if (insertTarget) {
    out = out.replace(
      /(\bDO\s+UPDATE\s+SET\b)([\s\S]*?)(\bWHERE\b|\bRETURNING\b|;|\s*$)/i,
      (_m, kw, body, tail) => kw + body.replace(/\b(\w+)\s*=\s*\1\b/g, `$1 = ${insertTarget[1]}.$1`) + tail,
    );
  }
  return out;
}
