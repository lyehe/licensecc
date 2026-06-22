// HTTP-level tests for the lease Worker (/v1/activate, /v1/renew).
//
// Covers the review's security-critical MUST-FIXES at the Worker layer: the
// valid-to clamp to the subscription end, fail-closed auth/availability, the 403
// taxonomy, and idempotent re-issue. The faithful atomic device-rebind cap (the
// TOCTOU fix) is verified against real SQLite in test/sql/lease-rebind.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import worker, { resetLeaseSigningKeyCacheForTests } from "../dist/index.js";
import { buildV201CanonicalPayload } from "../scripts/lease-sign.mjs";

function bytesToPem(bytes, label) {
  const b64 = Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
}

// One RSA-3072 hot lease key for the whole suite.
const { publicKey: pkcs1Der, privateKey: pkcs8Der } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "pkcs1", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "der" },
});
const LEASE_KEY_ID = "sha256:" + createHash("sha256").update(pkcs1Der).digest("hex");
const LEASE_PEM = bytesToPem(new Uint8Array(pkcs8Der), "PRIVATE KEY");
const LEASE_PUBLIC = createPublicKey({ key: Buffer.from(pkcs1Der), format: "der", type: "pkcs1" });

function makeEnv(state, overrides = {}) {
  return {
    LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM: LEASE_PEM,
    LEASE_SIGNING_KEY_ID: LEASE_KEY_ID,
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes("FROM entitlements")) return state.entitlement ?? null;
                if (sql.includes("INSERT INTO lease_issuance")) {
                  state.issuanceAttempts = (state.issuanceAttempts ?? 0) + 1;
                  return state.rebindAllowed === false ? null : { id: 1 };
                }
                if (sql.includes("FROM mutation_idempotency")) {
                  const key = args[1];
                  return state.idempotency?.[key] ? { response_json: state.idempotency[key] } : null;
                }
                return null;
              },
              async run() {
                if (sql.includes("INSERT INTO mutation_idempotency")) {
                  state.idempotency = state.idempotency ?? {};
                  state.idempotency[args[1]] = args[2];
                }
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

function activeEntitlement(overrides = {}) {
  return {
    status: "active",
    valid_from: null,
    valid_until: null,
    max_active_devices: 1,
    lease_seconds: 2592000,
    rebind_window_sec: 7776000,
    ...overrides,
  };
}

function leaseRequest(body, pathname = "/v1/activate", headers = {}) {
  return new Request(`https://verifier.example${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function validBody(overrides = {}) {
  return {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: "a".repeat(64),
    device_key_id: "sha256:" + "b".repeat(64),
    hw_id: "AEBC-Q0RF-Rkc=",
    client_signature_source_strength: "strong-disk-serial-or-uuid",
    ...overrides,
  };
}

function leaseField(lic, key) {
  const match = lic.match(new RegExp(`\\n${key} = (.+)\\n`));
  return match ? match[1] : null;
}

test("activate issues a verifiable, clamped v201 lease", async () => {
  resetLeaseSigningKeyCacheForTests();
  const validUntil = Math.floor(Date.now() / 1000) + 5 * 86400; // 5 days out
  const env = makeEnv({ entitlement: activeEntitlement({ valid_until: validUntil }) });
  const res = await worker.fetch(leaseRequest(validBody()), env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.match(out.lic, /^\[DEFAULT\]\n/);
  assert.match(out.lic, new RegExp(`\\nkey-id = ${LEASE_KEY_ID}\\n`));

  // Clamp: valid-to never exceeds the subscription end (5 days, not the 30-day budget).
  assert.ok(out.valid_to_epoch <= validUntil, "lease valid_to clamped to valid_until");
  const expectedValidTo = new Date(out.valid_to_epoch * 1000).toISOString().slice(0, 10);
  assert.equal(leaseField(out.lic, "valid-to"), expectedValidTo);
  assert.ok(typeof out.renew_by === "number" && out.renew_by > out.server_time);

  // The lease signature actually verifies against the hot public key over the canonical payload.
  const { bytes } = buildV201CanonicalPayload({
    "lic_ver": "201", "canonical-v": "1", "sig-v": "1", "sig-alg": "rsa-pkcs1-sha256",
    "key-id": LEASE_KEY_ID, "project": "DEFAULT", "feature": "DEFAULT",
    "valid-from": leaseField(out.lic, "valid-from"), "valid-to": expectedValidTo,
    "client-signature": "AEBC-Q0RF-Rkc=", "client-signature-source-strength": "strong-disk-serial-or-uuid",
  });
  const sigB64 = leaseField(out.lic, "sig");
  assert.ok(nodeVerify("RSA-SHA256", Buffer.from(bytes), LEASE_PUBLIC, Buffer.from(sigB64, "base64")));
});

test("non-expiring subscription gets the full lease budget", async () => {
  resetLeaseSigningKeyCacheForTests();
  const env = makeEnv({ entitlement: activeEntitlement({ valid_until: null, lease_seconds: 1000 }) });
  const res = await worker.fetch(leaseRequest(validBody()), env);
  const out = await res.json();
  assert.equal(out.valid_to_epoch, out.server_time + 1000);
});

test("rejects bad bearer auth (fail closed)", async () => {
  const env = makeEnv({ entitlement: activeEntitlement() }, { LEASE_ISSUE_BEARER: "secret" });
  const res = await worker.fetch(leaseRequest(validBody(), "/v1/activate", { authorization: "Bearer wrong" }), env);
  assert.equal(res.status, 401);
});

test("503 when no lease signing key is configured", async () => {
  const env = makeEnv({ entitlement: activeEntitlement() }, {
    LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM: undefined,
    LEASE_SIGNING_KEY_ID: undefined,
  });
  const res = await worker.fetch(leaseRequest(validBody()), env);
  assert.equal(res.status, 503);
});

test("403 no_active_entitlement when missing/inactive", async () => {
  const missing = await worker.fetch(leaseRequest(validBody()), makeEnv({ entitlement: null }));
  assert.equal(missing.status, 403);
  const revoked = await worker.fetch(leaseRequest(validBody()), makeEnv({ entitlement: activeEntitlement({ status: "revoked" }) }));
  assert.equal(revoked.status, 403);
  assert.equal((await revoked.json()).code, "no_active_entitlement");
});

test("403 expired_subscription when valid_until has passed", async () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  const res = await worker.fetch(leaseRequest(validBody()), makeEnv({ entitlement: activeEntitlement({ valid_until: past }) }));
  assert.equal(res.status, 403);
  // valid_until <= now is reported as outside the validity window first.
  assert.match((await res.json()).code, /entitlement|expired/);
});

test("403 device_limit_exceeded when the atomic cap insert lands no row", async () => {
  resetLeaseSigningKeyCacheForTests();
  const env = makeEnv({ entitlement: activeEntitlement(), rebindAllowed: false });
  const res = await worker.fetch(leaseRequest(validBody()), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "device_limit_exceeded");
});

test("renew is idempotent on request_id (same lease, single issuance)", async () => {
  resetLeaseSigningKeyCacheForTests();
  const state = { entitlement: activeEntitlement() };
  const env = makeEnv(state);
  const body = validBody({ request_id: "req-123" });
  const first = await worker.fetch(leaseRequest(body, "/v1/renew"), env);
  const firstOut = await first.json();
  const second = await worker.fetch(leaseRequest(body, "/v1/renew"), env);
  const secondOut = await second.json();
  assert.deepEqual(secondOut, firstOut, "idempotent replay returns the identical response");
  assert.equal(state.issuanceAttempts, 1, "second request did not issue a new lease");
});
