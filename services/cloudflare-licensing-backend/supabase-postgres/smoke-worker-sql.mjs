// smoke-worker-sql.mjs
//
// Real-Postgres smoke for the VERIFY WORKER's data layer: drives the Worker's EXACT
// complete `?`-placeholder inventory from src/db/verify-statements.mjs through the
// db-postgres.mjs adapter ({ workerSql: true }) against a live Postgres. This proves the
// adapter's Worker-SQL translation (`?` -> `$n`, and the bare ON CONFLICT counter update
// -> table-qualified) lets the UNMODIFIED Worker's SQL run on Postgres.
//
// This is a current executable smoke, not a historical pass-count attestation. A scheduled
// or manual PostgreSQL 16 job supplies DATABASE_URL and applies schema.pg.sql before running it.
//
// Run:
//   docker run -d --name pg -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=licensecc -p 5432:5432 postgres:16-alpine
//   psql "$DATABASE_URL" -f schema.pg.sql        # apply the schema
//   npm ci                                       # installs the lock-pinned adapter dependency
//   DATABASE_URL=postgresql://postgres:smoke@localhost:5432/licensecc node smoke-worker-sql.mjs
import { createPostgresDatabase, closePool } from "./db-postgres.mjs";
import { VERIFY_SQL } from "../src/db/verify-statements.mjs";

const connectionString = process.env.DATABASE_URL || "postgresql://postgres:smoke@localhost:5432/licensecc";
const DB = createPostgresDatabase(connectionString, { workerSql: true });
const seedDB = createPostgresDatabase(connectionString);

let pass = 0, fail = 0;
const check = (n, c, g) => { if (c) { pass++; console.log("PASS  " + n + (g !== undefined ? "  => " + JSON.stringify(g) : "")); } else { fail++; console.log("FAIL  " + n + "  got " + JSON.stringify(g)); } };

const SEED = "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)";

try {
  const now = Math.floor(Date.now() / 1000);
  const fp = "a".repeat(64);
  const key = "smoke-" + now; // unique rate-limit key so re-runs start clean
  // idempotent: clear the seed row
  await seedDB.prepare("DELETE FROM entitlements WHERE license_fingerprint = $1").bind(fp).run();

  let row = await DB.prepare(VERIFY_SQL.rateLimitUpsert).bind("ns", key, now, now + 60, now).first();
  check("rate-limit upsert #1 -> request_count=1 (?->$n + ON CONFLICT RETURNING)", row && Number(row.request_count) === 1, row);
  row = await DB.prepare(VERIFY_SQL.rateLimitUpsert).bind("ns", key, now, now + 60, now).first();
  check("rate-limit upsert #2 -> request_count=2 (atomic increment via qualified self-ref)", row && Number(row.request_count) === 2, row);

  await DB.prepare(VERIFY_SQL.rateLimitCleanup).bind(now - 1).run();
  check("cleanup DELETE via .run() executed (no throw)", true);

  await seedDB.prepare(SEED).bind("DEFAULT", "DEFAULT", fp, "", "active", 300, 3600, 0, now, now).run();
  row = await DB.prepare(VERIFY_SQL.entitlementLookup).bind("DEFAULT", "DEFAULT", fp).first();
  check("entitlement SELECT -> row, BIGINT cols as numbers", row && row.status === "active" && row.assertion_ttl_seconds === 300, row && { status: row.status, ttl: row.assertion_ttl_seconds, seq: row.revocation_seq });

  const miss = await DB.prepare(VERIFY_SQL.entitlementLookup).bind("DEFAULT", "DEFAULT", "b".repeat(64)).first();
  check("entitlement SELECT miss -> null (denial, not error)", miss === null, miss);

  const dmiss = await DB.prepare(VERIFY_SQL.entitlementDeviceLookup).bind("DEFAULT", "DEFAULT", fp, "sha256:x").first();
  check("device SELECT miss -> null", dmiss === null, dmiss);

  const nonce = "c".repeat(64);
  row = await DB.prepare(VERIFY_SQL.requestProofNonceConsume).bind("DEFAULT", "DEFAULT", fp, "sha256:" + "d".repeat(64), nonce, now, now, now + 600).first();
  check("request-proof nonce first consume -> row", row?.nonce === nonce, row);
  row = await DB.prepare(VERIFY_SQL.requestProofNonceConsume).bind("DEFAULT", "DEFAULT", fp, "sha256:" + "d".repeat(64), nonce, now, now, now + 600).first();
  check("request-proof nonce replay -> null", row === null, row);
  await DB.prepare(VERIFY_SQL.requestProofNonceCleanup).bind(now - 1).run();
  check("request-proof cleanup DELETE via .run() executed", true);

  let threw = false;
  try { DB.prepare("SELECT * FROM nope_table WHERE x = ?"); } catch { threw = true; }
  check("unknown Worker SQL is rejected by the closed inventory", threw);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
} catch (e) {
  fail++; console.log("HARNESS ERROR: " + e.message);
} finally { await closePool(); }
process.exit(fail > 0 ? 1 : 0);
