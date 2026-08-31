import { spawnSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  fstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const BACKUP_MANIFEST_SUFFIX = ".metadata.json";
const MAX_BACKUP_MANIFEST_BYTES = 16 * 1024;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_MANIFEST_STRING_LENGTH = 2048;
const SQL_HASH_CHUNK_BYTES = 64 * 1024;
const EXPECTED_SCHEMA_SIGNATURE_SHA256 = "41629ba98263e38a2bb53adbe20f7c24fae5235b392c64200004dbc698e9b0c0";
const SNAPSHOT_INVENTORY_ALGORITHM = "d1-export-sql-insert-count-v1";
const DEFAULT_BACKEND_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../cloudflare-licensing-backend/migrations",
);

// Durable business, configuration, and append-only audit tables whose row
// counts are compared when --source-database is supplied. Presence is always
// checked; count comparison is optional because a live source can advance
// after the exported snapshot.
const REQUIRED_TABLES = [
  "entitlements",
  "entitlement_events",
  "mutation_idempotency",
  "customers",
  "licenses",
  "entitlement_devices",
  "orders",
  "order_events",
  "account_tokens",
  "account_token_revocations",
  "account_token_events",
  "customer_events",
  "entitlement_policies",
  "policy_events",
  "webhook_endpoints",
  "audit_digests",
  "catalog_features",
  "catalog_plans",
  "catalog_plan_features",
  "license_plan_assignments",
  "catalog_events",
  "webhook_events",
  "license_plan_assignment_events",
];

// High-churn, swept, delivery, meter, cursor, and preview/projection state is
// presence-checked but deliberately not count-compared with a live source.
const PRESENCE_ONLY_TABLES = [
  "rate_limit_counters",
  "request_proof_nonces",
  "order_ingest_nonces",
  "lease_issuance",
  "seat_checkouts",
  "usage_events",
  "portal_otp",
  "portal_sessions",
  "portal_bootstrap_events",
  "webhook_deliveries",
  "webhook_cursor",
  "usage_meters",
  "license_plan_projection_generations",
  "license_plan_projection_previews",
  "catalog_import_previews",
];

// Tables holding keyed secret material (HMACs) or PII (email). The drill only ever runs COUNT(*) and
// sqlite_master presence checks against EVERY table — never SELECT * or any column projection — so no
// secret/PII value is ever read, logged, or placed in the summary. This list documents that guarantee
// and is surfaced (names only) in the summary; `count SQL is content-free` test pins it.
const SENSITIVE_TABLES = [
  "customers",
  "account_tokens",
  "account_token_revocations",
  "request_proof_nonces",
  "order_ingest_nonces",
  "portal_otp",
  "portal_sessions",
];

// Every table the restored database must contain (presence-asserted as one set).
const ALL_RESTORE_TABLES = [...REQUIRED_TABLES, ...PRESENCE_ONLY_TABLES];

// Final named indexes and triggers from migrations 0001-0032. SQLite's
// autoindexes are intentionally excluded; each named object's type, owner, and
// normalized DDL contributes to the canonical schema signature below.
const EXPECTED_INDEXES = {
  idx_account_token_events_customer: "account_token_events",
  idx_account_token_events_token: "account_token_events",
  idx_account_tokens_customer: "account_tokens",
  idx_account_tokens_hmac: "account_tokens",
  idx_account_tokens_status: "account_tokens",
  idx_audit_digests_source: "audit_digests",
  idx_catalog_events_entity: "catalog_events",
  idx_catalog_events_project: "catalog_events",
  idx_catalog_features_project_status: "catalog_features",
  idx_catalog_import_previews_consumed: "catalog_import_previews",
  idx_catalog_import_previews_expiry: "catalog_import_previews",
  idx_catalog_plan_features_addon: "catalog_plan_features",
  idx_catalog_plan_features_project: "catalog_plan_features",
  idx_catalog_plans_project_status: "catalog_plans",
  idx_customer_events_customer: "customer_events",
  idx_customers_email: "customers",
  idx_entitlement_devices_entitlement: "entitlement_devices",
  idx_entitlement_devices_status: "entitlement_devices",
  idx_entitlement_events_actor: "entitlement_events",
  idx_entitlement_events_lookup: "entitlement_events",
  idx_entitlement_events_request: "entitlement_events",
  idx_entitlement_policies_name: "entitlement_policies",
  idx_entitlements_customer: "entitlements",
  idx_entitlements_license: "entitlements",
  idx_entitlements_project_feature_status: "entitlements",
  idx_entitlements_project_license_fingerprint: "entitlements",
  idx_entitlements_status: "entitlements",
  idx_entitlements_valid_until: "entitlements",
  idx_lease_issuance_entitlement: "lease_issuance",
  idx_lease_issuance_issued_at: "lease_issuance",
  idx_license_plan_assignment_events_assignment: "license_plan_assignment_events",
  idx_license_plan_assignments_customer: "license_plan_assignments",
  idx_license_plan_assignments_plan: "license_plan_assignments",
  idx_license_plan_projection_previews_expiry_id: "license_plan_projection_previews",
  idx_licenses_customer: "licenses",
  idx_licenses_project: "licenses",
  idx_mutation_idempotency_created_at: "mutation_idempotency",
  idx_order_events_sub_seq: "order_events",
  idx_order_events_unprocessed: "order_events",
  idx_order_ingest_nonces_expires_at: "order_ingest_nonces",
  idx_orders_fp_unique: "orders",
  idx_policy_events_policy: "policy_events",
  idx_portal_bootstrap_customer: "portal_bootstrap_events",
  idx_portal_otp_code: "portal_otp",
  idx_portal_otp_expires: "portal_otp",
  idx_portal_otp_secret: "portal_otp",
  idx_portal_sessions_customer: "portal_sessions",
  idx_portal_sessions_expires: "portal_sessions",
  idx_portal_sessions_hmac: "portal_sessions",
  idx_rate_limit_counters_expires_at: "rate_limit_counters",
  idx_request_proof_nonces_expires_at: "request_proof_nonces",
  idx_seat_checkouts_live: "seat_checkouts",
  idx_usage_events_ts: "usage_events",
  idx_usage_events_window: "usage_events",
  idx_usage_meters_entitlement: "usage_meters",
  idx_webhook_deliveries_due: "webhook_deliveries",
  idx_webhook_endpoints_status: "webhook_endpoints",
  idx_webhook_events_endpoint: "webhook_events",
};

