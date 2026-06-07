import { spawn } from "node:child_process";

function usage() {
  console.error(`usage:
  npm run time-travel -- info --database <name> [--timestamp <unix-or-rfc3339>] [--config <wrangler.toml|jsonc>]
  npm run time-travel -- restore --database <name> (--timestamp <unix-or-rfc3339> | --bookmark <bookmark>) --confirm [--config <wrangler.toml|jsonc>]

Restore is destructive and intentionally requires --confirm.`);
  process.exit(2);
}

function parseArgs(argv) {
  if (argv.length < 3) {
    usage();
  }
  const command = argv[2];
  const options = { _: command };
  for (let index = 3; index < argv.length; ++index) {
    const arg = argv[index];
    if (arg === "--confirm") {
      options.confirm = "1";
      continue;
    }
    if (!arg.startsWith("--")) {
      usage();
    }
    const value = argv[++index];
    if (value === undefined) {
      usage();
    }
    options[arg.slice(2)] = value;
  }
  return options;
}

function required(value, label) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} is required`);
  }
  return value;
}

function wranglerArgs(options) {
  const database = required(options.database, "database");
  const args = ["wrangler", "d1", "time-travel"];
  if (options._ === "info") {
    args.push("info", database);
  } else if (options._ === "restore") {
    if (options.confirm !== "1") {
      throw new Error("restore requires --confirm");
    }
    args.push("restore", database);
  } else {
    usage();
  }
  if (typeof options.timestamp === "string") {
    args.push(`--timestamp=${options.timestamp}`);
  }
  if (typeof options.bookmark === "string") {
    args.push(`--bookmark=${options.bookmark}`);
  }
  if (typeof options.config === "string") {
    args.push("--config", options.config);
  }
  if (options._ === "restore" && options.timestamp === undefined && options.bookmark === undefined) {
    throw new Error("restore requires --timestamp or --bookmark");
  }
  return args;
}

const options = parseArgs(process.argv);
const args = wranglerArgs(options);
const child = spawn("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code) => {
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
