import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  SafeRollbackError,
  parseDeploymentList,
  parseRollbackArguments,
  rollbackWorkers,
  safeFailureEvidence,
} from "./rollback-workers.mjs";
import { assertWorkerDeployment, parseDeploymentAssertionArguments } from "./assert-worker-deployment.mjs";
import { captureDeploymentTransition, parseTransitionArguments } from "./capture-worker-deployment-transition.mjs";
import { parseProtectedWranglerArguments, runProtectedWrangler } from "./run-protected-wrangler.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const workflowPath = join(repositoryRoot, ".github", "workflows", "rollback-workers.yml");
const configPaths = Object.freeze({
  backend: "services/cloudflare-licensing-backend/wrangler.toml",
  admin: "services/cloudflare-license-admin/wrangler.jsonc",
  portal: "services/cloudflare-customer-portal/wrangler.jsonc",
  backup: "services/cloudflare-d1-backup/wrangler.jsonc",
});
const targetVersions = Object.freeze({
  backend: "11111111-1111-1111-1111-111111111111",
  admin: "22222222-2222-2222-2222-222222222222",
  portal: "33333333-3333-3333-3333-333333333333",
  backup: "44444444-4444-4444-4444-444444444444",
});
const previousVersions = Object.freeze({
  backend: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
  admin: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2",
  portal: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3",
  backup: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4",
});

function deploymentEvidence(raw, worker) {
  return Object.freeze({ schema_version: 1, worker, deployment: parseDeploymentList(raw, worker) });
}

test("deployment parser retains identities and drops Wrangler metadata", () => {
  const raw = JSON.stringify([{
    id: "deployment-backend-current",
    created_on: "2026-08-30T10:00:00.000Z",
    author_email: "operator@example.invalid",
    source: "wrangler",
    annotations: { message: "private operator note" },
    versions: [{ version_id: targetVersions.backend, percentage: 100 }],
  }]);
  const parsed = parseDeploymentList(raw, "backend");
  assert.deepEqual(parsed, {
    deployment_id: "deployment-backend-current",
    created_on: "2026-08-30T10:00:00.000Z",
    versions: [{ version_id: targetVersions.backend, percentage: 100 }],
  });
  const output = JSON.stringify({ schema_version: 1, worker: "backend", deployment: parsed });
  assert.match(output, /deployment-backend-current/u);
  assert.doesNotMatch(output, /operator@example\.invalid|private operator note|annotations|author_email/u);
});

test("capacity target assertion requires one exact active backend deployment", () => {
  const expected = parseDeploymentAssertionArguments([
    "--expected-deployment-id", "deployment-backend-current",
    "--expected-version-id", targetVersions.backend,
  ]);
  const sanitized = deploymentEvidence(JSON.stringify(deployment("backend", targetVersions.backend, "current")), "backend");
  assert.deepEqual(assertWorkerDeployment(JSON.stringify(sanitized), expected), sanitized);
  assert.throws(
    () => assertWorkerDeployment(JSON.stringify(sanitized), { ...expected, versionId: previousVersions.backend }),
    /does not match/u,
  );
  assert.throws(
    () => parseDeploymentAssertionArguments(["--expected-deployment-id", "bad id", "--expected-version-id", targetVersions.backend]),
    /invalid/u,
  );
});

