// Stage 4 — server-computed trial timing on /v1/activate, against REAL SQLite + the REAL worker.
//
// Drives the Worker's fetch() handler over an in-memory DB built from the shared migrations/*.sql
// (same D1Like adapter as account_isolation / policy-stamp). Nothing about the trial SQL is mocked:
// every assertion reads back the trial_started_at / trial_device_hash the worker's write-once stamp
// produced inside the atomic lease batch. Matrix:
//   - from_issue: NO activation stamp (clock set at stamp time); valid_to clamps to valid_until.
//   - from_first_activation: FIRST activation stamps trial_started_at=now write-once + clamps
//     valid_to to start+duration; a re-activation on the SAME device is idempotent (no re-stamp).
//   - trial_one_per_device: a DIFFERENT device after the first activation -> 403 trial_device_locked
//     (no mutation).
//   - trial_require_device_proof: no verified proof -> 403 trial_device_proof_required; a VALID
//     ECDSA proof activates and binds the lock to the device_key_id.
//   - non-trial entitlements are completely unaffected.
//
// Off mode (no ACCOUNT_TOKEN_MODE, no LEASE_ISSUE_BEARER) so the legacy non-owned cap path runs.
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import worker, { canonicalRequestProofPayloadForTests, resetLeaseSigningKeyCacheForTests } from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");

// --- D1-like adapter over node:sqlite (transactional batch) -------------------
function normalizeParam(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}
class PreparedStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...values) { const n = new PreparedStatement(this.db, this.sql); n.params = values.map(normalizeParam); return n; }
  async first() { const r = this.db.prepare(this.sql).get(...this.params); return r === undefined ? null : r; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() { this.db.prepare(this.sql).all(...this.params); return { success: true }; }
}
class D1Like {
  constructor(db) { this.db = db; }
  prepare(sql) { return new PreparedStatement(this.db, sql); }
  withSession() { return this; }
  async batch(statements) {
    const out = [];
    this.db.exec("BEGIN");
    try {
      for (const s of statements) out.push({ results: this.db.prepare(s.sql).all(...s.params), success: true });
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return out;
  }
}

const CTX = { waitUntil: (p) => { void p; } };

const PROJECT = "DEFAULT";
const FEATURE = "DEFAULT";
const NOW = Math.floor(Date.now() / 1000);
const FP = "a".repeat(64);
const LEASE_KEY_ID = "sha256:" + "a".repeat(64);
const ONLINE_KEY_ID = "sha256:" + "b".repeat(64);
const DEVICE_KEY_ID = "sha256:" + "d".repeat(64);
const SELF_DEVICE = "sha256:" + "e".repeat(64);
const OTHER_DEVICE = "sha256:" + "f".repeat(64);
const TRIAL_DURATION = 1209600; // 14 days
const FAR_VALID_UNTIL = NOW + 365 * 86400;
const LEASE_PURPOSE = "licensecc-lease-request";

// One throwaway 3072-bit RSA lease/online signing key (issuance only signs after the SQL lands).
let LEASE_PEM;
async function leaseKeyPem() {
  if (LEASE_PEM !== undefined) return LEASE_PEM;
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let b = "";
  for (const byte of pkcs8) b += String.fromCharCode(byte);
  const b64 = btoa(b).replace(/(.{64})/g, "$1\n");
  LEASE_PEM = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  return LEASE_PEM;
}

function applyMigrations(db) {
  for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
}

// Seed an entitlement wired for leasing, with the FROZEN trial columns set directly (as the policy
// stamp would have written them). trial=0 yields a plain non-trial subscription row.
function seedEntitlement(db, {
  fingerprint = FP, status = "active", validUntil = FAR_VALID_UNTIL,
  isTrial = 0, basis = null, durationSec = 0, onePerDevice = 0, requireProof = 0,
  startedAt = null, deviceHash = null,
} = {}) {
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, " +
      "assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, " +
      "max_active_devices, lease_seconds, rebind_window_sec, " +
      "is_trial, trial_expiration_basis, trial_duration_sec, trial_one_per_device, " +
      "trial_require_device_proof, trial_started_at, trial_device_hash, created_at, updated_at) VALUES " +
      "(?, ?, ?, '', ?, 300, 300, 0, ?, ?, 10, 2592000, 7776000, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    PROJECT, FEATURE, fingerprint, status, NOW - 86400, validUntil,
    isTrial, basis, durationSec, onePerDevice, requireProof, startedAt, deviceHash, NOW, NOW,
  );
}

