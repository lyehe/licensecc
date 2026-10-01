import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DATABASE = "licensecc-online-verifier";
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const NAME = /^[A-Za-z0-9_.:-]+$/;
const STATUS = new Set(["active", "revoked", "disabled"]);

function usage() {
  console.error(`usage:
  node scripts/entitlement.mjs upsert --fingerprint <64-hex> --actor <operator> --customer-id <text> --license-id <text> [--project DEFAULT] [--feature DEFAULT] [--status active] [--valid-from <epoch>] [--valid-until <epoch>] [--reason <text>] [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]
  node scripts/entitlement.mjs revoke --fingerprint <64-hex> --actor <operator> --reason <text> [--project DEFAULT] [--feature DEFAULT] [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]
  node scripts/entitlement.mjs disable --fingerprint <64-hex> --actor <operator> --reason <text> [--project DEFAULT] [--feature DEFAULT] [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]
  node scripts/entitlement.mjs reenable --fingerprint <64-hex> --actor <operator> [--reason <text>] [--project DEFAULT] [--feature DEFAULT] [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]
  node scripts/entitlement.mjs get --fingerprint <64-hex> [--project DEFAULT] [--feature DEFAULT] [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]
  node scripts/entitlement.mjs list [--project DEFAULT] [--feature DEFAULT] [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]

notes:
  revoked entitlements are terminal: no command makes a revoked row active again, and
  upsert/disable/reenable refuse it. Every upsert is a protected grant:
  --customer-id must name an existing active customer and --license-id is required, and
  neither is cleared or reassigned on a later conflict. A refused mutation changes 0 rows,
  writes no audit event, and exits 3 on --remote. An option the command does not list is
  refused. The CLI bypasses Cloudflare Access and stamps actor_type='cli', source='cli'.`);
  process.exit(2);
}

// The options each command reads, plus the connection options every command accepts. Anything
// else is refused rather than silently dropped, so a removed flag (a protected grant carries no
// device hash) or an option meant for another command fails loudly.
const CONNECTION_OPTIONS = ["database", "config", "remote", "local"];
const TRANSITION_OPTIONS = ["fingerprint", "actor", "reason", "project", "feature"];
const COMMAND_OPTIONS = {
  upsert: ["fingerprint", "actor", "customer-id", "license-id", "project", "feature", "status", "valid-from", "valid-until", "reason"],
  revoke: TRANSITION_OPTIONS,
  disable: TRANSITION_OPTIONS,
  reenable: TRANSITION_OPTIONS,
  get: ["fingerprint", "project", "feature"],
  list: ["project", "feature"],
};

function refuseUnknownOption(command, option) {
  const known = COMMAND_OPTIONS[command];
  if (known !== undefined && !known.includes(option) && !CONNECTION_OPTIONS.includes(option)) {
    throw new Error(`unknown option --${option} for ${command}`);
  }
}

function refuseUnknownOptions(command, options) {
  for (const option of Object.keys(options)) {
    refuseUnknownOption(command, option);
  }
}

function parseArgs(argv) {
  const command = argv[2];
  if (!command) {
    usage();
  }
  const options = {};
  for (let i = 3; i < argv.length; ++i) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      usage();
    }
    const key = arg.slice(2);
    // Refuse an unknown option before reading a value for it, so a removed flag fails as
    // unknown wherever it appears instead of consuming the next argument.
    refuseUnknownOption(command, key);
    if (key === "remote" || key === "local") {
      options[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) {
      usage();
    }
    options[key] = value;
  }
  return { command, options };
}

function validatedName(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !NAME.test(value)) {
    throw new Error(`${label} must be 1-${maxLength} characters using letters, digits, _, ., :, or -`);
  }
  return value;
}

function validatedHex(value, label, required = true) {
  if (!required && (value === undefined || value === "")) {
    return "";
  }
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new Error(`${label} must be exactly 64 hex characters`);
  }
  return value.toLowerCase();
}

function validatedOptionalInt(value, label, min, max) {
  if (value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  }
  return parsed;
}

