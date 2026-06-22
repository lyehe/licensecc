// Executable coverage for the atomic device-rebind cap (review MUST-FIX #3: the
// check-then-insert TOCTOU). Runs the EXACT worker SQL (LEASE_ISSUANCE_ATOMIC_SQL)
// against a real SQLite built from the shared migrations, proving the load-bearing
// behavior: at most max_active_devices DISTINCT devices land within the rebind
// window, renewing an already-bound device never consumes cap, and issuances
// outside the window do not count. Because the cap is evaluated and written in ONE
// statement, sequential inserts that would defeat a check-then-insert are denied.
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { LEASE_ISSUANCE_ATOMIC_SQL } from "../../src/lease/issuance_sql.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");
const fingerprint = "a".repeat(64);
const LEASE_KEY_ID = `sha256:${"e".repeat(64)}`;
const WINDOW_SEC = 7776000; // 90 days

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  db.exec(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, " +
      "assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, created_at, updated_at) VALUES " +
      `('DEFAULT', 'DEFAULT', '${fingerprint}', '', 'active', 300, 300, 0, unixepoch(), unixepoch())`,
  );
  return db;
}

function deviceId(label) {
  return `sha256:${label.repeat(64).slice(0, 64)}`;
}

// Returns true iff the atomic insert landed a row (i.e., the cap allowed it).
function issue(db, device, maxDevices, { now = Math.floor(Date.now() / 1000), requestId = null } = {}) {
  const windowStart = now - WINDOW_SEC;
  const row = db.prepare(LEASE_ISSUANCE_ATOMIC_SQL).get(
    "DEFAULT", "DEFAULT", fingerprint, device, LEASE_KEY_ID, now, now - 2 * 86400, now + 2592000, requestId,
    "DEFAULT", "DEFAULT", fingerprint, windowStart, device, maxDevices,
  );
  return row !== undefined;
}

function distinctDevicesInWindow(db, now = Math.floor(Date.now() / 1000)) {
  return db
    .prepare(
      "SELECT COUNT(DISTINCT device_key_id) AS c FROM lease_issuance WHERE license_fingerprint = ? AND issued_at >= ?",
    )
    .get(fingerprint, now - WINDOW_SEC).c;
}

test("caps DISTINCT devices at max_active_devices", () => {
  const db = freshDb();
  const a = deviceId("a");
  const b = deviceId("b");
  const c = deviceId("c");
  assert.equal(issue(db, a, 2), true, "first device binds");
  assert.equal(issue(db, b, 2), true, "second device binds (cap 2)");
  assert.equal(issue(db, c, 2), false, "third device is capped");
  assert.equal(distinctDevicesInWindow(db), 2, "exactly two distinct devices landed");
  db.close();
});

test("renewing an already-bound device never consumes cap", () => {
  const db = freshDb();
  const a = deviceId("a");
  const b = deviceId("b");
  assert.equal(issue(db, a, 1), true, "device A binds (cap 1)");
  assert.equal(issue(db, a, 1), true, "device A renews (same device, allowed)");
  assert.equal(issue(db, a, 1), true, "device A renews again");
  assert.equal(issue(db, b, 1), false, "a second distinct device is denied at cap 1");
  assert.equal(issue(db, a, 1), true, "device A still renews after B was denied");
  assert.equal(distinctDevicesInWindow(db), 1, "only one distinct device ever bound");
  db.close();
});

test("sequential new-device inserts cannot exceed the cap (no check-then-insert gap)", () => {
  const db = freshDb();
  // Five distinct devices attempt to bind under cap 2; only the first two may land,
  // because each insert re-evaluates COUNT(DISTINCT ...) atomically in the same statement.
  const results = ["a", "b", "c", "d", "f"].map((label) => issue(db, deviceId(label), 2));
  assert.deepEqual(results, [true, true, false, false, false]);
  assert.equal(distinctDevicesInWindow(db), 2);
  db.close();
});

test("issuances outside the rebind window do not count against the cap", () => {
  const db = freshDb();
  const now = Math.floor(Date.now() / 1000);
  const old = deviceId("a");
  // Directly seed an OLD issuance for device A (200 days ago, outside the 90-day window).
  db.prepare(
    "INSERT INTO lease_issuance (project, feature, license_fingerprint, device_key_id, lease_key_id, issued_at, valid_from, valid_to, request_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("DEFAULT", "DEFAULT", fingerprint, old, LEASE_KEY_ID, now - 200 * 86400, now - 200 * 86400, now - 170 * 86400, null);

  // A brand-new device binds under cap 1 because the old A is outside the window.
  assert.equal(issue(db, deviceId("b"), 1, { now }), true, "new device binds; out-of-window history ignored");
  // ...and now B is in-window, so a further distinct device is capped.
  assert.equal(issue(db, deviceId("c"), 1, { now }), false, "cap re-applies within the window");
  db.close();
});
