import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { test } from "node:test";

import adminWorker from "../../../cloudflare-license-admin/dist-worker/worker/index.js";
import { createLocalSqliteDb } from "../../local-host/db-sqlite.mjs";
import backend from "../../dist/app.js";
import { inspectBoundAuthorization, approveBoundAuthorization } from "../../src/device/bound_consent.mjs";
import { boundRandomId } from "../../src/device/bound_enrollment.mjs";
import { importBoundDeviceKey, normalizeDeviceSignature, sha256Hex } from "../../src/device/bound_crypto.mjs";
import { encodeBase64url, deviceOperationBody, deviceProofSigningInput, decodeDeviceLeaseEnvelope, deviceLeaseSigningInput } from "@licensecc/licensing-domain/lease/device_protocol";

const NOW = 1_700_000_000;
const SUPPORT_UNTIL = 1_900_000_000;
const FP = "d".repeat(64);
const signer = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString("base64")}\n-----END ${label}-----`;
const privatePem = pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", signer.privateKey));
const publicPem = pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", signer.publicKey));
const config = { issuer: "https://license.test/", audience: "desktop", authorization_url: "https://portal.test/connect",
  clients: [{ client_id: "desktop", project: "DEFAULT", display_name: "Application", callbacks: [{ host: "127.0.0.1", path: "/callback" }] }] };

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

// The consent and signed-exchange flow a protected application runs: a new device key asks for the
// named grant, the customer approves it, and the key proves possession to receive a signed lease.
async function signedExchange(adapter, env, customerId, entitlementId) {
  const call = async (path, body) => {
    const response = await backend.fetch(new Request(`https://license.test${path}`, { method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "127.0.0.2" }, body: JSON.stringify(body) }), env);
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result.data;
  };
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)));
  const verifier = boundRandomId(32), redirect = "http://127.0.0.1:45678/callback";
  const challenge = encodeBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const attempt = await call("/v2/device-authorizations", { client_id: "desktop", project: "DEFAULT", public_key_spki: spki,
    device_label: "Workstation", redirect_uri: redirect, state: boundRandomId(32), code_challenge: challenge, code_challenge_method: "S256" });
  const page = await inspectBoundAuthorization(adapter, customerId, attempt.attempt_handle, config);
  assert.ok(page.entitlements.some((offered) => offered.id === entitlementId), "the plan-applied grant is offered for consent");
  const consent = await approveBoundAuthorization(adapter, customerId, { attempt_handle: attempt.attempt_handle,
    entitlement_id: entitlementId, expected_attempt_revision: 0, operation_id: boundRandomId(32) }, config,
  JSON.stringify({ active: "approval", keys: { approval: boundRandomId(32) } }));
  const body = { attempt_handle: attempt.attempt_handle, code: new URL(consent.callback_url).searchParams.get("code"),
    code_verifier: verifier, redirect_uri: redirect, operation_id: boundRandomId(32) };
  const proofChallenge = await call("/v2/device-challenges", { purpose: "exchange", attempt_handle: body.attempt_handle, operation_id: body.operation_id });
  const keyId = (await importBoundDeviceKey(spki)).keyId;
  const intent = { audience: config.audience, method: "POST", path: "/v2/device-authorizations/exchange", key_id: keyId,
    operation_id: body.operation_id, body_sha256: await sha256Hex(deviceOperationBody("exchange", body)), ...proofChallenge };
  const signature = encodeBase64url(normalizeDeviceSignature(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, deviceProofSigningInput(intent)))));
  const result = await call("/v2/device-authorizations/exchange", { ...body, proof: { key_id: keyId, challenge_id: proofChallenge.challenge_id,
    nonce: proofChallenge.nonce, expires_at: proofChallenge.expires_at, signature } });
  const lease = decodeDeviceLeaseEnvelope(result.lease);
  assert.equal(verify("RSA-SHA256", deviceLeaseSigningInput(lease.payload), createPublicKey(publicPem), lease.signature), true);
  return lease.claims;
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
    max_active_devices: 1,
    expiry_strategy: "non_expiring",
    trial_expiration_basis: "from_issue",
    trial_duration_sec: 0,
    trial_one_per_device: 0,
    notes: "",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO entitlement_policies
      (id, project, name, type, status, valid_from_offset_sec, duration_sec, max_active_devices,
       expiry_strategy, trial_expiration_basis, trial_duration_sec, trial_one_per_device, notes,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    policy.project,
    policy.name,
    policy.type,
    policy.status,
    policy.valid_from_offset_sec,
    policy.duration_sec,
    policy.max_active_devices,
    policy.expiry_strategy,
    policy.trial_expiration_basis,
    policy.trial_duration_sec,
    policy.trial_one_per_device,
    policy.notes,
    NOW,
    NOW,
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
          { project: "DEFAULT", feature_key: "core", feature_inclusion: "included", addon_key: null, policy_id: "pol_node", status: "active", display_order: 1, max_active_devices: null },
          { project: "DEFAULT", feature_key: "team", feature_inclusion: "addon", addon_key: "team_seats", policy_id: "pol_team", status: "active", display_order: 2, max_active_devices: 6 },
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

test("admin catalog import and plan projection yield protected grants that support a signed exchange", async () => {
  const { db, adapter } = createLocalSqliteDb({ path: ":memory:" });
  try {
    const now = Math.floor(Date.now() / 1000); db.function("unixepoch", () => now);
    // Plan apply names the customer and license; the protected issuer requires both to exist and be active.
    db.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('cus_catalog_e2e','Owner',1,1);
      INSERT INTO licenses(id,customer_id,project,created_at,updated_at) VALUES('lic_catalog_e2e','cus_catalog_e2e','DEFAULT',1,1);`);
    seedPolicy(db, "pol_node");
    seedPolicy(db, "pol_team", { max_active_devices: 3 });
    const env = adminEnv(adapter);
    const manifest = catalogManifest();

    const dryRun = await adminWorker.fetch(adminReq("/api/admin/catalog/import?dry_run=1", { method: "POST", body: JSON.stringify(manifest) }), env);
    assert.equal(dryRun.status, 200, await dryRun.clone().text());
    const catalogPreview = await responseBody(dryRun);
    assert.equal(catalogPreview.code, "catalog_import_previewed");
    assert.match(catalogPreview.data.preview_id, /^civ_[A-Za-z0-9_-]{1,124}$/);
    assert.deepEqual(catalogPreview.data.effects.summary, {
      features: { create: 2, update: 0, disable: 0, reenable: 0, unchanged: 0 },
      plans: { create: 1, update: 0, disable: 0, reenable: 0, unchanged: 0 },
      plan_features: { create: 2, update: 0, disable: 0, reenable: 0, unchanged: 0 },
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM catalog_features").get().c, 0);

    const appliedImport = await adminWorker.fetch(adminReq("/api/admin/catalog/import", {
      method: "POST",
      headers: { "idempotency-key": "catalog-admin-worker-e2e-import" },
      body: JSON.stringify({ preview_id: catalogPreview.data.preview_id }),
    }), env);
    assert.equal(appliedImport.status, 200, await appliedImport.clone().text());
    const appliedImportBody = await responseBody(appliedImport);
    assert.equal(appliedImportBody.code, "catalog_import_applied");
    assert.equal(appliedImportBody.data.preview_id, catalogPreview.data.preview_id);
    assert.deepEqual(appliedImportBody.data.effects.summary, catalogPreview.data.effects.summary);
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
    // A projected grant is protected: node-locked, with the plan row's device limit.
    assert.equal(previewBody.data.will_create.find((row) => row.feature === "team").license_mode, "node_locked");
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);

    const appliedProjection = await adminWorker.fetch(adminReq("/api/admin/license-plans/apply", {
      method: "POST",
      headers: { "idempotency-key": "catalog-admin-worker-e2e-apply" },
      body: JSON.stringify({ preview_id: previewBody.data.preview_id }),
    }), env);
    assert.equal(appliedProjection.status, 200, await appliedProjection.clone().text());
    const appliedBody = await responseBody(appliedProjection);
    assert.equal(appliedBody.code, "license_plan_projection_applied");
    assert.equal(appliedBody.data.applied.created.length, 2);

    assert.equal("cache_ttl_seconds" in appliedBody.data.applied.created[0], false, "private cache policy must not change the public Apply response shape");
    const rows = db.prepare(`SELECT feature, enforcement_mode, device_hash, license_id, customer_id, pool_size, max_active_devices, max_borrow_sec
      FROM entitlements WHERE project = 'DEFAULT' AND license_fingerprint = ? ORDER BY feature`).all(FP).map((row) => ({ ...row }));
    const protectedGrant = (feature, maxActiveDevices) => ({ feature, enforcement_mode: "device_bound_v1", device_hash: "", license_id: "lic_catalog_e2e",
      customer_id: "cus_catalog_e2e", pool_size: 0, max_active_devices: maxActiveDevices, max_borrow_sec: 0 });
    // The plan row's device limit overrides the team policy's; no grant has a seat pool or borrowing.
    assert.deepEqual(rows, [protectedGrant("core", 1), protectedGrant("team", 6)]);

    // Each plan-applied grant supports the protected consent and signed exchange.
    const backendEnv = { DB: adapter, BOUND_DEVICE_CONFIG: JSON.stringify(config), BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM: privatePem,
      BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM: publicPem, DEVICE_PROOF_MODE: "off", ACCOUNT_TOKEN_MODE: "off", REQUEST_SIGNATURE_MODE: "off", D1_RATE_LIMIT_ENABLED: "0" };
    for (const created of appliedBody.data.applied.created) {
      const claims = await signedExchange(adapter, backendEnv, "cus_catalog_e2e", created.id);
      assert.equal(claims.project, "DEFAULT"); assert.equal(claims.feature, created.feature); assert.equal(claims["license-fingerprint"], FP);
    }
    assert.equal(db.prepare("SELECT count(*) AS n FROM device_bound_bindings WHERE state = 'active'").get().n, 2);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
