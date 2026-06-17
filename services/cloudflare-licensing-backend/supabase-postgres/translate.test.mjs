// Unit tests for the D1 -> PostgreSQL SQL translation (the { workerSql: true } path).
// Pure — no driver/DB needed:  node --test translate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { translateWorkerSqlToPg } from "./sql-translate.mjs";

test("? -> $1..$n positionally", () => {
  assert.equal(
    translateWorkerSqlToPg("SELECT a FROM t WHERE x = ? AND y = ? AND z = ?"),
    "SELECT a FROM t WHERE x = $1 AND y = $2 AND z = $3",
  );
});

test("? inside a single-quoted string literal is left alone", () => {
  assert.equal(
    translateWorkerSqlToPg("SELECT a FROM t WHERE label = 'huh?' AND id = ?"),
    "SELECT a FROM t WHERE label = 'huh?' AND id = $1",
  );
});

test("'' escape keeps us in-string (a ? after it stays literal)", () => {
  assert.equal(
    translateWorkerSqlToPg("SELECT 'O''Brien?' AS n, ? AS id"),
    "SELECT 'O''Brien?' AS n, $1 AS id",
  );
});

test("rate-limit upsert: ?->$n AND the self-ref increment is table-qualified", () => {
  const out = translateWorkerSqlToPg(
    "INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(namespace, rate_key, window_start) DO UPDATE SET request_count = request_count + 1, expires_at = excluded.expires_at, updated_at = excluded.updated_at RETURNING request_count",
  );
  assert.match(out, /VALUES \(\$1, \$2, \$3, 1, \$4, \$5\)/);
  assert.match(out, /SET request_count = rate_limit_counters\.request_count \+ 1/);
  assert.match(out, /excluded\.expires_at/); // excluded refs untouched
  assert.match(out, /RETURNING request_count$/); // RETURNING's request_count NOT qualified
  assert.doesNotMatch(out, /\?/);
});

test("plain SELECT: no self-ref qualification", () => {
  assert.equal(
    translateWorkerSqlToPg("SELECT x FROM t WHERE a = ? AND b = ?"),
    "SELECT x FROM t WHERE a = $1 AND b = $2",
  );
});

test("self-ref OUTSIDE the SET clause (in WHERE) is NOT qualified", () => {
  const out = translateWorkerSqlToPg(
    "INSERT INTO t (id) VALUES (?) ON CONFLICT (id) DO UPDATE SET n = n + 1 WHERE t.flag = flag",
  );
  assert.match(out, /SET n = t\.n \+ 1/); // SET self-ref qualified
  assert.match(out, /WHERE t\.flag = flag/); // WHERE self-ref left alone (scoped)
});
