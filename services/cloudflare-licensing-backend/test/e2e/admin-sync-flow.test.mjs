import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { test } from "node:test";
import adminWorker from "../../../cloudflare-license-admin/dist-worker/worker/index.js";
import backend from "../../dist/app.js";
import { baseFixture } from "../../../cloudflare-customer-portal/test/portal-worker-fixtures.mjs";
import { inspectBoundAuthorization, approveBoundAuthorization } from "../../src/device/bound_consent.mjs";
import { boundRandomId } from "../../src/device/bound_enrollment.mjs";
import { importBoundDeviceKey, normalizeDeviceSignature, sha256Hex } from "../../src/device/bound_crypto.mjs";
import { encodeBase64url, deviceOperationBody, deviceProofSigningInput, decodeDeviceLeaseEnvelope, deviceLeaseSigningInput } from "@licensecc/licensing-domain/lease/device_protocol";

const fingerprint = "d".repeat(64);
const signer = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString("base64")}\n-----END ${label}-----`;
const privatePem = pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", signer.privateKey));
const publicPem = pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", signer.publicKey));
const config = { issuer: "https://license.test/", audience: "desktop", authorization_url: "https://portal.test/connect",
  clients: [{ client_id: "desktop", project: "APP", display_name: "Application", callbacks: [{ host: "127.0.0.1", path: "/callback" }] }] };

function syncRequest(body) {
  return new Request("https://admin.example/api/sync/entitlements", {
    method: "POST",
    headers: { authorization: "Bearer sync-secret", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Every grant the shared writer creates is protected, so a synced grant is enrolled and exchanged
// through the device protocol.
test("user database sync yields a protected grant that supports a signed exchange until it is revoked", async t => {
  const { db, env: portal } = baseFixture(); t.after(() => db.close());
  const now = Math.floor(Date.now() / 1000); db.function("unixepoch", () => now);
  db.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('cus_sync','Owner',1,1);
    INSERT INTO licenses(id,customer_id,project,created_at,updated_at) VALUES('lic_sync','cus_sync','APP',1,1);`);
  const adminEnv = { DB: portal.DB, ENVIRONMENT: "development", ADMIN_DEV_BEARER_ENABLED: "0", SYNC_API_TOKEN: "sync-secret" };
  const grant = { project: "APP", feature: "PRO", license_fingerprint: fingerprint, customer_id: "cus_sync", license_id: "lic_sync" };

  const synced = await adminWorker.fetch(syncRequest({ ...grant, status: "active", reason: "subscription active" }), adminEnv);
  const syncedBody = await synced.json();
  assert.equal(synced.status, 200, JSON.stringify(syncedBody));
  assert.equal(syncedBody.code, "entitlement_synced");
  assert.equal(syncedBody.data.enforcement_mode, "device_bound_v1");
  assert.equal(db.prepare("SELECT source FROM entitlement_events ORDER BY id DESC LIMIT 1").get().source, "sync");

  const env = { DB: portal.DB, BOUND_DEVICE_CONFIG: JSON.stringify(config), BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM: privatePem,
    BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM: publicPem, DEVICE_PROOF_MODE: "off", ACCOUNT_TOKEN_MODE: "off", REQUEST_SIGNATURE_MODE: "off", D1_RATE_LIMIT_ENABLED: "0" };
  const call = async (path, body) => {
    const response = await backend.fetch(new Request(`https://license.test${path}`, { method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "127.0.0.2" }, body: JSON.stringify(body) }), env);
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result.data;
  };
  const authorize = async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)));
    const verifier = boundRandomId(32), redirect = "http://127.0.0.1:45678/callback";
    const challenge = encodeBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const attempt = await call("/v2/device-authorizations", { client_id: "desktop", project: "APP", public_key_spki: spki,
      device_label: "Workstation", redirect_uri: redirect, state: boundRandomId(32), code_challenge: challenge, code_challenge_method: "S256" });
    return { keys, spki, verifier, redirect, attempt, page: await inspectBoundAuthorization(portal.DB, "cus_sync", attempt.attempt_handle, config) };
  };

  const { keys, spki, verifier, redirect, attempt, page } = await authorize();
  assert.equal(page.entitlements.length, 1); assert.equal(page.entitlements[0].id, syncedBody.data.id);
  const consent = await approveBoundAuthorization(portal.DB, "cus_sync", { attempt_handle: attempt.attempt_handle,
    entitlement_id: syncedBody.data.id, expected_attempt_revision: 0, operation_id: boundRandomId(32) }, config,
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
  assert.equal(lease.claims.project, "APP"); assert.equal(lease.claims.feature, "PRO");
  assert.equal(db.prepare("SELECT count(*) AS n FROM device_bound_bindings WHERE state='active'").get().n, 1);

  // A revocation synced from the user database reaches the protected path: the grant is no longer offered.
  assert.equal((await authorize()).page.entitlements.length, 1, "the active grant is still offered");
  const revoked = await adminWorker.fetch(syncRequest({ ...grant, status: "revoked", reason: "subscription revoked" }), adminEnv);
  const revokedBody = await revoked.json();
  assert.equal(revoked.status, 200, JSON.stringify(revokedBody));
  assert.equal(revokedBody.data.status, "revoked");
  assert.equal((await authorize()).page.entitlements.length, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