test("post-deploy evidence polls through stale state and requires a new sole-active version", async () => {
  assert.equal(parseTransitionArguments(["--worker", "backend"]), "backend");
  assert.throws(() => parseTransitionArguments(["--worker", "unknown"]), /usage/u);
  const before = JSON.stringify(deploymentEvidence(
    JSON.stringify(deployment("backend", previousVersions.backend, "pre")),
    "backend",
  ));
  const responses = [
    deployment("backend", previousVersions.backend, "pre"),
    deployment("backend", previousVersions.backend, "different-id-same-version"),
    deployment("backend", targetVersions.backend, "post"),
  ];
  const sleeps = [];
  const result = await captureDeploymentTransition("backend", before, {
    attempts: 3,
    runCommand: async (_command, args) => {
      assert.deepEqual(args.slice(0, 5), ["--no-install", "wrangler", "deployments", "list", "--json"]);
      return { stdout: JSON.stringify(responses.shift()), exitCode: 0 };
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.equal(result.deployment.deployment_id, "deployment-backend-post");
  assert.equal(result.deployment.versions[0].version_id, targetVersions.backend);
  assert.deepEqual(sleeps, [2000, 2000]);

  await assert.rejects(
    captureDeploymentTransition("backend", before, {
      attempts: 1,
      runCommand: async () => ({
        stdout: JSON.stringify(deployment("backend", previousVersions.backend, "different-id-same-version")),
        exitCode: 0,
      }),
    }),
    /did not become visible/u,
  );
});

test("protected Wrangler wrapper allowlists commands and suppresses raw output", async () => {
  const deploymentRequest = parseProtectedWranglerArguments(["--operation", "deployments", "--worker", "backend"]);
  const calls = [];
  const result = await runProtectedWrangler(deploymentRequest, {
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify(deployment("backend", targetVersions.backend, "current")),
        exitCode: 0,
      };
    },
  });
  assert.equal(result.deployment.versions[0].version_id, targetVersions.backend);
  assert.deepEqual(calls[0].args, [
    "--no-install", "wrangler", "deployments", "list", "--json", "--config",
    "services/cloudflare-licensing-backend/wrangler.toml",
  ]);
  assert.equal(calls[0].options.env.WRANGLER_LOG, "error");
  assert.equal(calls[0].options.env.WRANGLER_WRITE_LOGS, "false");
  assert.throws(
    () => parseProtectedWranglerArguments(["--operation", "migrate", "--worker", "portal"]),
    /invalid/u,
  );
  const secret = "raw-sensitive-wrangler-output";
  await assert.rejects(
    runProtectedWrangler(parseProtectedWranglerArguments(["--operation", "deploy", "--worker", "admin"]), {
      runCommand: async () => { throw new Error(secret); },
    }),
    (error) => error instanceof Error && !error.message.includes(secret),
  );
});

function fixtureRoot({ omit } = {}) {
  const root = mkdtempSync(join(tmpdir(), "licensecc-worker-rollback-"));
  for (const [worker, relativePath] of Object.entries(configPaths)) {
    if (worker === omit) continue;
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `name = "fixture-${worker}"\n`, "utf8");
  }
  return root;
}

function workerFromArgs(args) {
  const configIndex = args.indexOf("--config");
  assert.notEqual(configIndex, -1, "every Wrangler command must use an owned config path");
  const config = args[configIndex + 1].replaceAll("\\", "/");
  for (const [worker, relativePath] of Object.entries(configPaths)) {
    if (config.endsWith(relativePath)) return worker;
  }
  assert.fail(`unexpected config path: ${config}`);
}

function deployment(worker, versionId, sequence) {
  return [{
    id: `deployment-${worker}-${sequence}`,
    created_on: sequence === "pre" ? "2026-08-30T10:00:00.000Z" : "2026-08-30T10:01:00.000Z",
    author_email: "operator@example.invalid",
    annotations: { "workers/message": "sensitive operator note" },
    versions: [{ version_id: versionId, percentage: 100 }],
  }];
}

