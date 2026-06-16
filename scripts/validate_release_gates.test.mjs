import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REQUIRED_EXTERNAL_RESULTS,
  REQUIRED_LOCAL_RESULTS,
} from "./assert_release_ready.mjs";
import { analyzeExternalGateEnv } from "./external_gate_preflight.mjs";
import {
  ACCESS_ADMIN_GATE_ID,
  ACCESS_ADMIN_URL_ENV,
  ACCESS_JWT_ENV,
  ACCESS_USE_CLOUDFLARED_ENV,
  ACCESS_NON_ADMIN_JWT_ENV,
  BACKUP_DEPLOY_GATE_ID,
  BACKUP_DEPLOY_URL_ENV,
  BACKUP_DEPLOY_WORKER_NAME_ENV,
  BACKUP_DEPLOY_WORKFLOW_NAME_ENV,
  PUBLIC_VERIFIER_ABUSE_GATE_ID,
  PUBLIC_VERIFIER_URL_ENV,
  R2_BACKUP_BUCKET_ENV,
  R2_BACKUP_OBJECT_KEY_ENV,
  R2_RESTORE_GATE_ID,
  R2_RESTORE_REQUIRE_STATUSES_ENV,
  R2_RESTORE_SCRATCH_D1_ENV,
  REQUIRED_LOCAL_COMMANDS,
} from "./release_gate_contract.mjs";
import {
  ACCESS_DRILL_ALLOWED_ENV_NAMES,
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
  externalInputBlockingReasons,
  externalInputsPresentFromPreflight,
  externalGateLabel,
  externalGateCredentialEnvNames,
  externalGateMissingReason,
  externalGateReadyFromEnv,
  externalGateRequiredEnvNames,
  externalGateSecretEnvNames,
  externalVariablesUsage,
  invalidResultLabels,
  invalidResultStatuses,
  localGateChunks,
  localCommandEvidenceProblems,
  localGates,
  localPreflightResults,
  missingRequiredResultLabels,
  parseArgs,
  publicVerifierAbuseArgsFromEnv,
  publicVerifierAbuseCommandForEvidence,
  releaseGateEnv,
  resultMetadataProblems,
  requiredResultLabels,
  restoreArgsFromEnv,
  restoreCommandForEvidence,
  restoreRequiredStatusesFromEnv,
  shouldFailRun,
} from "./validate_release_gates.mjs";

function gateResult(label, overrides = {}) {
  return {
    label,
    command: REQUIRED_LOCAL_COMMANDS.get(label) ?? `run ${label}`,
    status: 0,
    duration_ms: 1,
    ...overrides,
  };
}

function strictProductionResults(overridesByLabel = {}) {
  return [
    ...REQUIRED_LOCAL_RESULTS,
    ...REQUIRED_EXTERNAL_RESULTS,
  ].map((label) => gateResult(label, overridesByLabel[label] ?? {}));
}

test("release gate parser supports quick full external strict mode and json output", () => {
  const options = parseArgs([
    "node",
    "validate_release_gates.mjs",
    "--quick",
    "--full",
    "--external",
    "--require-external",
    "--json-out",
    "build/release-gates/latest.json",
  ]);
  assert.equal(options.quick, true);
  assert.equal(options.full, true);
  assert.equal(options.external, true);
  assert.equal(options.requireExternal, true);
  assert.match(options.jsonOut, /build[\\/]release-gates[\\/]latest\.json$/);
});

test("release gate strict external mode implies external", () => {
  const options = parseArgs(["node", "validate_release_gates.mjs", "--require-external"]);
  assert.equal(options.external, true);
  assert.equal(options.requireExternal, true);
});

test("release gate parser rejects missing json output path", () => {
  assert.throws(() => parseArgs(["node", "validate_release_gates.mjs", "--json-out"]), /requires a path/);
});

test("release gate local subprocess env strips secret release variables", () => {
  const env = releaseGateEnv({
    PATH: "/bin",
    LICENSECC_ADMIN_URL: "https://admin.example",
    LICENSECC_ACCESS_JWT: "access-token",
    LICENSECC_ACCESS_USE_CLOUDFLARED: "1",
    LICENSECC_NON_ADMIN_ACCESS_JWT: "reader-token",
    LICENSECC_R2_BACKUP_BUCKET: "bucket",
    LICENSECC_R2_BACKUP_OBJECT_KEY: "backup.sql",
    LICENSECC_RESTORE_SCRATCH_D1: "scratch",
    LICENSECC_RESTORE_REQUIRE_STATUSES: "active,revoked",
    LICENSECC_BACKUP_URL: "https://backup.example",
    LICENSECC_BACKUP_WORKER_NAME: "licensecc-d1-backup",
    LICENSECC_BACKUP_WORKFLOW_NAME: "licensecc-d1-backup",
    LICENSECC_VERIFIER_URL: "https://verifier.example",
    CLOUDFLARE_API_TOKEN: "cloudflare-token",
    D1_REST_API_TOKEN: "d1-token",
  });

  assert.equal(env.PATH, "/bin");
  assert.equal(env.CI, "1");
  assert.equal(env.NO_COLOR, "1");
  assert.equal("LICENSECC_ADMIN_URL" in env, false);
  assert.equal("LICENSECC_ACCESS_JWT" in env, false);
  assert.equal("LICENSECC_ACCESS_USE_CLOUDFLARED" in env, false);
  assert.equal("LICENSECC_NON_ADMIN_ACCESS_JWT" in env, false);
  assert.equal("LICENSECC_R2_BACKUP_BUCKET" in env, false);
  assert.equal("LICENSECC_R2_BACKUP_OBJECT_KEY" in env, false);
  assert.equal("LICENSECC_RESTORE_SCRATCH_D1" in env, false);
  assert.equal("LICENSECC_RESTORE_REQUIRE_STATUSES" in env, false);
  assert.equal("LICENSECC_BACKUP_URL" in env, false);
  assert.equal("LICENSECC_BACKUP_WORKER_NAME" in env, false);
  assert.equal("LICENSECC_BACKUP_WORKFLOW_NAME" in env, false);
  assert.equal("LICENSECC_VERIFIER_URL" in env, false);
  assert.equal("CLOUDFLARE_API_TOKEN" in env, false);
  assert.equal("D1_REST_API_TOKEN" in env, false);
});

