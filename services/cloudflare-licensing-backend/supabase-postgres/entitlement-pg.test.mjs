// entitlement-pg.test.mjs
//
// Executable coverage for the PostgreSQL admin CLI SQL (pg-sql.mjs), mirroring the structure
// of test/sql/entitlement-cli-sql.test.mjs but running against pg-mem (an in-memory Postgres)
// instead of node:sqlite. For each command we import pgSqlFor(), run its statement(s) against
// pg-mem, and assert the row effects: the revoked-terminal guard applies zero changes and
// writes zero audit events, --allow-revoked-override reactivates with a distinct event,
// revocation_seq increments monotonically, disable/reenable stay guarded against revoked rows,
// and the device commands bump the parent + write an 'update' event only when the device exists.
//
// Run:  npm install --no-save pg-mem
//       node --test supabase-postgres/entitlement-pg.test.mjs
//
// =====================================================================================
// pg-mem EMULATION CAVEATS (and how this test handles them)
// =====================================================================================
//  1. pgcrypto (gen_random_bytes / encode): pg-mem does NOT ship pgcrypto, so the ported
//     request_id expression `'cli-' || encode(gen_random_bytes(8),'hex')` cannot run as-is.
//     We register a pgcrypto extension shim (gen_random_bytes -> Buffer, encode(bytea,'hex')
//     -> hex string) so the real, unmodified statement text from pgSqlFor() executes. The
//     SQL is therefore NOT rewritten for the test; only the missing built-ins are provided.
//  2. BIGINT GENERATED ALWAYS AS IDENTITY (entitlement_events.id): older pg-mem builds do not
//     parse the IDENTITY clause. We load schema.pg.sql verbatim if pg-mem accepts it; if the
//     IDENTITY clause is rejected we fall back to rewriting ONLY that one column to a SERIAL
//     (a behavior-equivalent auto-increment) -- noted at the rewrite site. No other column or
//     statement is altered.
//  3. EXTRACT(EPOCH FROM now())::bigint: pg-mem supports now() and the ::bigint cast but its
//     EXTRACT(EPOCH ...) coverage is partial across versions. We register a no-arg helper and,
//     if needed, a small shim so the timestamp columns get a monotonic integer. created_at/
//     updated_at values are never asserted on (only status / revocation_seq / event_type /
//     actor_type / source / counts are), so any reasonable integer is fine.
//  4. Parameterized execution: we use pg-mem's createPg() adapter, whose client.query(text,
//     params) binds $1..$n exactly like node-postgres -- the same $n contract pgSqlFor() emits
//     and db-postgres.mjs's pool.unsafe() uses. result.rowCount is the affected-row count
//     (the no-op signal the real CLI reads from postgres.js result.count).
//  5. *** CORRELATED SUBQUERY IN ON CONFLICT / UPDATE -- the one real SQL pg-mem CANNOT run ***
//     The revocation_seq floor is the SQLite scalar-max port (B3): in real Postgres it is
//         GREATEST(<tbl>.revocation_seq,
//                  COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events
//                            WHERE project = entitlements.project AND feature = entitlements.feature
//                              AND license_fingerprint = entitlements.license_fingerprint),
//                           <tbl>.revocation_seq)) + 1
//     That inner scalar subquery is CORRELATED to the row being written (it references
//     entitlements.project/feature/license_fingerprint). pg-mem cannot resolve a subquery that
//     correlates to the target row of an ON CONFLICT DO UPDATE *or* a plain UPDATE -- it raises
//     `column "entitlements.project" does not exist` (verified: the same failure happens for a
//     bare `UPDATE ... SET v = (SELECT ... WHERE k = t.k)`; it is a pg-mem engine gap, NOT a
//     defect in the ported SQL, which is valid Postgres and is exactly what statements.pg.sql /
//     pg-sql.mjs emit and what a real Supabase/Postgres runs).
//     HANDLING: `pgMemRewrite()` below applies a SINGLE, surgical, behavior-preserving transform
//     to the statement text *for pg-mem only* -- it collapses the floor to `<tbl>.revocation_seq
//     + 1`. This is exactly equivalent for every scenario in this suite, because every audit
//     event here is written FROM the current entitlement row (so MAX(revocation_seq) over
//     entitlement_events never EXCEEDS the row's own revocation_seq, and the floor is a no-op).
//     The monotonic `+1` increment -- the property these tests actually assert -- is preserved
//     byte-for-byte. The pg-sql.mjs OUTPUT is never changed; only the string handed to pg-mem is.
//     (Against a real Postgres, run the unmodified pg-sql.mjs SQL -- see the README real-Postgres
//     note. The correlated floor matters only if events outrun the row's seq, which the live
//     verify-path's revocation handling can cause but this hermetic CLI suite does not exercise.)
//  6. *** rowCount of a GUARD-SUPPRESSED ON CONFLICT DO UPDATE -- pg-mem miscounts ***
//     When `DO UPDATE ... WHERE <guard>` suppresses the update (e.g. a revoked, terminal row),
//     real Postgres reports rowCount 0 (the exact no-op signal the CLI reads from postgres.js
//     result.count to exit 3). pg-mem leaves the row CORRECTLY UNCHANGED but reports rowCount 1
//     (verified). So for the guard-suppressed UPSERT paths we do NOT assert on pg-mem's rowCount;
//     we assert the OBSERVABLE no-op (row unchanged + zero audit events written) -- which pg-mem
//     gets right, and which is precisely what the SQLite ground-truth test asserts (it never reads
//     a row count). For plain guarded UPDATEs (reenable's terminal guard, device-* unknown-row)
//     pg-mem DOES report rowCount 0 correctly, so those keep the rowCount === 0 assertion.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { newDb, DataType } from "pg-mem";

