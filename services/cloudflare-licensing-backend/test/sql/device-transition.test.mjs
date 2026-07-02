// Real-SQLite integration for per-device revoke/disable/reenable (audit R6.5 / closes R6.1).
// Drives the EXACT transitionEntitlementDevice + listEntitlementDevices the admin worker's
// /api/admin/entitlements/{id}/devices endpoints run, against an in-memory SQLite built from the
// shared migrations. Asserts: a transition flips ONE device's status, bumps the entitlement's
// revocation_seq, and writes a constraint-safe event_type='update' audit row with a device detail —
// all atomically; revoke is terminal; a missing device / entitlement is refused; a same-status call
// is an idempotent no-op (no seq bump, no event). Requires node:sqlite (Node >= 22). Run via test:sql.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { transitionEntitlementDevice, listEntitlementDevices } from "../../src/entitlements/entitlement_mutation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");
const FP = "a".repeat(64);
const DEVICE = `sha256:${"b".repeat(64)}`;
const DEVICE2 = `sha256:${"c".repeat(64)}`;
const NOW = 1_700_000_000;
const KEY = { project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP };

function normalizeParam(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}
class PreparedStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...values) { const n = new PreparedStatement(this.db, this.sql); n.params = values.map(normalizeParam); return n; }
  async first() { const r = this.db.prepare(this.sql).get(...this.params); return r === undefined ? null : r; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() { this.db.prepare(this.sql).all(...this.params); return { success: true }; }
}
class D1Like {
  constructor(db) { this.db = db; }
  prepare(sql) { return new PreparedStatement(this.db, sql); }
  async batch(statements) {
    const out = [];
    this.db.exec("BEGIN");
    try {
      for (const s of statements) out.push({ results: this.db.prepare(s.sql).all(...s.params), success: true });
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return out;
  }
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, f), "utf8"));
  }
  db.exec(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, created_at, updated_at) " +
      `VALUES ('DEFAULT', 'DEFAULT', '${FP}', '', 'active', 300, 300, 0, ${NOW}, ${NOW})`,
  );
  return db;
}

function addDevice(db, deviceKeyId, status = "active") {
  db.prepare(
    "INSERT INTO entitlement_devices (project, feature, license_fingerprint, device_key_id, public_key_spki_der_base64, status, created_at, updated_at) VALUES ('DEFAULT','DEFAULT',?,?,'pk',?,?,?)",
  ).run(FP, deviceKeyId, status, NOW, NOW);
}

function ctx() {
  return { actor: { subject: "op", email: "op@x.test", role: "admin", actorType: "access" }, requestId: "req1", ip: "", idempotencyKey: null, source: "admin" };
}

function deviceStatus(db, deviceKeyId) {
  return db.prepare("SELECT status FROM entitlement_devices WHERE license_fingerprint = ? AND device_key_id = ?").get(FP, deviceKeyId)?.status;
}
function entitlementSeq(db) {
  return db.prepare("SELECT revocation_seq FROM entitlements WHERE license_fingerprint = ?").get(FP).revocation_seq;
}
function latestEvent(db) {
  return db.prepare("SELECT event_type, detail FROM entitlement_events WHERE license_fingerprint = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(FP);
}
function eventCount(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE license_fingerprint = ?").get(FP).c;
}

test("revoke a device flips status, bumps revocation_seq, writes a constraint-safe audit event (R6.5)", async () => {
  const db = freshDb();
  addDevice(db, DEVICE);
  const env = { DB: new D1Like(db) };

  const result = await transitionEntitlementDevice(env, KEY, DEVICE, "revoked", "chargeback", ctx(), null);
  assert.notEqual(result, null);
  assert.equal(deviceStatus(db, DEVICE), "revoked");
  assert.equal(entitlementSeq(db), 1, "revocation_seq bumped so caches invalidate on next check");
  const ev = latestEvent(db);
  assert.equal(ev.event_type, "update", "device events reuse the constraint-safe 'update' type");
  assert.match(ev.detail, /^device-revoke sha256:bbbbbbbb\.\.\.: chargeback$/);
  db.close();
});

test("disable then reenable a device round-trips status and bumps seq each time (R6.5)", async () => {
  const db = freshDb();
  addDevice(db, DEVICE);
  const env = { DB: new D1Like(db) };

  await transitionEntitlementDevice(env, KEY, DEVICE, "disabled", "audit", ctx(), null);
  assert.equal(deviceStatus(db, DEVICE), "disabled");
  assert.equal(entitlementSeq(db), 1);

  await transitionEntitlementDevice(env, KEY, DEVICE, "active", "", ctx(), null);
  assert.equal(deviceStatus(db, DEVICE), "active");
  assert.equal(entitlementSeq(db), 2, "reenable also bumps the seq");
  assert.match(latestEvent(db).detail, /^device-reenable /);
  db.close();
});

test("revoke is terminal: a revoked device cannot be disabled or reenabled (R6.5)", async () => {
  const db = freshDb();
  addDevice(db, DEVICE, "revoked");
  const env = { DB: new D1Like(db) };
  await assert.rejects(() => transitionEntitlementDevice(env, KEY, DEVICE, "disabled", "x", ctx(), null), /device_revoked_terminal/);
  await assert.rejects(() => transitionEntitlementDevice(env, KEY, DEVICE, "active", "x", ctx(), null), /device_revoked_terminal/);
  db.close();
});

test("a same-status transition is an idempotent no-op — no seq bump, no event (R6.5)", async () => {
  const db = freshDb();
  addDevice(db, DEVICE, "disabled");
  const env = { DB: new D1Like(db) };
  const before = eventCount(db);
  const result = await transitionEntitlementDevice(env, KEY, DEVICE, "disabled", "x", ctx(), null);
  assert.notEqual(result, null);
  assert.equal(entitlementSeq(db), 0, "no status change -> no revocation_seq bump");
  assert.equal(eventCount(db), before, "no audit event for a no-op");
  db.close();
});

test("a missing device throws device_not_found; a missing entitlement returns null (R6.5)", async () => {
  const db = freshDb();
  addDevice(db, DEVICE);
  const env = { DB: new D1Like(db) };
  await assert.rejects(() => transitionEntitlementDevice(env, KEY, DEVICE2, "revoked", "x", ctx(), null), /device_not_found/);
  const missingEnt = await transitionEntitlementDevice(env, { ...KEY, feature: "NOPE" }, DEVICE, "revoked", "x", ctx(), null);
  assert.equal(missingEnt, null);
  db.close();
});

test("listEntitlementDevices returns the entitlement's devices (R6.5)", async () => {
  const db = freshDb();
  addDevice(db, DEVICE);
  addDevice(db, DEVICE2, "revoked");
  const env = { DB: new D1Like(db) };
  const devices = await listEntitlementDevices(env, KEY);
  assert.equal(devices.length, 2);
  const byId = Object.fromEntries(devices.map((d) => [d.device_key_id, d.status]));
  assert.equal(byId[DEVICE], "active");
  assert.equal(byId[DEVICE2], "revoked");
  db.close();
});
