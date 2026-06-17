// smoke-worker-sql.mjs
//
// Real-Postgres smoke for the VERIFY WORKER's data layer: drives the Worker's EXACT
// `?`-placeholder verify-path statements (src/index.ts:304/310/604/615) through the patched
// db-postgres.mjs adapter ({ workerSql: true }) against a live Postgres. This proves the
// adapter's Worker-SQL translation (`?` -> `$n`, and the bare ON CONFLICT counter update
// -> table-qualified) lets the UNMODIFIED Worker's SQL run on Postgres.
//
// Verified 2026-06-16 on PostgreSQL 16 (Docker): 7/7. (A full worker.fetch() end-to-end on
// the same engine -- signed lccoa1 assertion via dist/index.js + server.mjs -- also passed.)
//
// Run:
//   docker run -d --name pg -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=licensecc -p 5432:5432 postgres:16-alpine
//   psql "$DATABASE_URL" -f schema.pg.sql        # apply the schema
//   npm install --no-save postgres               # adapter runtime dep
//   DATABASE_URL=postgresql://postgres:smoke@localhost:5432/licensecc node smoke-worker-sql.mjs
import { createPostgresDatabase, closePool } from "./db-postgres.mjs";

const DB = createPostgresDatabase(
  process.env.DATABASE_URL || "postgresql://postgres:smoke@localhost:5432/licensecc",
  { workerSql: true },
);

let pass = 0, fail = 0;
const check = (n, c, g) => { if (c) { pass++; console.log("PASS  " + n + (g !== undefined ? "  => " + JSON.stringify(g) : "")); } else { fail++; console.log("FAIL  " + n + "  got " + JSON.stringify(g)); } };

// Verbatim from src/index.ts (the Worker's ? SQL; the adapter translates it for PG).
const RL_UPSERT = "INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(namespace, rate_key, window_start) DO UPDATE SET request_count = request_count + 1, expires_at = excluded.expires_at, updated_at = excluded.updated_at RETURNING request_count";
const RL_DELETE = "DELETE FROM rate_limit_counters WHERE expires_at < ?";
const ENT_SEL = "SELECT project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ? LIMIT 1";
const DEV_SEL = "SELECT device_key_id, public_key_spki_der_base64, status FROM entitlement_devices WHERE project = ? AND feature = ? AND license_fingerprint = ? AND device_key_id = ? LIMIT 1";
const SEED = "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

try {
  const now = Math.floor(Date.now() / 1000);
  const fp = "a".repeat(64);
  const key = "smoke-" + now; // unique rate-limit key so re-runs start clean
  // idempotent: clear the seed row
  await DB.prepare("DELETE FROM entitlements WHERE license_fingerprint = ?").bind(fp).run();

  let row = await DB.prepare(RL_UPSERT).bind("ns", key, now, now + 60, now).first();
  check("rate-limit upsert #1 -> request_count=1 (?->$n + ON CONFLICT RETURNING)", row && Number(row.request_count) === 1, row);
  row = await DB.prepare(RL_UPSERT).bind("ns", key, now, now + 60, now).first();
  check("rate-limit upsert #2 -> request_count=2 (atomic increment via qualified self-ref)", row && Number(row.request_count) === 2, row);

  await DB.prepare(RL_DELETE).bind(now - 1).run();
  check("cleanup DELETE via .run() executed (no throw)", true);

  await DB.prepare(SEED).bind("DEFAULT", "DEFAULT", fp, "", "active", 300, 3600, 0, now, now).run();
  row = await DB.prepare(ENT_SEL).bind("DEFAULT", "DEFAULT", fp).first();
  check("entitlement SELECT -> row, BIGINT cols as numbers", row && row.status === "active" && row.assertion_ttl_seconds === 300, row && { status: row.status, ttl: row.assertion_ttl_seconds, seq: row.revocation_seq });

  const miss = await DB.prepare(ENT_SEL).bind("DEFAULT", "DEFAULT", "b".repeat(64)).first();
  check("entitlement SELECT miss -> null (denial, not error)", miss === null, miss);

  const dmiss = await DB.prepare(DEV_SEL).bind("DEFAULT", "DEFAULT", fp, "sha256:x").first();
  check("device SELECT miss -> null", dmiss === null, dmiss);

  let threw = false;
  try { await DB.prepare("SELECT * FROM nope_table WHERE x = ?").bind(1).first(); } catch { threw = true; }
  check("bad query rejects (-> Worker maps to HTTP 500)", threw);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
} catch (e) {
  fail++; console.log("HARNESS ERROR: " + e.message);
} finally { await closePool(); }
process.exit(fail > 0 ? 1 : 0);