async function freshEnv() {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  const env = {
    DB: new D1Like(db),
    LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM: await leaseKeyPem(),
    LEASE_SIGNING_KEY_ID: LEASE_KEY_ID,
    ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: await leaseKeyPem(),
    ONLINE_SIGNING_KEY_ID: ONLINE_KEY_ID,
    REQUEST_SIGNATURE_MAX_SKEW_SECONDS: "300",
    // off mode: no ACCOUNT_TOKEN_MODE, no LEASE_ISSUE_BEARER -> open legacy path.
  };
  resetLeaseSigningKeyCacheForTests();
  return { db, env };
}

async function activate(env, body) {
  const req = new Request("https://x/v1/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: PROJECT, feature: FEATURE, license_fingerprint: FP, ...body }),
  });
  const res = await worker.fetch(req, env, CTX);
  return { status: res.status, body: await res.json() };
}

function trialRow(db, fingerprint = FP) {
  return db
    .prepare("SELECT trial_started_at, trial_device_hash FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ?")
    .get(PROJECT, FEATURE, fingerprint);
}

// Register an ECDSA device + return a body fragment carrying a VALID lease request proof for `nonce`.
async function provedDeviceBody(db, nonce, { deviceKeyId = DEVICE_KEY_ID } = {}) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  let s = "";
  for (const byte of spki) s += String.fromCharCode(byte);
  const spkiB64 = btoa(s);
  db.prepare(
    "INSERT INTO entitlement_devices (project, feature, license_fingerprint, device_key_id, public_key_spki_der_base64, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
  ).run(PROJECT, FEATURE, FP, deviceKeyId, spkiB64, NOW, NOW);

  const ts = Math.floor(Date.now() / 1000);
  const vr = {
    project: PROJECT, feature: FEATURE, license_fingerprint: FP, device_hash: "", nonce, client_hardening: 0,
    request_proof: { version: 1, device_key_id: deviceKeyId, request_timestamp: ts, algorithm: "ecdsa-p256-sha256", signature: "" },
  };
  const payload = canonicalRequestProofPayloadForTests(vr, LEASE_PURPOSE);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload)));
  let sb = "";
  for (const byte of sig) sb += String.fromCharCode(byte);
  return {
    device_key_id: deviceKeyId,
    nonce,
    request_signature_version: 1,
    request_timestamp: ts,
    request_signature_algorithm: "ecdsa-p256-sha256",
    request_signature: btoa(sb),
  };
}

// --- from_issue: clock set at stamp time, no activation stamp -----------------
test("from_issue trial: no activation stamp; valid_to clamps to valid_until; envelope marks trial", async () => {
  const { db, env } = await freshEnv();
  const trialEnd = NOW + TRIAL_DURATION;
  seedEntitlement(db, { isTrial: 1, basis: "from_issue", durationSec: TRIAL_DURATION, validUntil: trialEnd });
  const { status, body } = await activate(env, { device_key_id: SELF_DEVICE });
  assert.equal(status, 200);
  assert.equal(body.trial, true);
  assert.equal(body.trial_expires_at_epoch, trialEnd, "from_issue deadline is valid_until");
  assert.ok(body.valid_to_epoch <= trialEnd, "lease valid_to never exceeds the trial end");
  // NO activation stamp for from_issue.
  const row = trialRow(db);
  assert.equal(row.trial_started_at, null);
  assert.equal(row.trial_device_hash, null);
  db.close();
});

// --- from_first_activation: write-once stamp + clamp --------------------------
test("from_first_activation: first activate stamps trial_started_at + clamps valid_to to start+duration", async () => {
  const { db, env } = await freshEnv();
  seedEntitlement(db, { isTrial: 1, basis: "from_first_activation", durationSec: TRIAL_DURATION });
  const { status, body } = await activate(env, { device_key_id: SELF_DEVICE });
  assert.equal(status, 200);
  assert.equal(body.trial, true);
  const row = trialRow(db);
  assert.ok(row.trial_started_at !== null, "trial clock started on first activation");
  assert.equal(row.trial_device_hash, SELF_DEVICE, "lock bound to the self-asserted device");
  const expectedDeadline = row.trial_started_at + TRIAL_DURATION;
  assert.equal(body.trial_expires_at_epoch, expectedDeadline);
  assert.ok(body.valid_to_epoch <= expectedDeadline, "valid_to clamped to start+duration");
  db.close();
});

test("from_first_use behaves identically to from_first_activation (stamps + clamps)", async () => {
  const { db, env } = await freshEnv();
  seedEntitlement(db, { isTrial: 1, basis: "from_first_use", durationSec: TRIAL_DURATION });
  const { status, body } = await activate(env, { device_key_id: SELF_DEVICE });
  assert.equal(status, 200);
  assert.equal(body.trial, true);
  const row = trialRow(db);
  assert.ok(row.trial_started_at !== null);
  assert.equal(row.trial_device_hash, SELF_DEVICE);
  assert.equal(body.trial_expires_at_epoch, row.trial_started_at + TRIAL_DURATION);
  db.close();
});

