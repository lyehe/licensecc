import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import worker from "../../dist-worker/worker/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "cloudflare-licensing-backend", "migrations");
const FP = "c".repeat(64);
const NOW = 1_700_000_000;
// Worker tests use the real wall clock for Apply, so keep an explicit support
// expiry safely in the future rather than the historical fixture timestamp.
const SUPPORT_UNTIL = 2_000_000_000;

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

class CountingPreparedStatement {
  constructor(owner, sql, params = []) {
    this.owner = owner;
    this.sql = sql;
    this.params = params;
  }
  bind(...values) {
    return new CountingPreparedStatement(this.owner, this.sql, values.map(normalizeParam));
  }
  async first() {
    this.owner.queryCount += 1;
    if (this.owner.hideFirstIdempotencyRead && this.sql.startsWith("SELECT response_json FROM mutation_idempotency")) {
      this.owner.hideFirstIdempotencyRead = false;
      return null;
    }
    const row = this.owner.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    this.owner.queryCount += 1;
    return { results: this.owner.db.prepare(this.sql).all(...this.params) };
  }
  async run() {
    this.owner.queryCount += 1;
    this.owner.db.prepare(this.sql).all(...this.params);
    return { success: true };
  }
}

class CountingD1Like {
  constructor(db) {
    this.db = db;
    this.queryCount = 0;
    this.batchLengths = [];
    this.hideFirstIdempotencyRead = false;
  }
  prepare(sql) {
    return new CountingPreparedStatement(this, sql);
  }
  async batch(statements) {
    this.queryCount += statements.length;
    this.batchLengths.push(statements.length);
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
  for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return db;
}

function devEnv(db, d1 = new D1Like(db)) {
  return {
    DB: d1,
    ENVIRONMENT: "development",
    ADMIN_DEV_BEARER_ENABLED: "1",
    ADMIN_DEV_BEARER: "dev-secret",
  };
}

function addIncludedProjectionFeatures(db, count) {
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
    const key = `budget_${index}`;
    feature.run(`feat_${key}`, key, key, NOW, NOW);
    planFeature.run(key, 20 + index, NOW, NOW);
  }
}

function devReq(path, options = {}) {
  return new Request(`https://admin.example${path}`, {
    ...options,
    headers: { authorization: "Bearer dev-secret", "content-type": "application/json", ...(options.headers ?? {}) },
  });
}

