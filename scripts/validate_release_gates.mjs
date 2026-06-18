import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCESS_DRILL_COMMAND_TEMPLATE,
  ACCESS_ADMIN_GATE_ID,
  ACCESS_ADMIN_URL_ENV,
  ACCESS_JWT_ENV,
  ACCESS_NON_ADMIN_JWT_ENV,
  BACKUP_DEPLOY_COMMAND_REQUIRED_TOKENS,
  BACKUP_DEPLOY_GATE_ID,
  BACKUP_DEPLOY_URL_ENV,
  BACKUP_DEPLOY_WORKER_NAME_ENV,
  BACKUP_DEPLOY_WORKFLOW_NAME_ENV,
  EXTERNAL_GATE_ENV_NAMES,
  EXTERNAL_GATE_GROUPS,
  PUBLIC_VERIFIER_ABUSE_COMMAND_TEMPLATE,
  PUBLIC_VERIFIER_ABUSE_GATE_ID,
  PUBLIC_VERIFIER_URL_ENV,
  R2_RESTORE_COMMAND_OPTIONAL_PLACEHOLDERS,
  R2_RESTORE_COMMAND_REQUIRED_TOKENS,
  R2_BACKUP_BUCKET_ENV,
  R2_BACKUP_OBJECT_KEY_ENV,
  R2_RESTORE_GATE_ID,
  R2_RESTORE_R2_CONFIG_ENV,
  R2_RESTORE_REQUIRE_STATUSES_ENV,
  R2_RESTORE_SCRATCH_CONFIG_ENV,
  R2_RESTORE_SCRATCH_D1_ENV,
  R2_RESTORE_SOURCE_CONFIG_ENV,
  R2_RESTORE_SOURCE_D1_ENV,
  REQUIRED_EXTERNAL_RESULTS,
  REQUIRED_LOCAL_COMMANDS,
  REQUIRED_LOCAL_RESULTS,
  SKIPPED_EXTERNAL_COMMANDS,
} from "./release_gate_contract.mjs";
import {
  analyzeExternalGateEnv,
} from "./external_gate_preflight.mjs";
import { SECRET_ENV_NAMES } from "./secret_hygiene_scan.mjs";

function envHasValue(env, name) {
  return typeof env[name] === "string" && env[name] !== "";
}

function envTruthy(env, name) {
  return /^(1|true|yes|on)$/i.test(String(env[name] ?? ""));
}

function envSatisfiesVariable(env, variable) {
  return variable.truthy === true ? envTruthy(env, variable.name) : envHasValue(env, variable.name);
}

function externalGate(id) {
  const gate = EXTERNAL_GATE_GROUPS.find((group) => group.id === id);
  if (gate === undefined) {
    throw new Error(`unknown external gate: ${id}`);
  }
  return gate;
}

function externalGateLabel(id) {
  return externalGate(id).label;
}

function externalGateRequiredEnvNames(id) {
  return externalGate(id).required.map((variable) => variable.name);
}

function externalGateCredentialEnvNames(id) {
  return (externalGate(id).credential_alternatives ?? []).map((variable) => variable.name);
}

function externalGateSecretEnvNames(id) {
  const gate = externalGate(id);
  return [...gate.required, ...(gate.credential_alternatives ?? []), ...gate.optional]
    .filter((variable) => variable.secret)
    .map((variable) => variable.name);
}

function externalGateAllowedEnvNames(id) {
  const gate = externalGate(id);
  return [...gate.required, ...(gate.credential_alternatives ?? []), ...gate.optional]
    .map((variable) => variable.name);
}

function externalGateReadyFromEnv(id, env = process.env) {
  const gate = externalGate(id);
  const requiredReady = gate.required.every((variable) => envSatisfiesVariable(env, variable));
  const credentialVariables = gate.credential_alternatives ?? [];
  const credentialsReady = credentialVariables.length === 0
    || credentialVariables.some((variable) => envSatisfiesVariable(env, variable));
  return requiredReady && credentialsReady;
}

function externalGateMissingReason(id) {
  const required = externalGateRequiredEnvNames(id).join(", ");
  const credentials = externalGateCredentialEnvNames(id);
  if (credentials.length === 0) {
    return `${required} are required`;
  }
  return `${required} and one of ${credentials.join(", ")} are required`;
}

