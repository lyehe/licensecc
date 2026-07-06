import assert from "node:assert/strict";
import { test } from "node:test";

import adminWorker from "../../../cloudflare-license-admin/dist-worker/worker/index.js";
import { createLocalSqliteDb } from "../../local-host/db-sqlite.mjs";
import verifierWorker from "../../dist/index.js";

const NOW = 1_700_000_000;
const SUPPORT_UNTIL = 1_900_000_000;
const FP = "d".repeat(64);

function adminEnv(DB) {
  return {
    DB,
    ENVIRONMENT: "development",
    ADMIN_DEV_BEARER_ENABLED: "1",
    ADMIN_DEV_BEARER: "dev-secret",
  };
}

function adminReq(path, options = {}) {
  return new Request(`https://admin.example${path}`, {
    ...options,
    headers: { authorization: "Bearer dev-secret", "content-type": "application/json", ...(options.headers ?? {}) },
  });
}

function bytesToPem(bytes, label) {
  const b64 = Buffer.from(bytes).toString("base64");
  const lines = b64.match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

async function verifierEnv(DB) {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  return {
    ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: bytesToPem(new Uint8Array(pkcs8), "PRIVATE KEY"),
    ONLINE_SIGNING_KEY_ID: "sha256:e2e-catalog",
    MAX_ASSERTION_TTL_SECONDS: "300",
    DB,
  };
}

function verifyReq(feature) {
  return new Request("https://verifier.example/v1/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: "DEFAULT",
      feature,
      license_fingerprint: FP,
      device_hash: "",
      nonce: "e".repeat(64),
    }),
  });
}

async function responseBody(response) {
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
    meter_period_sec: 2_592_000,
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

function catalogManifest() {
  return {
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
          { project: "DEFAULT", feature_key: "core", feature_inclusion: "included", addon_key: null, policy_id: "pol_node", status: "active", display_order: 1, assertion_ttl_seconds: null, pool_size: null, max_active_devices: null, max_borrow_sec: null, meter_quota: null, meter_period_sec: null },
          { project: "DEFAULT", feature_key: "team", feature_inclusion: "addon", addon_key: "team_seats", policy_id: "pol_float", status: "active", display_order: 2, assertion_ttl_seconds: null, pool_size: 6, max_active_devices: 6, max_borrow_sec: 172_800, meter_quota: null, meter_period_sec: null },
        ],
      },
    ],
  };
}

function projectionBody() {
  return {
    project: "DEFAULT",
    license_id: "lic_catalog_e2e",
    license_fingerprint: FP,
    customer_id: "cus_catalog_e2e",
    plan_key: "pro",
    support_until: SUPPORT_UNTIL,
    addons: ["team_seats"],
    notes: "catalog admin worker e2e",
  };
}

test("admin catalog import and plan projection feed public verifier through worker boundaries", async () => {
  const { db, adapter } = createLocalSqliteDb({ path: ":memory:" });
  try {
    seedPolicy(db, "pol_node");
    seedPolicy(db, "pol_float", { type: "floating", pool_size: 6, max_active_devices: 6, max_borrow_sec: 172_800 });
    const env = adminEnv(adapter);
    const manifest = catalogManifest();

    const dryRun = await adminWorker.fetch(adminReq("/api/admin/catalog/import?dry_run=1", { method: "POST", body: JSON.stringify(manifest) }), env);
    assert.equal(dryRun.status, 200, await dryRun.clone().text());
    assert.deepEqual((await responseBody(dryRun)).data, {
      features: { created: 2, updated: 0, unchanged: 0 },
      plans: { created: 1, updated: 0, unchanged: 0 },
      plan_features: { created: 2, updated: 0, unchanged: 0 },
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM catalog_features").get().c, 0);

    const appliedImport = await adminWorker.fetch(adminReq("/api/admin/catalog/import", {
      method: "POST",
      headers: { "idempotency-key": "catalog-admin-worker-e2e-import" },
      body: JSON.stringify(manifest),
    }), env);
    assert.equal(appliedImport.status, 200, await appliedImport.clone().text());
    assert.equal((await responseBody(appliedImport)).code, "catalog_import_applied");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM catalog_features").get().c, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM catalog_plan_features").get().c, 2);

    const planId = db.prepare("SELECT id FROM catalog_plans WHERE project = 'DEFAULT' AND plan_key = 'pro'").get().id;
    const exported = await adminWorker.fetch(adminReq(`/api/admin/catalog/plans/${encodeURIComponent(planId)}/export`), env);
    assert.equal(exported.status, 200, await exported.clone().text());
    const exportedBody = await responseBody(exported);
    assert.equal(exportedBody.code, "catalog_plan_exported");
    assert.equal(exportedBody.data.plans[0].features.find((row) => row.feature_key === "team").addon_key, "team_seats");

    const preview = await adminWorker.fetch(adminReq("/api/admin/license-plans/preview", {
      method: "POST",
      body: JSON.stringify(projectionBody()),
    }), env);
    assert.equal(preview.status, 200, await preview.clone().text());
    const previewBody = await responseBody(preview);
    assert.equal(previewBody.code, "license_plan_projection_previewed");
    assert.equal(previewBody.data.summary.create, 2);
    assert.deepEqual(previewBody.data.will_create.map((row) => row.feature), ["core", "team"]);
    assert.equal(previewBody.data.will_create.find((row) => row.feature === "team").license_mode, "floating");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);

    const appliedProjection = await adminWorker.fetch(adminReq("/api/admin/license-plans/apply", {
      method: "POST",
      headers: { "idempotency-key": "catalog-admin-worker-e2e-apply" },
      body: JSON.stringify(projectionBody()),
    }), env);
    assert.equal(appliedProjection.status, 200, await appliedProjection.clone().text());
    const appliedBody = await responseBody(appliedProjection);
    assert.equal(appliedBody.code, "license_plan_projection_applied");
    assert.equal(appliedBody.data.applied.created.length, 2);

    const team = db.prepare("SELECT license_id, customer_id, pool_size, max_active_devices, max_borrow_sec FROM entitlements WHERE project = 'DEFAULT' AND feature = 'team' AND license_fingerprint = ?").get(FP);
    assert.equal(team.license_id, "lic_catalog_e2e");
    assert.equal(team.customer_id, "cus_catalog_e2e");
    assert.equal(team.pool_size, 6);
    assert.equal(team.max_active_devices, 6);
    assert.equal(team.max_borrow_sec, 172_800);

    const verifier = await verifierEnv(adapter);
    const allowedCore = await verifierWorker.fetch(verifyReq("core"), verifier);
    assert.equal(allowedCore.status, 200);
    const allowedCoreBody = await responseBody(allowedCore);
    assert.equal(allowedCoreBody.ok, true);
    assert.match(allowedCoreBody.assertion, /^lccoa1\./);

    const allowedTeam = await verifierWorker.fetch(verifyReq("team"), verifier);
    assert.equal(allowedTeam.status, 200);
    const allowedTeamBody = await responseBody(allowedTeam);
    assert.equal(allowedTeamBody.ok, true);
    assert.match(allowedTeamBody.assertion, /^lccoa1\./);
  } finally {
    db.close();
  }
});