const EXPECTED_TRIGGERS = Object.fromEntries(
  ["catalog_features", "catalog_plans", "catalog_plan_features", "entitlement_policies", "entitlements", "assignments"]
    .flatMap((subject) => ["insert", "update", "delete"].map((operation) => [
      `bump_license_plan_projection_generation_${subject}_${operation}`,
      subject === "assignments" ? "license_plan_assignments" : subject,
    ])),
);

function usage(exitCode = 2) {
  console.error(`usage:
  node scripts/restore-drill.mjs --bucket <r2-bucket> --object-key <backup.sql> --expected-database-id <database-id> --expected-database-name <database-name> --max-backup-age-seconds <seconds> --scratch-database <scratch-d1> --confirm-scratch [--scratch-config <wrangler config>] [--source-database <source-d1>] [--source-config <wrangler config>] [--r2-config <wrangler config>] [--require-restored-status active|revoked|disabled]... [--remote|--local]
  node scripts/restore-drill.mjs --sql-file <backup.sql> --scratch-database <scratch-d1> --confirm-scratch [--scratch-config <wrangler config>] [--source-database <source-d1>] [--source-config <wrangler config>] [--require-restored-status active|revoked|disabled]... [--remote|--local]

Restores an R2 D1 SQL dump into an explicitly named scratch database and
validates its adjacent manifest, RPO age, streamed SHA-256/size integrity, and
snapshot-pinned durable-table counts, then applies the checked-out backend
migrations and validates the current canonical schema. A live source, when
provided, is informational only because it can advance after the snapshot.
Local --sql-file drills remain manifest-free. The command refuses to run
without --confirm-scratch.`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 2; index < argv.length; ++index) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--allow-nonempty-scratch") {
      throw new Error("--allow-nonempty-scratch is not supported; the scratch database must be empty");
    }
    if (["--confirm-scratch", "--remote", "--local"].includes(arg)) {
      options[arg.slice(2)] = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    const key = arg.slice(2);
    if (key === "require-restored-status" && options[key] !== undefined) {
      options[key] = Array.isArray(options[key]) ? [...options[key], value] : [options[key], value];
    } else {
      options[key] = value;
    }
  }
  return options;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function validateOptions(options) {
  if (options.help) {
    usage(0);
  }
  if (options.remote && options.local) {
    throw new Error("choose either --remote or --local, not both");
  }
  if (!options["confirm-scratch"]) {
    throw new Error("--confirm-scratch is required");
  }
  const hasR2Source = options.bucket !== undefined || options["object-key"] !== undefined;
  if (hasR2Source) {
    requiredString(options.bucket, "bucket");
    requiredString(options["object-key"], "object-key");
  }
  if (options["sql-file"] === undefined && !hasR2Source) {
    throw new Error("provide --sql-file or --bucket plus --object-key");
  }
  if (options["sql-file"] !== undefined && hasR2Source) {
    throw new Error("provide either --sql-file or --bucket plus --object-key, not both");
  }
  const manifestExpectations = [
    options["expected-database-id"],
    options["expected-database-name"],
    options["max-backup-age-seconds"],
  ];
  if (!hasR2Source && manifestExpectations.some((value) => value !== undefined)) {
    throw new Error("manifest expectations apply only to an R2 backup source");
  }
  return {
    bucket: options.bucket,
    objectKey: options["object-key"],
    sqlFile: options["sql-file"] === undefined ? undefined : resolve(options["sql-file"]),
    scratchDatabase: requiredString(options["scratch-database"], "scratch-database"),
    scratchConfig: options["scratch-config"] === undefined ? undefined : resolve(options["scratch-config"]),
    sourceDatabase: options["source-database"],
    sourceConfig: options["source-config"] === undefined ? undefined : resolve(options["source-config"]),
    r2Config: options["r2-config"] === undefined ? undefined : resolve(options["r2-config"]),
    mode: options.local ? "local" : "remote",
    requiredRestoredStatuses: requiredRestoredStatuses(options["require-restored-status"]),
    expectedDatabaseId: hasR2Source
      ? requiredString(options["expected-database-id"], "expected-database-id")
      : undefined,
    expectedDatabaseName: hasR2Source
      ? requiredString(options["expected-database-name"], "expected-database-name")
      : undefined,
    maxBackupAgeSeconds: hasR2Source
      ? positiveInteger(options["max-backup-age-seconds"], "max-backup-age-seconds")
      : undefined,
  };
}

function requiredRestoredStatuses(value) {
  if (value === undefined) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.map((item) => String(item).trim().toLowerCase());
  for (const item of normalized) {
    if (!["active", "revoked", "disabled"].includes(item)) {
      throw new Error("--require-restored-status must be active, revoked, or disabled");
    }
  }
  return [...new Set(normalized)];
}