function fakeRunner({ malformedVersionFor, mismatchVersionFor, malformedDeploymentFor, failValidationFor, failRollbackFor } = {}) {
  const calls = [];
  const rolledBack = new Set();
  const runCommand = async (command, args) => {
    assert.equal(command, "npx");
    calls.push([...args]);
    const worker = workerFromArgs(args);
    const operation = args[2];
    if (operation === "versions") {
      if (worker === failValidationFor) return { stdout: "", exitCode: 17 };
      if (worker === malformedVersionFor) return { stdout: "not-json", exitCode: 0 };
      const requestedId = args[4];
      return {
        stdout: JSON.stringify({
          id: worker === mismatchVersionFor ? previousVersions[worker] : requestedId,
          metadata: { created_on: "2026-08-29T09:00:00.000Z", author_email: "operator@example.invalid" },
          resources: { bindings: [{ type: "secret_text", name: "DO_NOT_DISCLOSE" }] },
        }),
        exitCode: 0,
      };
    }
    if (operation === "deployments") {
      if (worker === malformedDeploymentFor) return { stdout: "not-json", exitCode: 0 };
      const current = rolledBack.has(worker) ? targetVersions[worker] : previousVersions[worker];
      return { stdout: JSON.stringify(deployment(worker, current, rolledBack.has(worker) ? "post" : "pre")), exitCode: 0 };
    }
    if (operation === "rollback") {
      if (worker === failRollbackFor) return { stdout: "raw remote failure with secret metadata", exitCode: 1 };
      rolledBack.add(worker);
      return { stdout: "human-oriented Wrangler output that must stay redacted", exitCode: 0 };
    }
    assert.fail(`unexpected Wrangler operation: ${operation}`);
  };
  return { calls, runCommand };
}

function requestFor(workers) {
  return {
    environment: "production",
    workers,
    reason: "Incident INC-1234 approved rollback",
    versions: Object.fromEntries(Object.keys(configPaths).map((worker) => [worker, workers.includes(worker) ? targetVersions[worker] : ""])),
  };
}

