import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as cli from "../../scripts/entitlement.mjs";

const { interpretWranglerResult, sqlFor } = cli;

const cliPath = fileURLToPath(new URL("../../scripts/entitlement.mjs", import.meta.url));
// Each run is refused before any database command, so no wrangler process starts.
const runCli = (...args) => spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });

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

test("break-glass CLI upsert writes the grant and its audit event only for an existing active customer", () => {
  const sql = sqlFor("upsert", { fingerprint: "a".repeat(64), actor: "operator", "customer-id": "cus_1", "license-id": "lic_1" });
  const guard = "EXISTS (SELECT 1 FROM customers WHERE id = 'cus_1' AND status = 'active')";
  const [write, audit] = sql.split(";\n");
  assert.ok(write.includes(guard), "the grant write is guarded");
  assert.ok(audit.includes(guard), "the audit event is guarded the same way");
});

test("the removed revoked override is an unknown option wherever it appears on the command line", () => {
  for (const args of [
    ["upsert", "--fingerprint", "not-hex", "--allow-revoked-override"],
    ["upsert", "--allow-revoked-override", "--fingerprint", "not-hex"],
  ]) {
    const result = runCli(...args);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stderr.trim(), "unknown option --allow-revoked-override for upsert", args.join(" "));
  }
});

test("the CLI usage names no way to reactivate a revoked grant", () => {
  const result = runCli();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage:/u);
  assert.match(result.stderr, /revoked entitlements are terminal/);
  assert.doesNotMatch(result.stderr, /override|reactivate/i);
  assert.match(result.stderr, /--customer-id must name an existing active customer/);
});

test("a refused mutation's notice names its cause and never suggests reactivating a revoked grant", () => {
  const { noOpNotice } = cli;
  const fingerprint = "a".repeat(64);
  const upsert = noOpNotice("upsert", { fingerprint, "customer-id": "cus_typo" });
  assert.match(upsert, /^NO-OP: upsert on project=DEFAULT feature=DEFAULT fingerprint=a{64} changed 0 rows and wrote no audit event\./u);
  assert.match(upsert, /customer cus_typo does not exist or is not active/);
  assert.match(upsert, /the entitlement belongs to another customer, and upsert never changes an owner/);
  assert.match(upsert, /revoked, and revocation is permanent/);
  assert.match(upsert, /get --fingerprint a{64}/);
  // get shows the owner, so the operator can see which cause applies.
  assert.match(cli.sqlFor("get", { fingerprint }), /^SELECT project, feature, license_fingerprint, customer_id, license_id, status, /u);
  for (const command of ["disable", "reenable", "revoke"]) {
    const notice = noOpNotice(command, { fingerprint, project: "CAD" });
    assert.match(notice, new RegExp(`^NO-OP: ${command} on project=CAD feature=DEFAULT`, "u"));
    assert.doesNotMatch(notice, /customer/);
  }
  for (const notice of [upsert, noOpNotice("reenable", { fingerprint })]) assert.doesNotMatch(notice, /override|reactivate/i);
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

test("break-glass CLI refuses an option its command does not use instead of dropping it", () => {
  const fingerprint = "a".repeat(64);
  const upsert = { fingerprint, actor: "operator", "customer-id": "cus_1", "license-id": "lic_1" };
  // A protected grant carries no device hash: a removed flag must fail loudly, not vanish.
  assert.throws(() => sqlFor("upsert", { ...upsert, "device-hash": "b".repeat(64) }), /^Error: unknown option --device-hash for upsert$/u);
  assert.throws(() => sqlFor("upsert", { ...upsert, "assertion-ttl": "300" }), /^Error: unknown option --assertion-ttl for upsert$/u);
  // An option another command uses is still unknown here.
  assert.throws(() => sqlFor("revoke", { fingerprint, actor: "operator", reason: "r", "customer-id": "cus_1" }), /unknown option --customer-id for revoke/u);
  assert.throws(() => sqlFor("reenable", { fingerprint, actor: "operator", "allow-revoked-override": true }), /unknown option --allow-revoked-override for reenable/u);
  assert.throws(() => sqlFor("upsert", { ...upsert, "allow-revoked-override": true }), /^Error: unknown option --allow-revoked-override for upsert$/u);
  assert.throws(() => sqlFor("list", { fingerprint }), /unknown option --fingerprint for list/u);
  // The connection options apply to every command.
  for (const connection of [{ database: "db" }, { config: "wrangler.toml" }, { remote: true }, { local: true }]) {
    assert.doesNotThrow(() => sqlFor("get", { fingerprint, ...connection }), JSON.stringify(connection));
    assert.doesNotThrow(() => sqlFor("list", connection), JSON.stringify(connection));
  }
});

test("schema permits sync audit actor type", () => {
  const schema = readFileSync("schema.sql", "utf8");
  assert.match(schema, /actor_type IN \('access', 'dev', 'cli', 'sync', 'system', 'unknown'\)/);
});

test("break-glass CLI upsert sets customer_id and license_id when provided", () => {
  const sql = sqlFor("upsert", {
    fingerprint: "a".repeat(64),
    actor: "operator",
    "customer-id": "cus_123",
    "license-id": "lic_123",
  });
  assert.match(sql, /customer_id, license_id, created_at, updated_at\) SELECT /);
  assert.match(sql, /'cus_123'/);
  assert.match(sql, /'lic_123'/);
  // A later upsert never reassigns the owner or the license: neither is in the SET clause.
  const assignments = sql.slice(sql.indexOf("DO UPDATE SET"), sql.indexOf(" WHERE entitlements.status != 'revoked'"));
  assert.match(assignments, /^DO UPDATE SET status = excluded\.status, /u);
  assert.doesNotMatch(assignments, /customer_id|license_id/);
  // It refuses a grant another customer owns instead of refreshing it.
  assert.match(sql, /WHERE entitlements\.status != 'revoked' AND entitlements\.customer_id = excluded\.customer_id/);
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
