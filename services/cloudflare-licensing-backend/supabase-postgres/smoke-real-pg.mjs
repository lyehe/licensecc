// smoke-real-pg.mjs
//
// Real-PostgreSQL smoke for the entitlement-pg port — the live-engine counterpart
// to the hermetic entitlement-pg.test.mjs (which runs on pg-mem).
//
// It drives the REAL, UNMODIFIED pgSqlFor() output through node-postgres against a
// live Postgres, WITHOUT the pg-mem rewrite — so the one construct pg-mem cannot
// emulate (the revocation_seq floor subquery correlated to the ON CONFLICT / UPDATE
// target row, `... WHERE project = entitlements.project ...`) runs exactly as shipped.
//
// Verified 2026-06-16 on PostgreSQL 16 (Docker): 9/9.
//
// Run:
//   1) start a Postgres and apply the schema:
//        docker run -d --name pg -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=licensecc -p 5433:5432 postgres:16-alpine
//        psql postgresql://postgres:smoke@localhost:5433/licensecc -f schema.pg.sql   # or pipe via docker exec
//   2) npm install --no-save pg        # node-postgres (a smoke-only dep; the runtime adapter uses postgres.js)
//   3) DATABASE_URL=postgresql://postgres:smoke@localhost:5433/licensecc node smoke-real-pg.mjs
//
// Exit 0 = all assertions passed; exit 1 = a failure (or the correlated subquery did not resolve).
import pg from "pg";
import { pgSqlFor } from "./pg-sql.mjs";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:smoke@localhost:5433/licensecc";
const pool = new pg.Pool({ connectionString: DATABASE_URL });

// UN-SHIMMED executor: the real statement text, no rewrite.
async function exec(s) { return pool.query(s.text, s.params); }
async function runCommand(command, options) {
  const built = pgSqlFor(command, options);
  if (!Array.isArray(built)) { const r = await exec(built); return { rowCount: r.rowCount, rows: r.rows }; }
  let primary = 0;
  for (let i = 0; i < built.length; ++i) { const r = await exec(built[i]); if (i === 0) primary = r.rowCount; }
  return { rowCount: primary };
}

const fp = "a".repeat(64);
const ent = async () => (await pool.query("SELECT * FROM entitlements WHERE license_fingerprint=$1", [fp])).rows[0];
const events = async () => (await pool.query("SELECT COUNT(*)::int n FROM entitlement_events WHERE license_fingerprint=$1", [fp])).rows[0].n;
const dev = async () => (await pool.query("SELECT * FROM entitlement_devices WHERE license_fingerprint=$1", [fp])).rows[0];

let pass = 0, fail = 0;
const check = (name, cond, got) => { if (cond) { pass++; console.log("PASS  " + name + (got !== undefined ? "  => " + JSON.stringify(got) : "")); } else { fail++; console.log("FAIL  " + name + "  got " + JSON.stringify(got)); } };
const N = (v) => Number(v);

try {
  // Start clean so the run is repeatable.
  await pool.query("DELETE FROM entitlement_devices WHERE license_fingerprint=$1", [fp]);
  await pool.query("DELETE FROM entitlement_events WHERE license_fingerprint=$1", [fp]);
  await pool.query("DELETE FROM entitlements WHERE license_fingerprint=$1", [fp]);

  let r;
  await runCommand("upsert", { fingerprint: fp, actor: "op", status: "active" });
  r = await ent(); check("create -> active, seq=1", r.status === "active" && N(r.revocation_seq) === 1, { status: r.status, seq: r.revocation_seq });

  // THE caveat: ON CONFLICT DO UPDATE with the correlated floor subquery referencing entitlements.<col>
  await runCommand("upsert", { fingerprint: fp, actor: "op", status: "active" });
  r = await ent(); check("conflict-update -> correlated floor RESOLVED, seq=2", N(r.revocation_seq) === 2, { seq: r.revocation_seq });

  await runCommand("disable", { fingerprint: fp, actor: "op", reason: "x" });
  r = await ent(); check("disable -> seq=3, disabled", N(r.revocation_seq) === 3 && r.status === "disabled", { seq: r.revocation_seq, status: r.status });

  await runCommand("revoke", { fingerprint: fp, actor: "op", reason: "y" });
  r = await ent(); check("revoke -> seq=4, revoked", N(r.revocation_seq) === 4 && r.status === "revoked", { seq: r.revocation_seq, status: r.status });

  const re = await runCommand("reenable", { fingerprint: fp, actor: "op" });
  r = await ent(); check("reenable on revoked -> guarded no-op (rowCount 0, unchanged)", re.rowCount === 0 && r.status === "revoked" && N(r.revocation_seq) === 4, { rowCount: re.rowCount, status: r.status, seq: r.revocation_seq });
  check("reenable wrote NO audit event (events stay 4)", (await events()) === 4, await events());

  await runCommand("upsert", { fingerprint: fp, actor: "op", status: "active", reason: "ticket", "allow-revoked-override": true });
  r = await ent(); check("override -> reactivated active, seq=5", r.status === "active" && N(r.revocation_seq) === 5, { status: r.status, seq: r.revocation_seq });

  const beforeDev = N((await ent()).revocation_seq);
  await runCommand("device-upsert", { fingerprint: fp, "device-key-id": "sha256:" + "1".repeat(64), "public-key-spki-der-base64": Buffer.from("spki").toString("base64"), actor: "op", reason: "enroll" });
  r = await ent(); const d = await dev();
  check("device-upsert -> device enrolled (gen_random_bytes request_id) + parent seq bumped", d && d.status === "active" && N(r.revocation_seq) > beforeDev, { device: d && d.status, before: beforeDev, after: r.revocation_seq });

  const ev = await events();
  check("monotonic revocation_seq + audit trail intact", N((await ent()).revocation_seq) >= 6 && ev >= 5, { seq: (await ent()).revocation_seq, events: ev });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
} catch (e) {
  fail++; console.log("HARNESS ERROR: " + e.message + (/does not exist/.test(e.message) ? "  <-- correlated subquery FAILED to resolve" : ""));
} finally { await pool.end(); }
process.exit(fail > 0 ? 1 : 0);