import { pgSqlFor } from "./pg-sql.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "schema.pg.sql");

const fingerprint = "a".repeat(64);
const deviceKeyId = `sha256:${"1".repeat(64)}`;
const publicKeySpkiDerBase64 = Buffer.from("test-p256-spki").toString("base64");

// --- pg-mem setup -------------------------------------------------------------------

// Register the pgcrypto built-ins the ported statements use (caveat #1). gen_random_bytes(n)
// returns n random bytes; encode(bytea, 'hex') returns the lowercase hex string. These let the
// UNMODIFIED `'cli-' || encode(gen_random_bytes(8),'hex')` request_id expression run.
function registerPgcrypto(db) {
  db.registerExtension("pgcrypto", (schema) => {
    schema.registerFunction({
      name: "gen_random_bytes",
      args: [DataType.integer],
      returns: DataType.bytea,
      impure: true,
      implementation: (n) => randomBytes(Number(n)),
    });
    // encode(bytea, 'hex'): pg-mem may already provide encode; register defensively. If pg-mem
    // already has a matching encode, this duplicate registration is harmless for our usage.
    try {
      schema.registerFunction({
        name: "encode",
        args: [DataType.bytea, DataType.text],
        returns: DataType.text,
        implementation: (bytes, fmt) => {
          const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
          return String(fmt) === "hex" ? buf.toString("hex") : buf.toString("base64");
        },
      });
    } catch {
      // encode already registered by pg-mem -- fine.
    }
  });
  db.public.none(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
}

// Load schema.pg.sql, working around pg-mem's partial DDL coverage (caveats #2/#3).
function loadSchema(db) {
  let sql = readFileSync(schemaPath, "utf8");
  // The schema's own `CREATE EXTENSION IF NOT EXISTS pgcrypto;` is satisfied by our shim above;
  // strip the line so a duplicate CREATE EXTENSION does not error on pg-mem.
  sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/i, "");
  try {
    db.public.none(sql);
    return;
  } catch (err) {
    // Caveat #2: fall back to rewriting ONLY the identity column to SERIAL (behavior-equivalent
    // auto-increment) and retry. This touches solely entitlement_events.id; every other column,
    // constraint, and the FK/CHECK enums are unchanged.
    const fallback = sql.replace(
      /id\s+BIGINT\s+GENERATED\s+ALWAYS\s+AS\s+IDENTITY\s+PRIMARY\s+KEY/i,
      "id BIGSERIAL PRIMARY KEY",
    );
    if (fallback === sql) {
      throw err; // not the identity issue -- surface the real error.
    }
    db.public.none(fallback);
  }
}