const ACCESS_DRILL_ALLOWED_ENV_NAMES = externalGateAllowedEnvNames(ACCESS_ADMIN_GATE_ID);

const R2_RESTORE_DRILL_SECRET_ENV_NAMES = [
  "CF_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
];

const RELEASE_GATE_STRIPPED_ENV_NAMES = [...new Set([
  ...SECRET_ENV_NAMES,
  ...EXTERNAL_GATE_ENV_NAMES,
])];

function usage(exitCode = 2) {
  console.error(`usage:
  node scripts/validate_release_gates.mjs [--quick] [--full] [--external] [--require-external] [--json-out <path>]

Runs deterministic local release gates in conservative parallel chunks. With
--external, also runs staging Access, R2 restore, backup deployment, and public
verifier abuse drills when their environment variables are present.
With --require-external, a redacted external input preflight runs before local
gates, and missing or skipped staging drills make the process exit nonzero.
This option implies --external.

External variables:
${externalVariablesUsage()}`);
  process.exit(exitCode);
}

function externalVariablesUsage() {
  return EXTERNAL_GATE_GROUPS.flatMap((group) => [
    ...group.required.map((variable) => `  ${variable.name}`),
    ...(group.credential_alternatives ?? []).map((variable) => `  ${variable.name}        credential`),
    ...group.optional.map((variable) => `  ${variable.name}        optional`),
  ]).join("\n");
}

function parseArgs(argv) {
  const options = { quick: false, full: false, external: false, requireExternal: false, jsonOut: null };
  for (let index = 2; index < argv.length; ++index) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    }
    if (arg === "--quick") {
      options.quick = true;
      continue;
    }
    if (arg === "--full") {
      options.full = true;
      continue;
    }
    if (arg === "--external") {
      options.external = true;
      continue;
    }
    if (arg === "--require-external") {
      options.external = true;
      options.requireExternal = true;
      continue;
    }
    if (arg === "--json-out") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--json-out requires a path");
      }
      options.jsonOut = resolve(value);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function releaseGateEnv(baseEnv = process.env, extraEnv = {}, options = {}) {
  const env = {
    ...baseEnv,
    CI: "1",
    NO_COLOR: "1",
    ...extraEnv,
  };
  const allowedEnv = new Set(options.allowedEnv ?? []);
  for (const name of RELEASE_GATE_STRIPPED_ENV_NAMES) {
    if (!allowedEnv.has(name)) {
      delete env[name];
    }
  }
  return env;
}

function run(command, args, label, options = {}) {
  const started = Date.now();
  const useShell = process.platform === "win32" && command === "npm";
  const commandForEvidence = options.commandForEvidence ?? [command, ...args].join(" ");
  console.log(`\n==> ${label}`);
  console.log(`$ ${commandForEvidence}`);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: releaseGateEnv(process.env, options.env ?? {}, { allowedEnv: options.allowedEnv ?? [] }),
    encoding: "utf8",
    shell: useShell,
  });
    let stdout = "";
    let stderr = "";
    let errorMessage = null;
    let resolved = false;
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const finish = (status) => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (stdout !== "") {
        process.stdout.write(stdout);
      }
      if (stderr !== "") {
        process.stderr.write(stderr);
      }
      if (errorMessage !== null) {
        console.error(errorMessage);
      }
      resolve({
        label,
        command: commandForEvidence,
        status,
        duration_ms: Date.now() - started,
      });
    };
    child.on("error", (error) => {
      errorMessage = error.message;
      finish(1);
    });
    child.on("close", (code) => {
      finish(code ?? 1);
    });
  });
}

function envPresent(...names) {
  return names.every((name) => envHasValue(process.env, name));
}

function optionalEnvPresent(name) {
  return envHasValue(process.env, name);
}

function externalInputsPresentFromPreflight(preflight) {
  const gateReady = (id) => preflight.gates.find((gate) => gate.id === id)?.ready === true;
  const optionalPresent = (name) =>
    preflight.gates.some((gate) => gate.optional.some((variable) => variable.name === name && variable.present));
  return {
    access_admin: gateReady(ACCESS_ADMIN_GATE_ID),
    access_non_admin_jwt: optionalPresent(ACCESS_NON_ADMIN_JWT_ENV),
    r2_restore: gateReady(R2_RESTORE_GATE_ID),
    backup_deploy: gateReady(BACKUP_DEPLOY_GATE_ID),
    public_verifier_abuse: gateReady(PUBLIC_VERIFIER_ABUSE_GATE_ID),
  };
}

