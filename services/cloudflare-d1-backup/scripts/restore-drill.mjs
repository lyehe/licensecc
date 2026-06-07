import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REQUIRED_TABLES = ["entitlements", "entitlement_events", "mutation_idempotency"];

function usage(exitCode = 2) {
  console.error(`usage:
  node scripts/restore-drill.mjs --bucket <r2-bucket> --object-key <backup.sql> --scratch-database <scratch-d1> --confirm-scratch [--scratch-config <wrangler config>] [--source-database <source-d1>] [--source-config <wrangler config>] [--r2-config <wrangler config>] [--require-restored-status active|revoked|disabled]... [--remote|--local]
  node scripts/restore-drill.mjs --sql-file <backup.sql> --scratch-database <scratch-d1> --confirm-scratch [--scratch-config <wrangler config>] [--source-database <source-d1>] [--source-config <wrangler config>] [--require-restored-status active|revoked|disabled]... [--remote|--local]

Restores an R2 D1 SQL dump into an explicitly named scratch database and
validates required table counts. It refuses to run without --confirm-scratch.`);
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
    if (["--confirm-scratch", "--allow-nonempty-scratch", "--remote", "--local"].includes(arg)) {
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
    allowNonemptyScratch: options["allow-nonempty-scratch"] === true,
    requiredRestoredStatuses: requiredRestoredStatuses(options["require-restored-status"]),
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
  return require.resolve("wrangler/bin/wrangler.js");
}

function modeArg(mode) {
  return mode === "local" ? "--local" : "--remote";
}

function configArgs(config) {
  return config === undefined ? [] : ["--config", config];
}

function runWrangler(args, label) {
  const result = spawnSync(process.execPath, [wranglerBin(), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
    },
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
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
  throw new Error(`wrangler output did not contain JSON: ${trimmed.slice(0, 500)}`);
}

function firstResults(envelope) {
  if (!Array.isArray(envelope) || envelope.length === 0 || envelope[0].success !== true || !Array.isArray(envelope[0].results)) {
    throw new Error(`unexpected wrangler D1 JSON envelope: ${JSON.stringify(envelope).slice(0, 500)}`);
  }
  return envelope[0].results;
}

function tableListSql() {
  const quoted = REQUIRED_TABLES.map((table) => `'${table}'`).join(", ");
  return `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${quoted}) ORDER BY name`;
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

function tableCounts(database, config, mode, tables, label) {
  return countMapFromRows(d1Json(database, config, mode, countSql(tables), label));
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

function downloadBackup(options, tempDir) {
  if (options.sqlFile !== undefined) {
    return options.sqlFile;
  }
  const fileName = basename(options.objectKey).replace(/[^A-Za-z0-9._-]/g, "_") || "restored.sql";
  const destination = join(tempDir, `${randomUUID().slice(0, 8)}-${fileName}`);
  runWrangler([
    "r2",
    "object",
    "get",
    `${options.bucket}/${options.objectKey}`,
    "--file",
    destination,
    modeArg(options.mode),
    ...configArgs(options.r2Config),
  ], "R2 backup download");
  return destination;
}

function restoreToScratch(options, sqlFile) {
  runWrangler([
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
}

function assertScratchSafe(options) {
  const tables = existingTables(
    options.scratchDatabase,
    options.scratchConfig,
    options.mode,
    "scratch D1 table inspection",
  );
  const requiredAlreadyPresent = REQUIRED_TABLES.filter((table) => tables.includes(table));
  if (requiredAlreadyPresent.length === 0) {
    return { existingTables: [], existingCounts: {} };
  }
  const existingCounts = tableCounts(
    options.scratchDatabase,
    options.scratchConfig,
    options.mode,
    requiredAlreadyPresent,
    "scratch D1 pre-restore count inspection",
  );
  const nonempty = Object.entries(existingCounts).filter(([, count]) => count > 0);
  if (nonempty.length > 0 && !options.allowNonemptyScratch) {
    throw new Error(`scratch database is not empty; refusing restore without --allow-nonempty-scratch: ${JSON.stringify(existingCounts)}`);
  }
  return { existingTables: requiredAlreadyPresent, existingCounts };
}

function validateRestoredTables(options) {
  const tables = existingTables(
    options.scratchDatabase,
    options.scratchConfig,
    options.mode,
    "restored D1 table inspection",
  );
  const missing = REQUIRED_TABLES.filter((table) => !tables.includes(table));
  if (missing.length > 0) {
    throw new Error(`restored scratch database is missing required tables: ${missing.join(", ")}`);
  }
  return tableCounts(
    options.scratchDatabase,
    options.scratchConfig,
    options.mode,
    REQUIRED_TABLES,
    "restored D1 count inspection",
  );
}

async function main() {
  const options = validateOptions(parseArgs(process.argv));
  const tempDir = mkdtempSync(join(tmpdir(), "licensecc-d1-restore-drill-"));
  try {
    const scratchBefore = assertScratchSafe(options);
    const sqlFile = downloadBackup(options, tempDir);
    restoreToScratch(options, sqlFile);
    const restoredCounts = validateRestoredTables(options);
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
    let sourceCounts = null;
    let mismatches = [];
    if (options.sourceDatabase !== undefined) {
      sourceCounts = tableCounts(
        options.sourceDatabase,
        options.sourceConfig,
        options.mode,
        REQUIRED_TABLES,
        "source D1 count inspection",
      );
      mismatches = compareCounts(sourceCounts, restoredCounts);
    }

    const summary = {
      ok: mismatches.length === 0 && requiredStatusFailures.length === 0,
      mode: options.mode,
      scratch_database: options.scratchDatabase,
      source_database: options.sourceDatabase ?? null,
      backup_source: options.sqlFile === undefined ? { bucket: options.bucket, object_key: options.objectKey } : { sql_file: options.sqlFile },
      scratch_before: scratchBefore,
      restored_counts: restoredCounts,
      source_counts: sourceCounts,
      restored_entitlement_semantics: restoredEntitlementSemantics,
      required_restored_statuses: options.requiredRestoredStatuses,
      mismatches,
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
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
