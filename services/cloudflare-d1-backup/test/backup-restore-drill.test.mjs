import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SNAPSHOT_COUNTED_TABLES } from "../dist/core.js";
import {
  BACKUP_MANIFEST_SUFFIX,
  MAX_BACKUP_MANIFEST_BYTES,
  MAX_FUTURE_CLOCK_SKEW_MS,
  REQUIRED_TABLES,
  PRESENCE_ONLY_TABLES,
  SENSITIVE_TABLES,
  ALL_RESTORE_TABLES,
  EXPECTED_INDEXES,
  EXPECTED_SCHEMA_SIGNATURE_SHA256,
  EXPECTED_TRIGGERS,
  SNAPSHOT_INVENTORY_ALGORITHM,
  assertScratchSafe,
  canonicalMigrationNames,
  compareCountMaps,
  compareCounts,
  countMapFromRows,
  countSql,
  entitlementSemanticsFromRows,
  entitlementSemanticsSql,
  liveSourceCountObservation,
  unavailableLiveSourceCountObservation,
  manifestSnapshotInventory,
  migrateScratchToCurrent,
  migrationHistoryFromRows,
  migrationHistorySql,
  observedSchemaIdentityFromRows,
  parseArgs,
  parseWranglerJson,
  prepareBackupSource,
  readBoundedJsonFile,
  requiredStatusMismatches,
  restoreEvidence,
  restoreToScratch,
  runWrangler,
  schemaObjectSql,
  schemaRowsFromGeneratedSnapshot,
  schemaSignature,
  sha256File,
  tableListSql,
  validateBackupManifest,
  validateSnapshotFidelity,
  validateSchemaObjectRows,
  validateOptions,
  verifySqlFileContentIntegrity,
  userTableListSql,
  snapshotSchemaObjectSql,
} from "../scripts/restore-drill.mjs";

const MANIFEST_NOW = Date.parse("2026-08-30T12:00:00.000Z");
const SQL_BACKUP = "-- SQL backup";
const R2_OPTIONS = {
  bucket: "licensecc-d1-backups",
  objectKey: "d1/export.sql",
  expectedDatabaseId: "database-456",
  expectedDatabaseName: "licensecc-online-verifier",
  maxBackupAgeSeconds: 3600,
  mode: "remote",
  r2Config: undefined,
};

function validManifest(overrides = {}) {
  const digestHex = createHash("sha256").update(SQL_BACKUP).digest("hex");
  return {
    database_id: R2_OPTIONS.expectedDatabaseId,
    database_name: R2_OPTIONS.expectedDatabaseName,
    source: "cloudflare-d1-export",
    bookmark: "bookmark-1",
    export_filename: "export.sql",
    object_key: R2_OPTIONS.objectKey,
    snapshot_requested_at: "2026-08-30T11:30:00.000Z",
    created_at: "2026-08-30T11:31:00.000Z",
    content_integrity: {
      algorithm: "sha256",
      digest_hex: digestHex,
      size_bytes: Buffer.byteLength(SQL_BACKUP),
      r2_etag: "opaque-r2-etag",
      r2_version: "opaque-r2-version",
      r2_size_bytes: Buffer.byteLength(SQL_BACKUP),
      r2_sha256_hex: digestHex,
    },
    snapshot_inventory: {
      algorithm: "d1-export-sql-insert-count-v1",
      table_counts: {
        entitlements: 2,
        entitlement_events: 5,
        mutation_idempotency: 1,
      },
    },
    ...overrides,
  };
}

