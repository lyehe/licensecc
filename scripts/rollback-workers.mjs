import { execFile as execFileCallback } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const workerDefinitions = Object.freeze({
  backend: Object.freeze({ config: "services/cloudflare-licensing-backend/wrangler.toml" }),
  admin: Object.freeze({ config: "services/cloudflare-license-admin/wrangler.jsonc" }),
  portal: Object.freeze({ config: "services/cloudflare-customer-portal/wrangler.jsonc" }),
  backup: Object.freeze({ config: "services/cloudflare-d1-backup/wrangler.jsonc" }),
});

// Reverse the normal deployment order so dependent surfaces are unwound before
// the backend contract they call. Every target is validated before this order
// is allowed to mutate any deployment.
const rollbackOrder = Object.freeze(["backup", "portal", "admin", "backend"]);
const allowedFlags = new Set([
  "--environment",
  "--workers",
  "--reason",
  "--backend-version",
  "--admin-version",
  "--portal-version",
  "--backup-version",
]);
const versionIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const safeIdentityPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const maxJsonBytes = 1024 * 1024;

export class SafeRollbackError extends Error {
  constructor(code, message, { worker } = {}) {
    super(message);
    this.name = "SafeRollbackError";
    this.code = code;
    this.worker = worker;
  }
}

function fail(code, message, worker) {
  throw new SafeRollbackError(code, message, worker ? { worker } : undefined);
}

function platformPath(value) {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function insideRoot(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== "" && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(pathFromRoot);
}

function asTimestamp(value, code, worker) {
  if (typeof value !== "string" || value.length > 64) fail(code, "Wrangler returned an invalid deployment timestamp.", worker);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(code, "Wrangler returned an invalid deployment timestamp.", worker);
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function safeId(value, code, worker) {
  if (typeof value !== "string" || !safeIdentityPattern.test(value)) fail(code, "Wrangler returned an invalid deployment identity.", worker);
  return value;
}

function strictJson(stdout, code, worker) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") === 0 || Buffer.byteLength(stdout, "utf8") > maxJsonBytes || stdout.includes("\0")) {
    fail(code, "Wrangler returned malformed JSON.", worker);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    fail(code, "Wrangler returned malformed JSON.", worker);
  }
}

function parseVersionView(stdout, expectedVersionId, worker) {
  const parsed = strictJson(stdout, "MALFORMED_VERSION_JSON", worker);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.id !== expectedVersionId || !parsed.metadata || typeof parsed.metadata !== "object" || Array.isArray(parsed.metadata)) {
    fail("INVALID_VERSION_RESPONSE", "Wrangler did not validate the requested Worker version.", worker);
  }
  const created = asTimestamp(parsed.metadata.created_on, "INVALID_VERSION_RESPONSE", worker);
  return Object.freeze({ version_id: expectedVersionId, created_on: created.iso });
}

export function parseDeploymentList(stdout, worker) {
  const parsed = strictJson(stdout, "MALFORMED_DEPLOYMENT_JSON", worker);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 100) {
    fail("INVALID_DEPLOYMENT_RESPONSE", "Wrangler returned no valid deployments.", worker);
  }

  const deployments = parsed.map((deployment) => {
    if (!deployment || typeof deployment !== "object" || Array.isArray(deployment) || !Array.isArray(deployment.versions) || deployment.versions.length === 0 || deployment.versions.length > 2) {
      fail("INVALID_DEPLOYMENT_RESPONSE", "Wrangler returned a malformed deployment.", worker);
    }
    const deploymentId = safeId(deployment.id, "INVALID_DEPLOYMENT_RESPONSE", worker);
    const created = asTimestamp(deployment.created_on, "INVALID_DEPLOYMENT_RESPONSE", worker);
    const versions = deployment.versions.map((version) => {
      if (!version || typeof version !== "object" || Array.isArray(version) || !versionIdPattern.test(version.version_id) || typeof version.percentage !== "number" || !Number.isFinite(version.percentage) || version.percentage < 0 || version.percentage > 100) {
        fail("INVALID_DEPLOYMENT_RESPONSE", "Wrangler returned a malformed deployment version.", worker);
      }
      return Object.freeze({ version_id: version.version_id, percentage: version.percentage });
    }).sort((left, right) => left.version_id.localeCompare(right.version_id));
    const totalPercentage = versions.reduce((total, version) => total + version.percentage, 0);
    if (Math.abs(totalPercentage - 100) > 0.000001) fail("INVALID_DEPLOYMENT_RESPONSE", "Wrangler returned an invalid traffic allocation.", worker);
    return {
      milliseconds: created.milliseconds,
      identity: Object.freeze({ deployment_id: deploymentId, created_on: created.iso, versions }),
    };
  });

  deployments.sort((left, right) => left.milliseconds - right.milliseconds || left.identity.deployment_id.localeCompare(right.identity.deployment_id));
  return deployments.at(-1).identity;
}

