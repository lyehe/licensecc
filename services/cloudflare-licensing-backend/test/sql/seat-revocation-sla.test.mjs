// T7 revocation SLA — executable coverage for the two new seat mechanics, against real SQLite
// built from the shared migrations (the EXACT worker SQL, not a re-typed copy):
//
//   1. seatHeartbeatSql(mode) — the heartbeat UPDATE now re-asserts the entitlement is still
//      active AND inside its validity window (and, for soft/required, owned by the caller). A
//      revoked / disabled / expired entitlement's heartbeat matches NO row, so the seat stops
//      being extended and lapses within one grace — the seat revocation SLA. Closes the
//      one-heartbeat TOCTOU the handler's pre-read alone left open.
//   2. SEAT_OVERCAP_RECLAIM_SQL — after a pool downgrade, reclaims the LIVE seats above the new
//      ceiling (latest-alive kept), so a capacity cut takes effect within one sweep + grace.
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { seatHeartbeatSql, SEAT_OVERCAP_RECLAIM_SQL } from "../../src/lease/issuance_sql.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");
const FP = "a".repeat(64);
const NOW = 1_000_000;
const GRACE = 900;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return db;
}

function seedEntitlement(db, { status = "active", valid_from = null, valid_until = null, pool_size = 2, allow_overdraft = 0, customer_id = null, fingerprint = FP } = {}) {
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, " +
      "cache_ttl_seconds, revocation_seq, created_at, updated_at, valid_from, valid_until, pool_size, allow_overdraft, customer_id) " +
      "VALUES ('DEFAULT', 'DEFAULT', ?, '', ?, 300, 300, 0, ?, ?, ?, ?, ?, ?, ?)",
  ).run(fingerprint, status, NOW, NOW, valid_from, valid_until, pool_size, allow_overdraft, customer_id);
}

function seedSeat(db, seatId, { mode = "live", deadline = NOW + GRACE, fingerprint = FP } = {}) {
  db.prepare(
    "INSERT INTO seat_checkouts (project, feature, license_fingerprint, seat_id, client_instance_id, mode, checked_out_at, heartbeat_deadline) " +
      "VALUES ('DEFAULT', 'DEFAULT', ?, ?, 'i1', ?, ?, ?)",
  ).run(fingerprint, seatId, mode, NOW - 10, deadline);
}

// Returns true iff the heartbeat UPDATE refreshed a row (seat still entitled).
function heartbeat(db, seatId, mode, { now = NOW + 5, deadline = NOW + GRACE, customerId = null } = {}) {
  const binds = [deadline, "DEFAULT", "DEFAULT", FP, seatId, now, now, now];
  if (mode !== "off") binds.push(customerId);
  const row = db.prepare(seatHeartbeatSql(mode)).get(...binds);
  return row !== undefined;
}

function liveSeatIds(db, now = NOW) {
  return db
    .prepare("SELECT seat_id FROM seat_checkouts WHERE heartbeat_deadline > ? ORDER BY seat_id")
    .all(now)
    .map((r) => r.seat_id);
}

test("heartbeat refreshes a live seat while the entitlement is active and valid (off mode)", () => {
  const db = freshDb();
  seedEntitlement(db);
  seedSeat(db, "s1", { deadline: NOW + 10 });
  assert.equal(heartbeat(db, "s1", "off"), true);
  // Deadline extended far out, so the seat is still live well past its original 10s.
  assert.equal(liveSeatIds(db, NOW + 500).length, 1);
  db.close();
});

test("heartbeat is DENIED once the entitlement is revoked (SLA: seat lapses within grace)", () => {
  const db = freshDb();
  seedEntitlement(db, { status: "revoked" });
  seedSeat(db, "s1", { deadline: NOW + 10 });
  assert.equal(heartbeat(db, "s1", "off"), false, "revoked entitlement cannot refresh a seat");
  // Not extended: the seat lapses at its original deadline (NOW+10) — within one grace.
  assert.equal(liveSeatIds(db, NOW + 11).length, 0);
  db.close();
});

test("heartbeat is DENIED when the entitlement is disabled", () => {
  const db = freshDb();
  seedEntitlement(db, { status: "disabled" });
  seedSeat(db, "s1");
  assert.equal(heartbeat(db, "s1", "off"), false);
  db.close();
});

