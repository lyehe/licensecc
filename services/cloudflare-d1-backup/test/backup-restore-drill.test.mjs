import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REQUIRED_TABLES,
  compareCounts,
  countMapFromRows,
  countSql,
  entitlementSemanticsFromRows,
  entitlementSemanticsSql,
  parseArgs,
  parseWranglerJson,
  requiredStatusMismatches,
  tableListSql,
  validateOptions,
} from "../scripts/restore-drill.mjs";

test("restore drill arguments require explicit scratch confirmation", () => {
  const parsed = parseArgs([
    "node",
    "restore-drill.mjs",
    "--sql-file",
    "backup.sql",
    "--scratch-database",
    "scratch-db",
  ]);
  assert.throws(() => validateOptions(parsed), /--confirm-scratch/);
});

test("restore drill supports local sql-file source", () => {
  const options = validateOptions(parseArgs([
    "node",
    "restore-drill.mjs",
    "--sql-file",
    "backup.sql",
    "--scratch-database",
    "scratch-db",
    "--confirm-scratch",
    "--local",
  ]));
  assert.equal(options.mode, "local");
  assert.equal(options.scratchDatabase, "scratch-db");
  assert.match(options.sqlFile, /backup\.sql$/);
});

test("restore drill supports remote R2 source and optional source comparison", () => {
  const options = validateOptions(parseArgs([
    "node",
    "restore-drill.mjs",
    "--bucket",
    "licensecc-d1-backups",
    "--object-key",
    "d1/export.sql",
    "--scratch-database",
    "scratch-db",
    "--source-database",
    "source-db",
    "--require-restored-status",
    "active",
    "--require-restored-status",
    "revoked",
    "--confirm-scratch",
  ]));
  assert.equal(options.mode, "remote");
  assert.equal(options.bucket, "licensecc-d1-backups");
  assert.equal(options.objectKey, "d1/export.sql");
  assert.equal(options.sourceDatabase, "source-db");
  assert.deepEqual(options.requiredRestoredStatuses, ["active", "revoked"]);
});

test("restore drill rejects ambiguous backup source", () => {
  assert.throws(() => validateOptions(parseArgs([
    "node",
    "restore-drill.mjs",
    "--sql-file",
    "backup.sql",
    "--bucket",
    "bucket",
    "--object-key",
    "key.sql",
    "--scratch-database",
    "scratch-db",
    "--confirm-scratch",
  ])), /either --sql-file or --bucket/);
});

test("wrangler json parser tolerates advisory text before json", () => {
  const parsed = parseWranglerJson(`Cloudflare advisory line
[
  {
    "success": true,
    "results": [{ "x": 1 }]
  }
]`);
  assert.equal(parsed[0].results[0].x, 1);
});

test("count SQL covers required entitlement tables only", () => {
  assert.deepEqual(REQUIRED_TABLES, ["entitlements", "entitlement_events", "mutation_idempotency"]);
  assert.match(tableListSql(), /sqlite_master/);
  const sql = countSql();
  assert.match(sql, /FROM entitlements/);
  assert.match(sql, /FROM entitlement_events/);
  assert.match(sql, /FROM mutation_idempotency/);
});

test("count rows normalize to table count map", () => {
  assert.deepEqual(countMapFromRows([
    { table_name: "entitlements", row_count: 2 },
    { table_name: "entitlement_events", row_count: "5" },
  ]), {
    entitlements: 2,
    entitlement_events: 5,
  });
  assert.throws(() => countMapFromRows([{ table_name: "entitlements", row_count: "not-a-number" }]), /unexpected count row/);
});

test("count comparison reports exact mismatches", () => {
  const source = {
    entitlements: 2,
    entitlement_events: 5,
    mutation_idempotency: 1,
  };
  const restored = {
    entitlements: 2,
    entitlement_events: 4,
    mutation_idempotency: 1,
  };
  assert.deepEqual(compareCounts(source, restored), [
    { table: "entitlement_events", source: 5, restored: 4 },
  ]);
  assert.deepEqual(compareCounts(source, source), []);
});

test("entitlement semantic SQL and normalization track verifier-facing states", () => {
  const sql = entitlementSemanticsSql();
  assert.match(sql, /active_verifier_candidate_count/);
  assert.match(sql, /valid_until IS NULL OR valid_until > CAST/);

  const semantics = entitlementSemanticsFromRows([{
    total: "3",
    active_count: "1",
    revoked_count: 1,
    disabled_count: 1,
    active_verifier_candidate_count: "1",
    revoked_verifier_denial_count: "1",
    disabled_verifier_denial_count: 1,
    min_revocation_seq: "2",
    max_revocation_seq: "9",
  }]);
  assert.deepEqual(semantics, {
    total: 3,
    status_counts: {
      active: 1,
      revoked: 1,
      disabled: 1,
    },
    verifier_candidates: {
      active_accept: 1,
      revoked_deny: 1,
      disabled_deny: 1,
    },
    revocation_seq: {
      min: 2,
      max: 9,
    },
  });
});

test("required restored status checks fail on missing verifier candidates", () => {
  const semantics = entitlementSemanticsFromRows([{
    total: 2,
    active_count: 1,
    revoked_count: 1,
    disabled_count: 0,
    active_verifier_candidate_count: 0,
    revoked_verifier_denial_count: 1,
    disabled_verifier_denial_count: 0,
    min_revocation_seq: 1,
    max_revocation_seq: 2,
  }]);
  assert.deepEqual(requiredStatusMismatches(semantics, ["active", "revoked"]), [
    {
      status: "active",
      reason: "no restored active entitlement is currently eligible for verifier acceptance",
    },
  ]);
  assert.deepEqual(requiredStatusMismatches(semantics, ["revoked"]), []);
});