function isTargetDeployment(identity, targetVersionId) {
  return identity.versions.length === 1 && identity.versions[0].version_id === targetVersionId && identity.versions[0].percentage === 100;
}

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function validateReason(reason) {
  if (typeof reason !== "string" || reason.length === 0 || reason.length > 120 || reason !== reason.trim() || hasControlCharacters(reason)) {
    fail("INVALID_REASON", "Rollback reason must be 1-120 trimmed printable characters.");
  }
  return reason;
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) fail("INVALID_REQUEST", "Rollback request must be an object.");
  const allowedRequestKeys = new Set(["environment", "workers", "reason", "versions"]);
  for (const key of Object.keys(request)) {
    if (!allowedRequestKeys.has(key)) fail("UNEXPECTED_REQUEST_FIELD", "Rollback request contained an unexpected field.");
  }
  if (request.environment !== "staging" && request.environment !== "production") fail("INVALID_ENVIRONMENT", "Rollback environment must be staging or production.");
  validateReason(request.reason);
  if (!Array.isArray(request.workers) || request.workers.length === 0 || request.workers.length > rollbackOrder.length) fail("INVALID_WORKER_SELECTION", "Select at least one known Worker.");
  const selected = new Set();
  for (const worker of request.workers) {
    if (typeof worker !== "string" || !Object.hasOwn(workerDefinitions, worker) || selected.has(worker)) fail("INVALID_WORKER_SELECTION", "Worker selection is unknown or duplicated.");
    selected.add(worker);
  }
  if (!request.versions || typeof request.versions !== "object" || Array.isArray(request.versions)) fail("INVALID_VERSION_SET", "Worker version IDs are required.");
  for (const worker of Object.keys(request.versions)) {
    if (!Object.hasOwn(workerDefinitions, worker)) fail("UNEXPECTED_VERSION", "A version was supplied for an unknown Worker.");
  }
  for (const worker of rollbackOrder) {
    const versionId = request.versions[worker];
    if (selected.has(worker)) {
      if (typeof versionId !== "string" || !versionIdPattern.test(versionId)) fail("INVALID_VERSION_ID", "Every selected Worker requires one canonical version ID.", worker);
    } else if (versionId !== undefined && versionId !== "") {
      fail("UNEXPECTED_VERSION", "An unselected Worker must not have a version ID.", worker);
    }
  }
  return {
    environment: request.environment,
    reason: request.reason,
    workers: rollbackOrder.filter((worker) => selected.has(worker)),
    versions: Object.freeze({ ...request.versions }),
  };
}

export function parseRollbackArguments(argv) {
  if (!Array.isArray(argv)) fail("INVALID_ARGUMENTS", "Rollback arguments must be an array.");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowedFlags.has(flag)) fail("UNKNOWN_ARGUMENT", "Rollback command received an unknown argument.");
    if (values.has(flag)) fail("DUPLICATE_ARGUMENT", "Rollback command received a duplicate argument.");
    if (value === undefined) fail("MISSING_ARGUMENT_VALUE", "Rollback command argument is missing its value.");
    values.set(flag, value);
  }
  const workersValue = values.get("--workers");
  const workers = typeof workersValue === "string" ? workersValue.split(",").map((worker) => worker.trim()) : [];
  return validateRequest({
    environment: values.get("--environment"),
    workers,
    reason: values.get("--reason"),
    versions: {
      backend: values.get("--backend-version"),
      admin: values.get("--admin-version"),
      portal: values.get("--portal-version"),
      backup: values.get("--backup-version"),
    },
  });
}