function wranglerBin() {
  const require = createRequire(import.meta.url);
  return resolve(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
}

function modeArg(mode) {
  return mode === "local" ? "--local" : "--remote";
}

function configArgs(config) {
  return config === undefined ? [] : ["--config", config];
}

function runWrangler(args, label, spawn = spawnSync, resolveBin = wranglerBin) {
  const result = spawn(process.execPath, [resolveBin(), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
    },
  });
  if (result.status !== 0) {
    const operation = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "wrangler";
    const status = Number.isInteger(result.status) ? result.status : "unavailable";
    const errorClass = result.error !== undefined
      ? "spawn_error"
      : result.signal !== null && result.signal !== undefined
        ? "signal_exit"
        : "nonzero_exit";
    throw new Error(`wrangler_command_failed:operation=${operation};status=${status};error_class=${errorClass}`);
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseWranglerJson(stdout) {
  const trimmed = stdout.trim();
  for (let index = 0; index < trimmed.length; ++index) {
    const char = trimmed[index];
    if (char !== "[" && char !== "{") {
      continue;
    }
    try {
      return JSON.parse(trimmed.slice(index));
    } catch {
      // Wrangler can print advisory lines before JSON. Keep scanning.
    }
  }
  throw new Error("wrangler_output_invalid_json");
}

function firstResults(envelope) {
  if (!Array.isArray(envelope) || envelope.length === 0 || envelope[0].success !== true || !Array.isArray(envelope[0].results)) {
    throw new Error("wrangler_output_invalid_d1_envelope");
  }
  return envelope[0].results;
}

function tableListSql(tables = ALL_RESTORE_TABLES) {
  const quoted = tables.map((table) => `'${table}'`).join(", ");
  return `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${quoted}) ORDER BY name`;
}

function userTableListSql() {
  return "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' ORDER BY name";
}

function expectedSchemaObjects() {
  return [
    ...ALL_RESTORE_TABLES.map((name) => ({ type: "table", name, table_name: name })),
    ...Object.entries(EXPECTED_INDEXES).map(([name, table_name]) => ({ type: "index", name, table_name })),
    ...Object.entries(EXPECTED_TRIGGERS).map(([name, table_name]) => ({ type: "trigger", name, table_name })),
  ];
}

function schemaObjectSql() {
  const quoted = expectedSchemaObjects().map(({ name }) => `'${name}'`).join(", ");
  return `SELECT type, name, tbl_name AS table_name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') AND name IN (${quoted}) ORDER BY type, name`;
}

function snapshotSchemaObjectSql() {
  return "SELECT type, name, tbl_name AS table_name, sql FROM sqlite_master "
    + "WHERE type IN ('table', 'index', 'trigger') AND sql IS NOT NULL "
    + "AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV', 'd1_migrations') "
    + "ORDER BY type, name";
}

function normalizeSchemaSql(sql) {
  return sql
    .replaceAll('"', "")
    .replace(/\bIF\s+NOT\s+EXISTS\s+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function schemaSignature(rows) {
  const normalized = rows.map((row) => {
    if (!["table", "index", "trigger"].includes(row.type)) {
      throw new Error("restored_schema_object_invalid");
    }
    for (const field of ["name", "table_name", "sql"]) {
      if (typeof row[field] !== "string" || row[field].length < 1) {
        throw new Error("restored_schema_object_invalid");
      }
    }
    return `${row.type}:${row.name}:${row.table_name}:${normalizeSchemaSql(row.sql)}`;
  }).sort();
  if (new Set(normalized.map((entry) => entry.slice(0, entry.indexOf(":", entry.indexOf(":") + 1)))).size !== normalized.length) {
    throw new Error("restored_schema_object_duplicate");
  }
  return createHash("sha256").update(normalized.join("\n")).digest("hex");
}

function schemaRowsFromGeneratedSnapshot(snapshotSql) {
  const withoutComments = snapshotSql.replace(/^--.*$/gm, "").trim();
  const statements = withoutComments
    .split(/;\s*(?=CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS|$)/i)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
  return statements.map((sql) => {
    const header = /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i.exec(sql);
    if (header === null) {
      throw new Error("canonical_schema_snapshot_invalid");
    }
    const type = header[1].toLowerCase();
    const name = header[2].replaceAll('"', "");
    const ownerMatch = type === "table" ? name : /\bON\s+([^\s(]+)/i.exec(sql)?.[1];
    const owner = ownerMatch?.replaceAll('"', "");
    if (owner === undefined) {
      throw new Error("canonical_schema_snapshot_invalid");
    }
    return { type, name, table_name: owner, sql };
  });
}

function validateSchemaObjectRows(rows) {
  const actual = new Set(rows.map((row) => `${String(row.type)}:${String(row.name)}:${String(row.table_name)}`));
  const expected = expectedSchemaObjects();
  const missing = expected.filter((item) => !actual.has(`${item.type}:${item.name}:${item.table_name}`));
  if (missing.length > 0) {
    throw new Error(`restored_schema_objects_missing:${missing.map((item) => `${item.type}:${item.name}`).join(",")}`);
  }
  if (rows.length !== expected.length) {
    throw new Error("restored_schema_object_count_mismatch");
  }
  const digest = schemaSignature(rows);
  if (digest !== EXPECTED_SCHEMA_SIGNATURE_SHA256) {
    throw new Error("restored_schema_signature_mismatch");
  }
  return {
    verified: true,
    algorithm: "sha256",
    digest,
    table_count: ALL_RESTORE_TABLES.length,
    named_index_count: Object.keys(EXPECTED_INDEXES).length,
    trigger_count: Object.keys(EXPECTED_TRIGGERS).length,
  };
}

function observedSchemaIdentityFromRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1) {
    throw new Error("snapshot_schema_objects_missing");
  }
  const digest = schemaSignature(rows);
  const count = (type) => rows.filter((row) => row.type === type).length;
  return {
    recorded: true,
    algorithm: "sha256",
    digest,
    table_count: count("table"),
    named_index_count: count("index"),
    trigger_count: count("trigger"),
  };
}

function countSql(tables = REQUIRED_TABLES) {
  return tables
    .map((table) => `SELECT '${table}' AS table_name, COUNT(*) AS row_count FROM ${table}`)
    .join(" UNION ALL ");
}

function countMapFromRows(rows) {
  const counts = {};
  for (const row of rows) {
    const tableName = row.table_name;
    const rowCount = Number(row.row_count);
    if (typeof tableName !== "string" || !Number.isFinite(rowCount)) {
      throw new Error(`unexpected count row: ${JSON.stringify(row)}`);
    }
    counts[tableName] = rowCount;
  }
  return counts;
}

function d1Json(database, config, mode, command, label) {
  const output = runWrangler([
    "d1",
    "execute",
    database,
    "--command",
    command,
    "--json",
    modeArg(mode),
    ...configArgs(config),
  ], label);
  return firstResults(parseWranglerJson(output.stdout));
}

function existingTables(database, config, mode, label) {
  return d1Json(database, config, mode, tableListSql(), label).map((row) => String(row.name));
}

function existingUserTables(database, config, mode, label) {
  return d1Json(database, config, mode, userTableListSql(), label).map((row) => String(row.name));
}

function restoredSchemaIdentity(database, config, mode, label) {
  return validateSchemaObjectRows(d1Json(database, config, mode, schemaObjectSql(), label));
}

function tableCounts(database, config, mode, tables, label) {
  return countMapFromRows(d1Json(database, config, mode, countSql(tables), label));
}

function canonicalMigrationNames(migrationsDirectory = DEFAULT_BACKEND_MIGRATIONS_DIR) {
  let entries;
  try {
    entries = readdirSync(migrationsDirectory, { withFileTypes: true });
  } catch {
    throw new Error("canonical_migrations_unreadable");
  }
  if (entries.length < 1 || entries.some((entry) => !entry.isFile() || !/^\d{4}_[a-z0-9_]+\.sql$/.test(entry.name))) {
    throw new Error("canonical_migrations_invalid_inventory");
  }
  const names = entries.map((entry) => entry.name).sort();
  for (let index = 0; index < names.length; ++index) {
    const expectedPrefix = String(index + 1).padStart(4, "0");
    if (!names[index].startsWith(`${expectedPrefix}_`)) {
      throw new Error("canonical_migrations_noncontiguous");
    }
  }
  return names;
}

function migrationHistorySql() {
  return "SELECT id, name FROM d1_migrations ORDER BY id";
}

function migrationHistoryFromRows(rows, canonicalNames) {
  if (!Array.isArray(rows)) {
    throw new Error("snapshot_migration_history_invalid");
  }
  if (rows.length > canonicalNames.length) {
    throw new Error("snapshot_migration_history_ahead");
  }
  const names = rows.map((row, index) => {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id !== index + 1 || typeof row.name !== "string") {
      throw new Error("snapshot_migration_history_invalid");
    }
    if (row.name !== canonicalNames[index]) {
      throw new Error("snapshot_migration_history_not_canonical_prefix");
    }
    return row.name;
  });
  return {
    verified: true,
    algorithm: "sha256",
    digest: createHash("sha256").update(names.join("\n")).digest("hex"),
    applied_migration_count: names.length,
    latest_migration: names.at(-1) ?? null,
  };
}

function migrationRows(database, config, mode, label) {
  return d1Json(database, config, mode, migrationHistorySql(), label);
}

function snapshotSchemaRows(database, config, mode, label) {
  return d1Json(database, config, mode, snapshotSchemaObjectSql(), label);
}

function migrateScratchToCurrent(options, deps = {}) {
  const inspectUserTables = deps.existingUserTables ?? existingUserTables;
  const inspectMigrationRows = deps.migrationRows ?? migrationRows;
  const inspectSchemaRows = deps.snapshotSchemaRows ?? snapshotSchemaRows;
  const execute = deps.execute ?? runWrangler;
  const now = deps.now ?? (() => performance.now());
  const canonicalNames = deps.canonicalNames ?? canonicalMigrationNames();
  const userTables = inspectUserTables(
    options.scratchDatabase,
    options.scratchConfig,
    options.mode,
    "snapshot D1 user-table inspection",
  );
  if (!userTables.includes("d1_migrations")) {
    throw new Error("snapshot_migration_history_missing");
  }
  const before = migrationHistoryFromRows(inspectMigrationRows(
    options.scratchDatabase,
    options.scratchConfig,
    options.mode,
    "snapshot D1 migration-history inspection",
  ), canonicalNames);
  const snapshotSchemaIdentity = observedSchemaIdentityFromRows(inspectSchemaRows(
    options.scratchDatabase,
    options.scratchConfig,
    options.mode,
    "snapshot D1 schema-object inspection",
  ));
  const startedAt = now();
  let status = "already_current";
  if (before.applied_migration_count < canonicalNames.length) {
    if (options.scratchConfig === undefined) {
      throw new Error("scratch_config_required_for_migration_upgrade");
    }
    execute([
      "d1",
      "migrations",
      "apply",
      options.scratchDatabase,
      modeArg(options.mode),
      ...configArgs(options.scratchConfig),
    ], "scratch D1 canonical migration upgrade");
    status = "migrated_to_current";
  }
  const elapsedMs = Math.max(0, Math.floor(now() - startedAt));
  const after = migrationHistoryFromRows(inspectMigrationRows(
    options.scratchDatabase,
    options.scratchConfig,
    options.mode,
    "upgraded scratch D1 migration-history inspection",
  ), canonicalNames);
  if (after.applied_migration_count !== canonicalNames.length) {
    throw new Error("scratch_migration_upgrade_incomplete");
  }
  return {
    snapshot_schema_identity: {
      migration_history: before,
      schema_objects: snapshotSchemaIdentity,
    },
    migration_upgrade: {
      status,
      from_migration_count: before.applied_migration_count,
      target_migration_count: canonicalNames.length,
      migrations_applied: after.applied_migration_count - before.applied_migration_count,
      current_migration: after.latest_migration,
      elapsed_ms: elapsedMs,
    },
  };
}

function toNonnegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`unexpected ${label}: ${JSON.stringify(value)}`);
  }
  return number;
}