function withTempDirectory(action) {
  const directory = mkdtempSync(join(tmpdir(), "licensecc-manifest-test-"));
  try {
    return action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function withTempDirectoryAsync(action) {
  const directory = mkdtempSync(join(tmpdir(), "licensecc-manifest-test-"));
  try {
    return await action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("restore drill executes the SQL file against the confirmed scratch D1 database", () => {
  const executions = [];
  const options = validateOptions(parseArgs([
    "node",
    "restore-drill.mjs",
    "--sql-file",
    "restore backup.sql",
    "--scratch-database",
    "licensecc-online-verifier-restore-drill",
    "--scratch-config",
    "wrangler.restore-drill.jsonc",
    "--confirm-scratch",
    "--remote",
  ]));
  const sqlFile = "C:\\restore evidence\\restore backup.sql";
  const execute = (args, label) => {
    executions.push({ args, label });
    return { status: 0, stdout: "", stderr: "" };
  };

  const ticks = [1000, 1123];
  const elapsedMs = restoreToScratch(options, sqlFile, execute, () => ticks.shift());

  assert.deepEqual(executions, [{
    args: [
      "d1",
      "execute",
      "licensecc-online-verifier-restore-drill",
      "--file",
      sqlFile,
      "--yes",
      "--json",
      "--remote",
      "--config",
      options.scratchConfig,
    ],
    label: "scratch D1 restore",
  }]);
  assert.ok(!executions[0].args.includes("licensecc-online-verifier"));
  assert.ok(!executions[0].args.some((arg) => /[;&|`$()]/.test(arg)));
  assert.ok(!JSON.stringify(executions).match(/token|secret|authorization/i));
  assert.equal(elapsedMs, 123);

  assert.throws(
    () => restoreToScratch(options, sqlFile, () => { throw new Error("wrangler restore failed"); }),
    /wrangler restore failed/,
  );
});

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
  assert.throws(() => parseArgs([
    "node",
    "restore-drill.mjs",
    "--allow-nonempty-scratch",
  ]), /not supported/);
});

test("scratch safety rejects every pre-existing user table with no override", () => {
  const options = { scratchDatabase: "scratch-db", scratchConfig: undefined, mode: "remote" };
  assert.deepEqual(assertScratchSafe(options, {
    existingUserTables: () => [],
  }), { existingUserTables: [] });
  assert.throws(() => assertScratchSafe(options, {
    existingUserTables: () => ["unrelated_customer_archive"],
  }), /scratch_database_not_empty:user_table_count=1/);
  const sql = userTableListSql();
  assert.match(sql, /name NOT LIKE 'sqlite_%'/);
  assert.match(sql, /name <> '_cf_KV'/);
  assert.doesNotMatch(sql, /name IN/);
});

test("snapshot fidelity is pinned to the manifest and ignores later live-source growth", () => {
  const options = { scratchDatabase: "scratch-db", scratchConfig: "backend.toml", mode: "remote" };
  const snapshotCounts = { entitlements: 2, entitlement_events: 5, mutation_idempotency: 1 };
  const result = validateSnapshotFidelity(options, {
    snapshotInventory: {
      algorithm: SNAPSHOT_INVENTORY_ALGORITHM,
      table_counts: snapshotCounts,
    },
  }, {
    existingUserTables: () => ["d1_migrations", "entitlements", "entitlement_events", "mutation_idempotency"],
    tableCounts: () => ({ ...snapshotCounts }),
  });
  assert.deepEqual(result, {
    verified: true,
    status: "manifest_pinned_counts_match_imported_snapshot",
    algorithm: SNAPSHOT_INVENTORY_ALGORITHM,
    table_counts: snapshotCounts,
  });

  const liveSource = { ...snapshotCounts, entitlements: 3 };
  const observation = liveSourceCountObservation(liveSource, snapshotCounts);
  assert.equal(observation.promotion_blocking, false);
  assert.equal(observation.status, "observed");
  assert.deepEqual(observation.differences_from_restored_snapshot, [
    { table: "entitlements", source: 3, restored: 2 },
  ]);
  assert.deepEqual(unavailableLiveSourceCountObservation(), {
    role: "informational_current_source_not_snapshot_fidelity",
    promotion_blocking: false,
    status: "unavailable",
    source_counts: null,
    differences_from_restored_snapshot: null,
  });
});

test("snapshot fidelity fails when the imported scratch loses a manifest-pinned row or table", () => {
  const options = { scratchDatabase: "scratch-db", scratchConfig: "backend.toml", mode: "remote" };
  const backupSource = {
    snapshotInventory: {
      algorithm: SNAPSHOT_INVENTORY_ALGORITHM,
      table_counts: { entitlements: 2, entitlement_events: 5 },
    },
  };
  assert.throws(() => validateSnapshotFidelity(options, backupSource, {
    existingUserTables: () => ["d1_migrations", "entitlements", "entitlement_events"],
    tableCounts: () => ({ entitlements: 1, entitlement_events: 5 }),
  }), /snapshot_row_count_mismatch:table_count=1/);
  assert.throws(() => validateSnapshotFidelity(options, backupSource, {
    existingUserTables: () => ["d1_migrations", "entitlements"],
    tableCounts: () => assert.fail("table counts must not run after an inventory-set mismatch"),
  }), /snapshot_inventory_table_set_mismatch/);
  assert.deepEqual(compareCountMaps({ entitlements: 2 }, { entitlements: 1 }), [
    { table: "entitlements", expected: 2, actual: 1 },
  ]);
});

test("canonical migration lineage upgrades an old snapshot before current-schema validation", () => {
  const canonicalNames = ["0001_initial.sql", "0002_current.sql"];
  let upgraded = false;
  const executions = [];
  const ticks = [100, 127];
  const result = migrateScratchToCurrent({
    scratchDatabase: "scratch-db",
    scratchConfig: "C:\\protected\\backend.toml",
    mode: "remote",
  }, {
    canonicalNames,
    existingUserTables: () => ["d1_migrations", "entitlements"],
    migrationRows: () => upgraded
      ? [{ id: 1, name: canonicalNames[0] }, { id: 2, name: canonicalNames[1] }]
      : [{ id: 1, name: canonicalNames[0] }],
    snapshotSchemaRows: () => [{
      type: "table",
      name: "entitlements",
      table_name: "entitlements",
      sql: "CREATE TABLE entitlements (id TEXT PRIMARY KEY)",
    }],
    execute(args, label) {
      executions.push({ args, label });
      upgraded = true;
    },
    now: () => ticks.shift(),
  });
  assert.deepEqual(executions, [{
    args: [
      "d1", "migrations", "apply", "scratch-db", "--remote", "--config", "C:\\protected\\backend.toml",
    ],
    label: "scratch D1 canonical migration upgrade",
  }]);
  assert.equal(result.snapshot_schema_identity.migration_history.applied_migration_count, 1);
  assert.equal(result.snapshot_schema_identity.schema_objects.recorded, true);
  assert.deepEqual(result.migration_upgrade, {
    status: "migrated_to_current",
    from_migration_count: 1,
    target_migration_count: 2,
    migrations_applied: 1,
    current_migration: "0002_current.sql",
    elapsed_ms: 27,
  });
});

test("migration lineage fails closed when history is absent, divergent, or incomplete", () => {
  const canonicalNames = ["0001_initial.sql", "0002_current.sql"];
  assert.throws(() => migrateScratchToCurrent({
    scratchDatabase: "scratch-db",
    scratchConfig: "backend.toml",
    mode: "remote",
  }, {
    canonicalNames,
    existingUserTables: () => ["entitlements"],
  }), /snapshot_migration_history_missing/);
  assert.throws(() => migrationHistoryFromRows([
    { id: 1, name: "0001_other.sql" },
  ], canonicalNames), /snapshot_migration_history_not_canonical_prefix/);
  assert.throws(() => migrationHistoryFromRows([
    { id: 2, name: canonicalNames[0] },
  ], canonicalNames), /snapshot_migration_history_invalid/);
});

test("checked-out backend migrations are a contiguous canonical inventory", () => {
  const names = canonicalMigrationNames();
  assert.equal(names.length, 32);
  assert.equal(names[0], "0001_create_entitlements.sql");
  assert.equal(names.at(-1), "0032_plan_projection_remediation.sql");
  assert.equal(migrationHistorySql(), "SELECT id, name FROM d1_migrations ORDER BY id");
  assert.match(snapshotSchemaObjectSql(), /name NOT IN \('_cf_KV', 'd1_migrations'\)/);
  assert.deepEqual([...SNAPSHOT_COUNTED_TABLES], REQUIRED_TABLES);
  assert.equal(observedSchemaIdentityFromRows([{
    type: "table",
    name: "entitlements",
    table_name: "entitlements",
    sql: "CREATE TABLE entitlements (id TEXT)",
  }]).table_count, 1);
});

test("real backend migration suffix upgrades a deterministic old local D1 to the current schema", () => {
  withTempDirectory((directory) => {
    const canonicalNames = canonicalMigrationNames();
    const oldMigrationCount = 24;
    const oldMigrations = join(directory, "old-migrations");
    const persistence = join(directory, "d1-state");
    const configFile = join(directory, "wrangler.jsonc");
    const currentMigrations = fileURLToPath(new URL("../../cloudflare-licensing-backend/migrations/", import.meta.url));
    mkdirSync(oldMigrations);
    for (const name of canonicalNames.slice(0, oldMigrationCount)) {
      copyFileSync(join(currentMigrations, name), join(oldMigrations, name));
    }
    const writeConfig = (migrationsDir) => writeFileSync(configFile, JSON.stringify({
      name: "licensecc-backup-migration-integration",
      compatibility_date: "2026-08-01",
      d1_databases: [{
        binding: "DB",
        database_name: "licensecc-backup-migration-integration",
        database_id: "00000000-0000-0000-0000-000000000001",
        migrations_dir: migrationsDir,
      }],
    }));
    const apply = () => runWrangler([
      "d1", "migrations", "apply", "licensecc-backup-migration-integration",
      "--local", "--persist-to", persistence, "--config", configFile,
    ], "local migration integration");
    const query = (command) => {
      const output = runWrangler([
        "d1", "execute", "licensecc-backup-migration-integration",
        "--command", command, "--json", "--local", "--persist-to", persistence,
        "--config", configFile,
      ], "local migration integration query");
      return parseWranglerJson(output.stdout)[0].results;
    };

    writeConfig(oldMigrations);
    apply();
    assert.equal(query(migrationHistorySql()).length, oldMigrationCount);

    writeConfig(currentMigrations);
    apply();
    const history = migrationHistoryFromRows(query(migrationHistorySql()), canonicalNames);
    assert.equal(history.applied_migration_count, canonicalNames.length);
    assert.equal(history.latest_migration, canonicalNames.at(-1));
    assert.equal(validateSchemaObjectRows(query(schemaObjectSql())).digest, EXPECTED_SCHEMA_SIGNATURE_SHA256);
  });
});

test("Wrangler failures expose stable metadata but never raw command output", () => {
  const sensitive = "customer@example.test SQL INSERT secret-fragment";
  assert.throws(
    () => runWrangler(["d1", "execute"], "scratch D1 restore", () => ({
      status: 1,
      signal: null,
      stdout: sensitive,
      stderr: sensitive,
    }), () => "wrangler.js"),
    (error) => {
      assert.match(error.message, /^wrangler_command_failed:operation=scratch_d1_restore;status=1;error_class=nonzero_exit$/);
      assert.doesNotMatch(error.message, /customer|INSERT|secret-fragment/);
      return true;
    },
  );
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
  assert.equal(options.expectedDatabaseId, undefined);
  assert.equal(options.expectedDatabaseName, undefined);
  assert.equal(options.maxBackupAgeSeconds, undefined);
});

test("restore drill supports remote R2 source and optional source comparison", () => {
  const options = validateOptions(parseArgs([
    "node",
    "restore-drill.mjs",
    "--bucket",
    "licensecc-d1-backups",
    "--object-key",
    "d1/export.sql",
    "--expected-database-id",
    "database-456",
    "--expected-database-name",
    "licensecc-online-verifier",
    "--max-backup-age-seconds",
    "3600",
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
  assert.equal(options.expectedDatabaseId, "database-456");
  assert.equal(options.expectedDatabaseName, "licensecc-online-verifier");
  assert.equal(options.maxBackupAgeSeconds, 3600);
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

test("R2 restore arguments require manifest database identity and an RPO age", () => {
  const base = [
    "node",
    "restore-drill.mjs",
    "--bucket",
    "licensecc-d1-backups",
    "--object-key",
    "d1/export.sql",
    "--scratch-database",
    "scratch-db",
    "--confirm-scratch",
  ];
  assert.throws(() => validateOptions(parseArgs(base)), /expected-database-id/);
  assert.throws(() => validateOptions(parseArgs([
    ...base,
    "--expected-database-id",
    "database-456",
  ])), /expected-database-name/);
  assert.throws(() => validateOptions(parseArgs([
    ...base,
    "--expected-database-id",
    "database-456",
    "--expected-database-name",
    "licensecc-online-verifier",
  ])), /max-backup-age-seconds/);
  assert.throws(() => validateOptions(parseArgs([
    ...base,
    "--expected-database-id",
    "database-456",
    "--expected-database-name",
    "licensecc-online-verifier",
    "--max-backup-age-seconds",
    "0",
  ])), /positive integer/);

  assert.throws(() => validateOptions(parseArgs([
    "node",
    "restore-drill.mjs",
    "--sql-file",
    "backup.sql",
    "--expected-database-id",
    "database-456",
    "--scratch-database",
    "scratch-db",
    "--confirm-scratch",
  ])), /only to an R2 backup source/);
});

test("backup manifest matches the requested R2 object, database, and RPO", () => {
  const manifest = validManifest();
  const result = validateBackupManifest(manifest, R2_OPTIONS, MANIFEST_NOW);
  assert.deepEqual(result, {
    identity: {
      source: "cloudflare-d1-export",
      database_id: "database-456",
      database_name: "licensecc-online-verifier",
      bookmark: "bookmark-1",
      object_key: "d1/export.sql",
      manifest_key: `d1/export.sql${BACKUP_MANIFEST_SUFFIX}`,
      snapshot_requested_at: "2026-08-30T11:30:00.000Z",
      created_at: "2026-08-30T11:31:00.000Z",
    },
    backupAgeSeconds: 1800,
    contentIntegrity: manifest.content_integrity,
    snapshotInventory: manifest.snapshot_inventory,
  });
});

test("backup manifest requires bounded snapshot-pinned durable-table counts", () => {
  assert.deepEqual(manifestSnapshotInventory(validManifest().snapshot_inventory), validManifest().snapshot_inventory);
  const cases = [
    [validManifest({ snapshot_inventory: undefined }), /invalid_snapshot_inventory/],
    [validManifest({ snapshot_inventory: { ...validManifest().snapshot_inventory, algorithm: "other" } }), /invalid_snapshot_inventory_algorithm/],
    [validManifest({ snapshot_inventory: { algorithm: SNAPSHOT_INVENTORY_ALGORITHM, table_counts: {} } }), /invalid_snapshot_table_counts/],
    [validManifest({ snapshot_inventory: { algorithm: SNAPSHOT_INVENTORY_ALGORITHM, table_counts: { entitlements: -1 } } }), /invalid_snapshot_table_counts/],
    [validManifest({ snapshot_inventory: { algorithm: SNAPSHOT_INVENTORY_ALGORITHM, table_counts: { unknown_table: 1 } } }), /invalid_snapshot_table_counts/],
  ];
  for (const [manifest, expectation] of cases) {
    assert.throws(() => validateBackupManifest(manifest, R2_OPTIONS, MANIFEST_NOW), expectation);
  }
});

test("backup manifest fails closed on source, object, database, bookmark, and timestamp mismatch", () => {
  const cases = [
    [validManifest({ source: "other" }), /source_mismatch/],
    [validManifest({ object_key: "d1/other.sql" }), /object_key_mismatch/],
    [validManifest({ database_id: "other-id" }), /database_identity_mismatch/],
    [validManifest({ database_name: "other-name" }), /database_identity_mismatch/],
    [validManifest({ bookmark: "" }), /invalid_bookmark/],
    [validManifest({ snapshot_requested_at: "2026-08-30 11:30:00Z" }), /invalid_snapshot_requested_at/],
    [validManifest({ snapshot_requested_at: "2026-02-30T11:30:00.000Z" }), /invalid_snapshot_requested_at/],
    [validManifest({ created_at: "2026-08-30 11:30:00Z" }), /invalid_created_at/],
    [validManifest({ created_at: "2026-02-30T11:30:00.000Z" }), /invalid_created_at/],
  ];
  for (const [manifest, expectation] of cases) {
    assert.throws(() => validateBackupManifest(manifest, R2_OPTIONS, MANIFEST_NOW), expectation);
  }
  assert.throws(() => validateBackupManifest([], R2_OPTIONS, MANIFEST_NOW), /invalid_envelope/);
});

test("backup manifest requires a strong SHA-256/size binding and consistent R2 metadata", () => {
  const digest = validManifest().content_integrity.digest_hex;
  const cases = [
    [validManifest({ content_integrity: undefined }), /invalid_content_integrity/],
    [validManifest({ content_integrity: { ...validManifest().content_integrity, algorithm: "md5" } }), /invalid_integrity_algorithm/],
    [validManifest({ content_integrity: { ...validManifest().content_integrity, digest_hex: "a".repeat(63) } }), /invalid_integrity_digest/],
    [validManifest({ content_integrity: { ...validManifest().content_integrity, size_bytes: 0 } }), /invalid_integrity_size/],
    [validManifest({ content_integrity: { ...validManifest().content_integrity, r2_size_bytes: 1 } }), /invalid_r2_size/],
    [validManifest({ content_integrity: { ...validManifest().content_integrity, r2_etag: "" } }), /invalid_r2_etag/],
    [validManifest({ content_integrity: { ...validManifest().content_integrity, r2_version: "" } }), /invalid_r2_version/],
    [validManifest({ content_integrity: { ...validManifest().content_integrity, r2_sha256_hex: "b".repeat(64) } }), /invalid_r2_sha256/],
  ];
  for (const [manifest, expectation] of cases) {
    assert.throws(() => validateBackupManifest(manifest, R2_OPTIONS, MANIFEST_NOW), expectation);
  }
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test("backup manifest enforces maximum age and bounded future clock skew", () => {
  // A recent R2 upload must not disguise an old D1 snapshot.
  assert.throws(() => validateBackupManifest(validManifest({
    snapshot_requested_at: "2026-08-30T10:59:59.000Z",
    created_at: "2026-08-30T11:59:59.000Z",
  }), R2_OPTIONS, MANIFEST_NOW), /backup_manifest_stale/);

  const exactRpo = validateBackupManifest(validManifest({
    snapshot_requested_at: "2026-08-30T11:00:00.000Z",
  }), R2_OPTIONS, MANIFEST_NOW);
  assert.equal(exactRpo.backupAgeSeconds, 3600);
  assert.throws(() => validateBackupManifest(validManifest({
    snapshot_requested_at: new Date(MANIFEST_NOW - 3600 * 1000 - 1).toISOString(),
  }), R2_OPTIONS, MANIFEST_NOW), /backup_manifest_stale/);

  const futureWithinSkew = new Date(MANIFEST_NOW + MAX_FUTURE_CLOCK_SKEW_MS).toISOString();
  const withinSkew = validateBackupManifest(validManifest({
    snapshot_requested_at: futureWithinSkew,
    created_at: futureWithinSkew,
  }), R2_OPTIONS, MANIFEST_NOW);
  assert.equal(withinSkew.backupAgeSeconds, 0);

  const beyondSkew = new Date(MANIFEST_NOW + MAX_FUTURE_CLOCK_SKEW_MS + 1).toISOString();
  assert.throws(() => validateBackupManifest(validManifest({
    snapshot_requested_at: beyondSkew,
    created_at: beyondSkew,
  }), R2_OPTIONS, MANIFEST_NOW), /future_dated/);

  assert.throws(() => validateBackupManifest(validManifest({
    snapshot_requested_at: "2026-08-30T11:30:00.000Z",
    created_at: "2026-08-30T11:24:59.999Z",
  }), R2_OPTIONS, MANIFEST_NOW), /timestamp_order_invalid/);
});

test("backup manifest reader rejects malformed, invalid UTF-8, and oversized metadata", () => {
  withTempDirectory((directory) => {
    const malformed = join(directory, "malformed.metadata.json");
    writeFileSync(malformed, "{");
    assert.throws(() => readBoundedJsonFile(malformed), /invalid_json/);

    const invalidUtf8 = join(directory, "invalid-utf8.metadata.json");
    writeFileSync(invalidUtf8, Buffer.from([0xc3, 0x28]));
    assert.throws(() => readBoundedJsonFile(invalidUtf8), /invalid_utf8/);

    const oversized = join(directory, "oversized.metadata.json");
    writeFileSync(oversized, Buffer.alloc(MAX_BACKUP_MANIFEST_BYTES + 1, 0x20));
    assert.throws(() => readBoundedJsonFile(oversized), /too_large/);
  });
});

test("R2 source downloads, streams, and validates the adjacent manifest before the SQL object", async () => {
  await withTempDirectoryAsync(async (directory) => {
    const calls = [];
    const result = await prepareBackupSource(R2_OPTIONS, directory, {
      nowMs: MANIFEST_NOW,
      execute(args, label) {
        calls.push({ args, label });
        const destination = args[args.indexOf("--file") + 1];
        if (label === "R2 backup manifest download") {
          writeFileSync(destination, JSON.stringify(validManifest()));
        } else {
          writeFileSync(destination, SQL_BACKUP);
        }
      },
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].label, "R2 backup manifest download");
    assert.equal(calls[0].args[3], `licensecc-d1-backups/d1/export.sql${BACKUP_MANIFEST_SUFFIX}`);
    assert.equal(calls[1].label, "R2 backup download");
    assert.equal(calls[1].args[3], "licensecc-d1-backups/d1/export.sql");
    assert.equal(result.backupAgeSeconds, 1800);
    assert.equal(result.manifestIdentity.database_id, "database-456");
    assert.deepEqual(result.contentIntegrity, {
      verified: true,
      ...validManifest().content_integrity,
    });
    assert.deepEqual(result.snapshotInventory, validManifest().snapshot_inventory);
    assert.match(result.sqlFile, /export\.sql$/);
  });
});

test("R2 source never downloads SQL when metadata is malformed, oversized, or mismatched", async () => {
  const cases = [
    ["{", /invalid_json/],
    [Buffer.alloc(MAX_BACKUP_MANIFEST_BYTES + 1, 0x20), /too_large/],
    [JSON.stringify(validManifest({ database_id: "other-id" })), /database_identity_mismatch/],
  ];
  for (const [metadata, expectation] of cases) {
    await withTempDirectoryAsync(async (directory) => {
      const calls = [];
      await assert.rejects(prepareBackupSource(R2_OPTIONS, directory, {
        nowMs: MANIFEST_NOW,
        execute(args, label) {
          calls.push(label);
          const destination = args[args.indexOf("--file") + 1];
          writeFileSync(destination, metadata);
        },
      }), expectation);
      assert.deepEqual(calls, ["R2 backup manifest download"]);
    });
  }
});

test("R2 source rechecks backup age after the SQL download and integrity scan", async () => {
  await withTempDirectoryAsync(async (directory) => {
    const times = [MANIFEST_NOW, MANIFEST_NOW + 1001];
    await assert.rejects(prepareBackupSource({
      ...R2_OPTIONS,
      maxBackupAgeSeconds: 1800,
    }, directory, {
      now: () => times.shift(),
      execute(args, label) {
        const destination = args[args.indexOf("--file") + 1];
        writeFileSync(
          destination,
          label === "R2 backup manifest download" ? JSON.stringify(validManifest()) : SQL_BACKUP,
        );
      },
    }), /backup_manifest_stale/);
    assert.equal(times.length, 0);
  });
});

test("local SQL source remains manifest-free and performs no R2 download", async () => {
  const result = await prepareBackupSource({ sqlFile: "C:\\backup.sql" }, "C:\\unused", {
    execute() {
      assert.fail("local SQL source must not download a manifest or object");
    },
  });
  assert.deepEqual(result, {
    sqlFile: "C:\\backup.sql",
    manifestIdentity: null,
    backupAgeSeconds: null,
    contentIntegrity: null,
    snapshotInventory: null,
  });
});

test("restore evidence reports manifest identity, RPO age, and measured import time", () => {
  const manifest = validateBackupManifest(validManifest(), R2_OPTIONS, MANIFEST_NOW);
  assert.deepEqual(restoreEvidence({
    manifestIdentity: manifest.identity,
    backupAgeSeconds: manifest.backupAgeSeconds,
    contentIntegrity: {
      verified: true,
      ...manifest.contentIntegrity,
    },
    snapshotInventory: manifest.snapshotInventory,
  }, 123), {
    manifest_identity: manifest.identity,
    backup_age_seconds: 1800,
    content_integrity: {
      verified: true,
      ...manifest.contentIntegrity,
    },
    snapshot_inventory: manifest.snapshotInventory,
    authenticity_verified: false,
    elapsed_ms: 123,
  });
  assert.deepEqual(restoreEvidence({
    manifestIdentity: null,
    backupAgeSeconds: null,
    contentIntegrity: null,
    snapshotInventory: null,
  }, 5), {
    manifest_identity: null,
    backup_age_seconds: null,
    content_integrity: null,
    snapshot_inventory: null,
    authenticity_verified: false,
    elapsed_ms: 5,
  });
});

test("SQL integrity verification streams exact bytes and rejects size or digest corruption", async () => {
  await withTempDirectoryAsync(async (directory) => {
    const sqlFile = join(directory, "backup.sql");
    const manifest = validManifest();
    writeFileSync(sqlFile, SQL_BACKUP);

    assert.deepEqual(await sha256File(sqlFile), {
      digestHex: manifest.content_integrity.digest_hex,
      sizeBytes: manifest.content_integrity.size_bytes,
    });
    assert.deepEqual(
      await verifySqlFileContentIntegrity(sqlFile, manifest.content_integrity),
      { verified: true, ...manifest.content_integrity },
    );

    writeFileSync(sqlFile, "-- SQL backuQ");
    await assert.rejects(
      verifySqlFileContentIntegrity(sqlFile, manifest.content_integrity),
      /backup_sql_integrity_digest_mismatch/,
    );

    writeFileSync(sqlFile, `${SQL_BACKUP}\n`);
    await assert.rejects(
      verifySqlFileContentIntegrity(sqlFile, manifest.content_integrity),
      /backup_sql_integrity_size_mismatch/,
    );
  });
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

test("restore inventory pins all migrated tables through migration 0032", () => {
  const migratedTables = [
    "account_token_events", "account_token_revocations", "account_tokens", "audit_digests",
    "catalog_events", "catalog_features", "catalog_import_previews", "catalog_plan_features", "catalog_plans",
    "customer_events", "customers", "entitlement_devices", "entitlement_events", "entitlement_policies", "entitlements",
    "lease_issuance", "license_plan_assignment_events", "license_plan_assignments",
    "license_plan_projection_generations", "license_plan_projection_previews", "licenses", "mutation_idempotency",
    "order_events", "order_ingest_nonces", "orders", "policy_events", "portal_bootstrap_events", "portal_otp",
    "portal_sessions", "rate_limit_counters", "request_proof_nonces", "seat_checkouts", "usage_events", "usage_meters",
    "webhook_cursor", "webhook_deliveries", "webhook_endpoints", "webhook_events",
  ];
  assert.deepEqual([...ALL_RESTORE_TABLES].sort(), migratedTables);
  assert.equal(ALL_RESTORE_TABLES.length, 38);

  for (const durable of [
    "entitlements", "entitlement_policies", "catalog_features", "catalog_plans",
    "catalog_plan_features", "license_plan_assignments", "license_plan_assignment_events",
    "audit_digests", "webhook_endpoints", "webhook_events",
  ]) {
    assert.ok(REQUIRED_TABLES.includes(durable), `durable count inventory missing ${durable}`);
  }
  const sql = countSql();
  assert.match(sql, /FROM entitlements/);
  assert.match(sql, /FROM catalog_plans/);
  assert.match(sql, /FROM license_plan_assignment_events/);
});

test("high-churn and internal tables are presence-only and disjoint from durable count checks", () => {
  for (const table of [
    "rate_limit_counters", "request_proof_nonces", "order_ingest_nonces",
    "lease_issuance", "seat_checkouts", "usage_events",
    "portal_otp", "portal_sessions", "portal_bootstrap_events",
    "webhook_deliveries", "webhook_cursor", "usage_meters",
    "license_plan_projection_generations", "license_plan_projection_previews", "catalog_import_previews",
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

test("table and named schema-object checks cover migrated identity", () => {
  const sql = tableListSql();
  assert.match(sql, /sqlite_master/);
  for (const table of ALL_RESTORE_TABLES) {
    assert.ok(sql.includes(`'${table}'`), `tableListSql does not assert ${table} present`);
  }

  assert.equal(Object.keys(EXPECTED_INDEXES).length, 58);
  assert.equal(Object.keys(EXPECTED_TRIGGERS).length, 18);
  assert.equal(EXPECTED_INDEXES.idx_license_plan_projection_previews_expiry_id, "license_plan_projection_previews");
  assert.equal("idx_license_plan_projection_previews_expiry" in EXPECTED_INDEXES, false);
  assert.equal("idx_license_plan_projection_previews_consumed" in EXPECTED_INDEXES, false);

  const schemaSql = schemaObjectSql();
  assert.match(schemaSql, /tbl_name AS table_name/);
  assert.match(schemaSql, /idx_catalog_import_previews_consumed/);
  assert.match(schemaSql, /bump_license_plan_projection_generation_assignments_delete/);
  const snapshot = readFileSync(new URL("../../cloudflare-licensing-backend/schema.sql", import.meta.url), "utf8");
  const rows = schemaRowsFromGeneratedSnapshot(snapshot);
  assert.equal(rows.length, 114);
  assert.equal(schemaSignature(rows), EXPECTED_SCHEMA_SIGNATURE_SHA256);
  assert.deepEqual(validateSchemaObjectRows(rows), {
    verified: true,
    algorithm: "sha256",
    digest: EXPECTED_SCHEMA_SIGNATURE_SHA256,
    table_count: 38,
    named_index_count: 58,
    trigger_count: 18,
  });
  assert.throws(() => validateSchemaObjectRows(rows.filter((row) => row.name !== "entitlements")), /restored_schema_objects_missing:table:entitlements/);
  assert.throws(() => validateSchemaObjectRows(rows.map((row) => row.name === "entitlements"
    ? { ...row, sql: `${row.sql} /* changed */` }
    : row)), /restored_schema_signature_mismatch/);
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
