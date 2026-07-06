import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { applyPlanProjection, previewPlanProjection } from "../../src/catalog/plan_projection.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");
const FP = "b".repeat(64);
const NOW = 1_700_000_000;
const SUPPORT_UNTIL = NOW + 31_536_000;

function normalizeParam(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

class PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...values) {
    const next = new PreparedStatement(this.db, this.sql);
    next.params = values.map(normalizeParam);
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
      for (const statement of statements) {
        out.push({ results: this.db.prepare(statement.sql).all(...statement.params), success: true });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return out;
  }
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

function ctx() {
  return {
    actor: { subject: "admin", email: "admin@example.test", role: "admin", actorType: "access" },
    requestId: "req-plan",
    ip: "",
    idempotencyKey: null,
    source: "admin",
  };
}

function seedPolicy(db, id, overrides = {}) {
  const policy = {
    project: "DEFAULT",
    name: id,
    type: "subscription",
    status: "active",
    valid_from_offset_sec: null,
    duration_sec: null,
    assertion_ttl_seconds: 600,
    pool_size: 0,
    max_active_devices: 1,
    max_borrow_sec: 0,
    expiry_strategy: "non_expiring",
    trial_expiration_basis: "from_issue",
    trial_duration_sec: 0,
    trial_one_per_device: 0,
    trial_require_device_proof: 0,
    notes: "",
    meter_quota: 0,
    meter_period_sec: 2592000,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO entitlement_policies
      (id, project, name, type, status, valid_from_offset_sec, duration_sec, assertion_ttl_seconds,
       pool_size, max_active_devices, max_borrow_sec, expiry_strategy, trial_expiration_basis,
       trial_duration_sec, trial_one_per_device, trial_require_device_proof, notes, created_at,
       updated_at, meter_quota, meter_period_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    policy.project,
    policy.name,
    policy.type,
    policy.status,
    policy.valid_from_offset_sec,
    policy.duration_sec,
    policy.assertion_ttl_seconds,
    policy.pool_size,
    policy.max_active_devices,
    policy.max_borrow_sec,
    policy.expiry_strategy,
    policy.trial_expiration_basis,
    policy.trial_duration_sec,
    policy.trial_one_per_device,
    policy.trial_require_device_proof,
    policy.notes,
    NOW,
    NOW,
    policy.meter_quota,
    policy.meter_period_sec,
  );
}

function seedCatalog(db) {
  seedPolicy(db, "pol_node");
  seedPolicy(db, "pol_float", { pool_size: 5, max_active_devices: 5, max_borrow_sec: 86400, meter_quota: 1000, meter_period_sec: 3600 });

  const feature = db.prepare(
    "INSERT INTO catalog_features (id, project, feature_key, name, description, category, status, created_at, updated_at) VALUES (?, 'DEFAULT', ?, ?, '', '', 'active', ?, ?)",
  );
  feature.run("feat_core", "core", "Core", NOW, NOW);
  feature.run("feat_export", "export", "Export", NOW, NOW);
  feature.run("feat_team", "team", "Team Seats", NOW, NOW);

  const plan = db.prepare(
    "INSERT INTO catalog_plans (id, project, plan_key, name, status, version, description, created_at, updated_at) VALUES (?, 'DEFAULT', ?, ?, 'active', 1, '', ?, ?)",
  );
  plan.run("plan_basic", "basic", "Basic", NOW, NOW);
  plan.run("plan_pro", "pro", "Pro", NOW, NOW);

  const planFeature = db.prepare(
    `INSERT INTO catalog_plan_features
      (project, plan_id, feature_key, feature_inclusion, addon_key, policy_id, status, display_order,
       assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, meter_quota, meter_period_sec,
       created_at, updated_at)
     VALUES ('DEFAULT', ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  planFeature.run("plan_basic", "core", "included", null, "pol_node", 1, null, null, null, null, null, null, NOW, NOW);
  planFeature.run("plan_pro", "core", "included", null, "pol_node", 1, null, null, null, null, null, null, NOW, NOW);
  planFeature.run("plan_pro", "export", "included", null, "pol_node", 2, null, null, null, null, null, null, NOW, NOW);
  planFeature.run("plan_pro", "team", "addon", "team_seats", "pol_float", 3, null, 7, 7, 172800, 2500, 7200, NOW, NOW);
}

function projectionInput(overrides = {}) {
  return {
    project: "DEFAULT",
    license_id: "lic_1",
    license_fingerprint: FP,
    customer_id: "cus_1",
    plan_key: "pro",
    support_until: SUPPORT_UNTIL,
    addons: ["team_seats"],
    ...overrides,
  };
}

test("previewPlanProjection is non-mutating and classifies plan + add-on creates", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };

  const preview = await previewPlanProjection(env, projectionInput(), NOW);
  assert.equal(preview.summary.create, 3);
  assert.equal(preview.summary.update, 0);
  assert.equal(preview.summary.disable, 0);
  assert.deepEqual(preview.will_create.map((row) => row.feature), ["core", "export", "team"]);
  assert.equal(preview.will_create.find((row) => row.feature === "team").license_mode, "floating");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
});

test("applyPlanProjection creates stamped concrete entitlements and records assignment", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };

  const result = await applyPlanProjection(env, projectionInput(), ctx(), NOW);
  assert.equal(result.applied.created.length, 3);
  assert.equal(result.applied.updated.length, 0);
  assert.equal(result.applied.disabled.length, 0);

  const rows = db
    .prepare("SELECT feature, status, policy_id, pool_size, max_active_devices, max_borrow_sec, meter_quota, meter_period_sec, valid_until FROM entitlements WHERE license_fingerprint = ? ORDER BY feature")
    .all(FP);
  assert.deepEqual(rows.map((row) => row.feature), ["core", "export", "team"]);
  assert.equal(rows.find((row) => row.feature === "core").policy_id, "pol_node");
  const team = rows.find((row) => row.feature === "team");
  assert.equal(team.policy_id, "pol_float");
  assert.equal(team.pool_size, 7);
  assert.equal(team.max_active_devices, 7);
  assert.equal(team.max_borrow_sec, 172800);
  assert.equal(team.meter_quota, 2500);
  assert.equal(team.meter_period_sec, 7200);
  assert.equal(team.valid_until, SUPPORT_UNTIL);

  const assignment = db.prepare("SELECT plan_id, customer_id, support_until, addons_json FROM license_plan_assignments WHERE license_id = ? AND project = 'DEFAULT'").get("lic_1");
  assert.equal(assignment.plan_id, "plan_pro");
  assert.equal(assignment.customer_id, "cus_1");
  assert.equal(assignment.support_until, SUPPORT_UNTIL);
  assert.deepEqual(JSON.parse(assignment.addons_json), ["team_seats"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE license_fingerprint = ?").get(FP).c, 3);
});

test("plan downgrade disables catalog-managed features that are no longer desired", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };
  await applyPlanProjection(env, projectionInput(), ctx(), NOW);

  const downgrade = projectionInput({ plan_key: "basic", addons: [] });
  const preview = await previewPlanProjection(env, downgrade, NOW);
  assert.equal(preview.summary.create, 0);
  assert.equal(preview.summary.update, 0);
  assert.equal(preview.summary.disable, 2);
  assert.deepEqual(preview.will_disable.map((row) => row.feature), ["export", "team"]);

  const applied = await applyPlanProjection(env, downgrade, ctx(), NOW);
  assert.equal(applied.applied.disabled.length, 2);
  const statuses = db
    .prepare("SELECT feature, status FROM entitlements WHERE license_fingerprint = ? ORDER BY feature")
    .all(FP)
    .map((row) => ({ feature: row.feature, status: row.status }));
  assert.deepEqual(statuses, [
    { feature: "core", status: "active" },
    { feature: "export", status: "disabled" },
    { feature: "team", status: "disabled" },
  ]);
  assert.equal(db.prepare("SELECT plan_id FROM license_plan_assignments WHERE license_id = ? AND project = 'DEFAULT'").get("lic_1").plan_id, "plan_basic");
});

test("unknown add-on is rejected before mutating entitlements", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };

  await assert.rejects(
    () => applyPlanProjection(env, projectionInput({ addons: ["missing_addon"] }), ctx(), NOW),
    /unknown_addon:missing_addon/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments").get().c, 0);
});
