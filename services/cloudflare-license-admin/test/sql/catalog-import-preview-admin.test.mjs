import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import worker from "../../dist-worker/worker/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "cloudflare-licensing-backend", "migrations");

class PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...values) {
    const next = new PreparedStatement(this.db, this.sql);
    next.params = values.map((value) => value === undefined ? null : value);
    return next;
  }

  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
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

class CountingPreparedStatement extends PreparedStatement {
  constructor(owner, sql) {
    super(owner.db, sql);
    this.owner = owner;
  }

  bind(...values) {
    const next = new CountingPreparedStatement(this.owner, this.sql);
    next.params = values.map((value) => value === undefined ? null : value);
    return next;
  }

  async first() {
    this.owner.queryCount += 1;
    return super.first();
  }

  async all() {
    this.owner.queryCount += 1;
    return super.all();
  }

  async run() {
    this.owner.queryCount += 1;
    return super.run();
  }
}

class CountingD1Like extends D1Like {
  constructor(db) {
    super(db);
    this.queryCount = 0;
    this.batchLengths = [];
  }

  prepare(sql) {
    return new CountingPreparedStatement(this, sql);
  }

  async batch(statements) {
    this.queryCount += statements.length;
    this.batchLengths.push(statements.length);
    return super.batch(statements);
  }
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return db;
}

function envFor(db, d1 = new D1Like(db)) {
  return {
    DB: d1,
    ENVIRONMENT: "development",
    ADMIN_DEV_BEARER_ENABLED: "1",
    ADMIN_DEV_BEARER: "dev-secret",
  };
}

const NOW = 1_700_000_000;

function seedCatalog(db) {
  db.prepare(
    "INSERT INTO catalog_features (id, project, feature_key, name, description, category, status, created_at, updated_at) VALUES ('feat_core', 'DEFAULT', 'core', 'Core', 'baseline', 'base', 'active', ?, ?)",
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO catalog_plans (id, project, plan_key, name, status, version, description, created_at, updated_at) VALUES ('plan_pro', 'DEFAULT', 'pro', 'Pro', 'disabled', 1, 'baseline', ?, ?)",
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO catalog_plan_features
       (project, plan_id, feature_key, feature_inclusion, addon_key, policy_id, status, display_order,
        assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, meter_quota, meter_period_sec,
        created_at, updated_at)
     VALUES ('DEFAULT', 'plan_pro', 'core', 'included', NULL, NULL, 'active', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(NOW, NOW);
}

function seedPolicy(db, id, project = "DEFAULT") {
  db.prepare(
    `INSERT INTO entitlement_policies
       (id, project, name, type, status, valid_from_offset_sec, duration_sec, assertion_ttl_seconds,
        pool_size, max_active_devices, max_borrow_sec, expiry_strategy, trial_expiration_basis,
        trial_duration_sec, trial_one_per_device, trial_require_device_proof, notes, created_at,
        updated_at, meter_quota, meter_period_sec)
     VALUES (?, ?, ?, 'subscription', 'active', NULL, NULL, 600, 0, 1, 0, 'non_expiring',
             'from_issue', 0, 0, 0, '', ?, ?, 0, 2592000)`,
  ).run(id, project, id, NOW, NOW);
}

function transitionManifest() {
  return {
    format_version: 1,
    features: [{ project: "DEFAULT", feature_key: "core", name: "Core", description: "baseline", category: "base", status: "disabled" }],
    plans: [{
      project: "DEFAULT",
      plan_key: "pro",
      name: "Pro",
      description: "baseline",
      status: "active",
      version: 1,
      features: [{
        project: "DEFAULT",
        feature_key: "core",
        feature_inclusion: "included",
        addon_key: null,
        policy_id: null,
        status: "disabled",
        display_order: 0,
        assertion_ttl_seconds: null,
        pool_size: null,
        max_active_devices: null,
        max_borrow_sec: null,
        meter_quota: null,
        meter_period_sec: null,
      }],
    }],
  };
}

function unchangedManifest() {
  return {
    format_version: 1,
    features: [{ project: "DEFAULT", feature_key: "core", name: "Core", description: "baseline", category: "base", status: "active" }],
    plans: [{
      project: "DEFAULT",
      plan_key: "pro",
      name: "Pro",
      description: "baseline",
      status: "disabled",
      version: 1,
      features: [{
        project: "DEFAULT",
        feature_key: "core",
        feature_inclusion: "included",
        addon_key: null,
        policy_id: null,
        status: "active",
        display_order: 0,
        assertion_ttl_seconds: null,
        pool_size: null,
        max_active_devices: null,
        max_borrow_sec: null,
        meter_quota: null,
        meter_period_sec: null,
      }],
    }],
  };
}

function creationManifest(count) {
  return {
    format_version: 1,
    features: Array.from({ length: count }, (_item, index) => ({
      project: "DEFAULT",
      feature_key: `f${index}`,
      name: `Feature ${index}`,
      description: "",
      status: "active",
    })),
    plans: [],
  };
}

async function previewImport(env, manifest) {
  const response = await worker.fetch(
    request("/api/admin/catalog/import?dry_run=1", { method: "POST", body: JSON.stringify(manifest) }),
    env,
  );
  return { response, payload: await response.json() };
}

async function applyImport(env, previewId, key = crypto.randomUUID()) {
  const response = await worker.fetch(
    request("/api/admin/catalog/import", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ preview_id: previewId }),
    }),
    env,
  );
  return { response, payload: await response.json() };
}

