// Real-SQLite integration for metered consumption + quota (audit R6.3). Drives the EXACT meterUsage
// the Worker's POST /v1/meter runs, against an in-memory SQLite built from the shared migrations.
// Asserts: units accumulate within a rolling period; a new period starts a fresh counter; meter_quota
// enforcement rejects the over-quota increment atomically (nothing recorded); the owner conjunct
// isolates a customer from another's entitlement; invalid units and inactive entitlements are refused.
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { meterUsage } from "../../src/lease/metering.mjs";
import { setEntitlementCapacity } from "../../src/entitlements/entitlement_mutation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");
const FP = "a".repeat(64);
const NOW = 1_000_000;
const PERIOD = 2_592_000; // default meter_period_sec (30d)

class PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...values) {
    const next = new PreparedStatement(this.db, this.sql);
    next.params = values.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
    return next;
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
  async run() {
    this.db.prepare(this.sql).all(...this.params);
    return { success: true };
  }
}

class D1Like {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new PreparedStatement(this.db, sql);
  }
  async batch(statements) {
    const out = [];
    this.db.exec("BEGIN");
    try {
      for (const s of statements) out.push({ results: this.db.prepare(s.sql).all(...s.params), success: true });
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return db;
}

function seed(db, { customer_id = null, status = "active", meter_quota = 0, valid_from = null, valid_until = null } = {}) {
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, customer_id, device_hash, status, " +
      "assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, meter_quota, valid_from, valid_until, created_at, updated_at) " +
      "VALUES ('P','F',?,?,'',?,300,300,0,?,?,?,?,?)",
  ).run(FP, customer_id, status, meter_quota, valid_from, valid_until, NOW, NOW);
}

const KEY = { project: "P", feature: "F", license_fingerprint: FP };
const OFF = { mode: "off", customerId: null };

test("units accumulate within a rolling period (R6.3)", async () => {
  const db = freshDb();
  seed(db);
  const env = { DB: new D1Like(db) };

  const r1 = await meterUsage(env, KEY, OFF, 3, NOW);
  assert.equal(r1.ok, true);
  assert.equal(r1.units_consumed, 3);
  assert.equal(r1.period_start, 0);
  assert.equal(r1.period_end, PERIOD);

  const r2 = await meterUsage(env, KEY, OFF, 4, NOW + 10);
  assert.equal(r2.ok, true);
  assert.equal(r2.units_consumed, 7, "second call adds to the same period");
  db.close();
});

test("a new period starts a fresh counter (R6.3)", async () => {
  const db = freshDb();
  seed(db);
  const env = { DB: new D1Like(db) };

  await meterUsage(env, KEY, OFF, 5, NOW);
  const rolled = await meterUsage(env, KEY, OFF, 2, NOW + PERIOD); // next period bucket
  assert.equal(rolled.ok, true);
  assert.equal(rolled.units_consumed, 2, "rolls over -> fresh counter");
  assert.equal(rolled.period_start, PERIOD);
  db.close();
});

test("meter_quota rejects the over-quota increment atomically (R6.3)", async () => {
  const db = freshDb();
  seed(db, { meter_quota: 5 });
  const env = { DB: new D1Like(db) };

  assert.equal((await meterUsage(env, KEY, OFF, 3, NOW)).units_consumed, 3);

  const over = await meterUsage(env, KEY, OFF, 3, NOW); // 3 + 3 = 6 > 5 -> reject
  assert.equal(over.ok, false);
  assert.equal(over.code, "quota_exceeded");
  assert.equal(over.units_consumed, 3, "rejected increment records nothing");
  assert.equal(over.quota, 5);

  const fits = await meterUsage(env, KEY, OFF, 2, NOW); // 3 + 2 = 5 <= 5 -> ok
  assert.equal(fits.ok, true);
  assert.equal(fits.units_consumed, 5);

  const atCap = await meterUsage(env, KEY, OFF, 1, NOW); // 5 + 1 = 6 > 5 -> reject
  assert.equal(atCap.code, "quota_exceeded");
  assert.equal(atCap.units_consumed, 5);
  db.close();
});

test("the owner conjunct isolates a customer from another's entitlement (R6.3)", async () => {
  const db = freshDb();
  seed(db, { customer_id: "cust-A" });
  const env = { DB: new D1Like(db) };

  // required mode: the wrong owner sees no entitlement.
  const wrong = await meterUsage(env, KEY, { mode: "required", customerId: "cust-B" }, 1, NOW);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, "no_active_entitlement");

  // The rightful owner meters normally.
  const right = await meterUsage(env, KEY, { mode: "required", customerId: "cust-A" }, 1, NOW);
  assert.equal(right.ok, true);
  assert.equal(right.units_consumed, 1);
  db.close();
});

test("soft mode allows a NULL-owner entitlement; required does not (R6.3)", async () => {
  const db = freshDb();
  seed(db, { customer_id: null });
  const env = { DB: new D1Like(db) };

  const soft = await meterUsage(env, KEY, { mode: "soft", customerId: "cust-A" }, 1, NOW);
  assert.equal(soft.ok, true, "soft admits a NULL-owner entitlement");

  const required = await meterUsage(env, KEY, { mode: "required", customerId: "cust-A" }, 1, NOW);
  assert.equal(required.code, "no_active_entitlement", "required rejects a NULL owner");
  db.close();
});

