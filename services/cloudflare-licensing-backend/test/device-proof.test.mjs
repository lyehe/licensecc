// Device-proof (ECDSA relay-resistance) on the lease /activate and seat /checkout paths.
// A client proves possession of a registered, non-exportable device key by signing the
// canonical request-proof payload; the worker verifies it against the device's stored SPKI
// and spends the nonce. This closes the hw_id cloning hole (D4): a cloned id alone can't get
// a lease/seat without the device's private key. The proof core is shared with /v1/verify.

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, createHash } from "node:crypto";
import worker, { canonicalRequestProofPayloadForTests, resetSigningKeyCacheForTests } from "../dist/index.js";

function bytesToPem(bytes, label) {
  const b64 = Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
}

// RSA online signing key (seat lccoa1) + an ECDSA P-256 device key.
const { privateKey: onlinePkcs8Der } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "der" },
});
const ONLINE_PEM = bytesToPem(new Uint8Array(onlinePkcs8Der), "PRIVATE KEY");

const FP = "a".repeat(64);
const DEVICE_KEY_ID = "sha256:" + "1".repeat(64);
// Per-operation proof audiences (must match the worker's LEASE_PROOF_PURPOSE / SEAT_PROOF_PURPOSE).
const SEAT_PURPOSE = "licensecc-seat-request";
const LEASE_PURPOSE = "licensecc-lease-request";

let ecdsaPriv;
let deviceSpkiB64;

async function setupDeviceKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  ecdsaPriv = pair.privateKey;
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  deviceSpkiB64 = Buffer.from(spki).toString("base64");
}

function makeEnv(state, overrides = {}) {
  return {
    ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: ONLINE_PEM,
    ONLINE_SIGNING_KEY_ID: "sha256:" + "0".repeat(64),
    REQUEST_SIGNATURE_MAX_SKEW_SECONDS: "300",
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes("FROM entitlements")) return state.entitlement ?? null;
                if (sql.includes("FROM entitlement_devices")) {
                  return state.device && state.device.device_key_id === args[3] ? state.device : null;
                }
                if (sql.startsWith("INSERT INTO request_proof_nonces")) {
                  return state.nonceReplayed ? null : { nonce: "n" };
                }
                if (sql.startsWith("INSERT INTO seat_checkouts")) {
                  return state.seatGranted === false ? null : { seat_id: args[3] };
                }
                if (sql.startsWith("INSERT INTO lease_issuance")) {
                  return state.leaseGranted === false ? null : { id: 1 };
                }
                return null;
              },
              async all() {
                return { results: [] };
              },
              async run() {
                return {};
              },
            };
          },
        };
      },
    },
    ...overrides,
  };
}

function seatEntitlement(overrides = {}) {
  return {
    status: "active",
    valid_from: null,
    valid_until: null,
    pool_size: 5,
    heartbeat_grace_sec: 900,
    max_borrow_sec: 0,
    allow_overdraft: 0,
    revocation_seq: 0,
    ...overrides,
  };
}

function activeDevice(status = "active") {
  return { device_key_id: DEVICE_KEY_ID, public_key_spki_der_base64: deviceSpkiB64, status };
}

// Build the flat proof fields for a checkout/lease body, signing the canonical payload exactly
// the worker reconstructs (device-hash="", client-hardening=0, the request's nonce).
async function makeProofFields(nonce, { timestamp, tamper = false, deviceKeyId = DEVICE_KEY_ID, purpose = SEAT_PURPOSE } = {}) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const vr = {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: FP,
    device_hash: "",
    nonce,
    client_hardening: 0,
    request_proof: { version: 1, device_key_id: deviceKeyId, request_timestamp: ts, algorithm: "ecdsa-p256-sha256", signature: "" },
  };
  const payload = canonicalRequestProofPayloadForTests(vr, purpose);
  const sigBuf = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ecdsaPriv, new TextEncoder().encode(payload));
  const bytes = Buffer.from(sigBuf);
  if (tamper) bytes[0] ^= 0x01;
  return {
    device_key_id: deviceKeyId,
    request_signature_version: 1,
    request_timestamp: ts,
    request_signature_algorithm: "ecdsa-p256-sha256",
    request_signature: bytes.toString("base64"),
  };
}