function entitlementSemanticsSql() {
  return `
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
  SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked_count,
  SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled_count,
  SUM(CASE
    WHEN status = 'active'
      AND assertion_ttl_seconds > 0
      AND (device_hash = '' OR length(device_hash) = 64)
      AND (valid_from IS NULL OR valid_from <= CAST(strftime('%s','now') AS INTEGER))
      AND (valid_until IS NULL OR valid_until > CAST(strftime('%s','now') AS INTEGER))
    THEN 1 ELSE 0
  END) AS active_verifier_candidate_count,
  SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked_verifier_denial_count,
  SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled_verifier_denial_count,
  MIN(revocation_seq) AS min_revocation_seq,
  MAX(revocation_seq) AS max_revocation_seq
FROM entitlements`;
}

function entitlementSemanticsFromRows(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`unexpected entitlement semantic rows: ${JSON.stringify(rows).slice(0, 500)}`);
  }
  const row = rows[0];
  const total = toNonnegativeInteger(row.total ?? 0, "total entitlement count");
  return {
    total,
    status_counts: {
      active: toNonnegativeInteger(row.active_count ?? 0, "active entitlement count"),
      revoked: toNonnegativeInteger(row.revoked_count ?? 0, "revoked entitlement count"),
      disabled: toNonnegativeInteger(row.disabled_count ?? 0, "disabled entitlement count"),
    },
    verifier_candidates: {
      active_accept: toNonnegativeInteger(row.active_verifier_candidate_count ?? 0, "active verifier candidate count"),
      revoked_deny: toNonnegativeInteger(row.revoked_verifier_denial_count ?? 0, "revoked verifier denial count"),
      disabled_deny: toNonnegativeInteger(row.disabled_verifier_denial_count ?? 0, "disabled verifier denial count"),
    },
    revocation_seq: {
      min: total === 0 ? null : toNonnegativeInteger(row.min_revocation_seq, "minimum revocation sequence"),
      max: total === 0 ? null : toNonnegativeInteger(row.max_revocation_seq, "maximum revocation sequence"),
    },
  };
}

