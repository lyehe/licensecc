import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { applyPlanProjection, previewPlanProjection } from "@licensecc/cloudflare-runtime/d1/plan_projection";

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
    this.batchSizes = [];
  }
  prepare(sql) {
    return new PreparedStatement(this.db, sql);
  }
  async batch(statements) {
    this.batchSizes.push(statements.length);
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

class FailingSecondEntitlementD1Like extends D1Like {
  constructor(db) {
    super(db);
    this.failSecondEntitlementWrite = false;
  }
  async batch(statements) {
    const out = [];
    let entitlementWrites = 0;
    this.db.exec("BEGIN");
    try {
      for (const statement of statements) {
        if (this.failSecondEntitlementWrite && /^INSERT INTO entitlements/m.test(statement.sql) && ++entitlementWrites === 2) {
          throw new Error("injected_second_entitlement_failure");
        }
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

class FailingAssignmentAuditD1Like extends D1Like {
  constructor(db) {
    super(db);
    this.failAssignmentAuditWrite = false;
  }
  async batch(statements) {
    const out = [];
    this.db.exec("BEGIN");
    try {
      for (const statement of statements) {
        if (this.failAssignmentAuditWrite && /^INSERT INTO license_plan_assignment_events/.test(statement.sql)) {
          throw new Error("injected_assignment_audit_failure");
        }
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

class RejectPreviewWritesD1Like extends D1Like {
  constructor(db) {
    super(db);
    this.writeStatements = [];
  }
  async batch(statements) {
    this.writeStatements.push(
      ...statements
        .map((statement) => statement.sql)
        .filter((sql) => /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP)\b/i.test(sql)),
    );
    if (this.writeStatements.length > 0) throw new Error("unexpected_overflow_preview_write");
    return super.batch(statements);
  }
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

function preProjectionProtocolDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql") && x < "0028_plan_projection_preview_protocol.sql").sort()) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

function ctx(overrides = {}) {
  return {
    actor: { subject: "admin", email: "admin@example.test", role: "admin", actorType: "access" },
    requestId: "req-plan",
    ip: "",
    idempotencyKey: null,
    source: "admin",
    ...overrides,
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

function seedEquivalentBasicPlan(db) {
  db.prepare(
    "INSERT INTO catalog_plans (id, project, plan_key, name, status, version, description, created_at, updated_at) VALUES ('plan_basic_equivalent', 'DEFAULT', 'basic-equivalent', 'Basic equivalent', 'active', 1, '', ?, ?)",
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO catalog_plan_features
       (project, plan_id, feature_key, feature_inclusion, addon_key, policy_id, status, display_order,
        assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, meter_quota, meter_period_sec,
        created_at, updated_at)
     SELECT project, 'plan_basic_equivalent', feature_key, feature_inclusion, addon_key, policy_id, status, display_order,
       assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, meter_quota, meter_period_sec,
       ?, ?
     FROM catalog_plan_features
     WHERE plan_id = 'plan_basic'`,
  ).run(NOW, NOW);
}

function seedAtomicPlanFeatures(db, count) {
  const feature = db.prepare(
    "INSERT INTO catalog_features (id, project, feature_key, name, description, category, status, created_at, updated_at) VALUES (?, 'DEFAULT', ?, ?, '', '', 'active', ?, ?)",
  );
  const planFeature = db.prepare(
    `INSERT INTO catalog_plan_features
      (project, plan_id, feature_key, feature_inclusion, addon_key, policy_id, status, display_order,
       assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, meter_quota, meter_period_sec,
       created_at, updated_at)
     VALUES ('DEFAULT', 'plan_pro', ?, 'included', NULL, 'pol_node', 'active', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  );
  for (let index = 0; index < count; index += 1) {
    const key = `atomic_${index}`;
    feature.run(`feat_${key}`, key, key, NOW, NOW);
    planFeature.run(key, index + 10, NOW, NOW);
  }
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

function projectionApplyState(db, previewId, idempotencyKey) {
  const cache = db.prepare(
    "SELECT cache_ttl_seconds FROM entitlements WHERE project = 'DEFAULT' AND feature = 'core' AND license_fingerprint = ?",
  ).get(FP);
  return {
    entitlements: db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(FP).c,
    cache_ttl_seconds: cache?.cache_ttl_seconds ?? null,
    entitlement_events: db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE license_fingerprint = ?").get(FP).c,
    assignment: db.prepare(
      "SELECT plan_id, license_fingerprint, customer_id, support_until, addons_json, created_at, updated_at FROM license_plan_assignments WHERE license_id = 'lic_1' AND project = 'DEFAULT'",
    ).get() ?? null,
    assignment_events: db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignment_events WHERE license_id = 'lic_1' AND project = 'DEFAULT'").get().c,
    idempotency: db.prepare("SELECT COUNT(*) AS c FROM mutation_idempotency WHERE idempotency_key = ?").get(idempotencyKey).c,
    preview: db.prepare(
      "SELECT claim_token, claimed_at, consumed_at, applied_response_json FROM license_plan_projection_previews WHERE id = ?",
    ).get(previewId),
  };
}

test("projection preview migrations upgrade a pre-0028 D1 database without rewriting catalog data", async () => {
  const db = preProjectionProtocolDb();
  seedCatalog(db);
  const catalogCount = db.prepare("SELECT COUNT(*) AS c FROM catalog_features").get().c;
  for (const file of readdirSync(migrationsDir).filter((x) => x >= "0028_plan_projection_preview_protocol.sql" && x.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }

  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM catalog_features").get().c, catalogCount);
  const generation = db.prepare("SELECT scope, generation FROM license_plan_projection_generations").get();
  assert.equal(generation.scope, "catalog");
  assert.equal(generation.generation, 0);
  const preview = await previewPlanProjection({ DB: new D1Like(db) }, projectionInput(), "admin", NOW);
  assert.match(preview.preview_id, /^ppv_/);
});

test("legacy entitlement identity fence uses the project-license-fingerprint index", () => {
  const db = freshDb();
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM entitlements e WHERE e.project = ? AND e.license_id = ? AND e.license_fingerprint <> ? LIMIT 1",
    )
    .all("DEFAULT", "lic_1", FP);
  assert.match(plan.map((row) => row.detail).join("\n"), /idx_entitlements_project_license_fingerprint/);
});

test("previewPlanProjection is non-mutating and classifies plan + add-on creates", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };

  const preview = await previewPlanProjection(env, projectionInput(), "admin", NOW);
  assert.equal(preview.summary.create, 3);
  assert.equal(preview.summary.update, 0);
  assert.equal(preview.summary.disable, 0);
  assert.deepEqual(preview.will_create.map((row) => row.feature), ["core", "export", "team"]);
  assert.equal(preview.will_create.find((row) => row.feature === "team").license_mode, "floating");
  assert.match(preview.preview_id, /^ppv_/);
  assert.equal(preview.effective_at, NOW);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
});

test("runtime Apply accepts only the canonical opaque preview-id grammar", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };
  for (const previewId of ["ppv_bad=identifier", "ppv_line\nbreak", "ppv_"]) {
    await assert.rejects(
      () => applyPlanProjection(env, previewId, ctx(), null, NOW),
      /invalid_preview_id/,
    );
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
});

test("applyPlanProjection creates stamped concrete entitlements and records assignment", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };

  const preview = await previewPlanProjection(env, projectionInput(), "admin", NOW);
  const result = await applyPlanProjection(env, preview.preview_id, ctx(), null, NOW);
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

test("a private persisted cache TTL drift becomes an update, is corrected, and is fully audited", async () => {
  const db = freshDb();
  seedCatalog(db);
  db.prepare("UPDATE entitlement_policies SET assertion_ttl_seconds = 300 WHERE id = 'pol_node'").run();
  const env = { DB: new D1Like(db) };
  const initial = await previewPlanProjection(env, projectionInput({ addons: [] }), "admin", NOW);
  await applyPlanProjection(env, initial.preview_id, ctx(), null, NOW);
  db.prepare("UPDATE entitlements SET cache_ttl_seconds = 86400 WHERE project = 'DEFAULT' AND feature = 'core' AND license_fingerprint = ?").run(FP);

  const preview = await previewPlanProjection(env, projectionInput({ addons: [] }), "admin", NOW + 1);
  assert.equal(preview.summary.update, 1);
  assert.deepEqual(preview.will_update.map((row) => row.feature), ["core"]);
  assert.equal("cache_ttl_seconds" in preview.will_update[0], false, "cache policy stays out of the public preview");
  const actions = JSON.parse(db.prepare("SELECT actions_json FROM license_plan_projection_previews WHERE id = ?").get(preview.preview_id).actions_json);
  assert.equal(actions.updated[0].cache_ttl_seconds, 300, "the internal action carries the exact desired cache policy");

  const applied = await applyPlanProjection(env, preview.preview_id, ctx(), null, NOW + 1);
  assert.equal(applied.applied.updated.length, 1);
  assert.equal("cache_ttl_seconds" in applied.applied.updated[0], false, "cache policy stays out of the public Apply response");
  assert.equal(db.prepare("SELECT cache_ttl_seconds FROM entitlements WHERE project = 'DEFAULT' AND feature = 'core' AND license_fingerprint = ?").get(FP).cache_ttl_seconds, 300);
  const audit = db.prepare("SELECT prev_json, next_json FROM entitlement_events WHERE project = 'DEFAULT' AND feature = 'core' AND license_fingerprint = ? ORDER BY id DESC LIMIT 1").get(FP);
  assert.equal(JSON.parse(audit.prev_json).cache_ttl_seconds, 86400);
  assert.equal(JSON.parse(audit.next_json).cache_ttl_seconds, 300);
});

test("current-version projection snapshots persist and apply normally", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };
  const preview = await previewPlanProjection(env, projectionInput({ plan_key: "basic", addons: [] }), "admin", NOW);
  const stored = JSON.parse(db.prepare("SELECT actions_json FROM license_plan_projection_previews WHERE id = ?").get(preview.preview_id).actions_json);
  assert.equal(stored.projection_snapshot_version, 2);

  const applied = await applyPlanProjection(env, preview.preview_id, ctx(), null, NOW);
  assert.equal(applied.applied.created.length, 1);
  assert.equal(db.prepare("SELECT cache_ttl_seconds FROM entitlements WHERE project = 'DEFAULT' AND feature = 'core' AND license_fingerprint = ?").get(FP).cache_ttl_seconds, 600);
});

test("a parent-format unchanged cache-drift preview fails closed before any projection write", async () => {
  const db = freshDb();
  seedCatalog(db);
  db.prepare("UPDATE entitlement_policies SET assertion_ttl_seconds = 300 WHERE id = 'pol_node'").run();
  const env = { DB: new D1Like(db) };
  const input = projectionInput({ plan_key: "basic", addons: [] });
  const initial = await previewPlanProjection(env, input, "admin", NOW);
  await applyPlanProjection(env, initial.preview_id, ctx(), null, NOW);
  db.prepare("UPDATE entitlements SET cache_ttl_seconds = 86400 WHERE project = 'DEFAULT' AND feature = 'core' AND license_fingerprint = ?").run(FP);

  // Model a live parent-version preview: before the cache-TTL projection fix,
  // this row was classified unchanged and carried no version discriminator.
  const legacy = await previewPlanProjection(env, input, "admin", NOW + 1);
  const row = db.prepare("SELECT projection_json, actions_json FROM license_plan_projection_previews WHERE id = ?").get(legacy.preview_id);
  const actions = JSON.parse(row.actions_json);
  assert.equal(actions.updated.length, 1, "the current implementation sees cache drift");
  actions.updated = [];
  delete actions.projection_snapshot_version;
  const projection = JSON.parse(row.projection_json);
  projection.will_update = [];
  projection.unchanged = [projection.desired[0]];
  projection.summary = { create: 0, update: 0, disable: 0, blocked: 0, unchanged: 1 };
  db.prepare("UPDATE license_plan_projection_previews SET projection_json = ?, actions_json = ? WHERE id = ?").run(
    JSON.stringify(projection),
    JSON.stringify(actions),
    legacy.preview_id,
  );

  const idempotencyKey = "parent-format-cache-drift";
  const before = projectionApplyState(db, legacy.preview_id, idempotencyKey);
  const batchCount = env.DB.batchSizes.length;
  await assert.rejects(
    () => applyPlanProjection(env, legacy.preview_id, ctx({ idempotencyKey }), {
      scope: "POST:/api/admin/license-plans/apply:admin",
      responseCode: "license_plan_projection_applied",
    }, NOW + 2),
    /stale_projection_preview/,
  );
  assert.equal(env.DB.batchSizes.length, batchCount, "version rejection happens before the claim batch");
  assert.deepEqual(projectionApplyState(db, legacy.preview_id, idempotencyKey), before);
  assert.equal(before.cache_ttl_seconds, 86400, "the unsafe parent preview must leave cache policy untouched");
});

test("malformed, old, and future projection snapshot versions fail closed before any projection write", async () => {
  for (const [label, version] of [["malformed", "2"], ["old", 1], ["future", 3]]) {
    const db = freshDb();
    seedCatalog(db);
    const env = { DB: new D1Like(db) };
    const preview = await previewPlanProjection(env, projectionInput({ plan_key: "basic", addons: [] }), "admin", NOW);
    const snapshot = JSON.parse(db.prepare("SELECT actions_json FROM license_plan_projection_previews WHERE id = ?").get(preview.preview_id).actions_json);
    snapshot.projection_snapshot_version = version;
    db.prepare("UPDATE license_plan_projection_previews SET actions_json = ? WHERE id = ?").run(JSON.stringify(snapshot), preview.preview_id);

    const idempotencyKey = `snapshot-${label}`;
    const before = projectionApplyState(db, preview.preview_id, idempotencyKey);
    const batchCount = env.DB.batchSizes.length;
    await assert.rejects(
      () => applyPlanProjection(env, preview.preview_id, ctx({ idempotencyKey }), {
        scope: "POST:/api/admin/license-plans/apply:admin",
        responseCode: "license_plan_projection_applied",
      }, NOW + 1),
      /stale_projection_preview/,
      label,
    );
    assert.equal(env.DB.batchSizes.length, batchCount, label);
    assert.deepEqual(projectionApplyState(db, preview.preview_id, idempotencyKey), before, label);
  }
});

test("plan downgrade disables catalog-managed features that are no longer desired", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };
  const initialPreview = await previewPlanProjection(env, projectionInput(), "admin", NOW);
  await applyPlanProjection(env, initialPreview.preview_id, ctx(), null, NOW);

  const downgrade = projectionInput({ plan_key: "basic", addons: [] });
  const preview = await previewPlanProjection(env, downgrade, "admin", NOW);
  assert.equal(preview.summary.create, 0);
  assert.equal(preview.summary.update, 0);
  assert.equal(preview.summary.disable, 2);
  assert.deepEqual(preview.will_disable.map((row) => row.feature), ["export", "team"]);
  const snapshot = JSON.parse(db.prepare("SELECT actions_json FROM license_plan_projection_previews WHERE id = ?").get(preview.preview_id).actions_json);
  assert.equal(snapshot.assignment_snapshot.license_fingerprint, FP);
  assert.equal(snapshot.assignment_snapshot.plan_id, "plan_pro");

  const applyPreview = await previewPlanProjection(env, downgrade, "admin", NOW);
  const applied = await applyPlanProjection(env, applyPreview.preview_id, ctx(), null, NOW);
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

test("an assignment-only projection transition has a durable, asserted audit event", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };
  const initial = await previewPlanProjection(env, projectionInput({ plan_key: "basic", addons: [] }), "admin", NOW);
  await applyPlanProjection(env, initial.preview_id, ctx({ requestId: "req-assignment-create", idempotencyKey: "assignment-create" }), {
    scope: "POST:/api/admin/license-plans/apply:admin",
    responseCode: "license_plan_projection_applied",
  }, NOW);
  seedEquivalentBasicPlan(db);

  const preview = await previewPlanProjection(env, projectionInput({ plan_key: "basic-equivalent", addons: [] }), "admin", NOW + 1);
  assert.deepEqual(preview.summary, { create: 0, update: 0, disable: 0, blocked: 0, unchanged: 1 });
  const applied = await applyPlanProjection(env, preview.preview_id, ctx({ requestId: "req-assignment-only", idempotencyKey: "assignment-only" }), {
    scope: "POST:/api/admin/license-plans/apply:admin",
    responseCode: "license_plan_projection_applied",
  }, NOW + 1);
  assert.equal(applied.applied.created.length, 0);
  assert.equal(applied.applied.updated.length, 0);
  assert.equal(applied.applied.disabled.length, 0);

  const audit = db.prepare(
    `SELECT event_type, actor, actor_type, source, request_id, reason, idempotency_key, prev_json, next_json
     FROM license_plan_assignment_events
     WHERE license_id = 'lic_1' AND project = 'DEFAULT'
     ORDER BY id DESC LIMIT 1`,
  ).get();
  assert.equal(audit.event_type, "update");
  assert.equal(audit.actor, "admin@example.test");
  assert.equal(audit.actor_type, "access");
  assert.equal(audit.source, "admin");
  assert.equal(audit.request_id, "req-assignment-only");
  assert.equal(audit.reason, "plan_projection");
  assert.equal(audit.idempotency_key, "assignment-only");
  assert.equal(JSON.parse(audit.prev_json).plan_id, "plan_basic");
  assert.equal(JSON.parse(audit.next_json).plan_id, "plan_basic_equivalent");
});

test("unknown add-on is rejected before mutating entitlements", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };

  await assert.rejects(
    () => previewPlanProjection(env, projectionInput({ addons: ["missing_addon"] }), "admin", NOW),
    /unknown_addon:missing_addon/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments").get().c, 0);
});

test("Free-tier-safe atomic projection boundary accepts nine actions and rejects ten without persisting or attempting an overflow write", async () => {
  const db = freshDb();
  seedCatalog(db);
  seedAtomicPlanFeatures(db, 7);
  const env = { DB: new D1Like(db) };
  const accepted = await previewPlanProjection(env, projectionInput({ addons: [] }), "admin", NOW);
  assert.equal(accepted.summary.create, 9);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_projection_previews").get().c, 1);

  const overflowKey = "atomic_7";
  db.prepare("INSERT INTO catalog_features (id, project, feature_key, name, description, category, status, created_at, updated_at) VALUES (?, 'DEFAULT', ?, ?, '', '', 'active', ?, ?)").run(`feat_${overflowKey}`, overflowKey, overflowKey, NOW, NOW);
  db.prepare(
    `INSERT INTO catalog_plan_features
      (project, plan_id, feature_key, feature_inclusion, addon_key, policy_id, status, display_order,
       assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, meter_quota, meter_period_sec,
       created_at, updated_at)
     VALUES ('DEFAULT', 'plan_pro', ?, 'included', NULL, 'pol_node', 'active', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(overflowKey, 17, NOW, NOW);
  const generationBeforeOverflow = db.prepare("SELECT generation FROM license_plan_projection_generations WHERE scope = 'catalog'").get().generation;
  const overflowD1 = new RejectPreviewWritesD1Like(db);

  await assert.rejects(
    () => previewPlanProjection({ DB: overflowD1 }, projectionInput({ addons: [] }), "admin", NOW),
    /projection_too_large/,
  );
  assert.deepEqual(overflowD1.writeStatements, []);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_projection_previews").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments").get().c, 0);
  assert.equal(db.prepare("SELECT generation FROM license_plan_projection_generations WHERE scope = 'catalog'").get().generation, generationBeforeOverflow);
});

test("nine plan actions compose into exactly 38 claim-gated D1 batch statements", async () => {
  const db = freshDb();
  seedCatalog(db);
  seedAtomicPlanFeatures(db, 7);
  const env = { DB: new D1Like(db) };
  const preview = await previewPlanProjection(env, projectionInput({ addons: [] }), "admin", NOW);
  assert.equal(preview.summary.create, 9);
  await applyPlanProjection(env, preview.preview_id, ctx({ idempotencyKey: "nine-action-bound" }), {
    scope: "POST:/api/admin/license-plans/apply:admin",
    responseCode: "license_plan_projection_applied",
  }, NOW);
  assert.equal(env.DB.batchSizes.at(-1), 38);
  assert.ok(env.DB.batchSizes.at(-1) < 50);
});

test("every conservative source dependency mutation invalidates a persisted projection preview before any apply write", async () => {
  const mutations = [
    ["catalog feature", (db) => db.prepare("UPDATE catalog_features SET name = name WHERE id = 'feat_core'").run()],
    ["catalog plan", (db) => db.prepare("UPDATE catalog_plans SET description = description WHERE id = 'plan_pro'").run()],
    ["catalog plan feature", (db) => db.prepare("UPDATE catalog_plan_features SET display_order = display_order WHERE plan_id = 'plan_pro' AND feature_key = 'core'").run()],
    ["policy", (db) => db.prepare("UPDATE entitlement_policies SET assertion_ttl_seconds = assertion_ttl_seconds WHERE id = 'pol_node'").run()],
    ["managed entitlement source", (db) => db.prepare("INSERT INTO entitlements (project, feature, license_fingerprint, status, created_at, updated_at) VALUES ('DEFAULT', 'side', ?, 'active', ?, ?)").run("a".repeat(64), NOW, NOW)],
    ["assignment source", (db) => db.prepare("INSERT INTO license_plan_assignments (license_id, project, plan_id, license_fingerprint, customer_id, status, support_until, addons_json, created_at, updated_at) VALUES ('lic_other', 'DEFAULT', 'plan_pro', ?, NULL, 'active', NULL, '[]', ?, ?)").run("d".repeat(64), NOW, NOW)],
  ];

  for (const [label, mutate] of mutations) {
    const db = freshDb();
    seedCatalog(db);
    const env = { DB: new D1Like(db) };
    const preview = await previewPlanProjection(env, projectionInput(), "admin", NOW);
    const beforeGeneration = db.prepare("SELECT generation FROM license_plan_projection_generations WHERE scope = 'catalog'").get().generation;
    mutate(db);
    assert.ok(db.prepare("SELECT generation FROM license_plan_projection_generations WHERE scope = 'catalog'").get().generation > beforeGeneration, label);
    const before = {
      entitlements: db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c,
      events: db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c,
      assignments: db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments").get().c,
    };
    await assert.rejects(
      () => applyPlanProjection(env, preview.preview_id, ctx(), null, NOW + 1),
      /stale_projection_preview/,
      label,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, before.entitlements, label);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, before.events, label);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments").get().c, before.assignments, label);
    const persisted = db.prepare("SELECT claim_token, consumed_at FROM license_plan_projection_previews WHERE id = ?").get(preview.preview_id);
    assert.equal(persisted.claim_token, null, label);
    assert.equal(persisted.consumed_at, null, label);
  }
});

test("apply uses the preview effective_at for time-relative policy fields even after wall time advances", async () => {
  const db = freshDb();
  seedCatalog(db);
  db.prepare("UPDATE entitlement_policies SET expiry_strategy = 'fixed_window', valid_from_offset_sec = 10, duration_sec = 90 WHERE id = 'pol_node'").run();
  const env = { DB: new D1Like(db) };
  const input = projectionInput({ addons: [] });
  delete input.support_until;
  const preview = await previewPlanProjection(env, input, "admin", NOW);
  assert.equal(preview.effective_at, NOW);
  await applyPlanProjection(env, preview.preview_id, ctx(), null, NOW + 99);
  const core = db.prepare("SELECT valid_from, valid_until FROM entitlements WHERE feature = 'core' AND license_fingerprint = ?").get(FP);
  assert.equal(core.valid_from, NOW + 10);
  assert.equal(core.valid_until, NOW + 100);
});

test("apply rejects a preview whose server-derived grant expires before the final claim", async () => {
  const db = freshDb();
  seedCatalog(db);
  db.prepare("UPDATE entitlement_policies SET expiry_strategy = 'fixed_window', valid_from_offset_sec = 10, duration_sec = 90 WHERE id = 'pol_node'").run();
  const env = { DB: new D1Like(db) };
  const input = projectionInput({ addons: [] });
  delete input.support_until;
  const preview = await previewPlanProjection(env, input, "admin", NOW);

  await assert.rejects(
    () => applyPlanProjection(env, preview.preview_id, ctx(), null, NOW + 100),
    /projection_preview_grant_expired/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments").get().c, 0);
  const persisted = db.prepare("SELECT claim_token, consumed_at FROM license_plan_projection_previews WHERE id = ?").get(preview.preview_id);
  assert.equal(persisted.claim_token, null);
  assert.equal(persisted.consumed_at, null);
});

test("a differing existing assignment fingerprint rejects Preview without touching old or new projection state", async () => {
  const db = freshDb();
  seedCatalog(db);
  const oldFingerprint = "e".repeat(64);
  db.prepare("INSERT INTO entitlements (project, feature, license_fingerprint, status, license_id, created_at, updated_at) VALUES ('DEFAULT', 'core', ?, 'active', 'lic_1', ?, ?)").run(oldFingerprint, NOW, NOW);
  db.prepare("INSERT INTO license_plan_assignments (license_id, project, plan_id, license_fingerprint, customer_id, status, support_until, addons_json, created_at, updated_at) VALUES ('lic_1', 'DEFAULT', 'plan_basic', ?, 'cus_old', 'active', NULL, '[]', ?, ?)").run(oldFingerprint, NOW, NOW);
  const env = { DB: new D1Like(db) };
  const before = {
    old: db.prepare("SELECT status, license_id FROM entitlements WHERE feature = 'core' AND license_fingerprint = ?").get(oldFingerprint),
    assignment: db.prepare("SELECT plan_id, license_fingerprint, customer_id FROM license_plan_assignments WHERE license_id = 'lic_1' AND project = 'DEFAULT'").get(),
    events: db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c,
  };

  await assert.rejects(
    () => previewPlanProjection(env, projectionInput(), "admin", NOW),
    /license_fingerprint_conflict/,
  );
  assert.deepEqual(db.prepare("SELECT status, license_id FROM entitlements WHERE feature = 'core' AND license_fingerprint = ?").get(oldFingerprint), before.old);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(FP).c, 0);
  assert.deepEqual(db.prepare("SELECT plan_id, license_fingerprint, customer_id FROM license_plan_assignments WHERE license_id = 'lic_1' AND project = 'DEFAULT'").get(), before.assignment);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, before.events);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_projection_previews").get().c, 0);
});

test("a legacy entitlement identity conflict without an assignment rejects Preview and writes nothing", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };
  const oldFingerprint = "1".repeat(64);
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, status, license_id, created_at, updated_at) VALUES ('DEFAULT', 'legacy_unmanaged', ?, 'active', 'lic_1', ?, ?)",
  ).run(oldFingerprint, NOW, NOW);

  await assert.rejects(
    () => previewPlanProjection(env, projectionInput(), "admin", NOW),
    /license_fingerprint_conflict/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(oldFingerprint).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(FP).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments WHERE license_id = 'lic_1'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM mutation_idempotency").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_projection_previews").get().c, 0);
});

test("the legacy entitlement identity fence is status-independent", async () => {
  for (const status of ["disabled", "revoked"]) {
    const db = freshDb();
    seedCatalog(db);
    const env = { DB: new D1Like(db) };
    db.prepare(
      "INSERT INTO entitlements (project, feature, license_fingerprint, status, license_id, created_at, updated_at) VALUES ('DEFAULT', 'legacy_status', ?, ?, 'lic_1', ?, ?)",
    ).run(status === "disabled" ? "5".repeat(64) : "6".repeat(64), status, NOW, NOW);
    await assert.rejects(
      () => previewPlanProjection(env, projectionInput(), "admin", NOW),
      /license_fingerprint_conflict/,
      status,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_projection_previews").get().c, 0, status);
  }
});

test("same-fingerprint legacy features and null or empty legacy license ids remain compatible", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, status, license_id, created_at, updated_at) VALUES ('DEFAULT', ?, ?, 'active', ?, ?, ?)",
  ).run("legacy_same_a", FP, "lic_1", NOW, NOW);
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, status, license_id, created_at, updated_at) VALUES ('DEFAULT', ?, ?, 'active', ?, ?, ?)",
  ).run("legacy_same_b", FP, "lic_1", NOW, NOW);
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, status, license_id, created_at, updated_at) VALUES ('DEFAULT', ?, ?, 'active', NULL, ?, ?)",
  ).run("legacy_null", "2".repeat(64), NOW, NOW);
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, status, license_id, created_at, updated_at) VALUES ('DEFAULT', ?, ?, 'active', '', ?, ?)",
  ).run("legacy_empty", "3".repeat(64), NOW, NOW);

  const preview = await previewPlanProjection(env, projectionInput(), "admin", NOW);
  assert.equal(preview.summary.create, 3);
  await assert.rejects(
    () => previewPlanProjection(env, projectionInput({ license_id: "" }), "admin", NOW),
    /invalid_license_id/,
  );
});

test("the final in-batch claim rejects an assignment fingerprint conflict with zero projection writes", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };
  const preview = await previewPlanProjection(env, projectionInput(), "admin", NOW);
  const oldFingerprint = "f".repeat(64);
  db.prepare("INSERT INTO entitlements (project, feature, license_fingerprint, status, license_id, created_at, updated_at) VALUES ('DEFAULT', 'core', ?, 'active', 'lic_1', ?, ?)").run(oldFingerprint, NOW, NOW);
  db.prepare("INSERT INTO license_plan_assignments (license_id, project, plan_id, license_fingerprint, customer_id, status, support_until, addons_json, created_at, updated_at) VALUES ('lic_1', 'DEFAULT', 'plan_basic', ?, 'cus_old', 'active', NULL, '[]', ?, ?)").run(oldFingerprint, NOW, NOW);
  const beforeAssignment = db.prepare("SELECT plan_id, license_fingerprint, customer_id, support_until, addons_json FROM license_plan_assignments WHERE license_id = 'lic_1' AND project = 'DEFAULT'").get();
  const beforeEvents = db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c;

  await assert.rejects(
    () => applyPlanProjection(env, preview.preview_id, ctx(), null, NOW + 1),
    /license_fingerprint_conflict/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(FP).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(oldFingerprint).c, 1);
  assert.deepEqual(db.prepare("SELECT plan_id, license_fingerprint, customer_id, support_until, addons_json FROM license_plan_assignments WHERE license_id = 'lic_1' AND project = 'DEFAULT'").get(), beforeAssignment);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, beforeEvents);
  const persisted = db.prepare("SELECT claim_token, consumed_at FROM license_plan_projection_previews WHERE id = ?").get(preview.preview_id);
  assert.equal(persisted.claim_token, null);
  assert.equal(persisted.consumed_at, null);
});

test("the final in-batch claim rejects a post-Preview legacy entitlement identity conflict with zero projection writes", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };
  const preview = await previewPlanProjection(env, projectionInput(), "admin", NOW);
  const oldFingerprint = "4".repeat(64);
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, status, license_id, created_at, updated_at) VALUES ('DEFAULT', 'legacy_race', ?, 'active', 'lic_1', ?, ?)",
  ).run(oldFingerprint, NOW, NOW);
  const mutation = { scope: "POST:/api/admin/license-plans/apply:admin", responseCode: "license_plan_projection_applied" };

  await assert.rejects(
    () => applyPlanProjection(env, preview.preview_id, ctx({ idempotencyKey: "legacy-identity-race" }), mutation, NOW + 1),
    /license_fingerprint_conflict/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(oldFingerprint).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(FP).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments WHERE license_id = 'lic_1'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM mutation_idempotency WHERE idempotency_key = 'legacy-identity-race'").get().c, 0);
  const persisted = db.prepare("SELECT claim_token, consumed_at, applied_response_json FROM license_plan_projection_previews WHERE id = ?").get(preview.preview_id);
  assert.equal(persisted.claim_token, null);
  assert.equal(persisted.consumed_at, null);
  assert.equal(persisted.applied_response_json, null);
});

test("lazy preview cleanup is an indexable bounded expiry range and leaves unexpired consumed snapshots alone", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };
  const expired = await previewPlanProjection(env, projectionInput(), "admin", NOW);
  const consumed = await previewPlanProjection(env, projectionInput({ license_id: "lic_consumed" }), "admin", NOW);
  db.prepare("UPDATE license_plan_projection_previews SET expires_at = ? WHERE id = ?").run(NOW - 1, expired.preview_id);
  db.prepare("UPDATE license_plan_projection_previews SET consumed_at = ? WHERE id = ?").run(NOW, consumed.preview_id);

  const insert = db.prepare(
    `INSERT INTO license_plan_projection_previews
       (id, actor_subject, source_generation, normalized_input_json, projection_json, actions_json, effective_at, expires_at, created_at)
     VALUES (?, 'admin', 0, '{}', '{}', '{}', ?, ?, ?)`,
  );
  for (let index = 0; index < 1000; index += 1) {
    insert.run(`ppv_live_${index}`, NOW, NOW + 3600, NOW);
  }
  const queryPlan = db.prepare(
    `EXPLAIN QUERY PLAN
     DELETE FROM license_plan_projection_previews
     WHERE id IN (
       SELECT id FROM license_plan_projection_previews
       WHERE expires_at <= ?
       ORDER BY expires_at ASC, id ASC
       LIMIT ?
     )`,
  ).all(NOW + 1, 25).map((row) => row.detail).join("\n");
  assert.match(queryPlan, /SEARCH license_plan_projection_previews USING (?:COVERING )?INDEX idx_license_plan_projection_previews_expiry_id \(expires_at<\?\)/);
  assert.doesNotMatch(queryPlan, /USE TEMP B-TREE|SCAN license_plan_projection_previews/);

  const fresh = await previewPlanProjection(env, projectionInput({ license_id: "lic_fresh" }), "admin", NOW + 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_projection_previews WHERE id = ?").get(expired.preview_id).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_projection_previews WHERE id = ?").get(consumed.preview_id).c, 1, "consumed snapshots are cleaned by their existing five-minute expiry");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_projection_previews WHERE id LIKE 'ppv_live_%'").get().c, 1000, "a zero-match cleanup must not scan/delete the live backlog");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_projection_previews WHERE id = ?").get(fresh.preview_id).c, 1);

  await previewPlanProjection(env, projectionInput({ license_id: "lic_after_expiry" }), "admin", NOW + 301);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_projection_previews WHERE id = ?").get(consumed.preview_id).c, 0);
});

test("a failure while applying the second entitlement rolls back entitlements, every audit, assignment, idempotency, and preview consumption", async () => {
  const db = freshDb();
  seedCatalog(db);
  const d1 = new FailingSecondEntitlementD1Like(db);
  const env = { DB: d1 };
  const preview = await previewPlanProjection(env, projectionInput(), "admin", NOW);
  d1.failSecondEntitlementWrite = true;
  const generationBeforeApply = db.prepare("SELECT generation FROM license_plan_projection_generations WHERE scope = 'catalog'").get().generation;
  const mutation = { scope: "POST:/api/admin/license-plans/apply:admin", responseCode: "license_plan_projection_applied" };
  await assert.rejects(
    () => applyPlanProjection(env, preview.preview_id, ctx({ idempotencyKey: "projection-fail" }), mutation, NOW + 1),
    /injected_second_entitlement_failure/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignment_events").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM mutation_idempotency").get().c, 0);
  const persisted = db.prepare("SELECT claim_token, consumed_at, applied_response_json FROM license_plan_projection_previews WHERE id = ?").get(preview.preview_id);
  assert.equal(persisted.claim_token, null);
  assert.equal(persisted.consumed_at, null);
  assert.equal(persisted.applied_response_json, null);
  assert.equal(db.prepare("SELECT generation FROM license_plan_projection_generations WHERE scope = 'catalog'").get().generation, generationBeforeApply);
});

test("a failed assignment audit rolls back the already-stamped entitlements and assignment in the same claim-gated batch", async () => {
  const db = freshDb();
  seedCatalog(db);
  const d1 = new FailingAssignmentAuditD1Like(db);
  const env = { DB: d1 };
  const preview = await previewPlanProjection(env, projectionInput(), "admin", NOW);
  d1.failAssignmentAuditWrite = true;
  const mutation = { scope: "POST:/api/admin/license-plans/apply:admin", responseCode: "license_plan_projection_applied" };
  await assert.rejects(
    () => applyPlanProjection(env, preview.preview_id, ctx({ idempotencyKey: "assignment-audit-fail" }), mutation, NOW + 1),
    /injected_assignment_audit_failure/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignment_events").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM mutation_idempotency").get().c, 0);
  const persisted = db.prepare("SELECT claim_token, consumed_at, applied_response_json FROM license_plan_projection_previews WHERE id = ?").get(preview.preview_id);
  assert.equal(persisted.claim_token, null);
  assert.equal(persisted.consumed_at, null);
  assert.equal(persisted.applied_response_json, null);
});

test("expired previews are stale and leave the preview unclaimed", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = { DB: new D1Like(db) };
  const preview = await previewPlanProjection(env, projectionInput(), "admin", NOW);
  await assert.rejects(
    () => applyPlanProjection(env, preview.preview_id, ctx(), null, preview.expires_at),
    /stale_projection_preview/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
  const persisted = db.prepare("SELECT claim_token, consumed_at FROM license_plan_projection_previews WHERE id = ?").get(preview.preview_id);
  assert.equal(persisted.claim_token, null);
  assert.equal(persisted.consumed_at, null);
});
