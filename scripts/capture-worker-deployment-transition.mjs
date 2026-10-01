import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseDeploymentList } from "./rollback-workers.mjs";

const execFile = promisify(execFileCallback);
const pinnedWranglerEntrypoint = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const maxOutputBytes = 1024 * 1024;
const maxInputBytes = 64 * 1024;
const configs = Object.freeze({
  backend: "services/cloudflare-licensing-backend/wrangler.toml",
  admin: "services/cloudflare-license-admin/wrangler.jsonc",
  portal: "services/cloudflare-customer-portal/wrangler.jsonc",
  backup: "services/cloudflare-d1-backup/wrangler.jsonc",
});

// Parses the sanitized deployment evidence recorded for one Worker before a deploy (the
// pre-deployment input on stdin). It accepts only the exact sanitized shape for one known Worker.
const safeIdentity = /^[A-Za-z0-9_-]{1,128}$/u;
const versionIdentity = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;

export function parseSanitizedDeployment(input, expectedWorker) {
  if (!Object.hasOwn(configs, expectedWorker)) throw new Error("expected Worker identity is invalid");
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("sanitized Worker deployment evidence is malformed");
  }
  const deployment = parsed?.deployment;
  const versions = deployment?.versions;
  if (
    parsed?.schema_version !== 1
    || parsed?.worker !== expectedWorker
    || !safeIdentity.test(deployment?.deployment_id ?? "")
    || typeof deployment?.created_on !== "string"
    || !Array.isArray(versions)
    || versions.length < 1
    || versions.length > 2
    || versions.some((version) => !versionIdentity.test(version?.version_id ?? "") || typeof version?.percentage !== "number" || !Number.isFinite(version.percentage) || version.percentage < 0 || version.percentage > 100)
    || Math.abs(versions.reduce((total, version) => total + version.percentage, 0) - 100) > 0.000001
  ) {
    throw new Error("sanitized Worker deployment evidence has an invalid shape");
  }
  return Object.freeze({
    schema_version: 1,
    worker: expectedWorker,
    deployment: Object.freeze({
      deployment_id: deployment.deployment_id,
      created_on: deployment.created_on,
      versions: Object.freeze(versions.map((version) => Object.freeze({ version_id: version.version_id, percentage: version.percentage }))),
    }),
  });
}

export function parseTransitionArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--worker" || !Object.hasOwn(configs, argv[1])) {
    throw new Error("usage: node scripts/capture-worker-deployment-transition.mjs --worker backend|admin|portal|backup");
  }
  return argv[1];
}

async function defaultRunCommand(command, args) {
  const result = await execFile(command, args, {
    cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
    env: { ...process.env, WRANGLER_LOG: "log", WRANGLER_WRITE_LOGS: "false" },
    encoding: "utf8",
    maxBuffer: maxOutputBytes,
    timeout: 120_000,
    killSignal: "SIGTERM",
    windowsHide: true,
  });
  return { stdout: result.stdout, exitCode: 0 };
}

function transitioned(pre, post) {
  const priorVersions = new Set(pre.deployment.versions.map((version) => version.version_id));
  return post.deployment_id !== pre.deployment.deployment_id
    && post.versions.length === 1
    && post.versions[0].percentage === 100
    && !priorVersions.has(post.versions[0].version_id);
}

export async function captureDeploymentTransition(worker, beforeInput, {
  runCommand = defaultRunCommand,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  attempts = 10,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 30) throw new Error("deployment transition attempts are invalid");
  const pre = parseSanitizedDeployment(beforeInput, worker);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let result;
    try {
      result = await runCommand(process.execPath, [pinnedWranglerEntrypoint, "deployments", "list", "--json", "--config", configs[worker]]);
    } catch {
      throw new Error("Wrangler deployment query failed");
    }
    if (!result || result.exitCode !== 0 || typeof result.stdout !== "string") throw new Error("Wrangler deployment query failed");
    const post = parseDeploymentList(result.stdout, worker);
    if (transitioned(pre, post)) {
      return Object.freeze({ schema_version: 1, worker, deployment: post });
    }
    if (attempt + 1 < attempts) await sleep(2000);
  }
  throw new Error("new sole-active Worker deployment did not become visible within the bounded poll");
}

async function readBoundedStandardInput(stream = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxInputBytes) throw new Error("pre-deployment evidence exceeded the bounded parser limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const worker = parseTransitionArguments(process.argv.slice(2));
    const beforeInput = await readBoundedStandardInput();
    console.log(JSON.stringify(await captureDeploymentTransition(worker, beforeInput)));
  } catch {
    console.error("New Worker deployment identity could not be verified.");
    process.exitCode = 1;
  }
}
