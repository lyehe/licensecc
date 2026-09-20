import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("upgrade from migration 0032 preserves populated legacy authority without enrolling or creating login identities", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  const directory = new URL("../../migrations/", import.meta.url);
  const migrations = readdirSync(directory).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort();
  const boundary = migrations.indexOf("0032_plan_projection_remediation.sql") + 1;
  assert.equal(boundary, 32);
  const apply = names => { for (const name of names) db.exec(readFileSync(new URL(name, directory), "utf8")); };
  apply(migrations.slice(0, boundary));
  db.exec(`
    INSERT INTO customers(id,name,email,metadata_json,status,created_at,updated_at) VALUES
      ('customer-a','First customer','shared@example.invalid','{"keep":"Case Sensitive"}','active',10,20),
      ('customer-b','Second customer','second@example.invalid','{}','disabled',11,21);
    INSERT INTO licenses(id,customer_id,project,label,created_at,updated_at) VALUES
      ('license-a','customer-a','APP_A','Desktop',10,20),
      ('license-b','customer-a','APP_B','Floating',11,21),
      ('license-c','customer-b','APP_A','Revoked',12,22);
    INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,license_id,
      max_active_devices,pool_size,revocation_seq,valid_until,created_at,updated_at) VALUES
      ('APP_A','PRO','fingerprint-a','active','customer-a','license-a',2,0,7,2000000000,10,20),
      ('APP_B','PRO','fingerprint-b','disabled','customer-a','license-b',1,3,9,1900000000,11,21),
      ('APP_A','PRO','fingerprint-c','revoked','customer-b','license-c',1,0,12,1800000000,12,22);
    INSERT INTO entitlement_devices(project,feature,license_fingerprint,device_key_id,
      public_key_spki_der_base64,status,created_at,updated_at,last_seen_at,notes) VALUES
      ('APP_A','PRO','fingerprint-a','legacy-key','synthetic-public-material','active',10,20,19,'Keep binding');
    INSERT INTO lease_issuance(project,feature,license_fingerprint,device_key_id,lease_key_id,
      issued_at,valid_from,valid_to,request_id) VALUES
      ('APP_A','PRO','fingerprint-a','legacy-key','legacy-signer',10,10,2000000000,'old-request');
    INSERT INTO seat_checkouts(project,feature,license_fingerprint,seat_id,client_instance_id,mode,
      checked_out_at,heartbeat_deadline) VALUES
      ('APP_B','PRO','fingerprint-b','borrowed-seat','legacy-instance','borrowed',10,1900000000);
    INSERT INTO portal_sessions(id,customer_id,session_hmac,pepper_key_id,status,created_at,expires_at) VALUES
      ('old-session','customer-a','synthetic-hmac','old-pepper','active',10,2000000000);
    INSERT INTO entitlement_events(project,feature,license_fingerprint,event_type,status,revocation_seq,detail,created_at) VALUES
      ('APP_A','PRO','fingerprint-c','revoke','revoked',12,'Retain historical outcome',1);
  `);
  const tables = ["customers", "licenses", "entitlements", "entitlement_devices", "lease_issuance",
    "seat_checkouts", "portal_sessions", "entitlement_events"];
  const snapshots = tables.map(table => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => `"${row.name}"`).join(",");
    const query = `SELECT ${columns} FROM ${table} ORDER BY rowid`;
    return { table, query, rows: db.prepare(query).all() };
  });
  apply(migrations.slice(boundary));
  for (const { table, query, rows } of snapshots) assert.deepEqual(db.prepare(query).all(), rows, table);
  assert.ok(db.prepare("SELECT enforcement_mode,authority_revision FROM entitlements").all()
    .every(row => row.enforcement_mode === "legacy" && row.authority_revision === 0));
  assert.ok(db.prepare("SELECT authority_revision FROM customers").all().every(row => row.authority_revision === 0));
  assert.equal(db.prepare("SELECT auth_method FROM portal_sessions").get().auth_method, "legacy");
  for (const table of ["device_bound_devices", "device_bound_bindings", "device_bound_leases", "portal_passwords", "portal_identities"]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.throws(() => db.prepare("UPDATE entitlements SET enforcement_mode='device_bound_v1' WHERE license_fingerprint='fingerprint-a'").run(),
    /protected_mode_migration_required/u);
  assert.equal(db.prepare("SELECT enforcement_mode FROM entitlements WHERE license_fingerprint='fingerprint-a'").get().enforcement_mode, "legacy");
  db.exec("UPDATE entitlements SET valid_until=2100000000 WHERE license_fingerprint='fingerprint-a'");
  assert.equal(db.prepare("SELECT authority_revision FROM entitlements WHERE license_fingerprint='fingerprint-a'").get().authority_revision, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});