async function body(response) {
  return response.json();
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
  seedPolicy(db, "pol_float", { pool_size: 4, max_active_devices: 4, max_borrow_sec: 86400 });

  const feature = db.prepare(
    "INSERT INTO catalog_features (id, project, feature_key, name, description, category, status, created_at, updated_at) VALUES (?, 'DEFAULT', ?, ?, '', '', 'active', ?, ?)",
  );
  feature.run("feat_core", "core", "Core", NOW, NOW);
  feature.run("feat_export", "export", "Export", NOW, NOW);
  feature.run("feat_team", "team", "Team Seats", NOW, NOW);

  db.prepare(
    "INSERT INTO catalog_plans (id, project, plan_key, name, status, version, description, created_at, updated_at) VALUES ('plan_pro', 'DEFAULT', 'pro', 'Pro', 'active', 1, '', ?, ?)",
  ).run(NOW, NOW);

  const planFeature = db.prepare(
    `INSERT INTO catalog_plan_features
      (project, plan_id, feature_key, feature_inclusion, addon_key, policy_id, status, display_order,
       assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, meter_quota, meter_period_sec,
       created_at, updated_at)
     VALUES ('DEFAULT', 'plan_pro', ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  planFeature.run("core", "included", null, "pol_node", 1, null, null, null, null, null, null, NOW, NOW);
  planFeature.run("export", "included", null, "pol_node", 2, null, null, null, null, null, null, NOW, NOW);
  planFeature.run("team", "addon", "team_seats", "pol_float", 3, null, 6, 6, 172800, null, null, NOW, NOW);
}

function projectionBody(overrides = {}) {
  return {
    project: "DEFAULT",
    license_id: "lic_plan",
    license_fingerprint: FP,
    customer_id: "cus_plan",
    plan_key: "pro",
    support_until: SUPPORT_UNTIL,
    addons: ["team_seats"],
    ...overrides,
  };
}

test("license-plan preview is non-mutating and returns the concrete entitlement diff", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = devEnv(db);

  const res = await worker.fetch(devReq("/api/admin/license-plans/preview", { method: "POST", body: JSON.stringify(projectionBody()) }), env);
  assert.equal(res.status, 200, await res.clone().text());
  const json = await body(res);
  assert.equal(json.code, "license_plan_projection_previewed");
  assert.equal(json.data.summary.create, 3);
  assert.deepEqual(json.data.will_create.map((row) => row.feature), ["core", "export", "team"]);
  assert.equal(json.data.will_create.find((row) => row.feature === "team").license_mode, "floating");
  assert.match(json.data.preview_id, /^ppv_/);
  assert.equal(typeof json.data.effective_at, "number");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
});

test("catalog admin APIs create plan definitions consumed by projection", async () => {
  const db = freshDb();
  seedPolicy(db, "pol_node");
  const env = devEnv(db);

  const feature = await worker.fetch(
    devReq("/api/admin/catalog/features", {
      method: "POST",
      body: JSON.stringify({
        project: "DEFAULT",
        feature_key: "core",
        name: "Core",
        description: "Base entitlement",
        category: "base",
      }),
    }),
    env,
  );
  assert.equal(feature.status, 200, await feature.clone().text());
  assert.equal((await body(feature)).code, "catalog_feature_created");

  const duplicateFeature = await worker.fetch(
    devReq("/api/admin/catalog/features", {
      method: "POST",
      body: JSON.stringify({ project: "DEFAULT", feature_key: "core", name: "Core" }),
    }),
    env,
  );
  assert.equal(duplicateFeature.status, 409);
  assert.equal((await body(duplicateFeature)).code, "catalog_feature_conflict");

  const plan = await worker.fetch(
    devReq("/api/admin/catalog/plans", {
      method: "POST",
      body: JSON.stringify({
        project: "DEFAULT",
        plan_key: "pro",
        name: "Pro",
        description: "Professional",
      }),
    }),
    env,
  );
  assert.equal(plan.status, 200, await plan.clone().text());
  const planBody = await body(plan);
  assert.equal(planBody.code, "catalog_plan_created");
  assert.match(planBody.data.id, /^plan_/);

  const planFeature = await worker.fetch(
    devReq(`/api/admin/catalog/plans/${encodeURIComponent(planBody.data.id)}/features`, {
      method: "POST",
      body: JSON.stringify({
        project: "DEFAULT",
        feature_key: "core",
        policy_id: "pol_node",
      }),
    }),
    env,
  );
  assert.equal(planFeature.status, 200, await planFeature.clone().text());
  const planFeatureBody = await body(planFeature);
  assert.equal(planFeatureBody.code, "catalog_plan_feature_saved");
  assert.equal(planFeatureBody.data.feature_inclusion, "included");
  assert.equal(planFeatureBody.data.policy_id, "pol_node");
  assert.equal(planFeatureBody.data.pool_size, null);
  assert.equal(planFeatureBody.data.max_active_devices, null);

  const list = await worker.fetch(devReq(`/api/admin/catalog/plans/${encodeURIComponent(planBody.data.id)}/features?project=DEFAULT`), env);
  assert.equal(list.status, 200, await list.clone().text());
  const listBody = await body(list);
  assert.equal(listBody.data.items.length, 1);
  assert.equal(listBody.data.items[0].feature_key, "core");

  const preview = await worker.fetch(
    devReq("/api/admin/license-plans/preview", {
      method: "POST",
      body: JSON.stringify(projectionBody({ addons: [] })),
    }),
    env,
  );
  assert.equal(preview.status, 200, await preview.clone().text());
  const previewBody = await body(preview);
  assert.equal(previewBody.code, "license_plan_projection_previewed");
  assert.equal(previewBody.data.summary.create, 1);
  assert.deepEqual(previewBody.data.will_create.map((row) => row.feature), ["core"]);
});

test("catalog lifecycle APIs patch, transition, audit, and replay idempotently", async () => {
  const db = freshDb();
  seedPolicy(db, "pol_node");
  const env = devEnv(db);

  const featureRequest = {
    method: "POST",
    headers: { "idempotency-key": "catalog-feature-1" },
    body: JSON.stringify({
      project: "DEFAULT",
      feature_key: "core",
      name: "Core",
      description: "Base",
      category: "base",
    }),
  };
  const feature = await worker.fetch(devReq("/api/admin/catalog/features", featureRequest), env);
  assert.equal(feature.status, 200, await feature.clone().text());
  const featureBody = await body(feature);
  const featureId = featureBody.data.id;
  assert.equal(featureBody.code, "catalog_feature_created");

  const featureReplay = await worker.fetch(devReq("/api/admin/catalog/features", featureRequest), env);
  assert.equal(featureReplay.status, 200);
  assert.equal(featureReplay.headers.get("x-idempotent-replay"), "1");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM catalog_features WHERE feature_key = 'core'").get().c, 1);

  const featurePatch = await worker.fetch(
    devReq(`/api/admin/catalog/features/${encodeURIComponent(featureId)}`, {
      method: "PATCH",
      headers: { "idempotency-key": "catalog-feature-patch-1" },
      body: JSON.stringify({ name: "Core Runtime", description: "Updated", category: "" }),
    }),
    env,
  );
  assert.equal(featurePatch.status, 200, await featurePatch.clone().text());
  const patchedFeatureBody = await body(featurePatch);
  assert.equal(patchedFeatureBody.data.name, "Core Runtime");
  assert.equal(patchedFeatureBody.data.category, "");

  const immutableFeaturePatch = await worker.fetch(
    devReq(`/api/admin/catalog/features/${encodeURIComponent(featureId)}`, {
      method: "PATCH",
      body: JSON.stringify({ feature_key: "renamed" }),
    }),
    env,
  );
  assert.equal(immutableFeaturePatch.status, 400);
  const unknownFeaturePatch = await worker.fetch(
    devReq(`/api/admin/catalog/features/${encodeURIComponent(featureId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Core Runtime", unexpected: true }),
    }),
    env,
  );
  assert.equal(unknownFeaturePatch.status, 400);

  const disableFeature = await worker.fetch(
    devReq(`/api/admin/catalog/features/${encodeURIComponent(featureId)}/disable`, {
      method: "POST",
      headers: { "idempotency-key": "catalog-feature-disable-1" },
      body: JSON.stringify({ reason: "retired SKU" }),
    }),
    env,
  );
  assert.equal(disableFeature.status, 200, await disableFeature.clone().text());
  assert.equal((await body(disableFeature)).code, "catalog_feature_disabled");
  const disableReplay = await worker.fetch(
    devReq(`/api/admin/catalog/features/${encodeURIComponent(featureId)}/disable`, {
      method: "POST",
      headers: { "idempotency-key": "catalog-feature-disable-1" },
      body: JSON.stringify({ reason: "retired SKU" }),
    }),
    env,
  );
  assert.equal(disableReplay.headers.get("x-idempotent-replay"), "1");

  const reenableFeature = await worker.fetch(
    devReq(`/api/admin/catalog/features/${encodeURIComponent(featureId)}/reenable`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
    env,
  );
  assert.equal(reenableFeature.status, 200, await reenableFeature.clone().text());

  const plan = await worker.fetch(
    devReq("/api/admin/catalog/plans", {
      method: "POST",
      body: JSON.stringify({ project: "DEFAULT", plan_key: "pro", name: "Pro" }),
    }),
    env,
  );
  assert.equal(plan.status, 200, await plan.clone().text());
  const planId = (await body(plan)).data.id;

  const planPatch = await worker.fetch(
    devReq(`/api/admin/catalog/plans/${encodeURIComponent(planId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Pro Annual", description: "Updated" }),
    }),
    env,
  );
  assert.equal(planPatch.status, 200, await planPatch.clone().text());
  assert.equal((await body(planPatch)).data.description, "Updated");

  const disabledPlan = await worker.fetch(
    devReq(`/api/admin/catalog/plans/${encodeURIComponent(planId)}/disable`, {
      method: "POST",
      body: JSON.stringify({ reason: "sunset" }),
    }),
    env,
  );
  assert.equal(disabledPlan.status, 200, await disabledPlan.clone().text());
  const previewDisabled = await worker.fetch(
    devReq("/api/admin/license-plans/preview", {
      method: "POST",
      body: JSON.stringify(projectionBody({ addons: [] })),
    }),
    env,
  );
  assert.equal(previewDisabled.status, 409);
  assert.equal((await body(previewDisabled)).code, "plan_disabled");

  await worker.fetch(
    devReq(`/api/admin/catalog/plans/${encodeURIComponent(planId)}/reenable`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
    env,
  );
  const planFeature = await worker.fetch(
    devReq(`/api/admin/catalog/plans/${encodeURIComponent(planId)}/features`, {
      method: "POST",
      body: JSON.stringify({ project: "DEFAULT", feature_key: "core", policy_id: "pol_node" }),
    }),
    env,
  );
  assert.equal(planFeature.status, 200, await planFeature.clone().text());

  const disablePlanFeature = await worker.fetch(
    devReq(`/api/admin/catalog/plans/${encodeURIComponent(planId)}/features/core/disable`, {
      method: "POST",
      body: JSON.stringify({ reason: "tier change" }),
    }),
    env,
  );
  assert.equal(disablePlanFeature.status, 200, await disablePlanFeature.clone().text());
  const previewNoRows = await worker.fetch(
    devReq("/api/admin/license-plans/preview", {
      method: "POST",
      body: JSON.stringify(projectionBody({ addons: [] })),
    }),
    env,
  );
  assert.equal(previewNoRows.status, 200, await previewNoRows.clone().text());
  assert.equal((await body(previewNoRows)).data.summary.create, 0);

  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM catalog_events WHERE entity_type = 'feature' AND entity_id = ?").get(featureId).c, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM catalog_events WHERE entity_type = 'plan' AND entity_id = ?").get(planId).c, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM catalog_events WHERE entity_type = 'plan_feature' AND entity_id = ?").get(`${planId}:core`).c, 2);
  const featureDisableEvent = db.prepare("SELECT reason, prev_json, next_json FROM catalog_events WHERE entity_type = 'feature' AND event_type = 'disable' LIMIT 1").get();
  assert.equal(featureDisableEvent.reason, "retired SKU");
  assert.equal(JSON.parse(featureDisableEvent.prev_json).status, "active");
  assert.equal(JSON.parse(featureDisableEvent.next_json).status, "disabled");
});

test("catalog import/export manifests preview, apply, replay, and re-import unchanged", async () => {
  const db = freshDb();
  seedPolicy(db, "pol_node");
  seedPolicy(db, "pol_float", { type: "floating", pool_size: 6, max_active_devices: 6, max_borrow_sec: 172800 });
  const env = devEnv(db);
  const manifest = {
    format_version: 1,
    features: [
      { project: "DEFAULT", feature_key: "core", name: "Core", description: "", category: "base", status: "active" },
      { project: "DEFAULT", feature_key: "team", name: "Team Seats", description: "", category: "seats", status: "active" },
    ],
    plans: [
      {
        project: "DEFAULT",
        plan_key: "pro",
        name: "Pro",
        description: "Professional tier",
        status: "active",
        version: 1,
        features: [
          { project: "DEFAULT", feature_key: "core", feature_inclusion: "included", addon_key: null, policy_id: "pol_node", status: "active", display_order: 0, assertion_ttl_seconds: null, pool_size: null, max_active_devices: null, max_borrow_sec: null, meter_quota: null, meter_period_sec: null },
          { project: "DEFAULT", feature_key: "team", feature_inclusion: "addon", addon_key: "team_seats", policy_id: "pol_float", status: "active", display_order: 1, assertion_ttl_seconds: null, pool_size: 6, max_active_devices: 6, max_borrow_sec: 172800, meter_quota: null, meter_period_sec: null },
        ],
      },
    ],
  };

  const preview = await worker.fetch(
    devReq("/api/admin/catalog/import?dry_run=1", { method: "POST", body: JSON.stringify(manifest) }),
    env,
  );
  assert.equal(preview.status, 200, await preview.clone().text());
  const previewData = (await body(preview)).data;
  assert.match(previewData.preview_id, /^civ_[A-Za-z0-9_-]+$/);
  assert.deepEqual(previewData.effects.summary, {
    features: { create: 2, update: 0, disable: 0, reenable: 0, unchanged: 0 },
    plans: { create: 1, update: 0, disable: 0, reenable: 0, unchanged: 0 },
    plan_features: { create: 2, update: 0, disable: 0, reenable: 0, unchanged: 0 },
  });

  const request = {
    method: "POST",
    headers: { "idempotency-key": "catalog-import-1" },
    body: JSON.stringify({ preview_id: previewData.preview_id }),
  };
  const apply = await worker.fetch(devReq("/api/admin/catalog/import", request), env);
  assert.equal(apply.status, 200, await apply.clone().text());
  assert.equal((await body(apply)).code, "catalog_import_applied");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM catalog_events").get().c, 5);

  const replay = await worker.fetch(devReq("/api/admin/catalog/import", request), env);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("x-idempotent-replay"), "1");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM catalog_events").get().c, 5);

  const planId = db.prepare("SELECT id FROM catalog_plans WHERE plan_key = 'pro'").get().id;
  const exported = await worker.fetch(devReq(`/api/admin/catalog/plans/${encodeURIComponent(planId)}/export`), env);
  assert.equal(exported.status, 200, await exported.clone().text());
  const exportedBody = await body(exported);
  assert.equal(exportedBody.code, "catalog_plan_exported");
  assert.equal(exportedBody.data.format_version, 1);
  assert.equal(exportedBody.data.features.length, 2);
  assert.equal(exportedBody.data.plans[0].features.length, 2);
  assert.equal(exportedBody.data.plans[0].features[1].addon_key, "team_seats");

  const unchanged = await worker.fetch(
    devReq("/api/admin/catalog/import?dry_run=1", { method: "POST", body: JSON.stringify(exportedBody.data) }),
    env,
  );
  assert.equal(unchanged.status, 200, await unchanged.clone().text());
  assert.deepEqual((await body(unchanged)).data.effects.summary, {
    features: { create: 0, update: 0, disable: 0, reenable: 0, unchanged: 2 },
    plans: { create: 0, update: 0, disable: 0, reenable: 0, unchanged: 1 },
    plan_features: { create: 0, update: 0, disable: 0, reenable: 0, unchanged: 2 },
  });
});

test("catalog plan features reject disabled policies before projection", async () => {
  const db = freshDb();
  seedPolicy(db, "pol_disabled", { status: "disabled" });
  seedCatalog(db);
  const env = devEnv(db);

  const res = await worker.fetch(
    devReq("/api/admin/catalog/plans/plan_pro/features", {
      method: "POST",
      body: JSON.stringify({
        project: "DEFAULT",
        feature_key: "core",
        policy_id: "pol_disabled",
      }),
    }),
    env,
  );
  assert.equal(res.status, 409);
  assert.equal((await body(res)).code, "policy_disabled");
});

test("license-plan apply creates stamped entitlements, assignment row, and is request-idempotent", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = devEnv(db);
  const preview = await worker.fetch(
    devReq("/api/admin/license-plans/preview", { method: "POST", body: JSON.stringify(projectionBody()) }),
    env,
  );
  assert.equal(preview.status, 200, await preview.clone().text());
  const previewId = (await body(preview)).data.preview_id;
  const request = {
    method: "POST",
    headers: { "idempotency-key": "plan-apply-1" },
    body: JSON.stringify({ preview_id: previewId }),
  };

  const first = await worker.fetch(devReq("/api/admin/license-plans/apply", request), env);
  assert.equal(first.status, 200, await first.clone().text());
  const firstBody = await body(first);
  assert.equal(firstBody.code, "license_plan_projection_applied");
  assert.equal(firstBody.data.applied.created.length, 3);

  const team = db.prepare("SELECT status, policy_id, pool_size, max_active_devices, max_borrow_sec, valid_until FROM entitlements WHERE feature = 'team' AND license_fingerprint = ?").get(FP);
  assert.equal(team.status, "active");
  assert.equal(team.policy_id, "pol_float");
  assert.equal(team.pool_size, 6);
  assert.equal(team.max_active_devices, 6);
  assert.equal(team.max_borrow_sec, 172800);
  assert.equal(team.valid_until, SUPPORT_UNTIL);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE license_fingerprint = ?").get(FP).c, 3);
  assert.equal(db.prepare("SELECT plan_id FROM license_plan_assignments WHERE license_id = 'lic_plan' AND project = 'DEFAULT'").get().plan_id, "plan_pro");

  const replay = await worker.fetch(devReq("/api/admin/license-plans/apply", request), env);
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal(replay.headers.get("x-idempotent-replay"), "1");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE license_fingerprint = ?").get(FP).c, 3);
});

test("license-plan apply accepts only its server preview id, rejecting form substitution", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = devEnv(db);

  const res = await worker.fetch(
    devReq("/api/admin/license-plans/apply", { method: "POST", body: JSON.stringify(projectionBody({ addons: ["missing"] })) }),
    env,
  );
  assert.equal(res.status, 400);
  assert.equal((await body(res)).code, "invalid_request");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);

  const preview = await worker.fetch(
    devReq("/api/admin/license-plans/preview", { method: "POST", body: JSON.stringify(projectionBody()) }),
    env,
  );
  const previewId = (await body(preview)).data.preview_id;
  const substituted = await worker.fetch(
    devReq("/api/admin/license-plans/apply", {
      method: "POST",
      body: JSON.stringify({ preview_id: previewId, ...projectionBody({ notes: "cannot substitute" }) }),
    }),
    env,
  );
  assert.equal(substituted.status, 400);
  assert.equal((await body(substituted)).code, "invalid_request");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);

  const malformedPreviewId = await worker.fetch(
    devReq("/api/admin/license-plans/apply", {
      method: "POST",
      body: JSON.stringify({ preview_id: "ppv_bad=identifier" }),
    }),
    env,
  );
  assert.equal(malformedPreviewId.status, 400);
  assert.equal((await body(malformedPreviewId)).code, "invalid_request");
});

test("license-plan Preview reports license_fingerprint_conflict without changing old or new assignment state", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = devEnv(db);
  const oldFingerprint = "e".repeat(64);
  db.prepare("INSERT INTO entitlements (project, feature, license_fingerprint, status, license_id, created_at, updated_at) VALUES ('DEFAULT', 'core', ?, 'active', 'lic_plan', ?, ?)").run(oldFingerprint, NOW, NOW);
  db.prepare("INSERT INTO license_plan_assignments (license_id, project, plan_id, license_fingerprint, customer_id, status, support_until, addons_json, created_at, updated_at) VALUES ('lic_plan', 'DEFAULT', 'plan_pro', ?, 'cus_old', 'active', NULL, '[]', ?, ?)").run(oldFingerprint, NOW, NOW);
  const before = {
    old: db.prepare("SELECT feature, status, license_id FROM entitlements WHERE license_fingerprint = ?").get(oldFingerprint),
    assignment: db.prepare("SELECT plan_id, license_fingerprint, customer_id, addons_json FROM license_plan_assignments WHERE license_id = 'lic_plan' AND project = 'DEFAULT'").get(),
    events: db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c,
  };

  const preview = await worker.fetch(
    devReq("/api/admin/license-plans/preview", { method: "POST", body: JSON.stringify(projectionBody()) }),
    env,
  );
  assert.equal(preview.status, 409, await preview.clone().text());
  assert.equal((await body(preview)).code, "license_fingerprint_conflict");
  assert.deepEqual(db.prepare("SELECT feature, status, license_id FROM entitlements WHERE license_fingerprint = ?").get(oldFingerprint), before.old);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(FP).c, 0);
  assert.deepEqual(db.prepare("SELECT plan_id, license_fingerprint, customer_id, addons_json FROM license_plan_assignments WHERE license_id = 'lic_plan' AND project = 'DEFAULT'").get(), before.assignment);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, before.events);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_projection_previews").get().c, 0);
});

test("license-plan Preview rejects a legacy entitlement identity conflict without an assignment", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = devEnv(db);
  const oldFingerprint = "1".repeat(64);
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, status, license_id, created_at, updated_at) VALUES ('DEFAULT', 'legacy_unmanaged', ?, 'active', 'lic_plan', ?, ?)",
  ).run(oldFingerprint, NOW, NOW);

  const preview = await worker.fetch(
    devReq("/api/admin/license-plans/preview", { method: "POST", body: JSON.stringify(projectionBody()) }),
    env,
  );
  assert.equal(preview.status, 409, await preview.clone().text());
  assert.equal((await body(preview)).code, "license_fingerprint_conflict");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(oldFingerprint).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(FP).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments WHERE license_id = 'lic_plan'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM mutation_idempotency").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_projection_previews").get().c, 0);
});

test("license-plan Apply atomically reports license_fingerprint_conflict after a preview and writes nothing", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = devEnv(db);
  const preview = await worker.fetch(
    devReq("/api/admin/license-plans/preview", { method: "POST", body: JSON.stringify(projectionBody()) }),
    env,
  );
  const previewId = (await body(preview)).data.preview_id;
  const oldFingerprint = "f".repeat(64);
  db.prepare("INSERT INTO entitlements (project, feature, license_fingerprint, status, license_id, created_at, updated_at) VALUES ('DEFAULT', 'core', ?, 'active', 'lic_plan', ?, ?)").run(oldFingerprint, NOW, NOW);
  db.prepare("INSERT INTO license_plan_assignments (license_id, project, plan_id, license_fingerprint, customer_id, status, support_until, addons_json, created_at, updated_at) VALUES ('lic_plan', 'DEFAULT', 'plan_pro', ?, 'cus_old', 'active', NULL, '[]', ?, ?)").run(oldFingerprint, NOW, NOW);
  const before = {
    assignment: db.prepare("SELECT plan_id, license_fingerprint, customer_id, addons_json FROM license_plan_assignments WHERE license_id = 'lic_plan' AND project = 'DEFAULT'").get(),
    events: db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c,
  };

  const apply = await worker.fetch(
    devReq("/api/admin/license-plans/apply", { method: "POST", body: JSON.stringify({ preview_id: previewId }) }),
    env,
  );
  assert.equal(apply.status, 409, await apply.clone().text());
  assert.equal((await body(apply)).code, "license_fingerprint_conflict");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(FP).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(oldFingerprint).c, 1);
  assert.deepEqual(db.prepare("SELECT plan_id, license_fingerprint, customer_id, addons_json FROM license_plan_assignments WHERE license_id = 'lic_plan' AND project = 'DEFAULT'").get(), before.assignment);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, before.events);
  const persisted = db.prepare("SELECT claim_token, consumed_at FROM license_plan_projection_previews WHERE id = ?").get(previewId);
  assert.equal(persisted.claim_token, null);
  assert.equal(persisted.consumed_at, null);
});

test("license-plan Apply reports a post-Preview legacy entitlement identity conflict with zero writes", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = devEnv(db);
  const preview = await worker.fetch(
    devReq("/api/admin/license-plans/preview", { method: "POST", body: JSON.stringify(projectionBody()) }),
    env,
  );
  const previewId = (await body(preview)).data.preview_id;
  const oldFingerprint = "2".repeat(64);
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, status, license_id, created_at, updated_at) VALUES ('DEFAULT', 'legacy_race', ?, 'active', 'lic_plan', ?, ?)",
  ).run(oldFingerprint, NOW, NOW);

  const apply = await worker.fetch(
    devReq("/api/admin/license-plans/apply", {
      method: "POST",
      headers: { "idempotency-key": "legacy-identity-race" },
      body: JSON.stringify({ preview_id: previewId }),
    }),
    env,
  );
  assert.equal(apply.status, 409, await apply.clone().text());
  assert.equal((await body(apply)).code, "license_fingerprint_conflict");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(oldFingerprint).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(FP).c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments WHERE license_id = 'lic_plan'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM mutation_idempotency WHERE idempotency_key = 'legacy-identity-race'").get().c, 0);
  const persisted = db.prepare("SELECT claim_token, consumed_at, applied_response_json FROM license_plan_projection_previews WHERE id = ?").get(previewId);
  assert.equal(persisted.claim_token, null);
  assert.equal(persisted.consumed_at, null);
  assert.equal(persisted.applied_response_json, null);
});

test("a changed source generation makes Apply return stale_projection_preview with no projection writes", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = devEnv(db);
  const preview = await worker.fetch(
    devReq("/api/admin/license-plans/preview", { method: "POST", body: JSON.stringify(projectionBody()) }),
    env,
  );
  const previewId = (await body(preview)).data.preview_id;
  db.prepare("UPDATE entitlement_policies SET notes = 'changed after preview' WHERE id = 'pol_node'").run();
  const apply = await worker.fetch(
    devReq("/api/admin/license-plans/apply", { method: "POST", body: JSON.stringify({ preview_id: previewId }) }),
    env,
  );
  assert.equal(apply.status, 409);
  assert.equal((await body(apply)).code, "stale_projection_preview");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments").get().c, 0);
  const persisted = db.prepare("SELECT claim_token, consumed_at FROM license_plan_projection_previews WHERE id = ?").get(previewId);
  assert.equal(persisted.claim_token, null);
  assert.equal(persisted.consumed_at, null);
});

test("concurrent same-key Apply requests produce one committed result and one replay", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = devEnv(db);
  const preview = await worker.fetch(
    devReq("/api/admin/license-plans/preview", { method: "POST", body: JSON.stringify(projectionBody()) }),
    env,
  );
  const previewId = (await body(preview)).data.preview_id;
  const request = {
    method: "POST",
    headers: { "idempotency-key": "plan-concurrent-1" },
    body: JSON.stringify({ preview_id: previewId }),
  };
  const [first, second] = await Promise.all([
    worker.fetch(devReq("/api/admin/license-plans/apply", request), env),
    worker.fetch(devReq("/api/admin/license-plans/apply", request), env),
  ]);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(second.status, 200, await second.clone().text());
  assert.equal([first.headers.get("x-idempotent-replay"), second.headers.get("x-idempotent-replay")].filter((value) => value === "1").length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements WHERE license_fingerprint = ?").get(FP).c, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE license_fingerprint = ?").get(FP).c, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM license_plan_assignments WHERE license_id = 'lic_plan'").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM mutation_idempotency WHERE idempotency_key = 'plan-concurrent-1'").get().c, 1);
});

test("the nine-action Free-tier projection path has 38 batch statements, 40 winner queries, and 41 stale-loser replay queries", async () => {
  const winnerDb = freshDb();
  seedCatalog(winnerDb);
  addIncludedProjectionFeatures(winnerDb, 6); // core/export/team plus six = exactly nine creates.
  const winnerD1 = new CountingD1Like(winnerDb);
  const winnerEnv = devEnv(winnerDb, winnerD1);
  const winnerPreview = await worker.fetch(
    devReq("/api/admin/license-plans/preview", { method: "POST", body: JSON.stringify(projectionBody()) }),
    winnerEnv,
  );
  const winnerPreviewId = (await body(winnerPreview)).data.preview_id;
  winnerD1.queryCount = 0;
  winnerD1.batchLengths = [];
  const winner = await worker.fetch(
    devReq("/api/admin/license-plans/apply", {
      method: "POST",
      headers: { "idempotency-key": "plan-budget-winner" },
      body: JSON.stringify({ preview_id: winnerPreviewId }),
    }),
    winnerEnv,
  );
  assert.equal(winner.status, 200, await winner.clone().text());
  assert.equal(winnerD1.batchLengths.at(-1), 38);
  assert.equal(winnerD1.queryCount, 40);
  assert.ok(winnerD1.queryCount <= 50);

  const loserDb = freshDb();
  seedCatalog(loserDb);
  addIncludedProjectionFeatures(loserDb, 6);
  const loserD1 = new CountingD1Like(loserDb);
  const loserEnv = devEnv(loserDb, loserD1);
  const loserPreview = await worker.fetch(
    devReq("/api/admin/license-plans/preview", { method: "POST", body: JSON.stringify(projectionBody()) }),
    loserEnv,
  );
  const loserPreviewId = (await body(loserPreview)).data.preview_id;
  // Model the only concurrent window that matters: the loser has already read
  // an empty replay cache, then the winner consumes the capability and writes
  // the replay row. The wrapper hides just that first lookup; its later replay
  // lookup reads the real row while its 38-statement claimed batch stays gated.
  loserDb.prepare("UPDATE license_plan_projection_previews SET consumed_at = ? WHERE id = ?").run(NOW, loserPreviewId);
  loserDb.prepare("INSERT INTO mutation_idempotency (scope, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?)").run(
    "POST:/api/admin/license-plans/apply:dev",
    "plan-budget-loser",
    JSON.stringify({ ok: true, code: "license_plan_projection_applied", request_id: "winner", data: {} }),
    NOW,
  );
  loserD1.queryCount = 0;
  loserD1.batchLengths = [];
  loserD1.hideFirstIdempotencyRead = true;
  const loser = await worker.fetch(
    devReq("/api/admin/license-plans/apply", {
      method: "POST",
      headers: { "idempotency-key": "plan-budget-loser" },
      body: JSON.stringify({ preview_id: loserPreviewId }),
    }),
    loserEnv,
  );
  assert.equal(loser.status, 200, await loser.clone().text());
  assert.equal(loser.headers.get("x-idempotent-replay"), "1");
  assert.equal(loserD1.batchLengths.at(-1), 38);
  assert.equal(loserD1.queryCount, 41);
  assert.ok(loserD1.queryCount <= 50);
});
