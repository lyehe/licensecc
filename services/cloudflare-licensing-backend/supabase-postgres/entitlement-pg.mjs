// entitlement-pg.mjs
//
// PostgreSQL / Supabase port of the licensing-backend admin CLI (scripts/entitlement.mjs).
// Same command surface, flags, validation, UX, and exit codes -- but it executes against
// Postgres via postgres.js (reusing createPool from db-postgres.mjs) instead of shelling
// out to `wrangler d1 execute`. The SQL itself comes from pgSqlFor() in pg-sql.mjs (a
// faithful, command-for-command mirror of entitlement.mjs's sqlFor()).
//
//   node entitlement-pg.mjs <command> [--flags]      (DATABASE_URL from the environment)
//
// PARITY WITH THE D1 CLI
// ----------------------
//   * Identical command set and flags (see usage() below, copied from entitlement.mjs with
//     the wrangler-only flags --database/--config/--remote/--local removed and replaced by the
//     single Postgres connection from DATABASE_URL).
//   * Identical validation: pgSqlFor() reuses entitlement.mjs's exact validators, so the same
//     inputs throw the same messages. A validation/usage error -> exit 2 (top-level try/catch).
//   * Exit codes:
//       0  success.
//       2  usage / validation error (bad or missing command, bad flag, missing flag value,
//          any thrown validation Error).
//       3  a GUARDED mutation changed 0 rows (e.g. a terminal revoked row, or an unknown
//          device): no audit event was written. Mirrors entitlement.mjs's "NO-OP" exit 3.
//       1  any other runtime failure (DB/connection error) -- fail-closed.
//
// HOW NO-OP DETECTION DIFFERS FROM THE D1 CLI (and why this is BETTER here)
// ------------------------------------------------------------------------
//   entitlement.mjs cannot see row counts on --local and depends on D1 --remote --file
//   reporting meta.rows_written; it exits 3 only when that count is 0 and prints an
//   "unavailable" note on --local. Postgres ALWAYS reports the affected row count
//   (postgres.js: result.count), so this CLI detects a 0-row first/primary mutation
//   deterministically -- there is no "unavailable" branch. The "primary" statement is the
//   first statement of each mutation (the entitlement upsert/UPDATE, or the device
//   INSERT/UPDATE). If it changes 0 rows we treat the whole command as a no-op, exit 3, and
//   the dependent statements (which are themselves guarded and would also affect 0 rows)
//   change nothing -- the same outcome as the D1 guard.
//
// ATOMICITY
// ---------
//   entitlement.mjs routes mutations through `wrangler ... --file` specifically because the
//   two/three joined statements (entitlement/device write + parent bump + audit event) MUST
//   commit atomically. There is no .batch() on the adapter, so we open an explicit
//   transaction (BEGIN/COMMIT, ROLLBACK on error) around the ordered statement list and run
//   each statement on the SAME pooled connection. Reads run as a single statement, no
//   transaction needed.
//
// OUTPUT
// ------
//   Reads (get / list / device-list) print the result rows as JSON (one array) to stdout,
//   mirroring the D1 CLI which streams wrangler's --json result array. Mutations print a
//   small JSON summary { command, rows: <primary row count> } so the operator gets feedback
//   equivalent to wrangler's meta.rows_written.

import process from "node:process";

import { MUTATION_COMMANDS, READ_COMMANDS, pgSqlFor } from "./pg-sql.mjs";

// The Postgres adapter (and its `postgres` dependency) is imported LAZILY -- only once a
// command has parsed and validated and we actually need a connection. This mirrors the spirit
// of entitlement.mjs (validation throws before any execution machinery runs) and means a
// usage/validation error exits 2 even if `postgres` is not yet installed. createPool/closePool
// are resolved here on first use.
async function loadAdapter() {
  return import("./db-postgres.mjs");
}

function usage() {
  console.error(`usage:
  node entitlement-pg.mjs upsert --fingerprint <64-hex> --actor <operator> [--project DEFAULT] [--feature DEFAULT] [--device-hash <64-hex>] [--status active] [--assertion-ttl 300] [--valid-from <epoch>] [--valid-until <epoch>] [--customer-id <text>] [--license-id <text>] [--reason <text>] [--allow-revoked-override]
  node entitlement-pg.mjs revoke --fingerprint <64-hex> --actor <operator> --reason <text> [--project DEFAULT] [--feature DEFAULT]
  node entitlement-pg.mjs disable --fingerprint <64-hex> --actor <operator> --reason <text> [--project DEFAULT] [--feature DEFAULT]
  node entitlement-pg.mjs reenable --fingerprint <64-hex> --actor <operator> [--reason <text>] [--project DEFAULT] [--feature DEFAULT]
  node entitlement-pg.mjs get --fingerprint <64-hex> [--project DEFAULT] [--feature DEFAULT]
  node entitlement-pg.mjs list [--project DEFAULT] [--feature DEFAULT]
  node entitlement-pg.mjs device-upsert --fingerprint <64-hex> --device-key-id sha256:<64-hex> --public-key-spki-der-base64 <base64> --actor <operator> [--status active] [--reason <text>] [--project DEFAULT] [--feature DEFAULT]
  node entitlement-pg.mjs device-disable --fingerprint <64-hex> --device-key-id sha256:<64-hex> --actor <operator> --reason <text> [--project DEFAULT] [--feature DEFAULT]
  node entitlement-pg.mjs device-revoke --fingerprint <64-hex> --device-key-id sha256:<64-hex> --actor <operator> --reason <text> [--project DEFAULT] [--feature DEFAULT]
  node entitlement-pg.mjs device-list --fingerprint <64-hex> [--project DEFAULT] [--feature DEFAULT]

connection:
  DATABASE_URL must be a Postgres/Supabase connection string (e.g.
  postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres).

notes:
  revoked entitlements are terminal: upsert/disable/reenable refuse a revoked row (a refused mutation
  changes 0 rows, writes no audit event, and exits 3). Use
  'upsert --allow-revoked-override --reason <text>' to intentionally reactivate a revoked entitlement;
  it requires --reason and records a distinct 'revoked-override' audit event. This CLI stamps
  actor_type='cli', source='cli'.`);
  process.exit(2);
}