function clock(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function assertSafeCode(error, code) {
  assert.ok(error instanceof SafeRollbackError);
  assert.equal(error.code, code);
  return true;
}

test("validates every target before rollback and emits only redacted deployment evidence", async () => {
  const root = fixtureRoot();
  const { calls, runCommand } = fakeRunner();
  try {
    const evidence = await rollbackWorkers(requestFor(["backend", "portal"]), {
      root,
      runCommand,
      now: clock(1_000, 1_010, 1_020, 1_030, 1_040, 1_050),
      sleep: async () => assert.fail("no post-deployment retry should be needed"),
    });

    assert.deepEqual(calls.slice(0, 4).map((args) => [args[2], workerFromArgs(args)]), [
      ["versions", "portal"],
      ["deployments", "portal"],
      ["versions", "backend"],
      ["deployments", "backend"],
    ]);
    assert.equal(calls.slice(0, 4).some((args) => args[2] === "rollback"), false);
    assert.deepEqual(calls.filter((args) => args[2] === "rollback").map((args) => workerFromArgs(args)), ["portal", "backend"]);
    for (const args of calls.filter((entry) => entry[2] === "rollback")) {
      assert.equal(args[3], targetVersions[workerFromArgs(args)]);
      assert.ok(args.includes("--yes"));
      assert.equal(args[args.indexOf("--message") + 1], "Incident INC-1234 approved rollback");
    }
    assert.equal(evidence.status, "succeeded");
    assert.equal(evidence.storage_action, "none");
    assert.equal(evidence.elapsed_ms, 50);
    assert.deepEqual(evidence.workers.map((worker) => worker.worker), ["portal", "backend"]);
    assert.deepEqual(evidence.workers.map((worker) => worker.elapsed_ms), [10, 10]);
    assert.deepEqual(evidence.workers.map((worker) => worker.post_deployment.versions), [
      [{ version_id: targetVersions.portal, percentage: 100 }],
      [{ version_id: targetVersions.backend, percentage: 100 }],
    ]);

    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /Incident INC-1234|operator@|sensitive operator|DO_NOT_DISCLOSE|wrangler\.jsonc|wrangler\.toml|human-oriented/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unknown arguments, invalid selections, missing IDs, and extra IDs", () => {
  const validArguments = [
    "--environment", "staging",
    "--workers", "backend",
    "--backend-version", targetVersions.backend,
    "--admin-version", "",
    "--portal-version", "",
    "--backup-version", "",
    "--reason", "Approved incident rollback",
  ];
  assert.equal(parseRollbackArguments(validArguments).environment, "staging");
  assert.throws(() => parseRollbackArguments([...validArguments, "--config", "other.toml"]), (error) => assertSafeCode(error, "UNKNOWN_ARGUMENT"));
  assert.throws(() => parseRollbackArguments(validArguments.with(3, "backend,unknown")), (error) => assertSafeCode(error, "INVALID_WORKER_SELECTION"));
  assert.throws(() => parseRollbackArguments(validArguments.with(5, "")), (error) => assertSafeCode(error, "INVALID_VERSION_ID"));
  assert.throws(() => parseRollbackArguments(validArguments.with(7, targetVersions.admin)), (error) => assertSafeCode(error, "UNEXPECTED_VERSION"));
  assert.throws(() => parseRollbackArguments(validArguments.with(3, "backend,backend")), (error) => assertSafeCode(error, "INVALID_WORKER_SELECTION"));
  assert.throws(() => parseRollbackArguments(validArguments.with(13, "line one\nline two")), (error) => assertSafeCode(error, "INVALID_REASON"));
});

test("requires all four exact materialized config paths before any remote command", async () => {
  const root = fixtureRoot({ omit: "backup" });
  let commandCount = 0;
  try {
    await assert.rejects(
      rollbackWorkers(requestFor(["backend"]), { root, runCommand: async () => { commandCount += 1; } }),
      (error) => assertSafeCode(error, "INVALID_CONFIG_PATH"),
    );
    assert.equal(commandCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed or mismatched Wrangler JSON prevents every rollback command", async () => {
  for (const runnerOptions of [{ malformedVersionFor: "portal" }, { mismatchVersionFor: "portal" }, { malformedDeploymentFor: "portal" }]) {
    const root = fixtureRoot();
    const { calls, runCommand } = fakeRunner(runnerOptions);
    try {
      await assert.rejects(
        rollbackWorkers(requestFor(["backend", "portal"]), { root, runCommand }),
        (error) => error instanceof SafeRollbackError && ["MALFORMED_VERSION_JSON", "INVALID_VERSION_RESPONSE", "MALFORMED_DEPLOYMENT_JSON"].includes(error.code),
      );
      assert.equal(calls.some((args) => args[2] === "rollback"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a validation command failure prevents mutation and a rollback failure stays redacted", async () => {
  const validationRoot = fixtureRoot();
  const validationRunner = fakeRunner({ failValidationFor: "backend" });
  try {
    await assert.rejects(
      rollbackWorkers(requestFor(["backend", "portal"]), { root: validationRoot, runCommand: validationRunner.runCommand }),
      (error) => assertSafeCode(error, "WRANGLER_COMMAND_FAILED"),
    );
    assert.equal(validationRunner.calls.some((args) => args[2] === "rollback"), false);
  } finally {
    rmSync(validationRoot, { recursive: true, force: true });
  }

  const rollbackRoot = fixtureRoot();
  const rollbackRunner = fakeRunner({ failRollbackFor: "backend" });
  try {
    let caught;
    await assert.rejects(
      rollbackWorkers(requestFor(["backend"]), { root: rollbackRoot, runCommand: rollbackRunner.runCommand }),
      (error) => {
        caught = error;
        return assertSafeCode(error, "WRANGLER_COMMAND_FAILED");
      },
    );
    const failureEvidence = safeFailureEvidence(caught);
    assert.equal(failureEvidence.environment, "production");
    assert.equal(failureEvidence.workers[0].status, "failed");
    assert.equal(failureEvidence.workers[0].post_deployment, null);
    assert.equal(failureEvidence.workers[0].pre_deployment.versions[0].version_id, previousVersions.backend);
    assert.doesNotMatch(JSON.stringify(failureEvidence), /remote failure|secret metadata|Incident INC-1234/u);
  } finally {
    rmSync(rollbackRoot, { recursive: true, force: true });
  }
});

test("manual workflow is environment-protected, exact-confirmed, config-complete, and storage-neutral", async () => {
  const workflow = await import("node:fs/promises").then(({ readFile }) => readFile(workflowPath, "utf8"));
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /type:\s*choice[\s\S]*options:\s*\n\s*- staging\s*\n\s*- production/u);
  assert.match(workflow, /if:\s*inputs\.confirmation == format\('rollback-\{0\}', inputs\.environment\) && github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /environment:\s*\$\{\{ inputs\.environment \}\}/u);
  assert.match(workflow, /group:\s*licensecc-\$\{\{ inputs\.environment \}\}-operations/u);
  assert.match(workflow, /cancel-in-progress:\s*false/u);
  assert.match(workflow, /persist-credentials:\s*false/u);
  assert.match(workflow, /ref:\s*\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/u);
  assert.match(workflow, /materialize-deploy-configs\.mjs --profile "\$ROLLBACK_ENVIRONMENT"/u);
  assert.match(workflow, /LICENSECC_EXPECTED_CLOUDFLARE_ACCOUNT_ID:\s*\$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/u);
  assert.match(workflow, /LICENSECC_EXPECTED_D1_DATABASE_ID:\s*\$\{\{ vars\.LICENSECC_D1_DATABASE_ID \}\}/u);
  for (const worker of ["BACKEND", "ADMIN", "PORTAL", "BACKUP"]) {
    const lowerWorker = worker.toLowerCase();
    assert.match(workflow, new RegExp(String.raw`${lowerWorker}_url:\n\s+description: Canonical HTTPS[^\n]*\n\s+required: true\n\s+type: string`, "u"));
    assert.match(workflow, new RegExp(String.raw`LICENSECC_${worker}_WRANGLER_CONFIG_B64: \$\{\{ secrets\.LICENSECC_${worker}_WRANGLER_CONFIG_B64 \}\}`, "u"));
    assert.match(workflow, new RegExp(String.raw`LICENSECC_EXPECTED_${worker}_ORIGIN: \$\{\{ inputs\.${lowerWorker}_url \}\}`, "u"));
    assert.match(workflow, new RegExp(String.raw`--${lowerWorker}-version "\$ROLLBACK_${worker}_VERSION"`, "u"));
    assert.match(workflow, new RegExp(String.raw`--${lowerWorker}-url "\$ROLLBACK_${worker}_URL"`, "u"));
  }
  assert.match(workflow, /node scripts\/rollback-workers\.mjs/u);
  assert.match(workflow, /set -o pipefail[\s\S]*node scripts\/rollback-workers\.mjs[\s\S]*\| tee "\$RUNNER_TEMP\/licensecc-rollback-evidence\/rollback\.json"/u);
  assert.match(workflow, /node scripts\/check-worker-rollback-health\.mjs/u);
  assert.match(workflow, /LICENSECC_ACCESS_JWT:\s*\$\{\{ secrets\.LICENSECC_ADMIN_ACCESS_JWT \}\}/u);
  assert.match(workflow, /\| tee "\$RUNNER_TEMP\/licensecc-rollback-evidence\/post-rollback-health\.json"/u);
  assert.match(workflow, /- name: Preserve redacted rollback evidence\n\s+if: always\(\)/u);
  assert.match(workflow, /path:\s*\$\{\{ runner\.temp \}\}\/licensecc-rollback-evidence/u);
  assert.match(workflow, /if-no-files-found:\s*error/u);
  assert.match(workflow, /retention-days:\s*30/u);
  assert.ok(workflow.indexOf("node scripts/rollback-workers.mjs") < workflow.indexOf("node scripts/check-worker-rollback-health.mjs"));
  assert.ok(workflow.indexOf("node scripts/check-worker-rollback-health.mjs") < workflow.indexOf("actions/upload-artifact@"));
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.doesNotMatch(workflow, /wrangler\s+d1|migrations\s+apply|d1\s+(?:execute|export)|restore/u);
});