function externalInputBlockingReasons(preflight) {
  return preflight.gates.flatMap((gate) =>
    gate.missing.map((name) => ({
      type: "external_input_missing",
      gate: gate.id,
      label: gate.label,
      name,
    })),
  );
}

function addOptional(results, label, reason) {
  console.log(`\n==> ${label}`);
  console.log(`skipped: ${reason}`);
  results.push({ label, command: SKIPPED_EXTERNAL_COMMANDS.get(label) ?? `not run: ${label}`, status: "skipped", duration_ms: 0, reason });
}

function restoreArgsFromEnv() {
  const args = [
    "services/cloudflare-d1-backup/scripts/restore-drill.mjs",
    "--bucket",
    process.env[R2_BACKUP_BUCKET_ENV],
    "--object-key",
    process.env[R2_BACKUP_OBJECT_KEY_ENV],
    "--scratch-database",
    process.env[R2_RESTORE_SCRATCH_D1_ENV],
    "--confirm-scratch",
    "--remote",
  ];
  if (envPresent(R2_RESTORE_SOURCE_D1_ENV)) {
    args.push("--source-database", process.env[R2_RESTORE_SOURCE_D1_ENV]);
  }
  if (envPresent(R2_RESTORE_SCRATCH_CONFIG_ENV)) {
    args.push("--scratch-config", process.env[R2_RESTORE_SCRATCH_CONFIG_ENV]);
  }
  if (envPresent(R2_RESTORE_SOURCE_CONFIG_ENV)) {
    args.push("--source-config", process.env[R2_RESTORE_SOURCE_CONFIG_ENV]);
  }
  if (envPresent(R2_RESTORE_R2_CONFIG_ENV)) {
    args.push("--r2-config", process.env[R2_RESTORE_R2_CONFIG_ENV]);
  }
  for (const status of restoreRequiredStatusesFromEnv()) {
    args.push("--require-restored-status", status);
  }
  return args;
}

function restoreRequiredStatusesFromEnv(env = process.env) {
  const raw = env[R2_RESTORE_REQUIRE_STATUSES_ENV];
  if (!envHasValue(env, R2_RESTORE_REQUIRE_STATUSES_ENV)) {
    return [];
  }
  const statuses = raw.split(",").map((item) => item.trim().toLowerCase()).filter((item) => item !== "");
  const unique = [...new Set(statuses)];
  for (const status of unique) {
    if (!["active", "revoked", "disabled"].includes(status)) {
      throw new Error(`${R2_RESTORE_REQUIRE_STATUSES_ENV} must contain only active, revoked, or disabled`);
    }
  }
  return unique;
}

function restoreCommandForEvidence() {
  const args = [...R2_RESTORE_COMMAND_REQUIRED_TOKENS.slice(1)];
  if (envPresent(R2_RESTORE_SOURCE_D1_ENV)) {
    args.push("--source-database", R2_RESTORE_COMMAND_OPTIONAL_PLACEHOLDERS.get("--source-database"));
  }
  if (envPresent(R2_RESTORE_SCRATCH_CONFIG_ENV)) {
    args.push("--scratch-config", R2_RESTORE_COMMAND_OPTIONAL_PLACEHOLDERS.get("--scratch-config"));
  }
  if (envPresent(R2_RESTORE_SOURCE_CONFIG_ENV)) {
    args.push("--source-config", R2_RESTORE_COMMAND_OPTIONAL_PLACEHOLDERS.get("--source-config"));
  }
  if (envPresent(R2_RESTORE_R2_CONFIG_ENV)) {
    args.push("--r2-config", R2_RESTORE_COMMAND_OPTIONAL_PLACEHOLDERS.get("--r2-config"));
  }
  for (const status of restoreRequiredStatusesFromEnv()) {
    args.push("--require-restored-status", status);
  }
  return ["node", ...args].join(" ");
}

function accessArgsFromEnv() {
  return [
    "services/cloudflare-license-admin/scripts/access-admin-drill.mjs",
    "--url",
    process.env[ACCESS_ADMIN_URL_ENV],
  ];
}

