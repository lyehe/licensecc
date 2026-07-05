// Apply the real D1 migrations to a local SQLite database file.
//
// Usage:
//   node --experimental-sqlite local-host/migrate.mjs [db-path]
//   node --experimental-sqlite local-host/migrate.mjs --reset [db-path]

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyMigrations, openDatabase } from "./db-sqlite.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "..", "migrations");

function usage(exitCode = 2) {
  console.error("usage: node --experimental-sqlite local-host/migrate.mjs [--reset] [db-path]");
  process.exit(exitCode);
}

function parseArgs(argv, env = process.env) {
  const args = argv.slice(2);
  const reset = args.includes("--reset");
  const help = args.includes("--help") || args.includes("-h");
  const positional = args.filter((arg) => arg !== "--reset" && arg !== "--help" && arg !== "-h");
  if (help) usage(0);
  if (positional.length > 1) usage(2);
  return {
    dbPath: positional[0] ?? env.DB_PATH ?? "app.db",
    reset,
  };
}

function main() {
  const options = parseArgs(process.argv);
  const { db, path } = openDatabase(options.dbPath, { reset: options.reset });
  try {
    const result = applyMigrations(db, migrationsDir);
    for (const name of result.skipped) {
      console.log(`skip   ${name} (already applied)`);
    }
    for (const name of result.applied) {
      console.log(`apply  ${name}`);
    }
    console.log(`done: ${result.applied.length} migration(s) applied to ${path}`);
  } finally {
    db.close();
  }
}

export { parseArgs };

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