function request(path, options = {}) {
  return new Request(`https://admin.example${path}`, {
    ...options,
    headers: {
      authorization: "Bearer dev-secret",
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
}

test("catalog import Apply rejects a direct manifest and requires a server-bound preview", async () => {
  const db = freshDb();
  const response = await worker.fetch(
    request("/api/admin/catalog/import", {
      method: "POST",
      headers: { "idempotency-key": "catalog-preview-required" },
      body: JSON.stringify({ format_version: 1, features: [], plans: [] }),
    }),
    envFor(db),
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).code, "preview_required");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mutation_idempotency").get().count, 0);
});

test("catalog import Preview rejects two versions of one (project, plan_key) entity before persisting a capability", async () => {
  const db = freshDb();
  const response = await worker.fetch(
    request("/api/admin/catalog/import?dry_run=1", {
      method: "POST",
      body: JSON.stringify({
        format_version: 1,
        features: [],
        plans: [
          { project: "DEFAULT", plan_key: "pro", name: "Pro v1", version: 1 },
          { project: "DEFAULT", plan_key: "pro", name: "Pro v2", version: 2 },
        ],
      }),
    }),
    envFor(db),
  );
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).code, "invalid_request");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_import_previews").get().count, 0);
});

test("catalog import rejects tuple control characters before previewing", async () => {
  const db = freshDb();
  const response = await worker.fetch(
    request("/api/admin/catalog/import?dry_run=1", {
      method: "POST",
      body: JSON.stringify({
        format_version: 1,
        features: [{ project: "DEFAULT\u001fOTHER", feature_key: "core", name: "Core" }],
        plans: [],
      }),
    }),
    envFor(db),
  );

  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).code, "invalid_request");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_import_previews").get().count, 0);
});

test("catalog import reports a cross-project policy as its exact invalid_plan_config conflict", async () => {
  const db = freshDb();
  seedCatalog(db);
  seedPolicy(db, "pol_other_project", "OTHER");
  const response = await worker.fetch(
    request("/api/admin/catalog/import?dry_run=1", {
      method: "POST",
      body: JSON.stringify({
        format_version: 1,
        features: [{ project: "DEFAULT", feature_key: "core", name: "Core", description: "baseline", category: "base", status: "active" }],
        plans: [{
          project: "DEFAULT",
          plan_key: "pro",
          name: "Pro",
          description: "baseline",
          status: "disabled",
          version: 1,
          features: [{ project: "DEFAULT", feature_key: "core", feature_inclusion: "included", policy_id: "pol_other_project" }],
        }],
      }),
    }),
    envFor(db),
  );

  assert.equal(response.status, 409, await response.clone().text());
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "invalid_plan_config");
  assert.match(payload.request_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(payload.data, { policy_id: "pol_other_project" });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_import_previews").get().count, 0);
});