test("release gate stripped env list includes secrets and non-secret staging identifiers", () => {
  assert.equal(RELEASE_GATE_STRIPPED_ENV_NAMES.includes("LICENSECC_ADMIN_URL"), true);
  assert.equal(RELEASE_GATE_STRIPPED_ENV_NAMES.includes("LICENSECC_R2_BACKUP_BUCKET"), true);
  assert.equal(RELEASE_GATE_STRIPPED_ENV_NAMES.includes("LICENSECC_RESTORE_SCRATCH_D1"), true);
  assert.equal(RELEASE_GATE_STRIPPED_ENV_NAMES.includes("LICENSECC_RESTORE_REQUIRE_STATUSES"), true);
  assert.equal(RELEASE_GATE_STRIPPED_ENV_NAMES.includes("LICENSECC_BACKUP_URL"), true);
  assert.equal(RELEASE_GATE_STRIPPED_ENV_NAMES.includes("LICENSECC_BACKUP_WORKER_NAME"), true);
  assert.equal(RELEASE_GATE_STRIPPED_ENV_NAMES.includes("LICENSECC_VERIFIER_URL"), true);
  assert.equal(RELEASE_GATE_STRIPPED_ENV_NAMES.includes("LICENSECC_ACCESS_JWT"), true);
  assert.equal(RELEASE_GATE_STRIPPED_ENV_NAMES.includes("LICENSECC_ACCESS_USE_CLOUDFLARED"), true);
  assert.equal(RELEASE_GATE_STRIPPED_ENV_NAMES.includes("CLOUDFLARE_API_TOKEN"), true);
});

test("release gate runner derives external gate metadata from the shared contract", () => {
  assert.deepEqual(externalGateRequiredEnvNames(ACCESS_ADMIN_GATE_ID), [
    ACCESS_ADMIN_URL_ENV,
  ]);
  assert.deepEqual(externalGateCredentialEnvNames(ACCESS_ADMIN_GATE_ID), [
    ACCESS_JWT_ENV,
    ACCESS_USE_CLOUDFLARED_ENV,
  ]);
  assert.deepEqual(externalGateSecretEnvNames(ACCESS_ADMIN_GATE_ID), [
    ACCESS_JWT_ENV,
    ACCESS_NON_ADMIN_JWT_ENV,
  ]);
  assert.deepEqual(externalGateRequiredEnvNames(R2_RESTORE_GATE_ID), [
    R2_BACKUP_BUCKET_ENV,
    R2_BACKUP_OBJECT_KEY_ENV,
    R2_RESTORE_SCRATCH_D1_ENV,
  ]);
  assert.deepEqual(externalGateSecretEnvNames(R2_RESTORE_GATE_ID), []);
  assert.deepEqual(externalGateRequiredEnvNames(BACKUP_DEPLOY_GATE_ID), [
    BACKUP_DEPLOY_URL_ENV,
    BACKUP_DEPLOY_WORKER_NAME_ENV,
  ]);
  assert.deepEqual(externalGateRequiredEnvNames(PUBLIC_VERIFIER_ABUSE_GATE_ID), [
    PUBLIC_VERIFIER_URL_ENV,
  ]);
  assert.deepEqual(externalGateSecretEnvNames(BACKUP_DEPLOY_GATE_ID), []);
  assert.deepEqual(externalGateSecretEnvNames(PUBLIC_VERIFIER_ABUSE_GATE_ID), []);
  assert.equal(externalGateLabel(ACCESS_ADMIN_GATE_ID), "Cloudflare Access admin staging drill");
  assert.equal(externalGateLabel(R2_RESTORE_GATE_ID), "Cloudflare R2 backup restore staging drill");
  assert.equal(externalGateLabel(BACKUP_DEPLOY_GATE_ID), "Cloudflare backup deployment staging drill");
  assert.equal(externalGateLabel(PUBLIC_VERIFIER_ABUSE_GATE_ID), "Cloudflare public verifier abuse staging drill");
  assert.equal(
    externalGateMissingReason(ACCESS_ADMIN_GATE_ID),
    `${ACCESS_ADMIN_URL_ENV} and one of ${ACCESS_JWT_ENV}, ${ACCESS_USE_CLOUDFLARED_ENV} are required`,
  );
  assert.equal(
    externalGateReadyFromEnv(ACCESS_ADMIN_GATE_ID, { [ACCESS_ADMIN_URL_ENV]: "https://admin.example" }),
    false,
  );
  assert.equal(
    externalGateReadyFromEnv(ACCESS_ADMIN_GATE_ID, {
      [ACCESS_ADMIN_URL_ENV]: "https://admin.example",
      [ACCESS_JWT_ENV]: "jwt",
    }),
    true,
  );
  assert.equal(
    externalGateReadyFromEnv(ACCESS_ADMIN_GATE_ID, {
      [ACCESS_ADMIN_URL_ENV]: "https://admin.example",
      [ACCESS_USE_CLOUDFLARED_ENV]: "1",
    }),
    true,
  );
  assert.equal(
    externalGateReadyFromEnv(ACCESS_ADMIN_GATE_ID, {
      [ACCESS_ADMIN_URL_ENV]: "https://admin.example",
      [ACCESS_USE_CLOUDFLARED_ENV]: "0",
    }),
    false,
  );
  assert.equal(
    externalGateReadyFromEnv(BACKUP_DEPLOY_GATE_ID, {
      [BACKUP_DEPLOY_URL_ENV]: "https://backup.example",
      [BACKUP_DEPLOY_WORKER_NAME_ENV]: "licensecc-d1-backup",
    }),
    true,
  );
  assert.equal(
    externalGateReadyFromEnv(PUBLIC_VERIFIER_ABUSE_GATE_ID, {
      [PUBLIC_VERIFIER_URL_ENV]: "https://verifier.example",
    }),
    true,
  );
  assert.match(externalVariablesUsage(), new RegExp(ACCESS_ADMIN_URL_ENV));
  assert.match(externalVariablesUsage(), new RegExp(ACCESS_USE_CLOUDFLARED_ENV));
  assert.match(externalVariablesUsage(), new RegExp(`${ACCESS_NON_ADMIN_JWT_ENV}\\s+optional`));
  assert.match(externalVariablesUsage(), new RegExp(BACKUP_DEPLOY_URL_ENV));
  assert.match(externalVariablesUsage(), new RegExp(PUBLIC_VERIFIER_URL_ENV));
});