function accessCommandForEvidence() {
  return ACCESS_DRILL_COMMAND_TEMPLATE;
}

const BACKUP_DEPLOY_DRILL_SECRET_ENV_NAMES = [
  "CF_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
];

function backupDeployArgsFromEnv() {
  return [
    "services/cloudflare-d1-backup/scripts/validate-deploy.mjs",
    "--url",
    process.env[BACKUP_DEPLOY_URL_ENV],
    "--worker-name",
    process.env[BACKUP_DEPLOY_WORKER_NAME_ENV],
    "--workflow-name",
    process.env[BACKUP_DEPLOY_WORKFLOW_NAME_ENV] ?? process.env[BACKUP_DEPLOY_WORKER_NAME_ENV],
    "--require-d1-rest-token",
    "--json",
  ];
}

function backupDeployCommandForEvidence() {
  return BACKUP_DEPLOY_COMMAND_REQUIRED_TOKENS.join(" ");
}

function publicVerifierAbuseArgsFromEnv() {
  return [
    "services/cloudflare-licensing-backend/scripts/public-verifier-drill.mjs",
    "--url",
    process.env[PUBLIC_VERIFIER_URL_ENV],
    "--expect-rate-limit",
    "--json",
  ];
}

function publicVerifierAbuseCommandForEvidence() {
  return PUBLIC_VERIFIER_ABUSE_COMMAND_TEMPLATE;
}

function ctestAvailable(environment = {}) {
  return environment.ctestAvailable ?? existsSync("build/CTestTestfile.cmake");
}

function localPreflightResults(options, environment = {}) {
  if ((options.full === true || options.requireExternal === true) && !ctestAvailable(environment)) {
    return [
      {
        label: "CTest metadata check",
        command: "test -f build/CTestTestfile.cmake",
        status: 1,
        duration_ms: 0,
        reason: "build/CTestTestfile.cmake is required for --full or --require-external release gates",
      },
    ];
  }
  return [];
}

function localGates(options, environment = {}) {
  const gates = [
    ["node", ["scripts/workspace_hygiene_check.mjs"], "repository whitespace check"],
    ["node", ["--test", "scripts/workspace_hygiene_check.test.mjs"], "workspace hygiene checker tests"],
    ["node", ["--test", "scripts/secret_hygiene_scan.test.mjs"], "secret hygiene scanner tests"],
    ["node", ["scripts/secret_hygiene_scan.mjs"], "secret hygiene scan"],
    ["node", ["--test", "scripts/assert_release_ready.test.mjs"], "release readiness assertion tests"],
    ["node", ["--test", "scripts/external_gate_preflight.test.mjs"], "external gate preflight tests"],
    ["node", ["--test", "scripts/release_gate_contract.test.mjs"], "release gate contract tests"],
    ["node", ["--test", "scripts/release_gates_workflow.test.mjs"], "release gates workflow coverage tests"],
    ["node", ["--test", "scripts/validate_release_gates.test.mjs"], "release gate runner tests"],
    ["npm", ["--prefix", "services/cloudflare-license-admin", "test"], "admin Worker tests"],
    ["npm", ["--prefix", "services/cloudflare-license-admin", "run", "lint"], "admin Worker lint"],
    ["npm", ["--prefix", "services/cloudflare-license-admin", "run", "build:ui"], "admin UI build"],
    ["npm", ["--prefix", "services/cloudflare-license-admin", "run", "test:ui"], "admin UI workflow tests"],
    ["npm", ["--prefix", "services/cloudflare-licensing-backend", "test"], "online verifier tests"],
    ["npm", ["--prefix", "services/cloudflare-licensing-backend", "run", "schema:parity"], "online verifier schema parity"],
    ["npm", ["--prefix", "services/cloudflare-licensing-backend", "run", "lint"], "online verifier lint"],
    ["npm", ["--prefix", "services/cloudflare-d1-backup", "test"], "D1 backup tests"],
    ["npm", ["--prefix", "services/cloudflare-d1-backup", "run", "lint"], "D1 backup lint"],
    ["node", ["services/cloudflare-license-admin/scripts/validate-access-admin.mjs", "--help"], "Access admin validator help"],
    ["node", ["services/cloudflare-license-admin/scripts/access-admin-drill.mjs", "--help"], "Access admin drill help"],
    ["node", ["services/cloudflare-d1-backup/scripts/restore-drill.mjs", "--help"], "D1 restore drill help"],
    ["uv", ["run", "--no-project", "python", "scripts/check_docs_links.py", "doc"], "documentation link check"],
    ["uv", ["run", "--no-project", "python", "scripts/build_docs.py"], "documentation build"],
  ];
  if (!options.quick) {
    gates.splice(6, 0, ["npm", ["--prefix", "services/cloudflare-licensing-backend", "run", "test:e2e"], "online verifier/admin local e2e"]);
    gates.splice(15, 0, ["npm", ["--prefix", "services/cloudflare-license-admin", "run", "test:e2e"], "admin UI browser e2e"]);
    gates.push(["npm", ["--prefix", "services/cloudflare-license-admin", "run", "dry-run"], "admin Worker dry-run"]);
    gates.push(["npm", ["--prefix", "services/cloudflare-licensing-backend", "run", "dry-run"], "online verifier dry-run"]);
    gates.push(["npm", ["--prefix", "services/cloudflare-d1-backup", "run", "dry-run"], "D1 backup dry-run"]);
  }
  if (ctestAvailable(environment)) {
    gates.push([
      "ctest",
      ["--test-dir", "build", "-C", "Debug", "-R", "test_(public_api|anti_tamper|online_verification|online_callback_failover|ctest_label_audit)$", "--output-on-failure"],
      "focused C++ security/API tests",
    ]);
    if (options.full) {
      gates.push(["ctest", ["--test-dir", "build", "-C", "Debug", "--output-on-failure", "--timeout", "900"], "full CTest suite"]);
    }
  }
  return gates;
}

