// Executable coverage for the floating concurrent-seat pool (atomic checkout cap). Runs the
// EXACT worker SQL (SEAT_CHECKOUT_ATOMIC_SQL) against a real SQLite built from the shared
// migrations, proving: at most pool_size LIVE seats (heartbeat_deadline > now) are granted,
// expired seats are not counted (reclaimable), sequential checkouts cannot exceed the pool
// (no check-then-insert TOCTOU), release frees a seat, heartbeat keeps a seat live, and a
// borrowed seat counts against the pool until it expires.
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SEAT_CHECKOUT_ATOMIC_SQL } from "../../src/lease/issuance_sql.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");
const fingerprint = "a".repeat(64);
const NOW = 1_000_000;
const GRACE = 900;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  db.exec(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, " +
      "assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, created_at, updated_at) VALUES " +
      `('DEFAULT', 'DEFAULT', '${fingerprint}', '', 'active', 300, 300, 0, ${NOW}, ${NOW})`,
  );
  return db;
}

function checkout(db, seatId, ceiling, { now = NOW, deadline = NOW + GRACE, mode = "live", instance = "i1" } = {}) {
  const row = db.prepare(SEAT_CHECKOUT_ATOMIC_SQL).get(
    "DEFAULT", "DEFAULT", fingerprint, seatId, instance, mode, now, deadline,
    "DEFAULT", "DEFAULT", fingerprint, now, ceiling,
  );
  return row !== undefined;
}

function liveCount(db, now = NOW) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM seat_checkouts WHERE license_fingerprint = ? AND heartbeat_deadline > ?")
    .get(fingerprint, now).c;
}

test("caps live seats at the pool ceiling", () => {
  const db = freshDb();
  assert.equal(checkout(db, "s1", 2), true);
  assert.equal(checkout(db, "s2", 2), true);
  assert.equal(checkout(db, "s3", 2), false, "third checkout denied at pool 2");
  assert.equal(liveCount(db), 2);
  db.close();
});

test("sequential checkouts cannot exceed the pool (no check-then-insert gap)", () => {
  const db = freshDb();
  const results = ["s1", "s2", "s3", "s4", "s5"].map((id) => checkout(db, id, 2));
  assert.deepEqual(results, [true, true, false, false, false]);
  assert.equal(liveCount(db), 2);
  db.close();
});

test("expired seats are not counted and free capacity", () => {
  const db = freshDb();
  // Directly seed an EXPIRED seat (deadline in the past).
  db.prepare(
    "INSERT INTO seat_checkouts (project, feature, license_fingerprint, seat_id, client_instance_id, mode, checked_out_at, heartbeat_deadline) VALUES (?, ?, ?, ?, ?, 'live', ?, ?)",
  ).run("DEFAULT", "DEFAULT", fingerprint, "stale", "i0", NOW - 5000, NOW - 1);
  // Under pool 1, a fresh checkout still succeeds because the stale seat is not live.
  assert.equal(checkout(db, "s1", 1), true);
  assert.equal(checkout(db, "s2", 1), false, "now at the live cap");
  assert.equal(liveCount(db), 1);
  db.close();
});

test("release frees a seat", () => {
  const db = freshDb();
  assert.equal(checkout(db, "s1", 2), true);
  assert.equal(checkout(db, "s2", 2), true);
  assert.equal(checkout(db, "s3", 2), false);
  db.prepare("DELETE FROM seat_checkouts WHERE license_fingerprint = ? AND seat_id = ?").run(fingerprint, "s1");
  assert.equal(checkout(db, "s3", 2), true, "released seat freed capacity");
  db.close();
});

test("heartbeat keeps a seat live past its original deadline", () => {
  const db = freshDb();
  // A seat about to expire.
  assert.equal(checkout(db, "s1", 1, { deadline: NOW + 10 }), true);
  // Heartbeat refreshes the deadline (the worker's UPDATE).
  const refreshed = db
    .prepare(
      "UPDATE seat_checkouts SET heartbeat_deadline = ? WHERE license_fingerprint = ? AND seat_id = ? AND mode = 'live' AND heartbeat_deadline > ? RETURNING seat_id",
    )
    .get(NOW + GRACE, fingerprint, "s1", NOW + 5);
  assert.notEqual(refreshed, undefined, "heartbeat refreshed the live seat");
  // Far past the original deadline, still live, so the pool stays full.
  assert.equal(liveCount(db, NOW + 100), 1);
  assert.equal(checkout(db, "s2", 1, { now: NOW + 100, deadline: NOW + 100 + GRACE }), false);
  db.close();
});

test("a borrowed seat counts against the pool until it expires", () => {
  const db = freshDb();
  // Borrow a seat for a long offline window under pool 1.
  assert.equal(checkout(db, "b1", 1, { mode: "borrowed", deadline: NOW + 30 * 86400 }), true);
  // A live checkout is denied while the borrow holds the only seat.
  assert.equal(checkout(db, "s1", 1), false, "borrowed seat occupies the pool");
  assert.equal(liveCount(db), 1);
  db.close();
});