test("release gate external subprocess env keeps only allowed secret release variables", () => {
  const env = releaseGateEnv(
    {
      PATH: "/bin",
      LICENSECC_ADMIN_URL: "https://admin.example",
      LICENSECC_ACCESS_JWT: "access-token",
      LICENSECC_ACCESS_USE_CLOUDFLARED: "1",
      LICENSECC_NON_ADMIN_ACCESS_JWT: "reader-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      D1_REST_API_TOKEN: "d1-token",
    },
    {
      ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: "signing-key",
    },
    { allowedEnv: ACCESS_DRILL_ALLOWED_ENV_NAMES },
  );

  assert.equal(env.LICENSECC_ACCESS_JWT, "access-token");
  assert.equal(env.LICENSECC_ACCESS_USE_CLOUDFLARED, "1");
  assert.equal(env.LICENSECC_NON_ADMIN_ACCESS_JWT, "reader-token");
  assert.equal(env.LICENSECC_ADMIN_URL, "https://admin.example");
  assert.equal("CLOUDFLARE_API_TOKEN" in env, false);
  assert.equal("D1_REST_API_TOKEN" in env, false);
  assert.equal("ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM" in env, false);
  assert.equal(env.CI, "1");
  assert.equal(env.NO_COLOR, "1");
});

test("release gate R2 restore env keeps Wrangler auth but strips Access and signing secrets", () => {
  const env = releaseGateEnv(
    {
      LICENSECC_ACCESS_JWT: "access-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CF_API_TOKEN: "cf-token",
      ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: "signing-key",
      LICENSECC_R2_BACKUP_BUCKET: "bucket",
      LICENSECC_RESTORE_SCRATCH_D1: "scratch",
    },
    {},
    { allowedEnv: R2_RESTORE_DRILL_SECRET_ENV_NAMES },
  );

  assert.equal(env.CLOUDFLARE_API_TOKEN, "cloudflare-token");
  assert.equal(env.CF_API_TOKEN, "cf-token");
  assert.equal("LICENSECC_ACCESS_JWT" in env, false);
  assert.equal("ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM" in env, false);
  assert.equal("LICENSECC_R2_BACKUP_BUCKET" in env, false);
  assert.equal("LICENSECC_RESTORE_SCRATCH_D1" in env, false);
});

test("release gate backup deploy env keeps Wrangler auth only", () => {
  const env = releaseGateEnv(
    {
      LICENSECC_ACCESS_JWT: "access-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CF_API_TOKEN: "cf-token",
      D1_REST_API_TOKEN: "d1-token",
      BACKUP_TRIGGER_TOKEN: "backup-token",
      LICENSECC_BACKUP_URL: "https://backup.example",
      LICENSECC_BACKUP_WORKER_NAME: "licensecc-d1-backup",
      LICENSECC_VERIFIER_URL: "https://verifier.example",
    },
    {},
    { allowedEnv: BACKUP_DEPLOY_DRILL_SECRET_ENV_NAMES },
  );

  assert.equal(env.CLOUDFLARE_API_TOKEN, "cloudflare-token");
  assert.equal(env.CF_API_TOKEN, "cf-token");
  assert.equal("LICENSECC_ACCESS_JWT" in env, false);
  assert.equal("D1_REST_API_TOKEN" in env, false);
  assert.equal("BACKUP_TRIGGER_TOKEN" in env, false);
  assert.equal("LICENSECC_BACKUP_URL" in env, false);
  assert.equal("LICENSECC_BACKUP_WORKER_NAME" in env, false);
  assert.equal("LICENSECC_VERIFIER_URL" in env, false);
});