const LOCAL_GATE_CHUNK_LABELS = [
  [
    "repository whitespace check",
    "workspace hygiene checker tests",
    "secret hygiene scanner tests",
    "secret hygiene scan",
  ],
  [
    "release readiness assertion tests",
    "external gate preflight tests",
    "release gate contract tests",
    "release gates workflow coverage tests",
    "release gate runner tests",
  ],
  [
    "online verifier/admin local e2e",
  ],
  [
    "admin Worker tests",
    "online verifier tests",
    "D1 backup tests",
  ],
  [
    "admin Worker lint",
    "admin UI build",
    "admin UI workflow tests",
    "online verifier schema parity",
    "online verifier lint",
    "D1 backup lint",
    "Access admin validator help",
    "Access admin drill help",
    "D1 restore drill help",
    "documentation link check",
  ],
  [
    "documentation build",
    "focused C++ security/API tests",
  ],
  [
    "admin Worker dry-run",
    "online verifier dry-run",
    "D1 backup dry-run",
  ],
  [
    "full CTest suite",
  ],
];

function chunkGates(gates, chunkLabels = LOCAL_GATE_CHUNK_LABELS) {
  const gatesByLabel = new Map(gates.map((gate) => [gate[2], gate]));
  const usedLabels = new Set();
  const chunks = chunkLabels
    .map((labels) => labels
      .flatMap((label) => {
        const gate = gatesByLabel.get(label);
        if (gate === undefined) {
          return [];
        }
        usedLabels.add(label);
        return [gate];
      }))
    .filter((chunk) => chunk.length !== 0);
  const unchunked = gates.filter((gate) => !usedLabels.has(gate[2]));
  if (unchunked.length !== 0) {
    chunks.push(unchunked);
  }
  return chunks;
}

function localGateChunks(options, environment = {}) {
  return chunkGates(localGates(options, environment));
}

async function runGateChunks(chunks, results) {
  for (const chunk of chunks) {
    const chunkResults = await Promise.all(
      chunk.map(([command, args, label]) => run(command, args, label)),
    );
    results.push(...chunkResults);
    if (chunkResults.some((result) => typeof result.status === "number" && result.status !== 0)) {
      break;
    }
  }
}

function validResultLabel(result) {
  return result !== null
    && typeof result === "object"
    && typeof result.label === "string"
    && result.label.trim() !== ""
    && result.label === result.label.trim();
}

function displayResultLabel(result, index) {
  return validResultLabel(result) ? result.label : `result[${index}]`;
}

function validTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" && value === value.trim();
}