test("heartbeat is DENIED once the entitlement is expired (now >= valid_until)", () => {
  const db = freshDb();
  seedEntitlement(db, { valid_until: NOW + 1 });
  seedSeat(db, "s1");
  assert.equal(heartbeat(db, "s1", "off", { now: NOW + 100 }), false, "expired entitlement cannot refresh a seat");
  db.close();
});

test("required mode: heartbeat denies a foreign customer AND a revoked entitlement", () => {
  const db = freshDb();
  seedEntitlement(db, { customer_id: "cus_a" });
  seedSeat(db, "s1");
  // Wrong owner -> no row (no oracle).
  assert.equal(heartbeat(db, "s1", "required", { customerId: "cus_b" }), false, "A cannot heartbeat B's seat");
  // Right owner -> refreshes.
  assert.equal(heartbeat(db, "s1", "required", { customerId: "cus_a" }), true);
  // Revoke, then even the right owner is denied (status folded into the UPDATE).
  db.prepare("UPDATE entitlements SET status = 'revoked' WHERE customer_id = 'cus_a'").run();
  assert.equal(heartbeat(db, "s1", "required", { customerId: "cus_a" }), false, "revoke denies even the owner");
  db.close();
});

test("downgrade reclaim removes live seats above the new ceiling, keeping the latest-alive", () => {
  const db = freshDb();
  seedEntitlement(db, { pool_size: 1 });
  seedSeat(db, "s_low", { deadline: NOW + 100 });
  seedSeat(db, "s_mid", { deadline: NOW + 200 });
  seedSeat(db, "s_high", { deadline: NOW + 300 });
  const reclaimed = db.prepare(SEAT_OVERCAP_RECLAIM_SQL).all(NOW, NOW);
  assert.equal(reclaimed.length, 2);
  // Only the highest-deadline seat survives under pool_size 1.
  assert.deepEqual(liveSeatIds(db), ["s_high"]);
  // A reclaimed seat's heartbeat now denies (row gone) -> client stops within grace.
  assert.equal(heartbeat(db, "s_low", "off"), false);
  db.close();
});

test("downgrade reclaim respects allow_overdraft in the ceiling", () => {
  const db = freshDb();
  seedEntitlement(db, { pool_size: 1, allow_overdraft: 1 }); // ceiling 2
  seedSeat(db, "s1", { deadline: NOW + 100 });
  seedSeat(db, "s2", { deadline: NOW + 200 });
  seedSeat(db, "s3", { deadline: NOW + 300 });
  const reclaimed = db.prepare(SEAT_OVERCAP_RECLAIM_SQL).all(NOW, NOW);
  assert.equal(reclaimed.length, 1, "only one seat over the ceiling of 2");
  assert.deepEqual(liveSeatIds(db), ["s2", "s3"]);
  db.close();
});

test("downgrade reclaim counts borrowed seats in the ceiling but never deletes them", () => {
  const db = freshDb();
  seedEntitlement(db, { pool_size: 1 });
  seedSeat(db, "b1", { mode: "borrowed", deadline: NOW + 30 * 86400 }); // holds the only slot
  seedSeat(db, "s_live", { deadline: NOW + 200 });
  const reclaimed = db.prepare(SEAT_OVERCAP_RECLAIM_SQL).all(NOW, NOW);
  // The live seat is over the ceiling (the borrow already fills pool 1) -> reclaimed; the borrow stays.
  assert.deepEqual(reclaimed.map((r) => r.seat_id), ["s_live"]);
  assert.deepEqual(liveSeatIds(db), ["b1"]);
  db.close();
});

test("downgrade reclaim is a no-op when within capacity", () => {
  const db = freshDb();
  seedEntitlement(db, { pool_size: 3 });
  seedSeat(db, "s1", { deadline: NOW + 100 });
  seedSeat(db, "s2", { deadline: NOW + 200 });
  const reclaimed = db.prepare(SEAT_OVERCAP_RECLAIM_SQL).all(NOW, NOW);
  assert.equal(reclaimed.length, 0);
  assert.deepEqual(liveSeatIds(db), ["s1", "s2"]);
  db.close();
});