test("backup deployment args require token presence but keep identifiers out of evidence", () => {
  const originals = {
    LICENSECC_BACKUP_URL: process.env.LICENSECC_BACKUP_URL,
    LICENSECC_BACKUP_WORKER_NAME: process.env.LICENSECC_BACKUP_WORKER_NAME,
    LICENSECC_BACKUP_WORKFLOW_NAME: process.env.LICENSECC_BACKUP_WORKFLOW_NAME,
  };
  process.env.LICENSECC_BACKUP_URL = "https://backup.example.workers.dev";
  process.env.LICENSECC_BACKUP_WORKER_NAME = "licensecc-d1-backup";
  process.env.LICENSECC_BACKUP_WORKFLOW_NAME = "licensecc-d1-backup-workflow";
  try {
    const args = backupDeployArgsFromEnv();
    const command = backupDeployCommandForEvidence();
    assert.deepEqual(args, [
      "services/cloudflare-d1-backup/scripts/validate-deploy.mjs",
      "--url",
      "https://backup.example.workers.dev",
      "--worker-name",
      "licensecc-d1-backup",
      "--workflow-name",
      "licensecc-d1-backup-workflow",
      "--require-d1-rest-token",
      "--json",
    ]);
    assert.equal(command.includes("https://backup.example"), false);
    assert.equal(command.includes("licensecc-d1-backup"), false);
    assert.equal(command.includes("<redacted-backup-url>"), true);
    assert.equal(command.includes("<redacted-backup-worker>"), true);
    assert.equal(command.includes("<redacted-backup-workflow>"), true);
    assert.equal(command.includes("--require-d1-rest-token"), true);
  } finally {
    for (const [name, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("public verifier abuse args keep verifier URL out of evidence", () => {
  const originalUrl = process.env.LICENSECC_VERIFIER_URL;
  process.env.LICENSECC_VERIFIER_URL = "https://verifier.example.workers.dev";
  try {
    const args = publicVerifierAbuseArgsFromEnv();
    const command = publicVerifierAbuseCommandForEvidence();
    assert.deepEqual(args, [
      "services/cloudflare-licensing-backend/scripts/public-verifier-drill.mjs",
      "--url",
      "https://verifier.example.workers.dev",
      "--expect-rate-limit",
      "--json",
    ]);
    assert.equal(command.includes("https://verifier.example"), false);
    assert.equal(command.includes("<redacted-verifier-url>"), true);
    assert.equal(command.includes("--expect-rate-limit"), true);
    assert.equal(command.includes("--json"), true);
  } finally {
    if (originalUrl === undefined) {
      delete process.env.LICENSECC_VERIFIER_URL;
    } else {
      process.env.LICENSECC_VERIFIER_URL = originalUrl;
    }
  }
});

test("release gate parses optional restored status requirements", () => {
  assert.deepEqual(restoreRequiredStatusesFromEnv({
    [R2_RESTORE_REQUIRE_STATUSES_ENV]: "active, revoked,active",
  }), ["active", "revoked"]);
  assert.deepEqual(restoreRequiredStatusesFromEnv({}), []);
  assert.throws(() => restoreRequiredStatusesFromEnv({
    [R2_RESTORE_REQUIRE_STATUSES_ENV]: "active,expired",
  }), /active, revoked, or disabled/);
});

test("release gate summary distinguishes ok from complete when gates are skipped", () => {
  const summary = buildSummary({ quick: true, full: false, external: true, requireExternal: false }, [
    gateResult("local"),
    gateResult("staging", { command: "not run: staging", status: "skipped", duration_ms: 0, reason: "credentials missing" }),
  ]);
  assert.equal(summary.ok, true);
  assert.equal(summary.complete, false);
  assert.equal(summary.production_ready, false);
  assert.equal(summary.require_external, false);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.blocking_reasons, []);
});

test("release gate strict external mode fails skipped staging drills", () => {
  const options = { quick: false, full: true, external: true, requireExternal: true };
  const skippedSummary = buildSummary(options, strictProductionResults({
    "Cloudflare Access admin staging drill": {
      command: "not run: Cloudflare Access admin staging drill",
      status: "skipped",
      duration_ms: 0,
      reason: "credentials missing",
    },
  }));
  const completeSummary = buildSummary(options, strictProductionResults());
  const failedSummary = buildSummary(options, strictProductionResults({
    "repository whitespace check": { status: 1 },
  }));

  assert.equal(skippedSummary.ok, true);
  assert.equal(skippedSummary.complete, false);
  assert.equal(skippedSummary.production_ready, false);
  assert.deepEqual(skippedSummary.blocking_reasons, [
    {
      type: "external_gate_skipped",
      label: "Cloudflare Access admin staging drill",
      reason: "credentials missing",
    },
  ]);
  assert.equal(completeSummary.production_ready, true);
  assert.deepEqual(completeSummary.blocking_reasons, []);
  assert.deepEqual(failedSummary.blocking_reasons, [
    {
      type: "command_failed",
      label: "repository whitespace check",
      status: 1,
    },
  ]);
  assert.equal(shouldFailRun(options, skippedSummary), true);
  assert.equal(shouldFailRun(options, completeSummary), false);
  assert.equal(shouldFailRun(options, failedSummary), true);
});

test("strict release gate summary requires every production result label", () => {
  const options = { quick: false, full: true, external: true, requireExternal: true };
  const summary = buildSummary(options, [
    gateResult("repository whitespace check"),
    gateResult("Cloudflare Access admin staging drill"),
    gateResult("Cloudflare R2 backup restore staging drill"),
  ]);

  assert.deepEqual(requiredResultLabels(options), [
    ...REQUIRED_LOCAL_RESULTS,
    ...REQUIRED_EXTERNAL_RESULTS,
  ]);
  assert.equal(missingRequiredResultLabels(options, summary.results).includes("admin UI build"), true);
  assert.equal(missingRequiredResultLabels(options, summary.results).includes("full CTest suite"), true);
  assert.equal(summary.ok, false);
  assert.equal(summary.complete, false);
  assert.equal(summary.production_ready, false);
  assert.equal(summary.blocking_reasons.some((reason) =>
    reason.type === "missing_required_result" && reason.label === "admin UI build"), true);
  assert.equal(summary.blocking_reasons.some((reason) =>
    reason.type === "missing_required_result" && reason.label === "full CTest suite"), true);
  assert.equal(shouldFailRun(options, summary), true);
});

test("release gate summary rejects duplicate result labels", () => {
  const options = { quick: false, full: true, external: false, requireExternal: false };
  const summary = buildSummary(options, [
    gateResult("repository whitespace check"),
    gateResult("repository whitespace check"),
  ]);

  assert.deepEqual(duplicateResultLabels(summary.results), ["repository whitespace check"]);
  assert.equal(summary.ok, false);
  assert.equal(summary.complete, false);
  assert.equal(summary.production_ready, false);
  assert.deepEqual(summary.blocking_reasons, [
    {
      type: "duplicate_result_label",
      label: "repository whitespace check",
    },
  ]);
  assert.equal(shouldFailRun(options, summary), true);
});

test("release gate summary rejects invalid result labels", () => {
  const options = { quick: false, full: true, external: false, requireExternal: false };
  const summary = buildSummary(options, [
    gateResult("", { command: "run empty-label" }),
    gateResult(" padded label ", { command: "run padded-label" }),
    { command: "run missing-label", status: 0, duration_ms: 1 },
  ]);

  assert.deepEqual(invalidResultLabels(summary.results), [
    { label: "result[0]", value: "" },
    { label: "result[1]", value: " padded label " },
    { label: "result[2]", value: undefined },
  ]);
  assert.equal(summary.ok, false);
  assert.equal(summary.complete, false);
  assert.equal(summary.production_ready, false);
  assert.deepEqual(summary.blocking_reasons, [
    {
      type: "invalid_result_label",
      label: "result[0]",
      value: "",
    },
    {
      type: "invalid_result_label",
      label: "result[1]",
      value: " padded label ",
    },
    {
      type: "invalid_result_label",
      label: "result[2]",
      value: undefined,
    },
  ]);
  assert.equal(shouldFailRun(options, summary), true);
});

test("release gate summary rejects invalid result statuses", () => {
  const options = { quick: false, full: true, external: false, requireExternal: false };
  const summary = buildSummary(options, [
    gateResult("repository whitespace check", { status: "passed" }),
    gateResult("secret hygiene scan", { status: undefined }),
  ]);

  assert.deepEqual(invalidResultStatuses(summary.results), [
    {
      label: "repository whitespace check",
      status: "passed",
    },
    {
      label: "secret hygiene scan",
      status: undefined,
    },
  ]);
  assert.equal(summary.ok, false);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.blocking_reasons, [
    {
      type: "invalid_result_status",
      label: "repository whitespace check",
      status: "passed",
    },
    {
      type: "invalid_result_status",
      label: "secret hygiene scan",
      status: undefined,
    },
  ]);
  assert.equal(shouldFailRun(options, summary), true);
});

test("release gate summary rejects null result rows without crashing", () => {
  const options = { quick: false, full: true, external: false, requireExternal: false };
  const summary = buildSummary(options, [null]);

  assert.equal(summary.ok, false);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.blocking_reasons, [
    {
      type: "invalid_result_label",
      label: "result[0]",
      value: undefined,
    },
    {
      type: "invalid_result_status",
      label: "result[0]",
      status: undefined,
    },
    {
      type: "invalid_result_command",
      label: "result[0]",
      value: undefined,
    },
    {
      type: "invalid_result_duration",
      label: "result[0]",
      value: undefined,
    },
  ]);
  assert.equal(shouldFailRun(options, summary), true);
});

test("release gate summary rejects missing or malformed result metadata", () => {
  const options = { quick: false, full: true, external: false, requireExternal: false };
  const rows = [
    gateResult("missing command", { command: "" }),
    gateResult("padded command", { command: " run padded command " }),
    gateResult("bad duration", { duration_ms: -1 }),
    gateResult("missing skipped reason", { command: "not run: missing skipped reason", status: "skipped", duration_ms: 0, reason: "" }),
  ];
  const summary = buildSummary(options, rows);

  assert.deepEqual(resultMetadataProblems(rows), [
    {
      type: "invalid_result_command",
      label: "missing command",
      value: "",
    },
    {
      type: "invalid_result_command",
      label: "padded command",
      value: " run padded command ",
    },
    {
      type: "invalid_result_duration",
      label: "bad duration",
      value: -1,
    },
    {
      type: "invalid_skipped_result_reason",
      label: "missing skipped reason",
      value: "",
    },
  ]);
  assert.equal(summary.ok, false);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.blocking_reasons, [
    {
      type: "invalid_result_command",
      label: "missing command",
      value: "",
    },
    {
      type: "invalid_result_command",
      label: "padded command",
      value: " run padded command ",
    },
    {
      type: "invalid_result_duration",
      label: "bad duration",
      value: -1,
    },
    {
      type: "invalid_skipped_result_reason",
      label: "missing skipped reason",
      value: "",
    },
  ]);
  assert.equal(shouldFailRun(options, summary), true);
});

test("release gate summary rejects local command evidence that does not match the contract", () => {
  const options = { quick: false, full: true, external: false, requireExternal: false };
  const rows = [
    gateResult("repository whitespace check", {
      command: "node scripts/workspace_hygiene_check.mjs --fake-pass",
    }),
  ];
  const summary = buildSummary(options, rows);

  assert.deepEqual(localCommandEvidenceProblems(rows), [
    {
      type: "invalid_result_command_contract",
      label: "repository whitespace check",
      value: "node scripts/workspace_hygiene_check.mjs --fake-pass",
      expected: "node scripts/workspace_hygiene_check.mjs",
    },
  ]);
  assert.equal(summary.ok, false);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.blocking_reasons, [
    {
      type: "invalid_result_command_contract",
      label: "repository whitespace check",
      value: "node scripts/workspace_hygiene_check.mjs --fake-pass",
      expected: "node scripts/workspace_hygiene_check.mjs",
    },
  ]);
  assert.equal(shouldFailRun(options, summary), true);
});