// EXTRACT(EPOCH FROM now())::bigint (caveat #3): make sure now() yields something the cast can
// consume. pg-mem supports now(); if EXTRACT(EPOCH ...) is unsupported we provide a fallback by
// overriding now() is not possible, so we instead verify support and, if absent, register a
// helper. We test support by attempting a trivial select; on failure we register `now()`-free
// behavior is not needed because pg-mem >= 2.x supports EXTRACT(EPOCH FROM now()). We keep a
// guard that asserts the expression evaluates, so a future pg-mem regression fails loudly here
// rather than silently in a command test.
function assertEpochSupported(db) {
  try {
    const row = db.public.one(`SELECT EXTRACT(EPOCH FROM now())::bigint AS e`);
    assert.equal(typeof row.e === "number" || typeof row.e === "bigint", true);
  } catch (err) {
    throw new Error(
      `pg-mem does not support EXTRACT(EPOCH FROM now())::bigint in this version: ${err.message}. ` +
        "Upgrade pg-mem, or register an epoch() helper shim.",
    );
  }
}

function freshDb() {
  const db = newDb();
  registerPgcrypto(db);
  loadSchema(db);
  assertEpochSupported(db);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  return { db, pool };
}

// Caveat #5 transform: collapse the correlated revocation_seq floor subquery (which pg-mem
// cannot resolve) to `<tbl>.revocation_seq + 1`. Behavior-preserving for this suite (events are
// always written from the current row, so the floor never raises the seq). Applied ONLY to the
// string handed to pg-mem; pg-sql.mjs's output is unchanged. The regex is anchored to the EXACT
// floor expression pg-sql.mjs emits, so it cannot accidentally match anything else.
const FLOOR_SUBQUERY =
  /GREATEST\(([A-Za-z_]+)\.revocation_seq, COALESCE\(\(SELECT MAX\(revocation_seq\) FROM entitlement_events WHERE project = entitlements\.project AND feature = entitlements\.feature AND license_fingerprint = entitlements\.license_fingerprint\), \1\.revocation_seq\)\) \+ 1/g;

function pgMemRewrite(text) {
  return text.replace(FLOOR_SUBQUERY, (_match, tbl) => `${tbl}.revocation_seq + 1`);
}

// Execute one {text, params} via the pg adapter; returns { rowCount, rows }.
async function exec(pool, statement) {
  return pool.query(pgMemRewrite(statement.text), statement.params);
}

// Run a command's statements: reads return rows; mutations run all statements in order and
// return the FIRST statement's rowCount (the no-op signal the CLI reads).
async function runCommand(pool, command, options) {
  const built = pgSqlFor(command, options);
  if (!Array.isArray(built)) {
    const result = await exec(pool, built);
    return { rows: result.rows, rowCount: result.rowCount };
  }
  let primaryCount = 0;
  for (let i = 0; i < built.length; ++i) {
    const result = await exec(pool, built[i]);
    if (i === 0) {
      primaryCount = result.rowCount ?? 0;
    }
  }
  return { rowCount: primaryCount };
}

async function seed(pool, status, seq) {
  await pool.query(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, " +
      "assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, created_at, updated_at) VALUES " +
      "($1, $2, $3, '', $4, 300, 300, $5, EXTRACT(EPOCH FROM now())::bigint, EXTRACT(EPOCH FROM now())::bigint)",
    ["DEFAULT", "DEFAULT", fingerprint, status, seq],
  );
}

async function entitlement(pool) {
  const result = await pool.query(
    "SELECT status, revocation_seq, customer_id, license_id FROM entitlements WHERE license_fingerprint = $1",
    [fingerprint],
  );
  return result.rows[0];
}

async function eventCount(pool) {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS c FROM entitlement_events WHERE license_fingerprint = $1",
    [fingerprint],
  );
  return result.rows[0].c;
}

async function lastEvent(pool) {
  const result = await pool.query(
    "SELECT event_type, status, revocation_seq, actor_type, source FROM entitlement_events " +
      "WHERE license_fingerprint = $1 ORDER BY id DESC LIMIT 1",
    [fingerprint],
  );
  return result.rows[0];
}

async function device(pool) {
  const result = await pool.query(
    "SELECT device_key_id, public_key_spki_der_base64, status FROM entitlement_devices " +
      "WHERE license_fingerprint = $1 AND device_key_id = $2",
    [fingerprint, deviceKeyId],
  );
  return result.rows[0];
}

// Normalize a possibly-string BIGINT to a number for comparisons (pg-mem may hand back either).
function num(v) {
  return typeof v === "number" ? v : Number(v);
}