function checkoutReq(body, headers = {}) {
  return new Request("https://verifier.example/v1/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function baseCheckout(nonce, overrides = {}) {
  return {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: FP,
    client_instance_id: "instance-1",
    nonce,
    ...overrides,
  };
}

test("setup ECDSA device key", async () => {
  await setupDeviceKey();
  assert.ok(deviceSpkiB64.length > 0);
});

test("seat checkout with a valid device proof is granted", async () => {
  resetSigningKeyCacheForTests();
  const nonce = "b".repeat(64);
  const proof = await makeProofFields(nonce);
  const env = makeEnv({ entitlement: seatEntitlement(), device: activeDevice() });
  const res = await worker.fetch(checkoutReq(baseCheckout(nonce, proof)), env);
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal((await res.json()).ok, true);
});

test("required mode denies a checkout with no proof", async () => {
  const env = makeEnv({ entitlement: seatEntitlement(), device: activeDevice() }, { DEVICE_PROOF_MODE: "required" });
  const res = await worker.fetch(checkoutReq(baseCheckout("c".repeat(64))), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "device_proof_required");
});

test("a tampered proof signature is rejected", async () => {
  resetSigningKeyCacheForTests();
  const nonce = "d".repeat(64);
  const proof = await makeProofFields(nonce, { tamper: true });
  const env = makeEnv({ entitlement: seatEntitlement(), device: activeDevice() });
  const res = await worker.fetch(checkoutReq(baseCheckout(nonce, proof)), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "device_proof_invalid");
});

test("a proof for an unregistered device is rejected", async () => {
  const nonce = "e".repeat(64);
  const proof = await makeProofFields(nonce);
  const env = makeEnv({ entitlement: seatEntitlement(), device: null }); // device not registered
  const res = await worker.fetch(checkoutReq(baseCheckout(nonce, proof)), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "device_proof_invalid");
});

test("a replayed nonce is rejected (relay defense)", async () => {
  const nonce = "f".repeat(64);
  const proof = await makeProofFields(nonce);
  const env = makeEnv({ entitlement: seatEntitlement(), device: activeDevice(), nonceReplayed: true });
  const res = await worker.fetch(checkoutReq(baseCheckout(nonce, proof)), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "device_proof_invalid");
});

test("a stale-timestamp proof is rejected", async () => {
  const nonce = "0".repeat(64);
  const proof = await makeProofFields(nonce, { timestamp: Math.floor(Date.now() / 1000) - 100000 });
  const env = makeEnv({ entitlement: seatEntitlement(), device: activeDevice() });
  const res = await worker.fetch(checkoutReq(baseCheckout(nonce, proof)), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "device_proof_invalid");
});

test("a disabled device is rejected", async () => {
  const nonce = "9".repeat(64);
  const proof = await makeProofFields(nonce);
  const env = makeEnv({ entitlement: seatEntitlement(), device: activeDevice("disabled") });
  const res = await worker.fetch(checkoutReq(baseCheckout(nonce, proof)), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "device_proof_invalid");
});

test("a partial/malformed proof is rejected, never silently downgraded to no-proof", async () => {
  const env = makeEnv({ entitlement: seatEntitlement(), device: activeDevice() });
  // request_signature_version present but the signature is missing -> malformed -> 400, NOT a
  // silent fallthrough to "no proof, off mode, granted".
  const body = { ...baseCheckout("5".repeat(64)), device_key_id: DEVICE_KEY_ID, request_signature_version: 1 };
  const res = await worker.fetch(checkoutReq(body), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_request");
});

test("lease /activate with a proof but no nonce is rejected", async () => {
  resetSigningKeyCacheForTests();
  const proof = await makeProofFields("4".repeat(64), { purpose: LEASE_PURPOSE });
  const env = makeEnv(
    { entitlement: { status: "active", valid_from: null, valid_until: null, max_active_devices: 1, lease_seconds: 2592000, rebind_window_sec: 7776000 }, device: activeDevice() },
    { LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM: ONLINE_PEM, LEASE_SIGNING_KEY_ID: "sha256:" + "2".repeat(64) },
  );
  const body = {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: FP,
    device_key_id: DEVICE_KEY_ID,
    request_signature_version: proof.request_signature_version,
    request_timestamp: proof.request_timestamp,
    request_signature_algorithm: proof.request_signature_algorithm,
    request_signature: proof.request_signature,
  };
  const res = await worker.fetch(
    new Request("https://verifier.example/v1/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    env,
  );
  assert.equal(res.status, 400);
});

test("off mode without a proof still proceeds (back-compat)", async () => {
  resetSigningKeyCacheForTests();
  const env = makeEnv({ entitlement: seatEntitlement(), device: activeDevice() }); // DEVICE_PROOF_MODE unset
  const res = await worker.fetch(checkoutReq(baseCheckout("8".repeat(64))), env);
  assert.equal(res.status, 200);
});

test("a proof signed for one operation does NOT verify at another (audience binding)", async () => {
  resetSigningKeyCacheForTests();
  // Sign a proof for the SEAT operation, present it to the LEASE endpoint /v1/activate.
  const nonce = "6".repeat(64);
  const seatProof = await makeProofFields(nonce, { purpose: SEAT_PURPOSE });
  const env = makeEnv(
    {
      entitlement: { status: "active", valid_from: null, valid_until: null, max_active_devices: 1, lease_seconds: 2592000, rebind_window_sec: 7776000 },
      device: activeDevice(),
    },
    { LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM: ONLINE_PEM, LEASE_SIGNING_KEY_ID: "sha256:" + "2".repeat(64) },
  );
  const body = { project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP, device_key_id: DEVICE_KEY_ID, nonce, ...{ request_signature_version: seatProof.request_signature_version, request_timestamp: seatProof.request_timestamp, request_signature_algorithm: seatProof.request_signature_algorithm, request_signature: seatProof.request_signature } };
  const res = await worker.fetch(
    new Request("https://verifier.example/v1/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    env,
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "device_proof_invalid");
});

test("lease /activate with a valid device proof is granted", async () => {
  resetSigningKeyCacheForTests();
  const nonce = "7".repeat(64);
  const proof = await makeProofFields(nonce, { purpose: LEASE_PURPOSE });
  const env = makeEnv(
    {
      entitlement: { status: "active", valid_from: null, valid_until: null, max_active_devices: 1, lease_seconds: 2592000, rebind_window_sec: 7776000 },
      device: activeDevice(),
    },
    { LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM: ONLINE_PEM, LEASE_SIGNING_KEY_ID: "sha256:" + "2".repeat(64) },
  );
  const body = {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: FP,
    device_key_id: DEVICE_KEY_ID,
    nonce,
    request_signature_version: proof.request_signature_version,
    request_timestamp: proof.request_timestamp,
    request_signature_algorithm: proof.request_signature_algorithm,
    request_signature: proof.request_signature,
  };
  const res = await worker.fetch(
    new Request("https://verifier.example/v1/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    env,
  );
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal((await res.json()).ok, true);
});