function entitlementSemantics(database, config, mode, label) {
  return entitlementSemanticsFromRows(d1Json(database, config, mode, entitlementSemanticsSql(), label));
}

function compareCounts(sourceCounts, restoredCounts) {
  const mismatches = [];
  for (const table of REQUIRED_TABLES) {
    if (sourceCounts[table] !== restoredCounts[table]) {
      mismatches.push({ table, source: sourceCounts[table], restored: restoredCounts[table] });
    }
  }
  return mismatches;
}

function compareCountMaps(expectedCounts, actualCounts, tables = Object.keys(expectedCounts)) {
  return tables.flatMap((table) => expectedCounts[table] === actualCounts[table]
    ? []
    : [{ table, expected: expectedCounts[table], actual: actualCounts[table] }]);
}

function liveSourceCountObservation(sourceCounts, restoredCounts) {
  return {
    role: "informational_current_source_not_snapshot_fidelity",
    promotion_blocking: false,
    status: "observed",
    source_counts: sourceCounts,
    differences_from_restored_snapshot: compareCounts(sourceCounts, restoredCounts),
  };
}

function unavailableLiveSourceCountObservation() {
  return {
    role: "informational_current_source_not_snapshot_fidelity",
    promotion_blocking: false,
    status: "unavailable",
    source_counts: null,
    differences_from_restored_snapshot: null,
  };
}

function requiredStatusMismatches(semantics, requiredStatuses) {
  return requiredStatuses.flatMap((status) => {
    if (status === "active" && semantics.verifier_candidates.active_accept < 1) {
      return [{ status, reason: "no restored active entitlement is currently eligible for verifier acceptance" }];
    }
    if (status === "revoked" && semantics.verifier_candidates.revoked_deny < 1) {
      return [{ status, reason: "no restored revoked entitlement is available for verifier denial" }];
    }
    if (status === "disabled" && semantics.verifier_candidates.disabled_deny < 1) {
      return [{ status, reason: "no restored disabled entitlement is available for verifier denial" }];
    }
    return [];
  });
}

function manifestFailure(code) {
  throw new Error(code);
}

function readBoundedJsonFile(filePath, maximumBytes = MAX_BACKUP_MANIFEST_BYTES) {
  let descriptor;
  try {
    descriptor = openSync(filePath, "r");
  } catch {
    manifestFailure("backup_manifest_read_failed");
  }
  let bytes;
  try {
    let stats;
    try {
      stats = fstatSync(descriptor);
    } catch {
      manifestFailure("backup_manifest_read_failed");
    }
    if (!stats.isFile() || stats.size < 1) {
      manifestFailure("backup_manifest_invalid_json");
    }
    if (!Number.isSafeInteger(stats.size) || stats.size > maximumBytes) {
      manifestFailure("backup_manifest_too_large");
    }
    bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      let count;
      try {
        count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      } catch {
        manifestFailure("backup_manifest_read_failed");
      }
      if (count === 0) {
        manifestFailure("backup_manifest_read_failed");
      }
      offset += count;
    }
    const extra = Buffer.alloc(1);
    try {
      if (readSync(descriptor, extra, 0, 1, null) !== 0) {
        manifestFailure("backup_manifest_too_large");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "backup_manifest_too_large") {
        throw error;
      }
      manifestFailure("backup_manifest_read_failed");
    }
  } finally {
    closeSync(descriptor);
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    manifestFailure("backup_manifest_invalid_utf8");
  }
  try {
    return JSON.parse(text);
  } catch {
    manifestFailure("backup_manifest_invalid_json");
  }
}