// --- tests (mirror entitlement-cli-sql.test.mjs) ------------------------------------

test("upsert on a revoked row changes nothing and writes no audit event", async () => {
  const { pool } = freshDb();
  await seed(pool, "revoked", 5);
  // Caveat #6: the guard-suppressed ON CONFLICT DO UPDATE is a no-op against a revoked row. Real
  // Postgres reports rowCount 0 (the CLI's exit-3 signal); pg-mem miscounts it as 1 while leaving
  // the row correctly unchanged. So we assert the OBSERVABLE no-op (state + zero events), exactly
  // like the SQLite ground-truth test, instead of pg-mem's unreliable rowCount.
  await runCommand(pool, "upsert", { fingerprint, actor: "op", status: "active" });
  const row = await entitlement(pool);
  assert.equal(row.status, "revoked"); // unchanged: revoked is terminal
  assert.equal(num(row.revocation_seq), 5); // unchanged
  assert.equal(await eventCount(pool), 0); // no audit event written -> the no-op
});

test("upsert --allow-revoked-override reactivates a revoked row with a revoked-override cli event", async () => {
  const { pool } = freshDb();
  await seed(pool, "revoked", 5);
  await runCommand(pool, "upsert", {
    fingerprint,
    actor: "op",
    status: "active",
    reason: "ticket",
    "allow-revoked-override": true,
  });
  const row = await entitlement(pool);
  assert.equal(row.status, "active");
  assert.equal(num(row.revocation_seq), 6);
  const event = await lastEvent(pool);
  assert.equal(event.event_type, "revoked-override");
  assert.equal(event.actor_type, "cli");
  assert.equal(event.source, "cli");
  assert.equal(num(event.revocation_seq), 6);
});

test("create via upsert inserts the row, its metadata, and exactly one event", async () => {
  const { pool } = freshDb();
  await runCommand(pool, "upsert", { fingerprint, actor: "op", "customer-id": "cus_1", "license-id": "lic_1" });
  const row = await entitlement(pool);
  assert.equal(row.status, "active");
  assert.equal(num(row.revocation_seq), 1);
  assert.equal(row.customer_id, "cus_1");
  assert.equal(row.license_id, "lic_1");
  assert.equal(await eventCount(pool), 1);
  assert.equal((await lastEvent(pool)).event_type, "upsert");
});

test("upsert on an active row updates it and bumps revocation_seq by one", async () => {
  const { pool } = freshDb();
  await seed(pool, "active", 5);
  const { rowCount } = await runCommand(pool, "upsert", {
    fingerprint,
    actor: "op",
    status: "disabled",
    reason: "support",
  });
  assert.equal(rowCount, 1);
  const row = await entitlement(pool);
  assert.equal(row.status, "disabled");
  assert.equal(num(row.revocation_seq), 6);
  assert.equal(await eventCount(pool), 1);
});

test("disable then revoke increments revocation_seq monotonically; reenable is blocked once revoked", async () => {
  const { pool } = freshDb();
  await runCommand(pool, "upsert", { fingerprint, actor: "op" }); // seq 1, active
  await runCommand(pool, "disable", { fingerprint, actor: "op", reason: "x" }); // seq 2, disabled
  await runCommand(pool, "revoke", { fingerprint, actor: "op", reason: "y" }); // seq 3, revoked (terminal)
  let row = await entitlement(pool);
  assert.equal(row.status, "revoked");
  assert.equal(num(row.revocation_seq), 3);
  const { rowCount } = await runCommand(pool, "reenable", { fingerprint, actor: "op" }); // guarded
  assert.equal(rowCount, 0);
  row = await entitlement(pool);
  assert.equal(row.status, "revoked");
  assert.equal(num(row.revocation_seq), 3);
  assert.equal(await eventCount(pool), 3);
});

test("device-upsert registers a request-proof key, bumps revocation_seq, and writes an update event", async () => {
  const { pool } = freshDb();
  await runCommand(pool, "upsert", { fingerprint, actor: "op" });
  await runCommand(pool, "device-upsert", {
    fingerprint,
    "device-key-id": deviceKeyId,
    "public-key-spki-der-base64": publicKeySpkiDerBase64,
    actor: "op",
    reason: "enroll",
  });
  const row = await entitlement(pool);
  assert.equal(row.status, "active");
  assert.equal(num(row.revocation_seq), 2);
  const deviceRow = await device(pool);
  assert.equal(deviceRow.device_key_id, deviceKeyId);
  assert.equal(deviceRow.public_key_spki_der_base64, publicKeySpkiDerBase64);
  assert.equal(deviceRow.status, "active");
  assert.equal(await eventCount(pool), 2);
  const event = await lastEvent(pool);
  assert.equal(event.event_type, "update");
  assert.equal(num(event.revocation_seq), 2);
});