function validateConfigPaths(root) {
  const absoluteRoot = resolve(root);
  let realRoot;
  try {
    realRoot = realpathSync.native(absoluteRoot);
  } catch {
    fail("INVALID_REPOSITORY_ROOT", "Repository root is not a real directory.");
  }
  const configs = {};
  for (const [worker, definition] of Object.entries(workerDefinitions)) {
    const candidate = resolve(absoluteRoot, definition.config);
    if (!insideRoot(absoluteRoot, candidate)) fail("INVALID_CONFIG_PATH", "Worker configuration escaped the repository root.", worker);
    let stat;
    let realCandidate;
    try {
      stat = lstatSync(candidate);
      realCandidate = realpathSync.native(candidate);
    } catch {
      fail("INVALID_CONFIG_PATH", "Expected Worker configuration is missing.", worker);
    }
    const expectedRealCandidate = resolve(realRoot, definition.config);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 2 * 1024 * 1024 || platformPath(realCandidate) !== platformPath(expectedRealCandidate)) {
      fail("INVALID_CONFIG_PATH", "Worker configuration path is not an exact regular file.", worker);
    }
    configs[worker] = candidate;
  }
  return Object.freeze(configs);
}

async function defaultRunCommand(command, args, options) {
  const executable = process.platform === "win32" && command === "npx" ? "npx.cmd" : command;
  const result = await execFile(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: maxJsonBytes,
    timeout: 120_000,
    killSignal: "SIGTERM",
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
}

async function runWrangler(runCommand, root, processEnvironment, args, worker) {
  let result;
  try {
    result = await runCommand("npx", ["--no-install", "wrangler", ...args], { cwd: root, env: processEnvironment });
  } catch {
    fail("WRANGLER_COMMAND_FAILED", "Wrangler command failed.", worker);
  }
  if (!result || typeof result !== "object" || typeof result.stdout !== "string" || (result.exitCode !== undefined && result.exitCode !== 0)) {
    fail("WRANGLER_COMMAND_FAILED", "Wrangler command failed.", worker);
  }
  return result.stdout;
}

function evidenceTimestamp(milliseconds) {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) fail("INVALID_CLOCK", "Rollback clock returned an invalid time.");
  return new Date(milliseconds).toISOString();
}

async function findPostDeployment({ runCommand, root, processEnvironment, config, worker, targetVersionId, preDeploymentId, sleep, attempts }) {
  let lastIdentity;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const stdout = await runWrangler(runCommand, root, processEnvironment, ["deployments", "list", "--json", "--config", config], worker);
    lastIdentity = parseDeploymentList(stdout, worker);
    if (lastIdentity.deployment_id !== preDeploymentId && isTargetDeployment(lastIdentity, targetVersionId)) return lastIdentity;
    if (attempt + 1 < attempts) await sleep(1000);
  }
  fail("POST_DEPLOYMENT_MISMATCH", "Rollback target did not become the sole active Worker version.", worker);
}

