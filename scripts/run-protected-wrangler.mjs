import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseDeploymentList } from "./rollback-workers.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const maxOutputBytes = 2 * 1024 * 1024;
const configs = Object.freeze({
  backend: "services/cloudflare-licensing-backend/wrangler.toml",
  admin: "services/cloudflare-license-admin/wrangler.jsonc",
  portal: "services/cloudflare-customer-portal/wrangler.jsonc",
  backup: "services/cloudflare-d1-backup/wrangler.jsonc",
});
const operations = new Set(["dry-run", "deploy", "migrate", "deployments"]);

export function parseProtectedWranglerArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv[0] !== "--operation" || argv[2] !== "--worker") {
    throw new Error("usage: node scripts/run-protected-wrangler.mjs --operation dry-run|deploy|migrate|deployments --worker backend|admin|portal|backup");
  }
  const operation = argv[1];
  const worker = argv[3];
  if (!operations.has(operation) || !Object.hasOwn(configs, worker) || (operation === "migrate" && worker !== "backend")) {
    throw new Error("protected Wrangler operation is invalid");
  }
  return Object.freeze({ operation, worker });
}

function commandArguments(request) {
  const config = configs[request.worker];
  switch (request.operation) {
    case "dry-run": return ["--no-install", "wrangler", "deploy", "--dry-run", "--config", config];
    case "deploy": return ["--no-install", "wrangler", "deploy", "--strict", "--config", config];
    case "migrate": return ["--no-install", "wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", config];
    case "deployments": return ["--no-install", "wrangler", "deployments", "list", "--json", "--config", config];
    default: throw new Error("protected Wrangler operation is invalid");
  }
}

async function defaultRunCommand(command, args, options) {
  const result = await execFile(command, args, options);
  return { stdout: result.stdout, exitCode: 0 };
}

export async function runProtectedWrangler(request, { runCommand = defaultRunCommand } = {}) {
  const args = commandArguments(request);
  let result;
  try {
    result = await runCommand("npx", args, {
      cwd: repositoryRoot,
      env: { ...process.env, WRANGLER_LOG: "error", WRANGLER_WRITE_LOGS: "false" },
      encoding: "utf8",
      maxBuffer: maxOutputBytes,
      timeout: 10 * 60 * 1000,
      killSignal: "SIGTERM",
      windowsHide: true,
    });
  } catch {
    throw new Error("protected Wrangler command failed");
  }
  if (!result || result.exitCode !== 0 || typeof result.stdout !== "string") throw new Error("protected Wrangler command failed");
  if (request.operation === "deployments") {
    return Object.freeze({ schema_version: 1, worker: request.worker, deployment: parseDeploymentList(result.stdout, request.worker) });
  }
  return Object.freeze({ schema_version: 1, worker: request.worker, operation: request.operation, status: "succeeded" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const request = parseProtectedWranglerArguments(process.argv.slice(2));
    console.log(JSON.stringify(await runProtectedWrangler(request)));
  } catch {
    console.error("Protected Wrangler operation failed; raw command output was suppressed.");
    process.exitCode = 1;
  }
}
