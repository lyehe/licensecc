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
const deviceKeyId = `sha256:${"1".repeat(64)}`;
const publicKeySpkiDerBase64 = Buffer.from("test-p256-spki").toString("base64");

for (const bindingState of ["active", "retiring"]) {
  test(`CLI preserves protected ${bindingState} capacity and refuses ownership/device bypass`, t => {
    const db = freshDb(); t.after(() => db.close());
    db.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES
      ('owner','Owner',1,1),('other','Other',1,1);
      INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,enforcement_mode,
        max_active_devices,revocation_seq,created_at,updated_at)
      VALUES('DEFAULT','DEFAULT','${fingerprint}','active','owner','device_bound_v1',1,4,1,1);
      INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,created_at,last_proof_at)
      VALUES('device','owner','DEFAULT','protected-key','synthetic-public',1,1);
      INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,state,generation,revision,hold_until,created_at,updated_at)
      VALUES('binding','DEFAULT','DEFAULT','${fingerprint}','device','${bindingState}',3,4,4102444800,1,1);`);
    const binding = () => db.prepare("SELECT * FROM device_bound_bindings").get();
    const authority = () => db.prepare("SELECT * FROM entitlements").get();
    const originalBinding = binding(), originalAuthority = authority();
    assert.throws(() => db.exec(sqlFor("device-upsert", { fingerprint, actor: "operator",
      "device-key-id": deviceKeyId, "public-key-spki-der-base64": publicKeySpkiDerBase64 })), /legacy_protocol_disabled/);
    assert.throws(() => db.exec(sqlFor("upsert", { fingerprint, actor: "operator", "customer-id": "other" })), /capacity_in_use/);
    assert.deepEqual(authority(), originalAuthority);
    assert.deepEqual(binding(), originalBinding);
    assert.equal(eventCount(db), 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM entitlement_devices").get().n, 0);

    db.exec(sqlFor("upsert", { fingerprint, actor: "operator", "customer-id": "owner", "valid-until": 4102445000 }));
    assert.equal(authority().enforcement_mode, "device_bound_v1");
    assert.equal(authority().authority_revision, originalAuthority.authority_revision + 1);
    assert.equal(authority().valid_until, 4102445000);
    assert.equal(authority().max_active_devices, 1);
    db.exec(sqlFor("disable", { fingerprint, actor: "operator", reason: "support" }));
    assert.equal(authority().status, "disabled");
    db.exec(sqlFor("reenable", { fingerprint, actor: "operator" }));
    assert.equal(authority().status, "active");
    assert.equal(authority().authority_revision, originalAuthority.authority_revision + 3);
    assert.equal(authority().enforcement_mode, "device_bound_v1");
    assert.deepEqual(binding(), originalBinding);
    assert.equal(eventCount(db), 3);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });
}

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

function device(db) {
  return db
    .prepare(
      "SELECT device_key_id, public_key_spki_der_base64, status FROM entitlement_devices " +
        "WHERE license_fingerprint = ? AND device_key_id = ?",
    )
    .get(fingerprint, deviceKeyId);
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

test("device-upsert registers a request-proof key, bumps revocation_seq, and writes an update event", () => {
  const db = freshDb();
  db.exec(sqlFor("upsert", { fingerprint, actor: "op" }));
  db.exec(
    sqlFor("device-upsert", {
      fingerprint,
      "device-key-id": deviceKeyId,
      "public-key-spki-der-base64": publicKeySpkiDerBase64,
      actor: "op",
      reason: "enroll",
    }),
  );
  const row = entitlement(db);
  assert.equal(row.status, "active");
  assert.equal(row.revocation_seq, 2);
  const deviceRow = device(db);
  assert.equal(deviceRow.device_key_id, deviceKeyId);
  assert.equal(deviceRow.public_key_spki_der_base64, publicKeySpkiDerBase64);
  assert.equal(deviceRow.status, "active");
  assert.equal(eventCount(db), 2);
  const event = lastEvent(db);
  assert.equal(event.event_type, "update");
  assert.equal(event.revocation_seq, 2);
  db.close();
});

test("device-revoke changes the device state and bumps the parent revocation_seq", () => {
  const db = freshDb();
  db.exec(sqlFor("upsert", { fingerprint, actor: "op" }));
  db.exec(
    sqlFor("device-upsert", {
      fingerprint,
      "device-key-id": deviceKeyId,
      "public-key-spki-der-base64": publicKeySpkiDerBase64,
      actor: "op",
    }),
  );
  db.exec(sqlFor("device-revoke", { fingerprint, "device-key-id": deviceKeyId, actor: "op", reason: "lost" }));
  assert.equal(device(db).status, "revoked");
  assert.equal(entitlement(db).revocation_seq, 3);
  assert.equal(eventCount(db), 3);
  assert.equal(lastEvent(db).event_type, "update");
  db.close();
});

test("device-disable on an unknown device writes no audit event and does not bump revocation_seq", () => {
  const db = freshDb();
  db.exec(sqlFor("upsert", { fingerprint, actor: "op" }));
  db.exec(sqlFor("device-disable", { fingerprint, "device-key-id": deviceKeyId, actor: "op", reason: "unknown" }));
  assert.equal(device(db), undefined);
  assert.equal(entitlement(db).revocation_seq, 1);
  assert.equal(eventCount(db), 1);
  db.close();
});