function invalidResultLabels(results) {
  return results
    .flatMap((result, index) => validResultLabel(result) ? [] : [{
      label: `result[${index}]`,
      value: result !== null && typeof result === "object" && "label" in result ? result.label : undefined,
    }]);
}

function duplicateResultLabels(results) {
  const seen = new Set();
  const duplicates = new Set();
  for (const result of results) {
    if (!validResultLabel(result)) {
      continue;
    }
    if (seen.has(result.label)) {
      duplicates.add(result.label);
    }
    seen.add(result.label);
  }
  return [...duplicates].sort();
}

function invalidResultStatuses(results) {
  return results
    .flatMap((result, index) => result !== null
      && typeof result === "object"
      && (Number.isInteger(result.status) || result.status === "skipped")
      ? []
      : [{
      label: displayResultLabel(result, index),
      status: result !== null && typeof result === "object" ? result.status : undefined,
    }]);
}

function resultMetadataProblems(results) {
  return results.flatMap((result, index) => {
    const label = displayResultLabel(result, index);
    if (result === null || typeof result !== "object") {
      return [
        { type: "invalid_result_command", label, value: undefined },
        { type: "invalid_result_duration", label, value: undefined },
      ];
    }
    const problems = [];
    if (!validTrimmedString(result.command)) {
      problems.push({ type: "invalid_result_command", label, value: result.command });
    }
    if (!Number.isInteger(result.duration_ms) || result.duration_ms < 0) {
      problems.push({ type: "invalid_result_duration", label, value: result.duration_ms });
    }
    if (result.status === "skipped" && !validTrimmedString(result.reason)) {
      problems.push({ type: "invalid_skipped_result_reason", label, value: result.reason });
    }
    return problems;
  });
}

function localCommandEvidenceProblems(results) {
  return results.flatMap((result, index) => {
    if (result === null || typeof result !== "object" || typeof result.command !== "string") {
      return [];
    }
    const expectedCommand = REQUIRED_LOCAL_COMMANDS.get(result.label);
    if (expectedCommand === undefined || result.command === expectedCommand) {
      return [];
    }
    return [{
      type: "invalid_result_command_contract",
      label: displayResultLabel(result, index),
      value: result.command,
      expected: expectedCommand,
    }];
  });
}

function requiredResultLabels(options) {
  return options.requireExternal === true
    ? [...REQUIRED_LOCAL_RESULTS, ...REQUIRED_EXTERNAL_RESULTS]
    : [];
}

function missingRequiredResultLabels(options, results) {
  const labels = new Set(results
    .filter((result) => validResultLabel(result))
    .map((result) => result.label));
  return requiredResultLabels(options).filter((label) => !labels.has(label));
}

function buildBlockingReasons(options, failures, skipped, consistencyProblems = {}) {
  const blockers = failures.map((result) => ({
    type: "command_failed",
    label: result.label,
    status: result.status,
  }));
  for (const label of consistencyProblems.duplicateLabels ?? []) {
    blockers.push({
      type: "duplicate_result_label",
      label,
    });
  }
  for (const result of consistencyProblems.invalidLabels ?? []) {
    blockers.push({
      type: "invalid_result_label",
      label: result.label,
      value: result.value,
    });
  }
  for (const result of consistencyProblems.invalidStatuses ?? []) {
    blockers.push({
      type: "invalid_result_status",
      label: result.label,
      status: result.status,
    });
  }
  for (const problem of consistencyProblems.metadataProblems ?? []) {
    blockers.push({
      type: problem.type,
      label: problem.label,
      value: problem.value,
    });
  }
  for (const problem of consistencyProblems.localCommandProblems ?? []) {
    blockers.push({
      type: problem.type,
      label: problem.label,
      value: problem.value,
      expected: problem.expected,
    });
  }
  for (const label of consistencyProblems.missingRequiredLabels ?? []) {
    blockers.push({
      type: "missing_required_result",
      label,
    });
  }
  if (options.requireExternal === true) {
    for (const result of skipped) {
      blockers.push({
        type: "external_gate_skipped",
        label: result.label,
        reason: result.reason,
      });
    }
  }
  return blockers;
}