export async function rollbackWorkers(request, {
  root = repositoryRoot,
  processEnvironment = process.env,
  runCommand = defaultRunCommand,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  postDeploymentAttempts = 5,
} = {}) {
  const normalized = validateRequest(request);
  if (!Number.isInteger(postDeploymentAttempts) || postDeploymentAttempts < 1 || postDeploymentAttempts > 20) fail("INVALID_ATTEMPTS", "Post-deployment attempts are invalid.");
  const configs = validateConfigPaths(root);
  const started = now();
  evidenceTimestamp(started);

  // No rollback command is issued until every selected version and current
  // deployment has been validated successfully.
  const prepared = [];
  for (const worker of normalized.workers) {
    const targetVersionId = normalized.versions[worker];
    const versionStdout = await runWrangler(runCommand, root, processEnvironment, ["versions", "view", targetVersionId, "--json", "--config", configs[worker]], worker);
    parseVersionView(versionStdout, targetVersionId, worker);
    const deploymentStdout = await runWrangler(runCommand, root, processEnvironment, ["deployments", "list", "--json", "--config", configs[worker]], worker);
    const preDeployment = parseDeploymentList(deploymentStdout, worker);
    if (isTargetDeployment(preDeployment, targetVersionId)) fail("TARGET_ALREADY_ACTIVE", "Requested Worker version is already fully active.", worker);
    prepared.push({ worker, targetVersionId, preDeployment });
  }

  const completedWorkers = [];
  for (const preparedWorker of prepared) {
    const workerStarted = now();
    evidenceTimestamp(workerStarted);
    try {
      await runWrangler(runCommand, root, processEnvironment, [
        "rollback",
        preparedWorker.targetVersionId,
        "--yes",
        "--message",
        normalized.reason,
        "--config",
        configs[preparedWorker.worker],
      ], preparedWorker.worker);
      const postDeployment = await findPostDeployment({
        runCommand,
        root,
        processEnvironment,
        config: configs[preparedWorker.worker],
        worker: preparedWorker.worker,
        targetVersionId: preparedWorker.targetVersionId,
        preDeploymentId: preparedWorker.preDeployment.deployment_id,
        sleep,
        attempts: postDeploymentAttempts,
      });
      const workerCompleted = now();
      evidenceTimestamp(workerCompleted);
      if (workerCompleted < workerStarted) fail("INVALID_CLOCK", "Rollback clock moved backwards.", preparedWorker.worker);
      completedWorkers.push(Object.freeze({
        worker: preparedWorker.worker,
        status: "succeeded",
        target_version_id: preparedWorker.targetVersionId,
        pre_deployment: preparedWorker.preDeployment,
        post_deployment: postDeployment,
        elapsed_ms: workerCompleted - workerStarted,
      }));
    } catch (error) {
      const safeError = error instanceof SafeRollbackError ? error : new SafeRollbackError("UNEXPECTED_FAILURE", "Unexpected rollback failure.", { worker: preparedWorker.worker });
      const failedAt = now();
      const safeFailedAt = Number.isFinite(failedAt) && failedAt >= workerStarted ? failedAt : workerStarted;
      safeError.evidence = {
        schema_version: 1,
        operation: "worker-rollback",
        environment: normalized.environment,
        status: "failed",
        storage_action: "none",
        started_at: evidenceTimestamp(started),
        completed_at: evidenceTimestamp(safeFailedAt),
        elapsed_ms: safeFailedAt - started,
        workers: [
          ...completedWorkers,
          {
            worker: preparedWorker.worker,
            status: "failed",
            target_version_id: preparedWorker.targetVersionId,
            pre_deployment: preparedWorker.preDeployment,
            post_deployment: null,
            elapsed_ms: safeFailedAt - workerStarted,
          },
        ],
        error: {
          code: safeError.code,
          worker: preparedWorker.worker,
        },
      };
      throw safeError;
    }
  }

  const completed = now();
  evidenceTimestamp(completed);
  if (completed < started) fail("INVALID_CLOCK", "Rollback clock moved backwards.");
  return Object.freeze({
    schema_version: 1,
    operation: "worker-rollback",
    environment: normalized.environment,
    status: "succeeded",
    storage_action: "none",
    started_at: evidenceTimestamp(started),
    completed_at: evidenceTimestamp(completed),
    elapsed_ms: completed - started,
    workers: completedWorkers,
  });
}

export function safeFailureEvidence(error) {
  const safeError = error instanceof SafeRollbackError ? error : new SafeRollbackError("UNEXPECTED_FAILURE", "Unexpected rollback failure.");
  if (safeError.evidence) return safeError.evidence;
  return {
    schema_version: 1,
    operation: "worker-rollback",
    status: "failed",
    storage_action: "none",
    error: {
      code: safeError.code,
      ...(safeError.worker ? { worker: safeError.worker } : {}),
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const request = parseRollbackArguments(process.argv.slice(2));
    const evidence = await rollbackWorkers(request);
    console.log(JSON.stringify(evidence));
  } catch (error) {
    console.log(JSON.stringify(safeFailureEvidence(error)));
    process.exitCode = 1;
  }
}
