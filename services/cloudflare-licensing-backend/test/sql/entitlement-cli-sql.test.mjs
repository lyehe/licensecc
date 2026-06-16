// Executable coverage for the break-glass CLI SQL (GAP-3). The other CLI tests only regex-assert the SQL
// string; this suite EXECUTES sqlFor() output against a real SQLite database built from the shared
// migrations, proving the load-bearing runtime behaviors: the revoked-terminal guard actually applies zero
// changes and writes zero audit events, --allow-revoked-override reactivates with a distinct event,
// revocation_seq increments monotonically, and disable/reenable stay guarded against revoked rows.
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`; it is kept out
// of the default `test/*.mjs` glob so the hermetic unit suite needs no experimental flag.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { sqlFor } from "../../scripts/entitlement.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");
const fingerprint = "a".repeat(64);

function freshDb() {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return db;
}

function seed(db, status, seq) {
  db.exec(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, " +
      "assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, created_at, updated_at) VALUES " +
      `('DEFAULT', 'DEFAULT', '${fingerprint}', '', '${status}', 300, 300, ${seq}, unixepoch(), unixepoch())`,
  );
}

function entitlement(db) {
  return db
    .prepare("SELECT status, revocation_seq, customer_id, license_id FROM entitlements WHERE license_fingerprint = ?")
    .get(fingerprint);
}

function eventCount(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE license_fingerprint = ?").get(fingerprint).c;
}

function lastEvent(db) {
  return db
    .prepare(
      "SELECT event_type, status, revocation_seq, actor_type, source FROM entitlement_events " +
        "WHERE license_fingerprint = ? ORDER BY id DESC LIMIT 1",
    )
    .get(fingerprint);
}

test("upsert on a revoked row changes nothing and writes no audit event", () => {
  const db = freshDb();
  seed(db, "revoked", 5);
  db.exec(sqlFor("upsert", { fingerprint, actor: "op", status: "active" }));
  assert.equal(entitlement(db).status, "revoked");
  assert.equal(entitlement(db).revocation_seq, 5);
  assert.equal(eventCount(db), 0);
  db.close();
});

test("upsert --allow-revoked-override reactivates a revoked row with a revoked-override cli event", () => {
  const db = freshDb();
  seed(db, "revoked", 5);
  db.exec(
    sqlFor("upsert", { fingerprint, actor: "op", status: "active", reason: "ticket", "allow-revoked-override": true }),
  );
  const row = entitlement(db);
  assert.equal(row.status, "active");
  assert.equal(row.revocation_seq, 6);
  const event = lastEvent(db);
  assert.equal(event.event_type, "revoked-override");
  assert.equal(event.actor_type, "cli");
  assert.equal(event.source, "cli");
  assert.equal(event.revocation_seq, 6);
  db.close();
});

test("create via upsert inserts the row, its metadata, and exactly one event", () => {
  const db = freshDb();
  db.exec(sqlFor("upsert", { fingerprint, actor: "op", "customer-id": "cus_1", "license-id": "lic_1" }));
  const row = entitlement(db);
  assert.equal(row.status, "active");
  assert.equal(row.revocation_seq, 1);
  assert.equal(row.customer_id, "cus_1");
  assert.equal(row.license_id, "lic_1");
  assert.equal(eventCount(db), 1);
  assert.equal(lastEvent(db).event_type, "upsert");
  db.close();
});

test("upsert on an active row updates it and bumps revocation_seq by one", () => {
  const db = freshDb();
  seed(db, "active", 5);
  db.exec(sqlFor("upsert", { fingerprint, actor: "op", status: "disabled", reason: "support" }));
  assert.equal(entitlement(db).status, "disabled");
  assert.equal(entitlement(db).revocation_seq, 6);
  assert.equal(eventCount(db), 1);
  db.close();
});

test("disable then revoke increments revocation_seq monotonically; reenable is blocked once revoked", () => {
  const db = freshDb();
  db.exec(sqlFor("upsert", { fingerprint, actor: "op" })); // seq 1, active
  db.exec(sqlFor("disable", { fingerprint, actor: "op", reason: "x" })); // seq 2, disabled
  db.exec(sqlFor("revoke", { fingerprint, actor: "op", reason: "y" })); // seq 3, revoked (terminal)
  assert.equal(entitlement(db).status, "revoked");
  assert.equal(entitlement(db).revocation_seq, 3);
  db.exec(sqlFor("reenable", { fingerprint, actor: "op" })); // guarded: no change, no event
  assert.equal(entitlement(db).status, "revoked");
  assert.equal(entitlement(db).revocation_seq, 3);
  assert.equal(eventCount(db), 3);
  db.close();
});