function buildSummary(options, results) {
  const failures = results.flatMap((result, index) => result !== null
    && typeof result === "object"
    && Number.isInteger(result.status)
    && result.status !== 0
    ? [{ ...result, label: displayResultLabel(result, index), status: result.status }]
    : []);
  const skipped = results.flatMap((result, index) => result !== null
    && typeof result === "object"
    && result.status === "skipped"
    ? [{ ...result, label: displayResultLabel(result, index) }]
    : []);
  const invalidLabels = invalidResultLabels(results);
  const duplicateLabels = duplicateResultLabels(results);
  const invalidStatuses = invalidResultStatuses(results);
  const metadataProblems = resultMetadataProblems(results);
  const localCommandProblems = localCommandEvidenceProblems(results);
  const missingRequiredLabels = missingRequiredResultLabels(options, results);
  const hasInvalidEvidence =
    invalidLabels.length !== 0
    || duplicateLabels.length !== 0
    || invalidStatuses.length !== 0
    || metadataProblems.length !== 0
    || localCommandProblems.length !== 0
    || missingRequiredLabels.length !== 0;
  const blockingReasons = buildBlockingReasons(options, failures, skipped, {
    invalidLabels,
    duplicateLabels,
    invalidStatuses,
    metadataProblems,
    localCommandProblems,
    missingRequiredLabels,
  });
  return {
    ok: failures.length === 0 && !hasInvalidEvidence,
    complete: failures.length === 0 && skipped.length === 0 && !hasInvalidEvidence,
    production_ready: options.requireExternal === true && failures.length === 0 && skipped.length === 0 && !hasInvalidEvidence,
    generated_at: new Date().toISOString(),
    platform: process.platform,
    node_version: process.version,
    cwd: process.cwd(),
    quick: options.quick,
    full: options.full,
    external: options.external,
    require_external: options.requireExternal === true,
    skipped: skipped.length,
    blocking_reasons: blockingReasons,
    external_inputs_present: {
      access_admin: externalGateReadyFromEnv(ACCESS_ADMIN_GATE_ID),
      access_non_admin_jwt: optionalEnvPresent(ACCESS_NON_ADMIN_JWT_ENV),
      r2_restore: externalGateReadyFromEnv(R2_RESTORE_GATE_ID),
      backup_deploy: externalGateReadyFromEnv(BACKUP_DEPLOY_GATE_ID),
      public_verifier_abuse: externalGateReadyFromEnv(PUBLIC_VERIFIER_ABUSE_GATE_ID),
    },
    results,
  };
}

function buildExternalPreflightSummary(options, preflight) {
  const blockingReasons = externalInputBlockingReasons(preflight);
  return {
    ok: false,
    complete: false,
    production_ready: false,
    generated_at: new Date().toISOString(),
    platform: process.platform,
    node_version: process.version,
    cwd: process.cwd(),
    quick: options.quick,
    full: options.full,
    external: true,
    require_external: true,
    skipped: 0,
    blocking_reasons: blockingReasons,
    external_inputs_present: externalInputsPresentFromPreflight(preflight),
    preflight,
    results: [
      {
        label: "external gate preflight",
        command: "node scripts/external_gate_preflight.mjs --json",
        status: 1,
        duration_ms: 0,
        missing: preflight.missing,
      },
    ],
  };
}

function shouldFailRun(options, summary) {
  return summary.blocking_reasons.length > 0;
}