function manifestString(value, field) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_MANIFEST_STRING_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    manifestFailure(`backup_manifest_invalid_${field}`);
  }
  return value;
}

function canonicalManifestTimestamp(value, field) {
  const timestamp = manifestString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    manifestFailure(`backup_manifest_invalid_${field}`);
  }
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || new Date(timestampMs).toISOString() !== timestamp) {
    manifestFailure(`backup_manifest_invalid_${field}`);
  }
  return { timestamp, timestampMs };
}

function manifestContentIntegrity(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    manifestFailure("backup_manifest_invalid_content_integrity");
  }
  if (value.algorithm !== "sha256") {
    manifestFailure("backup_manifest_invalid_integrity_algorithm");
  }
  const digestHex = manifestString(value.digest_hex, "integrity_digest");
  if (!/^[0-9a-f]{64}$/.test(digestHex)) {
    manifestFailure("backup_manifest_invalid_integrity_digest");
  }
  const sizeBytes = Number(value.size_bytes);
  const r2SizeBytes = Number(value.r2_size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    manifestFailure("backup_manifest_invalid_integrity_size");
  }
  if (!Number.isSafeInteger(r2SizeBytes) || r2SizeBytes !== sizeBytes) {
    manifestFailure("backup_manifest_invalid_r2_size");
  }
  const r2Sha256Hex = value.r2_sha256_hex === undefined
    ? undefined
    : manifestString(value.r2_sha256_hex, "r2_sha256");
  if (r2Sha256Hex !== undefined && (!/^[0-9a-f]{64}$/.test(r2Sha256Hex) || r2Sha256Hex !== digestHex)) {
    manifestFailure("backup_manifest_invalid_r2_sha256");
  }
  const integrity = {
    algorithm: "sha256",
    digest_hex: digestHex,
    size_bytes: sizeBytes,
    r2_etag: manifestString(value.r2_etag, "r2_etag"),
    r2_version: manifestString(value.r2_version, "r2_version"),
    r2_size_bytes: r2SizeBytes,
  };
  if (r2Sha256Hex !== undefined) {
    integrity.r2_sha256_hex = r2Sha256Hex;
  }
  return integrity;
}

function manifestSnapshotInventory(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    manifestFailure("backup_manifest_invalid_snapshot_inventory");
  }
  if (value.algorithm !== SNAPSHOT_INVENTORY_ALGORITHM) {
    manifestFailure("backup_manifest_invalid_snapshot_inventory_algorithm");
  }
  if (typeof value.table_counts !== "object" || value.table_counts === null || Array.isArray(value.table_counts)) {
    manifestFailure("backup_manifest_invalid_snapshot_table_counts");
  }
  const inputEntries = Object.entries(value.table_counts);
  if (inputEntries.length < 1 || inputEntries.length > REQUIRED_TABLES.length) {
    manifestFailure("backup_manifest_invalid_snapshot_table_counts");
  }
  const allowed = new Set(REQUIRED_TABLES);
  const normalized = {};
  for (const [table, rawCount] of inputEntries) {
    const count = Number(rawCount);
    if (!allowed.has(table) || !Number.isSafeInteger(count) || count < 0) {
      manifestFailure("backup_manifest_invalid_snapshot_table_counts");
    }
    normalized[table] = count;
  }
  const tableCounts = {};
  for (const table of REQUIRED_TABLES) {
    if (normalized[table] !== undefined) {
      tableCounts[table] = normalized[table];
    }
  }
  return {
    algorithm: SNAPSHOT_INVENTORY_ALGORITHM,
    table_counts: tableCounts,
  };
}

function validateBackupManifest(value, options, nowMs = Date.now()) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    manifestFailure("backup_manifest_invalid_envelope");
  }
  if (!Number.isFinite(nowMs)) {
    throw new Error("restore clock is invalid");
  }
  const manifest = value;
  if (manifest.source !== "cloudflare-d1-export") {
    manifestFailure("backup_manifest_source_mismatch");
  }
  if (manifest.object_key !== options.objectKey) {
    manifestFailure("backup_manifest_object_key_mismatch");
  }
  if (
    manifest.database_id !== options.expectedDatabaseId ||
    manifest.database_name !== options.expectedDatabaseName
  ) {
    manifestFailure("backup_manifest_database_identity_mismatch");
  }
  const bookmark = manifestString(manifest.bookmark, "bookmark");
  const contentIntegrity = manifestContentIntegrity(manifest.content_integrity);
  const snapshotInventory = manifestSnapshotInventory(manifest.snapshot_inventory);
  const snapshot = canonicalManifestTimestamp(manifest.snapshot_requested_at, "snapshot_requested_at");
  const object = canonicalManifestTimestamp(manifest.created_at, "created_at");
  if (snapshot.timestampMs > nowMs + MAX_FUTURE_CLOCK_SKEW_MS || object.timestampMs > nowMs + MAX_FUTURE_CLOCK_SKEW_MS) {
    manifestFailure("backup_manifest_future_dated");
  }
  if (object.timestampMs + MAX_FUTURE_CLOCK_SKEW_MS < snapshot.timestampMs) {
    manifestFailure("backup_manifest_timestamp_order_invalid");
  }
  // RPO begins when D1 was asked to take the snapshot. R2 upload time can be
  // much later and must never make an old snapshot appear fresh.
  const backupAgeMs = Math.max(0, nowMs - snapshot.timestampMs);
  if (backupAgeMs > options.maxBackupAgeSeconds * 1000) {
    manifestFailure("backup_manifest_stale");
  }
  const backupAgeSeconds = Math.floor(backupAgeMs / 1000);
  return {
    identity: {
      source: "cloudflare-d1-export",
      database_id: options.expectedDatabaseId,
      database_name: options.expectedDatabaseName,
      bookmark,
      object_key: options.objectKey,
      manifest_key: `${options.objectKey}${BACKUP_MANIFEST_SUFFIX}`,
      snapshot_requested_at: snapshot.timestamp,
      created_at: object.timestamp,
    },
    backupAgeSeconds,
    contentIntegrity,
    snapshotInventory,
  };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    for await (const chunk of createReadStream(filePath, { highWaterMark: SQL_HASH_CHUNK_BYTES })) {
      if (!Number.isSafeInteger(sizeBytes + chunk.byteLength)) {
        throw new Error("backup_sql_integrity_size_overflow");
      }
      hash.update(chunk);
      sizeBytes += chunk.byteLength;
    }
  } catch (error) {
    if (error instanceof Error && error.message === "backup_sql_integrity_size_overflow") {
      throw error;
    }
    throw new Error("backup_sql_integrity_read_failed");
  }
  return { digestHex: hash.digest("hex"), sizeBytes };
}