test("strict external preflight summary fails before local gates when required inputs are missing", () => {
  const options = { quick: true, full: false, external: true, requireExternal: true };
  const preflight = analyzeExternalGateEnv({});
  const summary = buildExternalPreflightSummary(options, preflight);

  assert.equal(summary.ok, false);
  assert.equal(summary.complete, false);
  assert.equal(summary.production_ready, false);
  assert.equal(summary.require_external, true);
  assert.equal(summary.skipped, 0);
  assert.deepEqual(summary.external_inputs_present, {
    access_admin: false,
    access_non_admin_jwt: false,
    r2_restore: false,
    backup_deploy: false,
    public_verifier_abuse: false,
  });
  assert.deepEqual(summary.results, [
    {
      label: "external gate preflight",
      command: "node scripts/external_gate_preflight.mjs --json",
      status: 1,
      duration_ms: 0,
        missing: [
          "LICENSECC_ADMIN_URL",
          "LICENSECC_ACCESS_JWT or LICENSECC_ACCESS_USE_CLOUDFLARED",
          "LICENSECC_R2_BACKUP_BUCKET",
          "LICENSECC_R2_BACKUP_OBJECT_KEY",
        "LICENSECC_RESTORE_SCRATCH_D1",
        "LICENSECC_BACKUP_URL",
        "LICENSECC_BACKUP_WORKER_NAME",
        "LICENSECC_VERIFIER_URL",
      ],
    },
  ]);
  assert.deepEqual(summary.blocking_reasons, [
    {
      type: "external_input_missing",
      gate: "access_admin",
      label: "Cloudflare Access admin staging drill",
      name: "LICENSECC_ADMIN_URL",
    },
      {
        type: "external_input_missing",
        gate: "access_admin",
        label: "Cloudflare Access admin staging drill",
        name: "LICENSECC_ACCESS_JWT or LICENSECC_ACCESS_USE_CLOUDFLARED",
      },
    {
      type: "external_input_missing",
      gate: "r2_restore",
      label: "Cloudflare R2 backup restore staging drill",
      name: "LICENSECC_R2_BACKUP_BUCKET",
    },
    {
      type: "external_input_missing",
      gate: "r2_restore",
      label: "Cloudflare R2 backup restore staging drill",
      name: "LICENSECC_R2_BACKUP_OBJECT_KEY",
    },
    {
      type: "external_input_missing",
      gate: "r2_restore",
      label: "Cloudflare R2 backup restore staging drill",
      name: "LICENSECC_RESTORE_SCRATCH_D1",
    },
    {
      type: "external_input_missing",
      gate: "backup_deploy",
      label: "Cloudflare backup deployment staging drill",
      name: "LICENSECC_BACKUP_URL",
    },
    {
      type: "external_input_missing",
      gate: "backup_deploy",
      label: "Cloudflare backup deployment staging drill",
      name: "LICENSECC_BACKUP_WORKER_NAME",
    },
    {
      type: "external_input_missing",
      gate: "public_verifier_abuse",
      label: "Cloudflare public verifier abuse staging drill",
      name: "LICENSECC_VERIFIER_URL",
    },
  ]);
  assert.equal(shouldFailRun(options, summary), true);
});

