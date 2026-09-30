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

// Syncs an active protected grant for cus_sync, enrolls one device through consent and a signed
// exchange, and returns what a test needs to renew that device's binding.
async function enrolledSyncGrant(t) {
  const { db, env: portal } = baseFixture(); t.after(() => db.close());
  const now = Math.floor(Date.now() / 1000); db.function("unixepoch", () => now);
  db.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('cus_sync','Owner',1,1);
    INSERT INTO licenses(id,customer_id,project,created_at,updated_at) VALUES('lic_sync','cus_sync','APP',1,1);`);
  const adminEnv = { DB: portal.DB, ENVIRONMENT: "development", ADMIN_DEV_BEARER_ENABLED: "0", SYNC_API_TOKEN: "sync-secret" };
  const grant = { project: "APP", feature: "PRO", license_fingerprint: fingerprint, customer_id: "cus_sync", license_id: "lic_sync" };
  const sync = async (body) => {
    const response = await adminWorker.fetch(syncRequest(body), adminEnv);
    return { status: response.status, body: await response.json() };
  };

  const synced = await sync({ ...grant, status: "active", reason: "subscription active" });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.equal(synced.body.code, "entitlement_synced");
  assert.equal(db.prepare("SELECT source FROM entitlement_events ORDER BY id DESC LIMIT 1").get().source, "sync");

  const env = { DB: portal.DB, BOUND_DEVICE_CONFIG: JSON.stringify(config), BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM: privatePem,
    BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM: publicPem };
  const send = async (path, body) => {
    const response = await backend.fetch(new Request(`https://license.test${path}`, { method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "127.0.0.2" }, body: JSON.stringify(body) }), env);
    return { status: response.status, result: await response.json() };
  };
  const call = async (path, body) => {
    const { status, result } = await send(path, body); assert.equal(status, 200, JSON.stringify(result)); return result.data;
  };
  const authorize = async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)));
    const verifier = boundRandomId(32), redirect = "http://127.0.0.1:45678/callback";
    const challenge = encodeBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const attempt = await call("/v2/device-authorizations", { client_id: "desktop", project: "APP", requested_feature: "PRO", public_key_spki: spki,
      device_label: "Workstation", redirect_uri: redirect, state: boundRandomId(32), code_challenge: challenge, code_challenge_method: "S256" });
    return { keys, spki, verifier, redirect, attempt, page: await inspectBoundAuthorization(portal.DB, "cus_sync", attempt.attempt_handle, config) };
  };

  const { keys, spki, verifier, redirect, attempt, page } = await authorize();
  assert.equal(page.entitlements.length, 1); assert.equal(page.entitlements[0].id, synced.body.data.id);
  const consent = await approveBoundAuthorization(portal.DB, "cus_sync", { attempt_handle: attempt.attempt_handle,
    entitlement_id: synced.body.data.id, expected_attempt_revision: 0, operation_id: boundRandomId(32) }, config,
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

  // A renewal of the enrolled binding, proved with its device key under a fresh challenge.
  const renewal = async () => {
    const renew = { binding_id: result.binding_id, generation: result.generation, operation_id: boundRandomId(32) };
    const renewChallenge = await call("/v2/device-challenges", { purpose: "renew", binding_id: renew.binding_id, operation_id: renew.operation_id });
    const renewIntent = { audience: config.audience, method: "POST", path: "/v2/device-leases/renew", key_id: keyId,
      operation_id: renew.operation_id, body_sha256: await sha256Hex(deviceOperationBody("renew", renew)), ...renewChallenge };
    const renewSignature = encodeBase64url(normalizeDeviceSignature(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, deviceProofSigningInput(renewIntent)))));
    return { ...renew, proof: { key_id: keyId, challenge_id: renewChallenge.challenge_id, nonce: renewChallenge.nonce,
      expires_at: renewChallenge.expires_at, signature: renewSignature } };
  };
  return { db, grant, sync, send, call, authorize, renewal, bindingId: result.binding_id };
}

// Every grant the shared writer creates is protected, so a synced grant is enrolled and exchanged
// through the device protocol.
test("user database sync yields a protected grant that supports a signed exchange and renewal until it is revoked", async t => {
  const { db, grant, sync, send, call, authorize, renewal, bindingId } = await enrolledSyncGrant(t);
  assert.equal((await call("/v2/device-leases/renew", await renewal())).binding_id, bindingId, "the active grant renews");
  // Proved and challenged while the grant is still active, submitted after the revocation lands.
  const pendingRenewal = await renewal();

  // A revocation synced from the user database reaches the protected path: the grant is no longer offered.
  assert.equal((await authorize()).page.entitlements.length, 1, "the active grant is still offered");
  const revoked = await sync({ ...grant, status: "revoked", reason: "subscription revoked" });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.data.status, "revoked");
  assert.equal((await authorize()).page.entitlements.length, 0);
  // The already-enrolled binding cannot renew: the issuer refuses the proved renewal, and no new one can start.
  const refused = await send("/v2/device-leases/renew", pendingRenewal);
  assert.equal(refused.status, 403, JSON.stringify(refused.result));
  assert.equal(refused.result.code, "access_denied");
  const unavailable = await send("/v2/device-challenges", { purpose: "renew", binding_id: bindingId, operation_id: boundRandomId(32) });
  assert.equal(unavailable.status, 404, JSON.stringify(unavailable.result));
  assert.equal(unavailable.result.code, "binding_unavailable");
  assert.equal(db.prepare("SELECT count(*) AS n FROM device_bound_leases").get().n, 2, "only the exchange and the renewal before the revocation issued leases");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

// A revocation always applies, even when the owner can no longer pass the protected checks; the
// device stays refused after the customer is restored, because the grant itself is revoked.
test("a synced revocation applies after the customer is disabled, and the enrolled device cannot renew", async t => {
  const { db, grant, sync, send, renewal, bindingId } = await enrolledSyncGrant(t);
  // Proved and challenged while the grant and its customer are still active.
  const pendingRenewal = await renewal();
  db.exec("UPDATE customers SET status='disabled' WHERE id='cus_sync'");
  const revoked = await sync({ ...grant, status: "revoked", reason: "account closed" });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.deepEqual([revoked.body.data.status, revoked.body.data.customer_id, revoked.body.data.license_id], ["revoked", "cus_sync", "lic_sync"]);
  db.exec("UPDATE customers SET status='active' WHERE id='cus_sync'");
  const refused = await send("/v2/device-leases/renew", pendingRenewal);
  assert.equal(refused.status, 403, JSON.stringify(refused.result));
  assert.equal(refused.result.code, "access_denied");
  const unavailable = await send("/v2/device-challenges", { purpose: "renew", binding_id: bindingId, operation_id: boundRandomId(32) });
  assert.equal(unavailable.status, 404, JSON.stringify(unavailable.result));
  assert.equal(unavailable.result.code, "binding_unavailable");
  assert.equal(db.prepare("SELECT count(*) AS n FROM device_bound_leases").get().n, 1, "only the exchange issued a lease");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