async function verifySqlFileContentIntegrity(filePath, expected) {
  const actual = await sha256File(filePath);
  if (actual.sizeBytes !== expected.size_bytes) {
    throw new Error("backup_sql_integrity_size_mismatch");
  }
  if (actual.digestHex !== expected.digest_hex) {
    throw new Error("backup_sql_integrity_digest_mismatch");
  }
  return {
    verified: true,
    algorithm: "sha256",
    digest_hex: actual.digestHex,
    size_bytes: actual.sizeBytes,
    r2_etag: expected.r2_etag,
    r2_version: expected.r2_version,
    r2_size_bytes: expected.r2_size_bytes,
    ...(expected.r2_sha256_hex === undefined ? {} : { r2_sha256_hex: expected.r2_sha256_hex }),
  };
}

function downloadR2Object(options, objectKey, destination, label, execute = runWrangler) {
  execute([
    "r2",
    "object",
    "get",
    `${options.bucket}/${objectKey}`,
    "--file",
    destination,
    modeArg(options.mode),
    ...configArgs(options.r2Config),
  ], label);
  return destination;
}

async function prepareBackupSource(options, tempDir, deps = {}) {
  if (options.sqlFile !== undefined) {
    return {
      sqlFile: options.sqlFile,
      manifestIdentity: null,
      backupAgeSeconds: null,
      contentIntegrity: null,
      snapshotInventory: null,
    };
  }
  const execute = deps.execute ?? runWrangler;
  const now = deps.now ?? (() => deps.nowMs ?? Date.now());
  const manifestKey = `${options.objectKey}${BACKUP_MANIFEST_SUFFIX}`;
  const fileName = basename(options.objectKey).replace(/[^A-Za-z0-9._-]/g, "_") || "restored.sql";
  const nonce = randomUUID().slice(0, 8);
  const manifestFile = join(tempDir, `${nonce}-${fileName}${BACKUP_MANIFEST_SUFFIX}`);
  downloadR2Object(options, manifestKey, manifestFile, "R2 backup manifest download", execute);
  const manifest = readBoundedJsonFile(manifestFile);
  const initiallyValidated = validateBackupManifest(manifest, options, now());
  const sqlFile = join(tempDir, `${nonce}-${fileName}`);
  downloadR2Object(options, options.objectKey, sqlFile, "R2 backup download", execute);
  const contentIntegrity = await verifySqlFileContentIntegrity(sqlFile, initiallyValidated.contentIntegrity);
  const validated = validateBackupManifest(manifest, options, now());
  return {
    sqlFile,
    manifestIdentity: validated.identity,
    backupAgeSeconds: validated.backupAgeSeconds,
    contentIntegrity,
    snapshotInventory: validated.snapshotInventory,
  };
}

function restoreToScratch(options, sqlFile, execute = runWrangler, now = () => performance.now()) {
  const startedAt = now();
  execute([
    "d1",
    "execute",
    options.scratchDatabase,
    "--file",
    sqlFile,
    "--yes",
    "--json",
    modeArg(options.mode),
    ...configArgs(options.scratchConfig),
  ], "scratch D1 restore");
  return Math.max(0, Math.floor(now() - startedAt));
}

function restoreEvidence(backupSource, elapsedMs) {
  return {
    manifest_identity: backupSource.manifestIdentity,
    backup_age_seconds: backupSource.backupAgeSeconds,
    content_integrity: backupSource.contentIntegrity,
    snapshot_inventory: backupSource.snapshotInventory,
    authenticity_verified: false,
    elapsed_ms: elapsedMs,
  };
}

function assertScratchSafe(options, deps = {}) {
  const inspect = deps.existingUserTables ?? existingUserTables;
  const tables = inspect(
    options.scratchDatabase,
    options.scratchConfig,
    options.mode,
    "scratch D1 user-table inspection",
  );
  // A restore drill owns a unique empty scratch database. Even an unrelated
  // empty user table is evidence that the target was reused or misidentified.
  if (tables.length > 0) {
    throw new Error(`scratch_database_not_empty:user_table_count=${tables.length}`);
  }
  return { existingUserTables: [] };
}