function writeSummary(path, summary) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`wrote release gate evidence to ${path}`);
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.requireExternal) {
    const preflight = analyzeExternalGateEnv();
    if (!preflight.ready) {
      const summary = buildExternalPreflightSummary(options, preflight);
      console.log("\nrelease gate summary:");
      console.log(JSON.stringify(summary, null, 2));
      if (options.jsonOut !== null) {
        writeSummary(options.jsonOut, summary);
      }
      process.exit(1);
    }
  }
  const results = localPreflightResults(options);
  for (const result of results) {
    console.log(`\n==> ${result.label}`);
    console.log(result.reason);
  }
  if (results.find((result) => typeof result.status === "number" && result.status !== 0) === undefined) {
    await runGateChunks(localGateChunks(options), results);
  }
  const failed = results.find((result) => typeof result.status === "number" && result.status !== 0);
  if (failed === undefined && options.external) {
    const externalRuns = [];
    if (externalGateReadyFromEnv(ACCESS_ADMIN_GATE_ID)) {
      externalRuns.push(run("node", accessArgsFromEnv(), externalGateLabel(ACCESS_ADMIN_GATE_ID), {
        allowedEnv: ACCESS_DRILL_ALLOWED_ENV_NAMES,
        commandForEvidence: accessCommandForEvidence(),
      }));
    } else {
      addOptional(results, externalGateLabel(ACCESS_ADMIN_GATE_ID), externalGateMissingReason(ACCESS_ADMIN_GATE_ID));
    }
    if (externalGateReadyFromEnv(R2_RESTORE_GATE_ID)) {
      externalRuns.push(run("node", restoreArgsFromEnv(), externalGateLabel(R2_RESTORE_GATE_ID), {
        allowedEnv: R2_RESTORE_DRILL_SECRET_ENV_NAMES,
        commandForEvidence: restoreCommandForEvidence(),
      }));
    } else {
      addOptional(
        results,
        externalGateLabel(R2_RESTORE_GATE_ID),
        externalGateMissingReason(R2_RESTORE_GATE_ID),
      );
    }
    if (externalGateReadyFromEnv(BACKUP_DEPLOY_GATE_ID)) {
      externalRuns.push(run("node", backupDeployArgsFromEnv(), externalGateLabel(BACKUP_DEPLOY_GATE_ID), {
        allowedEnv: BACKUP_DEPLOY_DRILL_SECRET_ENV_NAMES,
        commandForEvidence: backupDeployCommandForEvidence(),
      }));
    } else {
      addOptional(
        results,
        externalGateLabel(BACKUP_DEPLOY_GATE_ID),
        externalGateMissingReason(BACKUP_DEPLOY_GATE_ID),
      );
    }
    if (externalGateReadyFromEnv(PUBLIC_VERIFIER_ABUSE_GATE_ID)) {
      externalRuns.push(run("node", publicVerifierAbuseArgsFromEnv(), externalGateLabel(PUBLIC_VERIFIER_ABUSE_GATE_ID), {
        allowedEnv: [],
        commandForEvidence: publicVerifierAbuseCommandForEvidence(),
      }));
    } else {
      addOptional(
        results,
        externalGateLabel(PUBLIC_VERIFIER_ABUSE_GATE_ID),
        externalGateMissingReason(PUBLIC_VERIFIER_ABUSE_GATE_ID),
      );
    }
    results.push(...await Promise.all(externalRuns));
  }

  const summary = buildSummary(options, results);
  console.log("\nrelease gate summary:");
  console.log(JSON.stringify(summary, null, 2));
  if (options.jsonOut !== null) {
    writeSummary(options.jsonOut, summary);
  }
  if (shouldFailRun(options, summary)) {
    process.exit(1);
  }
}

export {
  ACCESS_DRILL_ALLOWED_ENV_NAMES,
  ACCESS_DRILL_ALLOWED_ENV_NAMES as ACCESS_DRILL_SECRET_ENV_NAMES,
  BACKUP_DEPLOY_DRILL_SECRET_ENV_NAMES,
  RELEASE_GATE_STRIPPED_ENV_NAMES,
  R2_RESTORE_DRILL_SECRET_ENV_NAMES,
  accessArgsFromEnv,
  accessCommandForEvidence,
  backupDeployArgsFromEnv,
  backupDeployCommandForEvidence,
  buildExternalPreflightSummary,
  buildSummary,
  chunkGates,
  duplicateResultLabels,
  envPresent,
  externalGateCredentialEnvNames,
  externalGateLabel,
  externalGateMissingReason,
  externalGateReadyFromEnv,
  externalGateRequiredEnvNames,
  externalGateSecretEnvNames,
  externalVariablesUsage,
  externalInputBlockingReasons,
  externalInputsPresentFromPreflight,
  invalidResultLabels,
  invalidResultStatuses,
  publicVerifierAbuseArgsFromEnv,
  publicVerifierAbuseCommandForEvidence,
  localPreflightResults,
  localGates,
  localGateChunks,
  localCommandEvidenceProblems,
  missingRequiredResultLabels,
  parseArgs,
  releaseGateEnv,
  resultMetadataProblems,
  requiredResultLabels,
  restoreCommandForEvidence,
  restoreRequiredStatusesFromEnv,
  restoreArgsFromEnv,
  shouldFailRun,
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
