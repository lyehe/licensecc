// order-apply-smoke-real-pg.mjs
//
// Real-PostgreSQL smoke for the order-apply port (order-apply-pg.mjs) — the live-engine counterpart to
// the hermetic order-apply-pg.test.mjs. It drives the REAL, UNMODIFIED orderApplyStatementsFor()/builder
// output through node-postgres against a live Postgres, exercising the constructs pg-mem cannot emulate:
// the ON CONFLICT correlated floor, the FLOOR_PREDICATE_UPDATE suppression (empty RETURNING == superseded),
// json_build_object(...)::text, and the ctid + GREATEST(0,..) seat-reclaim DELETE.
//
// GATED on DATABASE_URL: with none set this is a CLEAN SKIP (exit 0), so CI/Windows without Docker is not a
// failure. To run:
//   docker run -d --name pg -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=licensecc -p 5433:5432 postgres:16-alpine
//   psql postgresql://postgres:smoke@localhost:5433/licensecc -f schema.pg.sql
//   npm install --no-save pg
//   DATABASE_URL=postgresql://postgres:smoke@localhost:5433/licensecc node order-apply-smoke-real-pg.mjs
//
// Exit 0 = all assertions passed (or skipped); exit 1 = a failure.

// Dependency-free builder imports are static; `pg` (node-postgres) is loaded DYNAMICALLY after the
// DATABASE_URL guard so a no-DB run is a clean skip WITHOUT requiring pg to be installed (static
// `import pg` would hoist above the guard and MODULE_NOT_FOUND first).
import {
  pgAcceptBatch,
  pgCreateStatement,
  pgPatchStatement,
  pgCapacityStatement,
  pgOrderEventStatement,
  pgReclaimStatement,
  pgProcessedMark,
} from "./order-apply-pg.mjs";

if (!process.env.DATABASE_URL) {
  console.log("SKIP order-apply smoke: set DATABASE_URL (a live Postgres) to run.");
  process.exit(0);
}

const pg = (await import("pg")).default;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const PROJECT = "DEFAULT";
const FEATURE = "DEFAULT";
const FP = "a".repeat(64);
const SUB = "sub_smoke";
const KEY = { project: PROJECT, feature: FEATURE, license_fingerprint: FP };
const NOW = 1_700_000_000;

const N = (v) => Number(v);
let pass = 0;
let fail = 0;
const check = (name, cond, got) => {
  if (cond) { pass++; console.log("PASS  " + name + (got !== undefined ? "  => " + JSON.stringify(got) : "")); }
  else { fail++; console.log("FAIL  " + name + "  got " + JSON.stringify(got)); }
};

const ent = async () => (await pool.query("SELECT * FROM entitlements WHERE license_fingerprint=$1", [FP])).rows[0];
const liveSeatCount = async () =>
  N((await pool.query("SELECT COUNT(*)::int n FROM seat_checkouts WHERE license_fingerprint=$1 AND heartbeat_deadline > $2", [FP, NOW])).rows[0].n);

// Run the ordered apply statements in ONE transaction (the smoke's stand-in for runApplyTransaction,
// which is postgres.js-specific). Returns { applied, row, reclaimedSeats }.
async function runApply(statements) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let applied = false;
    let row = null;
    let reclaimedSeats = [];
    for (let i = 0; i < statements.length; ++i) {
      const { text, params, role } = statements[i];
      const res = await client.query(text, params);
      if (i === 0) { applied = res.rows.length > 0; row = res.rows[0] ?? null; }
      else if (role === "reclaim") { reclaimedSeats = res.rows.map((r) => r.seat_id); }
    }
    await client.query("COMMIT");
    return { applied, row, reclaimedSeats };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Seed an 'accepted' order_event so the in-txn processed-mark has a row to flip.
async function seedAcceptedEvent(eventId, epoch, seq, intent) {
  await pool.query(
    "INSERT INTO order_events (event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, payload_digest, raw_payload, status, result_json, received_at, processed_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,'k','d','{}','accepted','',$8,NULL)",
    [eventId, SUB, PROJECT, FEATURE, epoch, seq, intent, NOW],
  );
}

