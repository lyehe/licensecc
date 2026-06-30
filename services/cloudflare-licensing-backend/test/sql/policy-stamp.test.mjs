// Workstream A keystone — policy stamp mechanics on real SQLite (node:sqlite, DB from migrations).
//
// Proves: (1) stampFromPolicy is a correct pure transform (trial basis variants, non-expiring,
// override precedence, non-trial zeroing); (2) createEntitlement(..., extraStatements=[stamp]) writes
// the policy's valid-window/ttl into the entitlement AND the capacity + frozen-trial columns via the
// atomic side-write, in ONE batch; (3) the BYTE-IDENTICAL guard — createEntitlement with NO extra
// statements produces exactly the legacy row (capacity/trial at their column defaults), so the shared
// INSERT path is unchanged.
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createEntitlement } from "../../src/entitlements/entitlement_mutation.mjs";
import { stampFromPolicy, buildPolicyStampStatement } from "../../src/entitlements/policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");
const FP = "a".repeat(64);
const NOW = 1_700_000_000;

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
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(join(migrationsDir, f), "utf8"));
  return db;
}
function ctx() {
  return { actor: { subject: "op", email: "op@x.test", role: "admin", actorType: "access" }, requestId: "req1", ip: "", idempotencyKey: null, source: "admin" };
}
function policy(overrides = {}) {
  return {
    id: "pol_1", project: "DEFAULT", name: "P", type: "subscription", status: "active",
    valid_from_offset_sec: null, duration_sec: null, assertion_ttl_seconds: 300,
    pool_size: 0, max_active_devices: 1, max_borrow_sec: 0, expiry_strategy: "fixed_window",
    trial_expiration_basis: "from_issue", trial_duration_sec: 0, trial_one_per_device: 0, trial_require_device_proof: 0,
    notes: "", created_at: NOW, updated_at: NOW, ...overrides,
  };
}
const target = { project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP };

test("stampFromPolicy: trial from_issue sets a now+duration window and freezes trial state", () => {
  const p = policy({ type: "trial", trial_expiration_basis: "from_issue", trial_duration_sec: 1209600, pool_size: 2, max_active_devices: 3, trial_one_per_device: 1, trial_require_device_proof: 1 });
  const { input, capacity, trial } = stampFromPolicy(p, { ...target }, NOW);
  assert.equal(input.valid_until, NOW + 1209600);
  assert.equal(input.status, "active");
  assert.deepEqual(capacity, { pool_size: 2, max_active_devices: 3, max_borrow_sec: 0 });
  assert.deepEqual(trial, { is_trial: 1, trial_expiration_basis: "from_issue", trial_duration_sec: 1209600, trial_one_per_device: 1, trial_require_device_proof: 1 });
});

test("stampFromPolicy: trial from_first_activation leaves valid_until OPEN (clamped at activation)", () => {
  const p = policy({ type: "trial", trial_expiration_basis: "from_first_activation", trial_duration_sec: 604800 });
  const { input, trial } = stampFromPolicy(p, { ...target }, NOW);
  assert.equal(input.valid_until, null);
  assert.equal(trial.is_trial, 1);
  assert.equal(trial.trial_expiration_basis, "from_first_activation");
});

test("stampFromPolicy: non_expiring -> null window; subscription duration -> now+duration; override wins", () => {
  assert.equal(stampFromPolicy(policy({ expiry_strategy: "non_expiring", duration_sec: 999 }), { ...target }, NOW).input.valid_until, null);
  assert.equal(stampFromPolicy(policy({ duration_sec: 2592000 }), { ...target }, NOW).input.valid_until, NOW + 2592000);
  // explicit overrides beat the policy defaults
  const o = stampFromPolicy(policy({ duration_sec: 2592000, pool_size: 5 }), { ...target, valid_until: 42, pool_size: 9, assertion_ttl_seconds: 120 }, NOW);
  assert.equal(o.input.valid_until, 42);
  assert.equal(o.input.assertion_ttl_seconds, 120);
  assert.equal(o.capacity.pool_size, 9);
});

test("stampFromPolicy: non-trial zeroes the trial state", () => {
  const { trial } = stampFromPolicy(policy({ type: "node_locked" }), { ...target }, NOW);
  assert.deepEqual(trial, { is_trial: 0, trial_expiration_basis: null, trial_duration_sec: 0, trial_one_per_device: 0, trial_require_device_proof: 0 });
});

test("createEntitlement + stamp extra writes the window/ttl AND capacity/trial atomically", async () => {
  const db = freshDb();
  const env = { DB: new D1Like(db) };
  const p = policy({ type: "trial", trial_expiration_basis: "from_issue", trial_duration_sec: 1209600, assertion_ttl_seconds: 600, pool_size: 4, max_active_devices: 2, max_borrow_sec: 86400, trial_one_per_device: 1 });
  const { input, capacity, trial } = stampFromPolicy(p, { ...target, customer_id: "cus_a" }, NOW);
  const extra = buildPolicyStampStatement(env, target, p.id, capacity, trial);
  const result = await createEntitlement(env, input, ctx(), "", undefined, null, [extra]);
  assert.equal(result.data.revocation_seq, 1);
  assert.equal(result.data.assertion_ttl_seconds, 600);
  assert.equal(result.data.valid_until, NOW + 1209600);
  // The side-write columns (not in ENTITLEMENT_COLUMNS) read directly:
  const row = db.prepare("SELECT policy_id, pool_size, max_active_devices, max_borrow_sec, is_trial, trial_expiration_basis, trial_duration_sec, trial_one_per_device, trial_require_device_proof, trial_started_at FROM entitlements WHERE license_fingerprint = ?").get(FP);
  assert.equal(row.policy_id, "pol_1");
  assert.equal(row.pool_size, 4);
  assert.equal(row.max_active_devices, 2);
  assert.equal(row.max_borrow_sec, 86400);
  assert.equal(row.is_trial, 1);
  assert.equal(row.trial_expiration_basis, "from_issue");
  assert.equal(row.trial_duration_sec, 1209600);
  assert.equal(row.trial_one_per_device, 1);
  assert.equal(row.trial_started_at, null); // not activated yet
  // Exactly one audit event from the create.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE license_fingerprint = ?").get(FP).c, 1);
});

test("byte-identical guard: createEntitlement with NO extras leaves capacity/trial at column defaults", async () => {
  const db = freshDb();
  const env = { DB: new D1Like(db) };
  const result = await createEntitlement(env, { ...target, assertion_ttl_seconds: 300 }, ctx());
  assert.equal(result.data.revocation_seq, 1);
  const row = db.prepare("SELECT policy_id, pool_size, max_active_devices, max_borrow_sec, is_trial, trial_expiration_basis, trial_duration_sec FROM entitlements WHERE license_fingerprint = ?").get(FP);
  assert.equal(row.policy_id, null);
  assert.equal(row.pool_size, 0);
  assert.equal(row.max_active_devices, 1);
  assert.equal(row.max_borrow_sec, 0);
  assert.equal(row.is_trial, 0);
  assert.equal(row.trial_expiration_basis, null);
  assert.equal(row.trial_duration_sec, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE license_fingerprint = ?").get(FP).c, 1);
});