test("catalog import Preview persists an opaque actor-bound capability with normalized effects", async () => {
  const db = freshDb();
  const response = await worker.fetch(
    request("/api/admin/catalog/import?dry_run=1", {
      method: "POST",
      body: JSON.stringify({ format_version: 1, features: [], plans: [] }),
    }),
    envFor(db),
  );

  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert.equal(payload.code, "catalog_import_previewed");
  assert.match(payload.data.preview_id, /^civ_[A-Za-z0-9_-]+$/);
  assert.match(payload.data.manifest_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(payload.data.effects.summary.features, {
    create: 0,
    update: 0,
    disable: 0,
    reenable: 0,
    unchanged: 0,
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_import_previews").get().count, 1);
});

test("catalog import Preview exposes exact status transitions and Apply writes matching audits at the preview time", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = envFor(db);
  const preview = await previewImport(env, transitionManifest());
  assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
  const data = preview.payload.data;
  assert.deepEqual(data.effects.summary, {
    features: { create: 0, update: 0, disable: 1, reenable: 0, unchanged: 0 },
    plans: { create: 0, update: 0, disable: 0, reenable: 1, unchanged: 0 },
    plan_features: { create: 0, update: 0, disable: 1, reenable: 0, unchanged: 0 },
  });
  assert.equal(data.effects.features[0].before.status, "active");
  assert.equal(data.effects.features[0].after.status, "disabled");
  assert.equal(data.effects.plans[0].before.status, "disabled");
  assert.equal(data.effects.plans[0].after.status, "active");

  const applied = await applyImport(env, data.preview_id, "catalog-transition-1");
  assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
  assert.equal(applied.payload.code, "catalog_import_applied");
  assert.equal(db.prepare("SELECT status FROM catalog_features WHERE id = 'feat_core'").get().status, "disabled");
  assert.equal(db.prepare("SELECT status FROM catalog_plans WHERE id = 'plan_pro'").get().status, "active");
  assert.equal(db.prepare("SELECT status FROM catalog_plan_features WHERE plan_id = 'plan_pro' AND feature_key = 'core'").get().status, "disabled");
  const audits = db.prepare("SELECT entity_type, event_type, prev_json, next_json, created_at FROM catalog_events ORDER BY id").all().map((row) => ({ ...row }));
  assert.deepEqual(
    audits.map(({ entity_type, event_type, created_at }) => ({ entity_type, event_type, created_at })),
    [
      { entity_type: "feature", event_type: "disable", created_at: data.effective_at },
      { entity_type: "plan", event_type: "reenable", created_at: data.effective_at },
      { entity_type: "plan_feature", event_type: "disable", created_at: data.effective_at },
    ],
  );
  assert.deepEqual(audits.map((audit) => [JSON.parse(audit.prev_json).status, JSON.parse(audit.next_json).status]), [
    ["active", "disabled"],
    ["disabled", "active"],
    ["active", "disabled"],
  ]);
});

test("catalog import publishes unchanged effects as exact persisted rows and Apply leaves every row byte-for-byte equivalent", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = envFor(db);
  const preview = await previewImport(env, unchangedManifest());
  assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
  const { effects } = preview.payload.data;
  assert.deepEqual(effects.summary, {
    features: { create: 0, update: 0, disable: 0, reenable: 0, unchanged: 1 },
    plans: { create: 0, update: 0, disable: 0, reenable: 0, unchanged: 1 },
    plan_features: { create: 0, update: 0, disable: 0, reenable: 0, unchanged: 1 },
  });
  for (const effect of [effects.features[0], effects.plans[0], effects.plan_features[0]]) {
    assert.equal(effect.effect, "unchanged");
    assert.deepEqual(effect.after, effect.before);
  }

  const applied = await applyImport(env, preview.payload.data.preview_id, "catalog-unchanged");
  assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
  assert.deepEqual(
    { ...db.prepare("SELECT id, project, feature_key, name, description, category, status, created_at, updated_at FROM catalog_features WHERE id = 'feat_core'").get() },
    effects.features[0].after,
  );
  assert.deepEqual(
    { ...db.prepare("SELECT id, project, plan_key, name, status, version, description, created_at, updated_at FROM catalog_plans WHERE id = 'plan_pro'").get() },
    effects.plans[0].after,
  );
  assert.deepEqual(
    { ...db.prepare(`SELECT project, plan_id, feature_key, feature_inclusion, addon_key, policy_id, status, display_order,
                            assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, meter_quota,
                            meter_period_sec, created_at, updated_at
                       FROM catalog_plan_features WHERE plan_id = 'plan_pro' AND feature_key = 'core'`).get() },
    effects.plan_features[0].after,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_events").get().count, 0);
});

test("catalog import source mutation, expiry, actor mismatch, and malformed preview ids leave Apply write-free", async () => {
  const db = freshDb();
  seedCatalog(db);
  const env = envFor(db);

  const stalePreview = await previewImport(env, transitionManifest());
  db.prepare("UPDATE catalog_features SET description = 'changed after Preview' WHERE id = 'feat_core'").run();
  const stale = await applyImport(env, stalePreview.payload.data.preview_id, "catalog-stale");
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.code, "stale_catalog_import_preview");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_events").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mutation_idempotency WHERE idempotency_key = 'catalog-stale'").get().count, 0);

  const expiredPreview = await previewImport(env, { format_version: 1, features: [], plans: [] });
  db.prepare("UPDATE catalog_import_previews SET expires_at = 0 WHERE id = ?").run(expiredPreview.payload.data.preview_id);
  const expired = await applyImport(env, expiredPreview.payload.data.preview_id, "catalog-expired");
  assert.equal(expired.response.status, 409);
  assert.equal(expired.payload.code, "expired_catalog_import_preview");

  const actorPreview = await previewImport(env, { format_version: 1, features: [], plans: [] });
  db.prepare("UPDATE catalog_import_previews SET actor_subject = 'other-operator' WHERE id = ?").run(actorPreview.payload.data.preview_id);
  const actorMismatch = await applyImport(env, actorPreview.payload.data.preview_id, "catalog-actor");
  assert.equal(actorMismatch.response.status, 409);
  assert.equal(actorMismatch.payload.code, "stale_catalog_import_preview");

  const malformed = await applyImport(env, "civ_bad=preview", "catalog-malformed");
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.payload.code, "invalid_request");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_events").get().count, 0);
});

