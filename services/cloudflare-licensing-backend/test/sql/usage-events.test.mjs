// End-to-end coverage for usage analytics over real SQLite: insert usage_events through the
// shared migrations, run the report query the Worker uses, and confirm the aggregation
// (peak concurrent, denials, denial rate, unique devices) plus the windowed baseline.
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { summarizeUsage } from "../../src/lease/usage_report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");
const fingerprint = "a".repeat(64);

const REPORT_SQL =
  "SELECT event_type, device_key_id, ts FROM usage_events WHERE project = ? AND feature = ? AND license_fingerprint = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return db;
}

function emit(db, eventType, ts, { seatId = null, device = null, reason = null } = {}) {
  db.prepare(
    "INSERT INTO usage_events (project, feature, license_fingerprint, event_type, seat_id, device_key_id, reason, ts) VALUES ('DEFAULT','DEFAULT',?,?,?,?,?,?)",
  ).run(fingerprint, eventType, seatId, device, reason, ts);
}

function report(db, from, to) {
  return db.prepare(REPORT_SQL).all("DEFAULT", "DEFAULT", fingerprint, from, to);
}

test("aggregates peak / denials / unique devices from the event log", () => {
  const db = freshDb();
  emit(db, "checkout", 10, { seatId: "s1", device: "d1" });
  emit(db, "checkout", 20, { seatId: "s2", device: "d2" });
  emit(db, "denied", 25, { reason: "pool_exhausted" });
  emit(db, "release", 30, { seatId: "s1" });
  emit(db, "checkout", 35, { seatId: "s3", device: "d1" }); // d1 again -> 2 unique
  emit(db, "reclaim", 40, { seatId: "s2" });

  const s = summarizeUsage(report(db, 0, 1000));
  assert.equal(s.peak_concurrent, 2);
  assert.equal(s.checkouts, 3);
  assert.equal(s.releases, 2);
  assert.equal(s.denials, 1);
  assert.equal(s.denial_rate, 0.25);
  assert.equal(s.unique_devices, 2);
  db.close();
});

test("peak reflects genuine concurrency, not just totals", () => {
  const db = freshDb();
  // Three checkouts that never overlap (each released before the next): peak should be 1.
  emit(db, "checkout", 10, { seatId: "s1", device: "d1" });
  emit(db, "release", 11, { seatId: "s1" });
  emit(db, "checkout", 20, { seatId: "s2", device: "d2" });
  emit(db, "release", 21, { seatId: "s2" });
  emit(db, "checkout", 30, { seatId: "s3", device: "d3" });
  emit(db, "release", 31, { seatId: "s3" });
  const s = summarizeUsage(report(db, 0, 1000));
  assert.equal(s.peak_concurrent, 1, "serial usage peaks at 1 even with 3 checkouts");
  assert.equal(s.checkouts, 3);
  db.close();
});

test("windowed report uses a baseline of seats open before the window", () => {
  const db = freshDb();
  // Two seats taken before the window (t < 100), one released before it.
  emit(db, "checkout", 10, { seatId: "s1", device: "d1" });
  emit(db, "checkout", 20, { seatId: "s2", device: "d2" });
  emit(db, "release", 30, { seatId: "s1" }); // s1 closed before the window
  // Inside the window [100, 200]: s2 still held, a third checked out.
  emit(db, "checkout", 120, { seatId: "s3", device: "d3" });

  // Baseline = checkouts(<100) - ends(<100) = 2 - 1 = 1 (s2 still open at the window start).
  const baselineRow = db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM usage_events WHERE license_fingerprint=? AND event_type='checkout' AND ts < ?) - " +
        "(SELECT COUNT(*) FROM usage_events WHERE license_fingerprint=? AND event_type IN ('release','reclaim') AND ts < ?) AS b",
    )
    .get(fingerprint, 100, fingerprint, 100);
  assert.equal(baselineRow.b, 1);

  const s = summarizeUsage(report(db, 100, 200), baselineRow.b);
  // Baseline 1 (s2) + the s3 checkout at 120 -> peak 2 inside the window.
  assert.equal(s.peak_concurrent, 2);
  db.close();
});
