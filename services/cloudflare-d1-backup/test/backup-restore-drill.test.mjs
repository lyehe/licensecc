import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REQUIRED_TABLES,
  PRESENCE_ONLY_TABLES,
  SENSITIVE_TABLES,
  ALL_RESTORE_TABLES,
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

test("required tables cover the entitlement core plus the operations back-office", () => {
  for (const table of [
    "entitlements", "entitlement_events", "mutation_idempotency",
    "customers", "licenses", "entitlement_devices",
    "orders", "order_events",
    "account_tokens", "account_token_revocations", "account_token_events",
    "customer_events",
  ]) {
    assert.ok(REQUIRED_TABLES.includes(table), `REQUIRED_TABLES missing ${table}`);
  }
  const sql = countSql();
  assert.match(sql, /FROM entitlements/);
  assert.match(sql, /FROM orders/);
  assert.match(sql, /FROM account_tokens/);
  assert.match(sql, /FROM customer_events/);
});

test("presence-only tables cover the high-churn / ephemeral / swept set, disjoint from required", () => {
  for (const table of [
    "rate_limit_counters", "request_proof_nonces", "order_ingest_nonces",
    "lease_issuance", "seat_checkouts", "usage_events",
    "portal_otp", "portal_sessions", "portal_bootstrap_events",
  ]) {
    assert.ok(PRESENCE_ONLY_TABLES.includes(table), `PRESENCE_ONLY_TABLES missing ${table}`);
  }
  // Required and presence-only must not overlap (a table is either count-compared or not).
  for (const table of REQUIRED_TABLES) {
    assert.ok(!PRESENCE_ONLY_TABLES.includes(table), `${table} is in both required and presence-only`);
  }
  // ALL_RESTORE_TABLES is exactly the union.
  assert.deepEqual([...ALL_RESTORE_TABLES].sort(), [...REQUIRED_TABLES, ...PRESENCE_ONLY_TABLES].sort());
});

test("presence assertion (tableListSql) covers every restored table", () => {
  const sql = tableListSql();
  assert.match(sql, /sqlite_master/);
  for (const table of ALL_RESTORE_TABLES) {
    assert.ok(sql.includes(`'${table}'`), `tableListSql does not assert ${table} present`);
  }
});

test("sensitive tables are a real subset of restored tables (so they are presence-asserted)", () => {
  assert.ok(SENSITIVE_TABLES.length > 0);
  for (const table of SENSITIVE_TABLES) {
    assert.ok(ALL_RESTORE_TABLES.includes(table), `sensitive table ${table} is not in the restore set`);
  }
});

// Sensitive handling: the drill must NEVER read secret/PII column values — only COUNT(*) and
// sqlite_master presence. Pin that the generated SQL is content-free (no SELECT *, no column
// projection beyond the table_name literal + COUNT aggregate), for ALL tables including sensitive ones.
test("count and presence SQL are content-free (no column projection on any table)", () => {
  const sql = `${countSql(ALL_RESTORE_TABLES)} ; ${tableListSql()}`;
  assert.doesNotMatch(sql, /SELECT \*/, "drill must not SELECT * any table");
  // The only projected expressions are the literal table_name, COUNT(*), and sqlite_master's `name`.
  // No HMAC / email / secret column name should ever appear in the drill's SQL.
  for (const forbidden of ["token_hmac", "secret_hmac", "session_hmac", "code_hmac", "email", "raw_payload"]) {
    assert.ok(!sql.includes(forbidden), `drill SQL references sensitive column ${forbidden}`);
  }
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