function validateSnapshotFidelity(options, backupSource, deps = {}) {
  if (backupSource.snapshotInventory === null) {
    return {
      verified: false,
      status: "local_sql_source_not_manifest_bound",
      algorithm: null,
      table_counts: null,
    };
  }
  const inspectUserTables = deps.existingUserTables ?? existingUserTables;
  const inspectCounts = deps.tableCounts ?? tableCounts;
  const tables = inspectUserTables(
    options.scratchDatabase,
    options.scratchConfig,
    options.mode,
    "snapshot D1 inventory-table inspection",
  );
  const countedTablesPresent = REQUIRED_TABLES.filter((table) => tables.includes(table));
  const expectedCounts = backupSource.snapshotInventory.table_counts;
  const expectedTables = Object.keys(expectedCounts);
  if (
    expectedTables.length !== countedTablesPresent.length ||
    expectedTables.some((table, index) => table !== countedTablesPresent[index])
  ) {
    throw new Error("snapshot_inventory_table_set_mismatch");
  }
  const actualCounts = inspectCounts(
    options.scratchDatabase,
    options.scratchConfig,
    options.mode,
    expectedTables,
    "snapshot D1 manifest-pinned count inspection",
  );
  const mismatches = compareCountMaps(expectedCounts, actualCounts, expectedTables);
  if (mismatches.length > 0) {
    throw new Error(`snapshot_row_count_mismatch:table_count=${mismatches.length}`);
  }
  return {
    verified: true,
    status: "manifest_pinned_counts_match_imported_snapshot",
    algorithm: backupSource.snapshotInventory.algorithm,
    table_counts: actualCounts,
  };
}

function validateRestoredTables(options) {
  const tables = existingTables(
    options.scratchDatabase,
    options.scratchConfig,
    options.mode,
    "restored D1 table inspection",
  );
  // Presence is asserted over the FULL set (required + presence-only): a restore missing any back-office
  // table means the migrations did not fully apply.
  const missing = ALL_RESTORE_TABLES.filter((table) => !tables.includes(table));
  if (missing.length > 0) {
    throw new Error(`restored scratch database is missing required tables: ${missing.join(", ")}`);
  }
  const schemaIdentity = restoredSchemaIdentity(
    options.scratchDatabase,
    options.scratchConfig,
    options.mode,
    "restored D1 schema-object inspection",
  );
  return {
    schemaIdentity,
    requiredCounts: tableCounts(
      options.scratchDatabase,
      options.scratchConfig,
      options.mode,
      REQUIRED_TABLES,
      "restored D1 required-count inspection",
    ),
    presenceOnlyCounts: tableCounts(
      options.scratchDatabase,
      options.scratchConfig,
      options.mode,
      PRESENCE_ONLY_TABLES,
      "restored D1 presence-only-count inspection",
    ),
  };
}

async function main() {
  const options = validateOptions(parseArgs(process.argv));
  const tempDir = mkdtempSync(join(tmpdir(), "licensecc-d1-restore-drill-"));
  try {
    const scratchBefore = assertScratchSafe(options);
    const backupSource = await prepareBackupSource(options, tempDir);
    const restoreElapsedMs = restoreToScratch(options, backupSource.sqlFile);
    const snapshotFidelity = validateSnapshotFidelity(options, backupSource);
    const { snapshot_schema_identity: snapshotSchemaIdentity, migration_upgrade: migrationUpgrade } = migrateScratchToCurrent(options);
    const { schemaIdentity, requiredCounts: restoredCounts, presenceOnlyCounts } = validateRestoredTables(options);
    const restoredEntitlementSemantics = entitlementSemantics(
      options.scratchDatabase,
      options.scratchConfig,
      options.mode,
      "restored entitlement semantic inspection",
    );
    const requiredStatusFailures = requiredStatusMismatches(
      restoredEntitlementSemantics,
      options.requiredRestoredStatuses,
    );
    let liveSourceObservation = null;
    if (options.sourceDatabase !== undefined) {
      try {
        const sourceCounts = tableCounts(
          options.sourceDatabase,
          options.sourceConfig,
          options.mode,
          REQUIRED_TABLES,
          "source D1 count inspection",
        );
        liveSourceObservation = liveSourceCountObservation(sourceCounts, restoredCounts);
      } catch {
        // This query is convenience telemetry only. Snapshot fidelity is bound
        // to manifest counts before migration, so a live source that advanced
        // or is temporarily unreadable must not invalidate a sound restore.
        liveSourceObservation = unavailableLiveSourceCountObservation();
      }
    }

    const summary = {
      ok: requiredStatusFailures.length === 0,
      mode: options.mode,
      scratch_database: options.scratchDatabase,
      source_database: options.sourceDatabase ?? null,
      backup_source: options.sqlFile === undefined ? { bucket: options.bucket, object_key: options.objectKey } : { sql_file: options.sqlFile },
      ...restoreEvidence(backupSource, restoreElapsedMs),
      scratch_before: scratchBefore,
      snapshot_fidelity: snapshotFidelity,
      snapshot_schema_identity: snapshotSchemaIdentity,
      migration_upgrade: migrationUpgrade,
      restored_schema_identity: schemaIdentity,
      restored_counts: restoredCounts,
      restored_presence_only_counts: presenceOnlyCounts,
      // Names only — these tables were counted (content-free), never their secret/PII columns read.
      sensitive_tables_present: SENSITIVE_TABLES.filter((table) => table in restoredCounts || table in presenceOnlyCounts),
      live_source_observation: liveSourceObservation,
      restored_entitlement_semantics: restoredEntitlementSemantics,
      required_restored_statuses: options.requiredRestoredStatuses,
      semantic_mismatches: requiredStatusFailures,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export {
  BACKUP_MANIFEST_SUFFIX,
  MAX_BACKUP_MANIFEST_BYTES,
  MAX_FUTURE_CLOCK_SKEW_MS,
  SQL_HASH_CHUNK_BYTES,
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
  validateOptions,
  validateSnapshotFidelity,
  validateSchemaObjectRows,
  verifySqlFileContentIntegrity,
  userTableListSql,
  snapshotSchemaObjectSql,
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