test("strict external preflight helpers report readiness without leaking secret values", () => {
  const preflight = analyzeExternalGateEnv({
    LICENSECC_ADMIN_URL: "https://admin.example",
    LICENSECC_ACCESS_JWT: "secret-token-value",
    LICENSECC_NON_ADMIN_ACCESS_JWT: "optional-secret-token-value",
    LICENSECC_R2_BACKUP_BUCKET: "bucket",
    LICENSECC_R2_BACKUP_OBJECT_KEY: "backup.sql",
    LICENSECC_RESTORE_SCRATCH_D1: "scratch-db",
    LICENSECC_BACKUP_URL: "https://backup.example",
    LICENSECC_BACKUP_WORKER_NAME: "licensecc-d1-backup",
    LICENSECC_VERIFIER_URL: "https://verifier.example",
  });

  assert.equal(preflight.ready, true);
  assert.deepEqual(externalInputBlockingReasons(preflight), []);
  assert.deepEqual(externalInputsPresentFromPreflight(preflight), {
    access_admin: true,
    access_non_admin_jwt: true,
    r2_restore: true,
    backup_deploy: true,
    public_verifier_abuse: true,
  });
  assert.equal(JSON.stringify(preflight).includes("secret-token-value"), false);
  assert.equal(JSON.stringify(preflight).includes("optional-secret-token-value"), false);
});

