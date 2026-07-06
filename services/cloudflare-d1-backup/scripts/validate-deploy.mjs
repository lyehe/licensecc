#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_D1_SECRET = "D1_REST_API_TOKEN";
const OPTIONAL_TRIGGER_SECRET = "BACKUP_TRIGGER_TOKEN";

function usage() {
  return `usage:
  node scripts/validate-deploy.mjs --url <backup-worker-url> --worker-name <worker-name> [--workflow-name <workflow-name>] [--require-d1-rest-token] [--require-trigger-token] [--json]

Validates a deployed backup Worker without printing secret values. The check
fetches /health, verifies unauthenticated /backup/run fails closed, lists
Worker secret names through Wrangler, and confirms the Workflow is registered.
`;
}

function truthy(value) {
  return value === true || value === "" || /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function configValue(value) {
  if (value === undefined || value === true || value === "" || String(value).toLowerCase() === "true") {
    return undefined;
  }
  return value;
}

function parseArgs(argv, env = process.env) {
  const options = {
    json: truthy(env.npm_config_json),
    requireD1RestToken: truthy(env.npm_config_require_d1_rest_token),
    requireTriggerToken: truthy(env.npm_config_require_trigger_token),
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--require-d1-rest-token") {
      options.requireD1RestToken = true;
      continue;
    }
    if (arg === "--require-trigger-token") {
      options.requireTriggerToken = true;
      continue;
    }
    if (arg === "--url" || arg === "--worker-name" || arg === "--workflow-name") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      options[key] = value;
      i += 1;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (options.help === true) {
    return options;
  }
  options.url ??= configValue(env.npm_config_url) ?? positional[0];
  options.workerName ??= configValue(env.npm_config_worker_name) ?? positional[1];
  options.workflowName ??= configValue(env.npm_config_workflow_name) ?? positional[2];
  if (positional.length > 3) {
    throw new Error(`unexpected positional argument: ${positional[3]}`);
  }
  if (typeof options.url !== "string" || options.url.trim() === "") {
    throw new Error("--url is required");
  }
  if (typeof options.workerName !== "string" || options.workerName.trim() === "") {
    throw new Error("--worker-name is required");
  }
  options.url = options.url.replace(/\/+$/, "");
  options.workerName = options.workerName.trim();
  options.workflowName = typeof options.workflowName === "string" && options.workflowName.trim() !== ""
    ? options.workflowName.trim()
    : options.workerName;
  return options;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: process.platform === "win32", ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function parseJsonBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseSecretList(text) {
  const parsed = parseJsonBody(text);
  if (!Array.isArray(parsed)) {
    throw new Error("wrangler secret list did not return a JSON array");
  }
  return parsed
    .map((item) => item?.name)
    .filter((name) => typeof name === "string");
}

function secretPresence(names) {
  return {
    [REQUIRED_D1_SECRET]: names.includes(REQUIRED_D1_SECRET),
    [OPTIONAL_TRIGGER_SECRET]: names.includes(OPTIONAL_TRIGGER_SECRET),
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  return { status: response.status, body: parseJsonBody(text), raw: text };
}

function isHealthReady(result) {
  return result.status === 200 && result.body?.ok === true && result.body?.code === "backup_ready";
}

function isManualTriggerFailClosed(result) {
  return (
    (result.status === 401 && result.body?.code === "backup_trigger_not_configured") ||
    (result.status === 403 && result.body?.code === "invalid_backup_trigger_token")
  );
}

async function validateDeployment(options, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const run = deps.runCommand ?? runCommand;
  const blocking = [];

  const health = await readJsonResponse(await fetchImpl(`${options.url}/health`));
  if (!isHealthReady(health)) {
    blocking.push("backup health endpoint did not return backup_ready");
  }

  const manualTrigger = await readJsonResponse(await fetchImpl(`${options.url}/backup/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "deploy-validation" }),
  }));
  if (!isManualTriggerFailClosed(manualTrigger)) {
    blocking.push("unauthenticated manual backup trigger did not fail closed");
  }

  const secretListCommand = ["wrangler", "secret", "list", "--name", options.workerName];
  const secretList = await run("npx", secretListCommand);
  let secrets = {};
  if (secretList.status === 0) {
    try {
      secrets = secretPresence(parseSecretList(secretList.stdout));
    } catch (error) {
      blocking.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    blocking.push("wrangler secret list failed");
  }
  if (options.requireD1RestToken && secrets[REQUIRED_D1_SECRET] !== true) {
    blocking.push(`${REQUIRED_D1_SECRET} secret is required but not configured`);
  }
  if (options.requireTriggerToken && secrets[OPTIONAL_TRIGGER_SECRET] !== true) {
    blocking.push(`${OPTIONAL_TRIGGER_SECRET} secret is required but not configured`);
  }

  const workflowCommand = ["wrangler", "workflows", "describe", options.workflowName];
  const workflow = await run("npx", workflowCommand);
  if (workflow.status !== 0) {
    blocking.push("wrangler workflows describe failed");
  }

  return {
    ok: blocking.length === 0,
    blocking,
    health: {
      ok: isHealthReady(health),
      status: health.status,
      code: health.body?.code ?? null,
      database_name: health.body?.database_name ?? null,
      backup_prefix: health.body?.backup_prefix ?? null,
      retention_days: health.body?.retention_days ?? null,
    },
    manual_trigger_unauthenticated: {
      ok: isManualTriggerFailClosed(manualTrigger),
      status: manualTrigger.status,
      code: manualTrigger.body?.code ?? null,
    },
    secrets,
    commands: {
      secret_list: {
        command: "npx wrangler secret list --name <worker-name>",
        status: secretList.status,
      },
      workflow_describe: {
        command: "npx wrangler workflows describe <workflow-name>",
        status: workflow.status,
      },
    },
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(2);
  }
  if (options.help === true) {
    console.log(usage());
    return;
  }
  const result = await validateDeployment(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.ok ? "backup deployment validation ok" : "backup deployment validation failed");
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.ok) {
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export {
  OPTIONAL_TRIGGER_SECRET,
  REQUIRED_D1_SECRET,
  isHealthReady,
  isManualTriggerFailClosed,
  parseArgs,
  parseSecretList,
  secretPresence,
  validateDeployment,
};
