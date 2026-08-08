import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { interpretWranglerResult, sqlFor } from "../../scripts/entitlement.mjs";
import { derPayloadOffset } from "./fixtures.mjs";

test("key generator emits PKCS#1 public key records for the C++ verifier", () => {
  const outDir = mkdtempSync(join(tmpdir(), "licensecc-online-key-"));
  try {
    const result = spawnSync(process.execPath, ["scripts/generate-online-key.mjs", "--out-dir", outDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const publicRecord = JSON.parse(readFileSync(join(outDir, "online_public_key.json"), "utf8"));
    const publicDer = Buffer.from(publicRecord.public_key_der_base64, "base64");
    const payloadOffset = derPayloadOffset(publicDer, 0);
    assert.equal(publicDer[payloadOffset], 0x02, "PKCS#1 RSA public key starts with a modulus INTEGER");

    const expectedKeyId = `sha256:${createHash("sha256").update(publicDer).digest("hex")}`;
    assert.equal(publicRecord.key_id, expectedKeyId);
    assert.match(readFileSync(join(outDir, "online_private_key.pkcs8.pem"), "utf8"), new RegExp("BEGIN " + "PRIVATE KEY"));
    const cmakeRecord = readFileSync(join(outDir, "online_public_key_record.cmake.txt"), "utf8");
    assert.match(cmakeRecord, /CACHE STRING/);
    assert.match(
      cmakeRecord,
      new RegExp(`SignaturePublicKey\\(\\\\"${expectedKeyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\\\"`),
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("break-glass CLI upsert does not update revoked entitlements", () => {
  const sql = sqlFor("upsert", { fingerprint: "a".repeat(64), actor: "operator", status: "active" });
  assert.match(sql, /ON CONFLICT\(project, feature, license_fingerprint\) DO UPDATE SET/);
  assert.match(sql, /WHERE entitlements\.status != 'revoked'/);
  assert.match(sql, /INSERT INTO entitlement_events/);
});

test("break-glass CLI transitions keep revoked terminal except revoke", () => {
  const disabled = sqlFor("disable", { fingerprint: "a".repeat(64), actor: "operator", reason: "support" });
  const reenabled = sqlFor("reenable", { fingerprint: "a".repeat(64), actor: "operator" });
  const revoked = sqlFor("revoke", { fingerprint: "a".repeat(64), actor: "operator", reason: "chargeback" });
  assert.match(disabled, /AND status != 'revoked'/);
  assert.match(reenabled, /AND status != 'revoked'/);
  assert.doesNotMatch(revoked, /AND status != 'revoked'/);
});

test("break-glass CLI list does not require a fingerprint", () => {
  const sql = sqlFor("list", {});
  assert.match(sql, /FROM entitlements ORDER BY updated_at DESC LIMIT 100/);
  assert.doesNotMatch(sql, /license_fingerprint =/);
});

test("schema permits sync audit actor type", () => {
  const schema = readFileSync("schema.sql", "utf8");
  const migration = readFileSync("migrations/0006_allow_sync_actor_type.sql", "utf8");
  assert.match(schema, /actor_type IN \('access', 'dev', 'cli', 'sync', 'system', 'unknown'\)/);
  assert.match(migration, /actor_type IN \('access', 'dev', 'cli', 'sync', 'system', 'unknown'\)/);
});

test("break-glass CLI upsert --allow-revoked-override drops the guard and stamps a distinct event", () => {
  const sql = sqlFor("upsert", {
    fingerprint: "a".repeat(64),
    actor: "operator",
    status: "active",
    reason: "mistaken revoke, ticket #123",
    "allow-revoked-override": true,
  });
  assert.doesNotMatch(sql, /WHERE entitlements\.status != 'revoked'/);
  assert.match(sql, /'revoked-override'/);
  assert.match(sql, /INSERT INTO entitlement_events/);
});

test("break-glass CLI upsert override requires a reason", () => {
  assert.throws(
    () => sqlFor("upsert", { fingerprint: "a".repeat(64), actor: "operator", "allow-revoked-override": true }),
    /reason is required/,
  );
});

test("break-glass CLI upsert sets customer_id and license_id when provided", () => {
  const sql = sqlFor("upsert", {
    fingerprint: "a".repeat(64),
    actor: "operator",
    "customer-id": "cus_123",
    "license-id": "lic_123",
  });
  assert.match(sql, /customer_id, license_id, created_at, updated_at/);
  assert.match(sql, /'cus_123'/);
  assert.match(sql, /'lic_123'/);
  assert.match(sql, /customer_id = excluded\.customer_id, license_id = excluded\.license_id/);
});

test("break-glass CLI upsert leaves customer_id and license_id NULL when unset", () => {
  const sql = sqlFor("upsert", { fingerprint: "a".repeat(64), actor: "operator" });
  // unset customer_id/license_id must be SQL NULL (not ''), matching the admin Worker's nullable columns:
  // ...valid_from, valid_until, customer_id, license_id, created_at, updated_at -> ..., NULL, NULL, unixepoch(), unixepoch())
  assert.match(sql, /, NULL, NULL, unixepoch\(\), unixepoch\(\)\)/);
});

test("schema and migration 0007 permit the revoked-override audit event type", () => {
  const schema = readFileSync("schema.sql", "utf8");
  const migration = readFileSync("migrations/0007_allow_revoked_override_event_type.sql", "utf8");
  assert.match(schema, /event_type IN \([^)]*'revoked-override'\)/);
  assert.match(migration, /event_type IN \([^)]*'revoked-override'\)/);
});

test("schema and migration 0008 define entitlement device keys", () => {
  const schema = readFileSync("schema.sql", "utf8");
  const migration = readFileSync("migrations/0008_create_entitlement_devices.sql", "utf8");
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS entitlement_devices/);
    assert.match(sql, /device_key_id TEXT NOT NULL/);
    assert.match(sql, /public_key_spki_der_base64 TEXT NOT NULL/);
    assert.match(sql, /status TEXT NOT NULL CHECK \(status IN \('active', 'revoked', 'disabled'\)\)/);
  }
});

test("interpretWranglerResult flags 0-row mutations and ignores reads", () => {
  // --remote --file (D1 import) reports rows_written; 0 means a guarded no-op.
  assert.equal(interpretWranglerResult([{ meta: { rows_written: 0 } }], "upsert"), "noop");
  assert.equal(interpretWranglerResult([{ meta: { rows_written: 2 } }], "revoke"), "ok");
  // --local strips meta to { duration }; a no-op cannot be distinguished from success.
  assert.equal(interpretWranglerResult([{ meta: { duration: 1 } }], "disable"), "unavailable");
  assert.equal(interpretWranglerResult(undefined, "reenable"), "unavailable");
  // reads never report a no-op regardless of payload.
  assert.equal(interpretWranglerResult([{ meta: { rows_written: 0 } }], "get"), "ignore");
  assert.equal(interpretWranglerResult([{ meta: { rows_written: 0 } }], "list"), "ignore");
});