// Same flag parser as entitlement.mjs: first non-"--" token after the command is invalid;
// --remote/--local/--allow-revoked-override are booleans; everything else consumes a value.
// (--remote/--local are accepted-but-ignored for D1-CLI muscle-memory parity; the Postgres
// CLI always targets the single DATABASE_URL connection.)
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
    if (key === "remote" || key === "local" || key === "allow-revoked-override") {
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

// Run an ordered list of {text, params} as ONE atomic transaction on a single connection.
// Returns the affected-row count of the FIRST (primary) statement -- the one whose guard
// decides whether the whole mutation is a no-op (mirrors entitlement.mjs's rows_written).
async function runMutation(pool, statements) {
  return pool.begin(async (sql) => {
    let primaryCount = 0;
    for (let i = 0; i < statements.length; ++i) {
      const { text, params } = statements[i];
      const result = await sql.unsafe(text, params);
      if (i === 0) {
        // postgres.js exposes the affected row count as result.count for INSERT/UPDATE.
        primaryCount = typeof result.count === "number" ? result.count : 0;
      }
    }
    return primaryCount;
  });
}

// Read: run one statement and return its rows as a plain array.
async function runRead(pool, statement) {
  const rows = await pool.unsafe(statement.text, statement.params);
  return Array.from(rows);
}

function noopMessage(command, options) {
  const project = options.project ?? "DEFAULT";
  const feature = options.feature ?? "DEFAULT";
  const target =
    command.startsWith("device-") && options["device-key-id"] !== undefined
      ? `fingerprint=${options.fingerprint} device_key_id=${options["device-key-id"]}`
      : `fingerprint=${options.fingerprint}`;
  const recovery = command.startsWith("device-")
    ? `Confirm the entitlement and device key with "device-list --fingerprint ${options.fingerprint}".`
    : `The entitlement is revoked (terminal) or does not exist. Re-run "upsert --allow-revoked-override --reason <text>" to reactivate a revoked entitlement, or check with "get --fingerprint ${options.fingerprint}".`;
  return (
    `NO-OP: ${command} on project=${project} feature=${feature} ` +
    `${target} changed 0 rows and wrote no audit event. ${recovery}`
  );
}

async function run(command, options) {
  // Build the SQL FIRST. Validation throws here (BEFORE any connection or the `postgres`
  // driver is loaded) -> the caller maps that thrown Error to exit 2, matching entitlement.mjs.
  const built = pgSqlFor(command, options);

  const connectionString = process.env.DATABASE_URL;
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    // Connection misconfiguration is a runtime (not usage) failure -> fail-closed exit 1.
    console.error("DATABASE_URL is required (a Postgres/Supabase connection string).");
    process.exitCode = 1;
    return;
  }

  // From here on, any thrown error is a RUNTIME (DB/connection) failure -> exit 1 (fail-closed),
  // NOT a usage error. We catch DB errors locally so the top-level catch only ever sees the
  // pre-connection validation throw.
  const { createPool, closePool } = await loadAdapter();
  const pool = createPool(connectionString);
  try {
    if (READ_COMMANDS.has(command)) {
      const rows = await runRead(pool, built);
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    if (MUTATION_COMMANDS.has(command)) {
      const rows = await runMutation(pool, built);
      if (rows === 0) {
        // A guarded mutation changed 0 rows (terminal revoked row, or unknown device): no audit
        // event was written. Mirrors entitlement.mjs's NO-OP exit 3.
        console.error(noopMessage(command, options));
        process.exitCode = 3;
        return;
      }
      process.stdout.write(`${JSON.stringify({ command, rows }, null, 2)}\n`);
      return;
    }
    // pgSqlFor already throws on unknown commands; defensively mirror usage() exit 2.
    usage();
  } catch (dbError) {
    console.error(dbError instanceof Error ? dbError.message : String(dbError));
    process.exitCode = 1; // fail-closed on any DB/runtime error
  } finally {
    await closePool();
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  // Mirror entitlement.mjs's entry guard. (Windows backslash paths are normalized so the
  // file:// URL comparison matches; on POSIX the replace is a no-op.)
  (async () => {
    try {
      const { command, options } = parseArgs(process.argv);
      await run(command, options);
    } catch (error) {
      // Only the pre-connection validation throw (from pgSqlFor) reaches here -> exit 2,
      // matching entitlement.mjs's top-level catch. (DB/runtime errors are handled inside run()
      // and set exit 1.)
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    }
  })();
}

export { parseArgs, runMutation, runRead, noopMessage };