test("release gate local gates include dry-runs outside quick mode", () => {
  const quickLabels = localGates({ quick: true, full: false }).map((gate) => gate[2]);
  const fullLabels = localGates({ quick: false, full: false }).map((gate) => gate[2]);
  assert.equal(quickLabels.includes("admin UI build"), true);
  assert.equal(fullLabels.includes("admin UI build"), true);
  assert.equal(quickLabels.includes("admin UI workflow tests"), true);
  assert.equal(fullLabels.includes("admin UI workflow tests"), true);
  assert.equal(quickLabels.includes("admin UI browser e2e"), false);
  assert.equal(fullLabels.includes("admin UI browser e2e"), true);
  assert.equal(quickLabels.includes("admin Worker dry-run"), false);
  assert.equal(fullLabels.includes("admin Worker dry-run"), true);
  assert.equal(fullLabels.includes("online verifier/admin local e2e"), true);
});

test("release gate local gates are grouped into conservative concurrent chunks", () => {
  const chunks = localGateChunks({ quick: false, full: true }, { ctestAvailable: true });
  const chunkLabels = chunks.map((chunk) => chunk.map((gate) => gate[2]));
  const flattened = chunkLabels.flat();

  assert.equal(chunks.length > 1, true);
  assert.equal(new Set(flattened).size, flattened.length);
  for (const label of localGates({ quick: false, full: true }, { ctestAvailable: true }).map((gate) => gate[2])) {
    assert.equal(flattened.includes(label), true, `${label} must be present in exactly one chunk`);
  }
  assert.deepEqual(chunkLabels[0], [
    "repository whitespace check",
    "workspace hygiene checker tests",
    "secret hygiene scanner tests",
    "secret hygiene scan",
  ]);
  assert.equal(chunkLabels.some((labels) => labels.includes("admin UI browser e2e")), true);
  assert.equal(chunkLabels.some((labels) => labels.includes("admin Worker tests") && labels.includes("online verifier tests")), true);
  assert.equal(chunkLabels.some((labels) => labels.includes("admin Worker lint") && labels.includes("admin UI build") && labels.includes("admin UI workflow tests")), true);
  assert.equal(chunkLabels.findIndex((labels) => labels.includes("full CTest suite")) >
    chunkLabels.findIndex((labels) => labels.includes("focused C++ security/API tests")), true);
});

test("release gate chunker preserves unknown future gates as a final chunk", () => {
  const chunks = chunkGates([
    ["node", ["known"], "repository whitespace check"],
    ["node", ["future"], "future gate"],
  ]);

  assert.deepEqual(chunks.map((chunk) => chunk.map((gate) => gate[2])), [
    ["repository whitespace check"],
    ["future gate"],
  ]);
});

test("production readiness local result labels are emitted by full local gates", () => {
  const fullGates = localGates({ quick: false, full: true }, { ctestAvailable: true });
  const fullLabels = new Set(fullGates.map((gate) => gate[2]));
  for (const label of REQUIRED_LOCAL_RESULTS) {
    assert.equal(fullLabels.has(label), true, `${label} must be emitted by full local gates`);
  }
  for (const [command, args, label] of fullGates) {
    if (!REQUIRED_LOCAL_COMMANDS.has(label)) {
      continue;
    }
    assert.equal([command, ...args].join(" "), REQUIRED_LOCAL_COMMANDS.get(label), `${label} command must match the shared contract`);
  }
});

test("full and strict release gates fail closed when CTest metadata is missing", () => {
  const fullResults = localPreflightResults(
    { quick: false, full: true, external: false, requireExternal: false },
    { ctestAvailable: false },
  );
  const strictResults = localPreflightResults(
    { quick: true, full: false, external: true, requireExternal: true },
    { ctestAvailable: false },
  );
  const quickResults = localPreflightResults(
    { quick: true, full: false, external: false, requireExternal: false },
    { ctestAvailable: false },
  );

  assert.deepEqual(fullResults, [
    {
      label: "CTest metadata check",
      command: "test -f build/CTestTestfile.cmake",
      status: 1,
      duration_ms: 0,
      reason: "build/CTestTestfile.cmake is required for --full or --require-external release gates",
    },
  ]);
  assert.deepEqual(strictResults, fullResults);
  assert.deepEqual(quickResults, []);
  assert.equal(shouldFailRun({ requireExternal: false }, buildSummary({ requireExternal: false }, fullResults)), true);
});

test("access staging args do not put JWTs on the command line", () => {
  const originalUrl = process.env.LICENSECC_ADMIN_URL;
  const originalNonAdmin = process.env.LICENSECC_NON_ADMIN_ACCESS_JWT;
  process.env.LICENSECC_ADMIN_URL = "https://admin.example";
  process.env.LICENSECC_NON_ADMIN_ACCESS_JWT = "reader-secret";
  try {
    const args = accessArgsFromEnv();
    assert.deepEqual(args, [
      "services/cloudflare-license-admin/scripts/access-admin-drill.mjs",
      "--url",
      "https://admin.example",
    ]);
    assert.equal(args.includes("reader-secret"), false);
  } finally {
    if (originalUrl === undefined) {
      delete process.env.LICENSECC_ADMIN_URL;
    } else {
      process.env.LICENSECC_ADMIN_URL = originalUrl;
    }
    if (originalNonAdmin === undefined) {
      delete process.env.LICENSECC_NON_ADMIN_ACCESS_JWT;
    } else {
      process.env.LICENSECC_NON_ADMIN_ACCESS_JWT = originalNonAdmin;
    }
  }
});

