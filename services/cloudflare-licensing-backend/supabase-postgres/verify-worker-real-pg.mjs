import assert from "node:assert/strict";

import worker from "../dist/index.js";
import { requestProofFixture, testKeyEnv, validBody } from "../test/contexts/fixtures.mjs";
import { closePool, createPostgresDatabase } from "./db-postgres.mjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for the PostgreSQL Worker conformance gate");

const seedDb = createPostgresDatabase(connectionString);
const workerDb = createPostgresDatabase(connectionString, { workerSql: true });
const originalNow = Date.now;
Date.now = () => 1_000_000_000;

const entitlement = {
  ...validBody(),
  status: "active",
  assertion_ttl_seconds: 120,
  cache_ttl_seconds: 600,
  revocation_seq: 3,
  valid_from: null,
  valid_until: null,
};

try {
  const proof = await requestProofFixture();
  await seedDb
    .prepare("DELETE FROM request_proof_nonces WHERE project = $1 AND feature = $2 AND license_fingerprint = $3")
    .bind(entitlement.project, entitlement.feature, entitlement.license_fingerprint)
    .run();
  await seedDb
    .prepare("DELETE FROM entitlements WHERE project = $1 AND feature = $2 AND license_fingerprint = $3")
    .bind(entitlement.project, entitlement.feature, entitlement.license_fingerprint)
    .run();
  await seedDb
    .prepare(
      "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)",
    )
    .bind(
      entitlement.project,
      entitlement.feature,
      entitlement.license_fingerprint,
      entitlement.device_hash,
      entitlement.status,
      entitlement.assertion_ttl_seconds,
      entitlement.cache_ttl_seconds,
      entitlement.revocation_seq,
      1_000_000,
    )
    .run();
  await seedDb
    .prepare(
      "INSERT INTO entitlement_devices (project, feature, license_fingerprint, device_key_id, public_key_spki_der_base64, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)",
    )
    .bind(
      proof.deviceRow.project,
      proof.deviceRow.feature,
      proof.deviceRow.license_fingerprint,
      proof.deviceRow.device_key_id,
      proof.deviceRow.public_key_spki_der_base64,
      proof.deviceRow.status,
      1_000_000,
    )
    .run();

  const base = await testKeyEnv(entitlement, { REQUEST_SIGNATURE_MODE: "required" });
  const env = { ...base, DB: workerDb };
  const send = () => worker.fetch(
    new Request("https://postgres-conformance.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proof.body),
    }),
    env,
  );

  const fresh = await send();
  assert.equal(fresh.status, 200);
  assert.equal((await fresh.json()).ok, true);

  const replay = await send();
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    ok: false,
    code: "request_proof_invalid",
    server_time: 1_000_000,
  });

  const nonceRows = await seedDb
    .prepare(
      "SELECT nonce FROM request_proof_nonces WHERE project = $1 AND feature = $2 AND license_fingerprint = $3 AND device_key_id = $4",
    )
    .bind(
      entitlement.project,
      entitlement.feature,
      entitlement.license_fingerprint,
      proof.deviceRow.device_key_id,
    )
    .all();
  assert.equal(nonceRows.length, 1);
  assert.equal(nonceRows[0].nonce, proof.body.nonce);
  console.log("PostgreSQL Worker conformance passed: fresh proof accepted and replay denied.");
} finally {
  Date.now = originalNow;
  await seedDb
    .prepare("DELETE FROM request_proof_nonces WHERE project = $1 AND feature = $2 AND license_fingerprint = $3")
    .bind(entitlement.project, entitlement.feature, entitlement.license_fingerprint)
    .run()
    .catch(() => undefined);
  await seedDb
    .prepare("DELETE FROM entitlements WHERE project = $1 AND feature = $2 AND license_fingerprint = $3")
    .bind(entitlement.project, entitlement.feature, entitlement.license_fingerprint)
    .run()
    .catch(() => undefined);
  await closePool();
}