test("invalid units and inactive/absent entitlements are refused (R6.3)", async () => {
  const db = freshDb();
  seed(db, { status: "revoked" });
  const env = { DB: new D1Like(db) };

  assert.equal((await meterUsage(env, KEY, OFF, 0, NOW)).code, "invalid_units");
  assert.equal((await meterUsage(env, KEY, OFF, -1, NOW)).code, "invalid_units");
  assert.equal((await meterUsage(env, KEY, OFF, 1.5, NOW)).code, "invalid_units");

  // Entitlement present but revoked.
  assert.equal((await meterUsage(env, KEY, OFF, 1, NOW)).code, "no_active_entitlement");

  // Absent entitlement.
  const missing = await meterUsage(env, { ...KEY, feature: "MISSING" }, OFF, 1, NOW);
  assert.equal(missing.code, "no_active_entitlement");
  db.close();
});

test("an out-of-window entitlement is refused (R6.3)", async () => {
  const db = freshDb();
  seed(db, { valid_from: NOW + 100 }); // not yet valid
  const env = { DB: new D1Like(db) };
  assert.equal((await meterUsage(env, KEY, OFF, 1, NOW)).code, "no_active_entitlement");
  db.close();
});

// The read accessor (GET /api/admin/entitlements/:id/meter) exercises exactly this SQL: read the
// meter columns, derive the current period, then read units_consumed — WITHOUT incrementing it.
test("the read-accessor SQL reports current-period consumption without incrementing (R6.3)", async () => {
  const db = freshDb();
  seed(db, { meter_quota: 100 });
  const env = { DB: new D1Like(db) };
  await meterUsage(env, KEY, OFF, 6, NOW);

  const readMeter = () => {
    const ent = db.prepare("SELECT meter_quota, meter_period_sec FROM entitlements WHERE project=? AND feature=? AND license_fingerprint=?").get("P", "F", FP);
    const periodSec = ent.meter_period_sec > 0 ? ent.meter_period_sec : 2592000;
    const periodStart = Math.floor(NOW / periodSec) * periodSec;
    const row = db.prepare("SELECT units_consumed FROM usage_meters WHERE project=? AND feature=? AND license_fingerprint=? AND period_start=?").get("P", "F", FP, periodStart);
    return { quota: ent.meter_quota, periodStart, units: row?.units_consumed ?? 0 };
  };

  const first = readMeter();
  assert.equal(first.quota, 100);
  assert.equal(first.units, 6);
  // Reading again observes the SAME value — the accessor never mutates the counter.
  assert.equal(readMeter().units, 6);
  db.close();
});

test("units is bounded — an absurd value cannot corrupt the int64 counter (R6.3)", async () => {
  const db = freshDb();
  seed(db);
  const env = { DB: new D1Like(db) };
  // Above the per-call cap, and beyond MAX_SAFE_INTEGER -> rejected, not written.
  assert.equal((await meterUsage(env, KEY, OFF, 1_000_000_001, NOW)).code, "invalid_units");
  assert.equal((await meterUsage(env, KEY, OFF, 1e20, NOW)).code, "invalid_units");
  assert.equal((await meterUsage(env, KEY, OFF, Number.MAX_SAFE_INTEGER, NOW)).code, "invalid_units");
  // The cap boundary itself is allowed.
  assert.equal((await meterUsage(env, KEY, OFF, 1_000_000_000, NOW)).ok, true);
  db.close();
});

// The HIGH gap the completeness critic found: the quota was enforceable but not CONFIGURABLE through
// any supported surface. Proves it is now settable via the capacity chokepoint (order-ingest / admin).
test("meter_quota is configurable via setEntitlementCapacity and then enforced (R6.3)", async () => {
  const db = freshDb();
  seed(db); // default meter_quota = 0 (count-only)
  const env = { DB: new D1Like(db) };
  const ctx = { actor: { subject: "op", email: "op@x.test", role: "admin", actorType: "access" }, requestId: "r1", ip: "", idempotencyKey: null, source: "admin" };

  // Count-only initially: a large call is allowed.
  assert.equal((await meterUsage(env, KEY, OFF, 8, NOW)).ok, true);

  // Operator sets a quota through the supported capacity path.
  const set = await setEntitlementCapacity(env, KEY, { meter_quota: 10, meter_period_sec: 3600 }, ctx, null);
  assert.notEqual(set, null);
  assert.equal(db.prepare("SELECT meter_quota FROM entitlements WHERE license_fingerprint = ?").get(FP).meter_quota, 10);

  // The next period now enforces the quota that was configured (period_sec=3600 -> a fresh bucket).
  const later = NOW + 3600;
  assert.equal((await meterUsage(env, KEY, OFF, 7, later)).ok, true); // 7 <= 10
  const over = await meterUsage(env, KEY, OFF, 5, later); // 7 + 5 = 12 > 10 -> rejected
  assert.equal(over.code, "quota_exceeded");
  assert.equal(over.units_consumed, 7);
  db.close();
});