test("a second catalog audit failure rolls back every catalog row, audit, idempotency response, and preview claim", async () => {
  const db = freshDb();
  const env = envFor(db);
  const preview = await previewImport(env, creationManifest(2));
  assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
  db.exec(
    `CREATE TRIGGER fail_second_catalog_import_audit
     BEFORE INSERT ON catalog_events
     WHEN (SELECT COUNT(*) FROM catalog_events) >= 1
     BEGIN
       SELECT RAISE(ABORT, 'forced catalog import audit failure');
     END`,
  );

  const applied = await applyImport(env, preview.payload.data.preview_id, "catalog-rollback");
  assert.equal(applied.response.status, 500);
  assert.equal(applied.payload.code, "catalog_mutation_failed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_features").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_events").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM license_plan_assignments").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mutation_idempotency WHERE idempotency_key = 'catalog-rollback'").get().count, 0);
  assert.deepEqual(
    { ...db.prepare("SELECT claim_token, consumed_at, applied_response_json FROM catalog_import_previews WHERE id = ?").get(preview.payload.data.preview_id) },
    { claim_token: null, consumed_at: null, applied_response_json: null },
  );
});

test("a second catalog row failure rolls back the first row, audits, idempotency, and preview claim", async () => {
  const db = freshDb();
  const env = envFor(db);
  const preview = await previewImport(env, creationManifest(2));
  assert.equal(preview.response.status, 200, JSON.stringify(preview.payload));
  db.exec(
    `CREATE TRIGGER fail_second_catalog_import_row
     BEFORE INSERT ON catalog_features
     WHEN (SELECT COUNT(*) FROM catalog_features) >= 1
     BEGIN
       SELECT RAISE(ABORT, 'forced catalog import row failure');
     END`,
  );

  const applied = await applyImport(env, preview.payload.data.preview_id, "catalog-row-rollback");
  assert.equal(applied.response.status, 500);
  assert.equal(applied.payload.code, "catalog_mutation_failed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_features").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_events").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM license_plan_assignments").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mutation_idempotency WHERE idempotency_key = 'catalog-row-rollback'").get().count, 0);
  assert.deepEqual(
    { ...db.prepare("SELECT claim_token, consumed_at, applied_response_json FROM catalog_import_previews WHERE id = ?").get(preview.payload.data.preview_id) },
    { claim_token: null, consumed_at: null, applied_response_json: null },
  );
});