test("external drill evidence commands redact staging resource identifiers", () => {
  const originals = {
    LICENSECC_ADMIN_URL: process.env.LICENSECC_ADMIN_URL,
    LICENSECC_R2_BACKUP_BUCKET: process.env.LICENSECC_R2_BACKUP_BUCKET,
    LICENSECC_R2_BACKUP_OBJECT_KEY: process.env.LICENSECC_R2_BACKUP_OBJECT_KEY,
    LICENSECC_RESTORE_SCRATCH_D1: process.env.LICENSECC_RESTORE_SCRATCH_D1,
    LICENSECC_RESTORE_SOURCE_D1: process.env.LICENSECC_RESTORE_SOURCE_D1,
    LICENSECC_RESTORE_SCRATCH_CONFIG: process.env.LICENSECC_RESTORE_SCRATCH_CONFIG,
    LICENSECC_RESTORE_SOURCE_CONFIG: process.env.LICENSECC_RESTORE_SOURCE_CONFIG,
    LICENSECC_RESTORE_R2_CONFIG: process.env.LICENSECC_RESTORE_R2_CONFIG,
    LICENSECC_RESTORE_REQUIRE_STATUSES: process.env.LICENSECC_RESTORE_REQUIRE_STATUSES,
    LICENSECC_VERIFIER_URL: process.env.LICENSECC_VERIFIER_URL,
  };
  process.env.LICENSECC_ADMIN_URL = "https://admin.example";
  process.env.LICENSECC_R2_BACKUP_BUCKET = "licensecc-d1-backups";
  process.env.LICENSECC_R2_BACKUP_OBJECT_KEY = "d1/backups/production.sql";
  process.env.LICENSECC_RESTORE_SCRATCH_D1 = "licensecc-restore-scratch";
  process.env.LICENSECC_RESTORE_SOURCE_D1 = "licensecc-source";
  process.env.LICENSECC_RESTORE_SCRATCH_CONFIG = "services/cloudflare-d1-backup/wrangler.scratch.jsonc";
  process.env.LICENSECC_RESTORE_SOURCE_CONFIG = "services/cloudflare-licensing-backend/wrangler.source.toml";
  process.env.LICENSECC_RESTORE_R2_CONFIG = "services/cloudflare-d1-backup/wrangler.r2.jsonc";
  process.env.LICENSECC_RESTORE_REQUIRE_STATUSES = "active,revoked";
  process.env.LICENSECC_VERIFIER_URL = "https://verifier.example.workers.dev";
  try {
    const accessArgs = accessArgsFromEnv();
    const restoreArgs = restoreArgsFromEnv();
    const publicVerifierArgs = publicVerifierAbuseArgsFromEnv();
    const accessCommand = accessCommandForEvidence();
    const restoreCommand = restoreCommandForEvidence();
    const publicVerifierCommand = publicVerifierAbuseCommandForEvidence();

    assert.equal(accessArgs.includes("https://admin.example"), true);
    assert.equal(restoreArgs.includes("licensecc-d1-backups"), true);
    assert.equal(restoreArgs.includes("d1/backups/production.sql"), true);
    assert.equal(restoreArgs.includes("licensecc-restore-scratch"), true);
    assert.equal(restoreArgs.includes("licensecc-source"), true);
    assert.equal(restoreArgs.includes("services/cloudflare-d1-backup/wrangler.scratch.jsonc"), true);
    assert.equal(restoreArgs.includes("--require-restored-status"), true);
    assert.equal(restoreArgs.includes("active"), true);
    assert.equal(restoreArgs.includes("revoked"), true);
    assert.equal(publicVerifierArgs.includes("https://verifier.example.workers.dev"), true);

    assert.equal(accessCommand.includes("https://admin.example"), false);
    assert.equal(accessCommand.includes("<redacted-admin-url>"), true);
    assert.equal(restoreCommand.includes("licensecc-d1-backups"), false);
    assert.equal(restoreCommand.includes("d1/backups/production.sql"), false);
    assert.equal(restoreCommand.includes("licensecc-restore-scratch"), false);
    assert.equal(restoreCommand.includes("licensecc-source"), false);
    assert.equal(restoreCommand.includes("services/cloudflare-d1-backup/wrangler.scratch.jsonc"), false);
    assert.equal(restoreCommand.includes("<redacted-r2-bucket>"), true);
    assert.equal(restoreCommand.includes("<redacted-r2-object-key>"), true);
    assert.equal(restoreCommand.includes("<redacted-scratch-d1>"), true);
    assert.equal(restoreCommand.includes("<redacted-source-d1>"), true);
    assert.equal(restoreCommand.includes("<redacted-scratch-config>"), true);
    assert.equal(restoreCommand.includes("<redacted-source-config>"), true);
    assert.equal(restoreCommand.includes("<redacted-r2-config>"), true);
    assert.equal(restoreCommand.includes("--require-restored-status active"), true);
    assert.equal(restoreCommand.includes("--require-restored-status revoked"), true);
    assert.equal(publicVerifierCommand.includes("https://verifier.example"), false);
    assert.equal(publicVerifierCommand.includes("<redacted-verifier-url>"), true);
    assert.equal(publicVerifierCommand.includes("--expect-rate-limit"), true);
  } finally {
    for (const [name, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