function validatedText(value, label, maxLength, required = false) {
  if (value === undefined || value === "") {
    if (required) {
      throw new Error(`${label} is required`);
    }
    return "";
  }
  if (typeof value !== "string" || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be at most ${maxLength} characters without control line breaks`);
  }
  return value;
}

function sqlNullableInt(value) {
  return value === null ? "NULL" : String(value);
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function baseFields(options) {
  return {
    project: validatedName(options.project ?? "DEFAULT", "project", 127),
    feature: validatedName(options.feature ?? "DEFAULT", "feature", 15),
    fingerprint: validatedHex(options.fingerprint, "fingerprint"),
  };
}

function mutationContext(options, reasonRequired = false) {
  return {
    actor: validatedText(options.actor, "actor", 128, true),
    reason: validatedText(options.reason, "reason", 1000, reasonRequired),
  };
}

function eventSqlFromCurrent(fields, eventType, status, actor, reason = "", guard = "") {
  return `INSERT INTO entitlement_events (project, feature, license_fingerprint, event_type, status, revocation_seq, detail, actor, actor_type, source, request_id, reason, created_at) SELECT project, feature, license_fingerprint, ${sqlString(eventType)}, status, revocation_seq, ${sqlString(reason)}, ${sqlString(actor)}, 'cli', 'cli', 'cli-' || lower(hex(randomblob(8))), ${sqlString(reason)}, unixepoch() FROM entitlements WHERE project = ${sqlString(fields.project)} AND feature = ${sqlString(fields.feature)} AND license_fingerprint = ${sqlString(fields.fingerprint)} AND status = ${sqlString(status)}${guard === "" ? "" : ` AND ${guard}`}`;
}

function eventHistoryFloorSql(projectExpr, featureExpr, fingerprintExpr, fallbackExpr) {
  return `COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events WHERE project = ${projectExpr} AND feature = ${featureExpr} AND license_fingerprint = ${fingerprintExpr}), ${fallbackExpr})`;
}

function nextExistingRevocationSeqSql() {
  return `max(revocation_seq, ${eventHistoryFloorSql("entitlements.project", "entitlements.feature", "entitlements.license_fingerprint", "revocation_seq")}) + 1`;
}

function nextInsertedRevocationSeqSql(fields) {
  return `COALESCE((SELECT MAX(revocation_seq) + 1 FROM entitlement_events WHERE project = ${sqlString(fields.project)} AND feature = ${sqlString(fields.feature)} AND license_fingerprint = ${sqlString(fields.fingerprint)}), 1)`;
}

function sqlFor(command, options) {
  refuseUnknownOptions(command, options);
  if (command === "upsert") {
    const fields = baseFields(options);
    const status = options.status ?? "active";
    if (!STATUS.has(status)) {
      throw new Error("status must be active, revoked, or disabled");
    }
    const validFrom = validatedOptionalInt(options["valid-from"], "valid-from", 0, Number.MAX_SAFE_INTEGER);
    const validUntil = validatedOptionalInt(options["valid-until"], "valid-until", 0, Number.MAX_SAFE_INTEGER);
    const customerId = validatedText(options["customer-id"], "customer-id", 128, true);
    const licenseId = validatedText(options["license-id"], "license-id", 128, true);
    const ctx = mutationContext(options);
    if (validFrom !== null && validUntil !== null && validFrom >= validUntil) {
      throw new Error("valid-from must be less than valid-until");
    }
    // Revoked rows are terminal: the ON CONFLICT guard refuses them and no option lifts it. The
    // schema has no foreign key from a grant to its customer, so a mistyped or suspended customer
    // would get a grant no one can use; both statements require an existing active customer, so a
    // refused upsert writes neither the grant nor its audit event.
    const activeCustomer = `EXISTS (SELECT 1 FROM customers WHERE id = ${sqlString(customerId)} AND status = 'active')`;
    return [
      `INSERT INTO entitlements (project, feature, license_fingerprint, status, revocation_seq, valid_from, valid_until, customer_id, license_id, created_at, updated_at) SELECT ${sqlString(fields.project)}, ${sqlString(fields.feature)}, ${sqlString(fields.fingerprint)}, ${sqlString(status)}, ${nextInsertedRevocationSeqSql(fields)}, ${sqlNullableInt(validFrom)}, ${sqlNullableInt(validUntil)}, ${sqlString(customerId)}, ${sqlString(licenseId)}, unixepoch(), unixepoch() WHERE ${activeCustomer} ON CONFLICT(project, feature, license_fingerprint) DO UPDATE SET status = excluded.status, revocation_seq = ${nextExistingRevocationSeqSql()}, valid_from = excluded.valid_from, valid_until = excluded.valid_until, updated_at = unixepoch() WHERE entitlements.status != 'revoked'`,
      eventSqlFromCurrent(fields, "upsert", status, ctx.actor, ctx.reason, activeCustomer),
    ].join(";\n");
  }
  if (command === "revoke" || command === "disable" || command === "reenable") {
    const fields = baseFields(options);
    const status = command === "revoke" ? "revoked" : command === "disable" ? "disabled" : "active";
    const eventType = command === "revoke" ? "revoke" : command === "disable" ? "disable" : "reenable";
    const ctx = mutationContext(options, command !== "reenable");
    const terminalGuard = command === "disable" || command === "reenable" ? " AND status != 'revoked'" : "";
    return [
      `UPDATE entitlements SET status = ${sqlString(status)}, revocation_seq = ${nextExistingRevocationSeqSql()}, updated_at = unixepoch() WHERE project = ${sqlString(fields.project)} AND feature = ${sqlString(fields.feature)} AND license_fingerprint = ${sqlString(fields.fingerprint)}${terminalGuard}`,
      eventSqlFromCurrent(fields, eventType, status, ctx.actor, ctx.reason),
    ].join(";\n");
  }
  if (command === "get") {
    const fields = baseFields(options);
    return `SELECT project, feature, license_fingerprint, status, revocation_seq, valid_from, valid_until, notes, created_at, updated_at FROM entitlements WHERE project = ${sqlString(fields.project)} AND feature = ${sqlString(fields.feature)} AND license_fingerprint = ${sqlString(fields.fingerprint)}`;
  }
  if (command === "list") {
    const project = options.project === undefined ? undefined : validatedName(options.project, "project", 127);
    const feature = options.feature === undefined ? undefined : validatedName(options.feature, "feature", 15);
    const filters = [];
    if (project !== undefined) {
      filters.push(`project = ${sqlString(project)}`);
    }
    if (feature !== undefined) {
      filters.push(`feature = ${sqlString(feature)}`);
    }
    return `SELECT project, feature, license_fingerprint, status, revocation_seq, valid_from, valid_until, notes, created_at, updated_at FROM entitlements${filters.length === 0 ? "" : ` WHERE ${filters.join(" AND ")}`} ORDER BY updated_at DESC LIMIT 100`;
  }
  usage();
}

const MUTATION_COMMANDS = new Set(["upsert", "revoke", "disable", "reenable"]);

// wrangler prepends a non-JSON "agent skills" banner to stdout even in --json mode, so JSON.parse(stdout)
// is unsafe. Extract from the first array/object token instead; return undefined if no JSON is present.
function parseWranglerJson(stdout) {
  if (typeof stdout !== "string") {
    return undefined;
  }
  const start = stdout.search(/[[{]/);
  if (start === -1) {
    return undefined;
  }
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

// Classify a mutation result as "ok" | "noop" | "unavailable" | "ignore". A guarded mutation that matches
// zero rows (e.g. a terminal revoked row) is otherwise silent; the --remote --file (import) result reports
// rows_written so a 0-row mutation is detectable. --local strips meta to { duration }, so detection is
// unavailable there. Reads ("ignore") never report a no-op.
function interpretWranglerResult(parsedJson, command) {
  if (!MUTATION_COMMANDS.has(command)) {
    return "ignore";
  }
  const results = Array.isArray(parsedJson) ? parsedJson : parsedJson === undefined ? [] : [parsedJson];
  const withCount = results.find(
    (entry) => entry && typeof entry === "object" && entry.meta && typeof entry.meta.rows_written === "number",
  );
  if (withCount === undefined) {
    return "unavailable";
  }
  return withCount.meta.rows_written === 0 ? "noop" : "ok";
}

// The error for a guarded mutation that changed no rows, and so wrote no audit event: it names
// what refused it. Revocation is permanent, so no notice offers a way to undo one.
function noOpNotice(command, options) {
  const target = `project=${options.project ?? "DEFAULT"} feature=${options.feature ?? "DEFAULT"} fingerprint=${options.fingerprint}`;
  const cause = command === "upsert"
    ? `Either customer ${options["customer-id"]} does not exist or is not active, or the entitlement is revoked, and revocation is permanent.`
    : command === "revoke"
      ? "The entitlement does not exist."
      : "The entitlement is revoked, and revocation is permanent, or it does not exist.";
  return `NO-OP: ${command} on ${target} changed 0 rows and wrote no audit event. ${cause} Check it with "get --fingerprint ${options.fingerprint}".`;
}

function runWrangler(sql, options, command) {
  const require = createRequire(import.meta.url);
  const wranglerBin = require.resolve("wrangler/bin/wrangler.js");
  const database = options.database ?? DEFAULT_DATABASE;
  // Mutations join two statements (entitlement write + audit event) that MUST commit atomically. On remote
  // D1, --command runs statements as sequential auto-commit (non-atomic), but --file uses the D1 import path
  // which is transactional ("the database returns to its original state" on failure); --local runs either as
  // an atomic db.batch(). So route mutations through a temp --file. Reads stay on --command (it returns rows).
  const useFile = MUTATION_COMMANDS.has(command);
  const args = [wranglerBin, "d1", "execute", database, "--json"];
  let tempDir;
  if (useFile) {
    tempDir = mkdtempSync(join(tmpdir(), "lcc-entitlement-"));
    const sqlPath = join(tempDir, "mutation.sql");
    writeFileSync(sqlPath, sql);
    args.push("--file", sqlPath);
  } else {
    args.push("--command", sql);
  }
  if (options.config !== undefined) {
    args.push("--config", options.config);
  }
  args.push(options.remote ? "--remote" : "--local");
  try {
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    if (result.error) {
      console.error(result.error.message);
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
    const signal = interpretWranglerResult(parseWranglerJson(result.stdout), command);
    if (signal === "noop") {
      console.error(noOpNotice(command, options));
      process.exit(3);
    }
    if (signal === "unavailable" && !options.remote) {
      console.error(
        "note: no-op detection is unavailable on --local (wrangler reports no row counts locally). " +
          "Run against --remote, where a 0-row mutation exits 3, or confirm the result with \"get\".",
      );
    }
  } finally {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export { interpretWranglerResult, noOpNotice, sqlFor };

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { command, options } = parseArgs(process.argv);
    runWrangler(sqlFor(command, options), options, command);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