function order(eventId, epoch, seq, intent) {
  return { intent, subscription_id: SUB, event_id: eventId, project: PROJECT, feature: FEATURE, order_epoch: epoch, seq };
}

const createFields = {
  device_hash: "", status: "active", assertion_ttl_seconds: 300, valid_from: null, valid_until: NOW + 86400,
  notes: "", customer_id: "cus_smoke", license_id: null, pool_size: 3, max_active_devices: 1, created_at: NOW,
};

try {
  // Clean (repeatable).
  await pool.query("DELETE FROM seat_checkouts WHERE license_fingerprint=$1", [FP]);
  await pool.query("DELETE FROM entitlement_events WHERE license_fingerprint=$1", [FP]);
  await pool.query("DELETE FROM order_events WHERE subscription_id=$1", [SUB]);
  await pool.query("DELETE FROM entitlements WHERE license_fingerprint=$1", [FP]);
  await pool.query("DELETE FROM orders WHERE subscription_id=$1", [SUB]);
  await pool.query("DELETE FROM customers WHERE id=$1", ["cus_smoke"]);

  // Seed customer (FK) + the orders cursor row at epoch 0.
  await pool.query("INSERT INTO customers (id, name, email, metadata_json, created_at, updated_at, status, external_ref) VALUES ($1,'Smoke','s@x.test','{}',$2,$2,'active','') ON CONFLICT (id) DO NOTHING", ["cus_smoke", NOW]);
  await pool.query(
    "INSERT INTO orders (subscription_id, project, feature, license_fingerprint, customer_id, license_id, last_seq, order_epoch, fingerprint_origin, created_at, updated_at) VALUES ($1,$2,$3,$4,'cus_smoke',NULL,0,0,'derived',$5,$5)",
    [SUB, PROJECT, FEATURE, FP, NOW],
  );

  // (1) ACCEPT event @ (1,1): both RETURNING rows present.
  const acc = pgAcceptBatch(order("evt_create", 1, 1, "subscription.active"), "k", "d", "{}", NOW);
  const client = await pool.connect();
  await client.query("BEGIN");
  const cur = await client.query(acc[0].text, acc[0].params);
  const clm = await client.query(acc[1].text, acc[1].params);
  await client.query("COMMIT");
  client.release();
  check("ACCEPT advanced the cursor + claimed the event", cur.rows.length === 1 && clm.rows.length === 1, { cursor: cur.rows[0], claim: clm.rows[0] });

  // (2) APPLY create @ floor (1,1): entitlement materializes, seq=1, floor=(1,1), event processed.
  const createStmts = [
    pgCreateStatement(KEY, createFields, { epoch: 1, seq: 1 }, NOW),
    pgOrderEventStatement(KEY, "create", order("evt_create", 1, 1, "subscription.active"), NOW),
    pgProcessedMark("evt_create", "{}", NOW),
  ];
  const created = await runApply(createStmts);
  let r = await ent();
  check("create applied: active, seq=1, floor=(1,1)", created.applied && r.status === "active" && N(r.revocation_seq) === 1 && N(r.last_applied_order_epoch) === 1 && N(r.last_applied_order_seq) === 1, { applied: created.applied, seq: r.revocation_seq, floor: [r.last_applied_order_epoch, r.last_applied_order_seq] });
  const evState = (await pool.query("SELECT status FROM order_events WHERE event_id=$1", ["evt_create"])).rows[0].status;
  check("create event marked processed", evState === "processed", evState);

  // (3) STALE patch @ floor (0,9) [epoch 0 < 1]: FLOOR_PREDICATE_UPDATE false -> empty RETURNING = superseded.
  await seedAcceptedEvent("evt_stale", 0, 9, "subscription.renew");
  const stale = await runApply([
    pgPatchStatement(KEY, { ...createFields, valid_until: NOW + 999 }, { epoch: 0, seq: 9 }, NOW),
    pgOrderEventStatement(KEY, "update", order("evt_stale", 0, 9, "subscription.renew"), NOW),
    pgProcessedMark("evt_stale", "{}", NOW),
  ]);
  r = await ent();
  check("stale apply -> superseded (no row), seq UNCHANGED at 1, floor still (1,1)", stale.applied === false && N(r.revocation_seq) === 1 && N(r.last_applied_order_epoch) === 1, { applied: stale.applied, seq: r.revocation_seq });

  // (4) FORWARD patch @ floor (3,1): advances -> seq=2, floor=(3,1).
  await seedAcceptedEvent("evt_fwd", 3, 1, "subscription.renew");
  const fwd = await runApply([
    pgPatchStatement(KEY, { ...createFields, valid_until: NOW + 172800 }, { epoch: 3, seq: 1 }, NOW),
    pgOrderEventStatement(KEY, "update", order("evt_fwd", 3, 1, "subscription.renew"), NOW),
    pgProcessedMark("evt_fwd", "{}", NOW),
  ]);
  r = await ent();
  check("forward apply -> seq=2, floor=(3,1)", fwd.applied && N(r.revocation_seq) === 2 && N(r.last_applied_order_epoch) === 3, { applied: fwd.applied, seq: r.revocation_seq, floor: [r.last_applied_order_epoch, r.last_applied_order_seq] });

  // (5) CAPACITY downgrade @ floor (4,1), pool 3->1, with 3 live seats: reclaim the 2 longest-held.
  for (const [sid, dl] of [["s1", NOW + 100], ["s2", NOW + 200], ["s3", NOW + 300]]) {
    await pool.query(
      "INSERT INTO seat_checkouts (project, feature, license_fingerprint, seat_id, client_instance_id, mode, checked_out_at, heartbeat_deadline) VALUES ($1,$2,$3,$4,'i','live',$5,$6)",
      [PROJECT, FEATURE, FP, sid, NOW - 10, dl],
    );
  }
  await seedAcceptedEvent("evt_cap", 4, 1, "quantity.changed");
  const cap = await runApply([
    pgCapacityStatement(KEY, { pool_size: 1 }, { epoch: 4, seq: 1 }, NOW),
    pgOrderEventStatement(KEY, "update", order("evt_cap", 4, 1, "quantity.changed"), NOW),
    pgReclaimStatement(KEY, NOW, 1),
    pgProcessedMark("evt_cap", "{}", NOW),
  ]);
  const liveAfter = await liveSeatCount();
  check("capacity downgrade reclaimed 2 longest-held seats; 1 live remains (ctid + GREATEST)", cap.applied && cap.reclaimedSeats.length === 2 && liveAfter === 1, { reclaimed: cap.reclaimedSeats, live: liveAfter });

  // (6) Processed-mark idempotency: re-running the mark on an already-processed event no-ops.
  const remark = await pool.query(pgProcessedMark("evt_create", "{}", NOW).text, pgProcessedMark("evt_create", "{}", NOW).params);
  check("processed-mark on an already-processed event is a no-op (0 rows)", remark.rowCount === 0, { rowCount: remark.rowCount });

  // (7) Audit events landed with json_build_object next_json that parses to the expected shape.
  const audit = (await pool.query("SELECT next_json FROM entitlement_events WHERE license_fingerprint=$1 AND event_type='create' ORDER BY id DESC LIMIT 1", [FP])).rows[0];
  let parsed = null;
  try { parsed = JSON.parse(audit.next_json); } catch { /* parsed stays null */ }
  check("audit next_json (json_build_object::text) parses with the contract keys", parsed !== null && parsed.project === PROJECT && typeof parsed.id === "string", parsed && { project: parsed.project, id: parsed.id });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
} catch (error) {
  fail++;
  console.log("HARNESS ERROR: " + (error instanceof Error ? error.message : String(error)));
} finally {
  await pool.end();
}
process.exit(fail > 0 ? 1 : 0);