test("same-key concurrent catalog Applies commit once and replay once; another key sees the claimed capability", async () => {
  const db = freshDb();
  const env = envFor(db);
  const preview = await previewImport(env, creationManifest(1));
  const previewId = preview.payload.data.preview_id;
  const key = "catalog-concurrent";
  const [first, second] = await Promise.all([
    applyImport(env, previewId, key),
    applyImport(env, previewId, key),
  ]);
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  assert.equal([first.response.headers.get("x-idempotent-replay"), second.response.headers.get("x-idempotent-replay")].filter((value) => value === "1").length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_features").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_events").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mutation_idempotency WHERE idempotency_key = ?").get(key).count, 1);
  const anotherKey = await applyImport(env, previewId, "catalog-other-key");
  assert.equal(anotherKey.response.status, 409);
  assert.equal(anotherKey.payload.code, "claimed_catalog_import_preview");
});

test("the thirteen-action catalog Apply path stays below 50 Free-tier queries and fourteen actions are rejected read-only", async () => {
  const winnerDb = freshDb();
  const winnerD1 = new CountingD1Like(winnerDb);
  const winnerEnv = envFor(winnerDb, winnerD1);
  const winnerPreview = await previewImport(winnerEnv, creationManifest(13));
  assert.equal(winnerPreview.response.status, 200, JSON.stringify(winnerPreview.payload));
  winnerD1.queryCount = 0;
  winnerD1.batchLengths = [];
  const winner = await applyImport(winnerEnv, winnerPreview.payload.data.preview_id, "catalog-budget-winner");
  assert.equal(winner.response.status, 200, JSON.stringify(winner.payload));
  assert.equal(winnerD1.batchLengths.at(-1), 46);
  assert.equal(winnerD1.queryCount, 48);
  assert.ok(winnerD1.queryCount < 50);

  // A same-key concurrent loser may read the idempotency cache just before the
  // winner commits. It then executes the fully gated claim batch and retries
  // the cache once. Count that realistic worst case mechanically: 1 replay
  // read + 1 stored-preview read + 46 batch statements + 1 replay retry.
  const loserDb = freshDb();
  const loserD1 = new CountingD1Like(loserDb);
  const loserEnv = envFor(loserDb, loserD1);
  const loserPreview = await previewImport(loserEnv, creationManifest(13));
  loserDb.prepare("UPDATE catalog_import_previews SET claim_token = 'already-claimed' WHERE id = ?").run(loserPreview.payload.data.preview_id);
  loserD1.queryCount = 0;
  loserD1.batchLengths = [];
  const loser = await applyImport(loserEnv, loserPreview.payload.data.preview_id, "catalog-budget-loser");
  assert.equal(loser.response.status, 409, JSON.stringify(loser.payload));
  assert.equal(loser.payload.code, "claimed_catalog_import_preview");
  assert.equal(loserD1.batchLengths.at(-1), 46);
  assert.equal(loserD1.queryCount, 49);
  assert.ok(loserD1.queryCount < 50);
  assert.equal(loserDb.prepare("SELECT COUNT(*) AS count FROM catalog_features").get().count, 0);
  assert.equal(loserDb.prepare("SELECT COUNT(*) AS count FROM catalog_events").get().count, 0);
  assert.equal(loserDb.prepare("SELECT COUNT(*) AS count FROM mutation_idempotency").get().count, 0);

  const oversizedDb = freshDb();
  const oversized = await previewImport(envFor(oversizedDb), creationManifest(14));
  assert.equal(oversized.response.status, 409);
  assert.equal(oversized.payload.code, "catalog_import_too_large");
  assert.deepEqual(oversized.payload.data, {
    max_mutable_actions: 13,
    guidance: "narrow the manifest and preview again",
  });
  assert.equal(oversizedDb.prepare("SELECT COUNT(*) AS count FROM catalog_import_previews").get().count, 0);
  assert.equal(oversizedDb.prepare("SELECT COUNT(*) AS count FROM catalog_features").get().count, 0);
});

test("catalog import rejects a present invalid idempotency key even for dry-run Preview", async () => {
  const db = freshDb();
  const response = await worker.fetch(
    request("/api/admin/catalog/import?dry_run=1", {
      method: "POST",
      headers: { "idempotency-key": "" },
      body: JSON.stringify({ format_version: 1, features: [], plans: [] }),
    }),
    envFor(db),
  );
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).code, "invalid_idempotency_key");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM catalog_import_previews").get().count, 0);
});