test("from_first_activation: re-activation on the SAME device is idempotent (no re-stamp)", async () => {
  const { db, env } = await freshEnv();
  seedEntitlement(db, { isTrial: 1, basis: "from_first_activation", durationSec: TRIAL_DURATION });
  const first = await activate(env, { device_key_id: SELF_DEVICE });
  assert.equal(first.status, 200);
  const startedFirst = trialRow(db).trial_started_at;
  // A later re-activation must NOT move the clock (write-once); deadline stays anchored to the first.
  const second = await activate(env, { device_key_id: SELF_DEVICE });
  assert.equal(second.status, 200);
  const startedSecond = trialRow(db).trial_started_at;
  assert.equal(startedSecond, startedFirst, "trial_started_at is write-once");
  assert.equal(second.body.trial_expires_at_epoch, startedFirst + TRIAL_DURATION, "deadline anchored to the first activation");
  db.close();
});

// --- trial_one_per_device device lock ----------------------------------------
test("trial_one_per_device: a different device after first activation -> 403 trial_device_locked (no mutation)", async () => {
  const { db, env } = await freshEnv();
  seedEntitlement(db, { isTrial: 1, basis: "from_first_activation", durationSec: TRIAL_DURATION, onePerDevice: 1 });
  const first = await activate(env, { device_key_id: SELF_DEVICE });
  assert.equal(first.status, 200);
  const before = trialRow(db);
  assert.equal(before.trial_device_hash, SELF_DEVICE);
  assert.ok(before.trial_started_at !== null);

  const other = await activate(env, { device_key_id: OTHER_DEVICE });
  assert.equal(other.status, 403);
  assert.equal(other.body.code, "trial_device_locked");
  // No mutation: the lock + start are unchanged by the denied request.
  const after = trialRow(db);
  assert.equal(after.trial_device_hash, SELF_DEVICE);
  assert.equal(after.trial_started_at, before.trial_started_at, "denied activation left the clock untouched");
  db.close();
});

test("trial_one_per_device: the ORIGINAL device keeps activating (lock matches)", async () => {
  const { db, env } = await freshEnv();
  seedEntitlement(db, { isTrial: 1, basis: "from_first_activation", durationSec: TRIAL_DURATION, onePerDevice: 1 });
  assert.equal((await activate(env, { device_key_id: SELF_DEVICE })).status, 200);
  const again = await activate(env, { device_key_id: SELF_DEVICE });
  assert.equal(again.status, 200, "same device re-activates under the per-device lock");
  db.close();
});

// --- trial_require_device_proof ----------------------------------------------
test("trial_require_device_proof: no verified proof -> 403 trial_device_proof_required (no mutation)", async () => {
  const { db, env } = await freshEnv();
  seedEntitlement(db, { isTrial: 1, basis: "from_first_activation", durationSec: TRIAL_DURATION, requireProof: 1 });
  const { status, body } = await activate(env, { device_key_id: SELF_DEVICE });
  assert.equal(status, 403);
  assert.equal(body.code, "trial_device_proof_required");
  const row = trialRow(db);
  assert.equal(row.trial_started_at, null, "no clock start on a denied require-proof activation");
  assert.equal(row.trial_device_hash, null);
  db.close();
});

test("trial_require_device_proof: a VALID device proof activates and binds the lock to the proven device_key_id", async () => {
  const { db, env } = await freshEnv();
  seedEntitlement(db, { isTrial: 1, basis: "from_first_activation", durationSec: TRIAL_DURATION, requireProof: 1, onePerDevice: 1 });
  const proofBody = await provedDeviceBody(db, "n".repeat(64));
  const { status, body } = await activate(env, proofBody);
  assert.equal(status, 200);
  assert.equal(body.trial, true);
  const row = trialRow(db);
  assert.ok(row.trial_started_at !== null, "proven activation started the clock");
  assert.equal(row.trial_device_hash, DEVICE_KEY_ID, "lock bound to the PROVEN device_key_id");
  db.close();
});

// --- non-trial unaffected -----------------------------------------------------
test("non-trial entitlement: no trial fields in the envelope; no trial columns touched", async () => {
  const { db, env } = await freshEnv();
  seedEntitlement(db, { isTrial: 0 });
  const { status, body } = await activate(env, { device_key_id: SELF_DEVICE });
  assert.equal(status, 200);
  assert.equal(body.trial, undefined, "non-trial leases carry no trial flag");
  assert.equal(body.trial_expires_at_epoch, undefined);
  const row = trialRow(db);
  assert.equal(row.trial_started_at, null);
  assert.equal(row.trial_device_hash, null);
  db.close();
});
