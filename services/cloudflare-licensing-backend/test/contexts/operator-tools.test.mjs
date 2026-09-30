import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { interpretWranglerResult, sqlFor } from "../../scripts/entitlement.mjs";

test("break-glass CLI upsert does not update revoked entitlements", () => {
  const sql = sqlFor("upsert", {
    fingerprint: "a".repeat(64),
    actor: "operator",
    status: "active",
    "customer-id": "cus_1",
    "license-id": "lic_1",
  });
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
  assert.match(schema, /actor_type IN \('access', 'dev', 'cli', 'sync', 'system', 'unknown'\)/);
});

test("break-glass CLI upsert --allow-revoked-override drops the guard and stamps a distinct event", () => {
  const sql = sqlFor("upsert", {
    fingerprint: "a".repeat(64),
    actor: "operator",
    status: "active",
    reason: "mistaken revoke, ticket #123",
    "allow-revoked-override": true,
    "customer-id": "cus_1",
    "license-id": "lic_1",
  });
  assert.doesNotMatch(sql, /WHERE entitlements\.status != 'revoked'/);
  assert.match(sql, /'revoked-override'/);
  assert.match(sql, /INSERT INTO entitlement_events/);
});

test("break-glass CLI upsert override requires a reason", () => {
  assert.throws(
    () =>
      sqlFor("upsert", {
        fingerprint: "a".repeat(64),
        actor: "operator",
        "allow-revoked-override": true,
        "customer-id": "cus_1",
        "license-id": "lic_1",
      }),
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
  // The upsert names no mode: the schema default makes every new grant protected.
  assert.match(sql, /customer_id, license_id, created_at, updated_at\) VALUES/);
  assert.doesNotMatch(sql, /enforcement_mode|device_bound_v1/);
  assert.match(sql, /'cus_123'/);
  assert.match(sql, /'lic_123'/);
  assert.doesNotMatch(sql, /customer_id = excluded\.customer_id/);
  assert.doesNotMatch(sql, /license_id = excluded\.license_id/);
});

test("upsert requires --customer-id and --license-id", () => {
  assert.throws(
    () => sqlFor("upsert", { fingerprint: "a".repeat(64), actor: "operator" }),
    /customer-id is required/,
  );
  assert.throws(
    () => sqlFor("upsert", { fingerprint: "a".repeat(64), actor: "operator", "customer-id": "cus_1" }),
    /license-id is required/,
  );
});

test("schema permits the revoked-override audit event type", () => {
  const schema = readFileSync("schema.sql", "utf8");
  assert.match(schema, /event_type IN \([^)]*'revoked-override'\)/);
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