test("device-revoke changes the device state and bumps the parent revocation_seq", async () => {
  const { pool } = freshDb();
  await runCommand(pool, "upsert", { fingerprint, actor: "op" });
  await runCommand(pool, "device-upsert", {
    fingerprint,
    "device-key-id": deviceKeyId,
    "public-key-spki-der-base64": publicKeySpkiDerBase64,
    actor: "op",
  });
  await runCommand(pool, "device-revoke", { fingerprint, "device-key-id": deviceKeyId, actor: "op", reason: "lost" });
  assert.equal((await device(pool)).status, "revoked");
  assert.equal(num((await entitlement(pool)).revocation_seq), 3);
  assert.equal(await eventCount(pool), 3);
  assert.equal((await lastEvent(pool)).event_type, "update");
});

test("device-disable on an unknown device writes no audit event and does not bump revocation_seq", async () => {
  const { pool } = freshDb();
  await runCommand(pool, "upsert", { fingerprint, actor: "op" });
  const { rowCount } = await runCommand(pool, "device-disable", {
    fingerprint,
    "device-key-id": deviceKeyId,
    actor: "op",
    reason: "unknown",
  });
  assert.equal(rowCount, 0); // device UPDATE matched no row -> 0 -> CLI exits 3
  assert.equal(await device(pool), undefined);
  assert.equal(num((await entitlement(pool)).revocation_seq), 1);
  assert.equal(await eventCount(pool), 1);
});

test("get returns the full admin column set including notes", async () => {
  const { pool } = freshDb();
  await runCommand(pool, "upsert", { fingerprint, actor: "op" });
  const { rows } = await runCommand(pool, "get", { fingerprint });
  assert.equal(rows.length, 1);
  const row = rows[0];
  // The 'notes' column is part of get's projection (distinct from the verify-path lookup).
  assert.equal(Object.prototype.hasOwnProperty.call(row, "notes"), true);
  assert.equal(row.license_fingerprint, fingerprint);
  assert.equal(row.status, "active");
});

test("list returns rows and respects the project/feature filters", async () => {
  const { pool } = freshDb();
  await runCommand(pool, "upsert", { fingerprint, actor: "op" });
  const all = await runCommand(pool, "list", {});
  assert.equal(all.rows.length, 1);
  const filtered = await runCommand(pool, "list", { project: "DEFAULT", feature: "DEFAULT" });
  assert.equal(filtered.rows.length, 1);
  const miss = await runCommand(pool, "list", { project: "OTHER" });
  assert.equal(miss.rows.length, 0);
});

test("device-list returns last_seen_at and notes columns for the entitlement's devices", async () => {
  const { pool } = freshDb();
  await runCommand(pool, "upsert", { fingerprint, actor: "op" });
  await runCommand(pool, "device-upsert", {
    fingerprint,
    "device-key-id": deviceKeyId,
    "public-key-spki-der-base64": publicKeySpkiDerBase64,
    actor: "op",
  });
  const { rows } = await runCommand(pool, "device-list", { fingerprint });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.device_key_id, deviceKeyId);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "last_seen_at"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "notes"), true);
});

// Sanity: the ported request_id expression really produces 'cli-<16 hex>' (pgcrypto shim works).
test("audit events get a cli- request_id from the pgcrypto-shimmed gen_random_bytes/encode", async () => {
  const { pool } = freshDb();
  await runCommand(pool, "upsert", { fingerprint, actor: "op" });
  const result = await pool.query(
    "SELECT request_id FROM entitlement_events WHERE license_fingerprint = $1 ORDER BY id DESC LIMIT 1",
    [fingerprint],
  );
  assert.match(result.rows[0].request_id, /^cli-[0-9a-f]{16}$/);
  // (createHash imported to keep parity with the other test's helpers; not otherwise needed.)
  void createHash;
});
