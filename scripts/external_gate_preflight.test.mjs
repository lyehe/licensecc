import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXTERNAL_GATE_ENV_NAMES,
  EXTERNAL_GATE_GROUPS,
  analyzeExternalGateEnv,
  parseArgs,
} from "./external_gate_preflight.mjs";
import {
  EXTERNAL_GATE_ENV_NAMES as CONTRACT_EXTERNAL_GATE_ENV_NAMES,
  EXTERNAL_GATE_GROUPS as CONTRACT_EXTERNAL_GATE_GROUPS,
} from "./release_gate_contract.mjs";

test("external gate preflight parser accepts json mode", () => {
  const options = parseArgs(["node", "external_gate_preflight.mjs", "--json"]);
  assert.equal(options.json, true);
});

test("external gate preflight exports every release staging input name", () => {
  assert.equal(EXTERNAL_GATE_GROUPS, CONTRACT_EXTERNAL_GATE_GROUPS);
  assert.equal(EXTERNAL_GATE_ENV_NAMES, CONTRACT_EXTERNAL_GATE_ENV_NAMES);
  assert.deepEqual(EXTERNAL_GATE_ENV_NAMES, [
    "LICENSECC_ADMIN_URL",
    "LICENSECC_ACCESS_JWT",
    "LICENSECC_ACCESS_USE_CLOUDFLARED",
    "LICENSECC_NON_ADMIN_ACCESS_JWT",
    "LICENSECC_R2_BACKUP_BUCKET",
    "LICENSECC_R2_BACKUP_OBJECT_KEY",
    "LICENSECC_RESTORE_SCRATCH_D1",
    "LICENSECC_RESTORE_SOURCE_D1",
    "LICENSECC_RESTORE_SCRATCH_CONFIG",
    "LICENSECC_RESTORE_SOURCE_CONFIG",
    "LICENSECC_RESTORE_R2_CONFIG",
    "LICENSECC_RESTORE_REQUIRE_STATUSES",
    "LICENSECC_BACKUP_URL",
    "LICENSECC_BACKUP_WORKER_NAME",
    "LICENSECC_BACKUP_WORKFLOW_NAME",
    "LICENSECC_VERIFIER_URL",
  ]);
});

test("external gate preflight reports missing required inputs without values", () => {
  const result = analyzeExternalGateEnv({});
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, [
    "LICENSECC_ADMIN_URL",
    "LICENSECC_ACCESS_JWT or LICENSECC_ACCESS_USE_CLOUDFLARED",
    "LICENSECC_R2_BACKUP_BUCKET",
    "LICENSECC_R2_BACKUP_OBJECT_KEY",
    "LICENSECC_RESTORE_SCRATCH_D1",
    "LICENSECC_BACKUP_URL",
    "LICENSECC_BACKUP_WORKER_NAME",
    "LICENSECC_VERIFIER_URL",
  ]);
  assert.equal(JSON.stringify(result).includes("secret-token-value"), false);
});

test("external gate preflight marks ready when required inputs are present", () => {
  const result = analyzeExternalGateEnv({
    LICENSECC_ADMIN_URL: "https://admin.example",
    LICENSECC_ACCESS_JWT: "secret-token-value",
    LICENSECC_R2_BACKUP_BUCKET: "bucket",
    LICENSECC_R2_BACKUP_OBJECT_KEY: "backup.sql",
    LICENSECC_RESTORE_SCRATCH_D1: "scratch-db",
    LICENSECC_BACKUP_URL: "https://backup.example",
    LICENSECC_BACKUP_WORKER_NAME: "licensecc-d1-backup",
    LICENSECC_VERIFIER_URL: "https://verifier.example",
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
  assert.equal(JSON.stringify(result).includes("secret-token-value"), false);
  assert.equal(result.gates[0].credential_alternatives.find((item) => item.name === "LICENSECC_ACCESS_JWT").secret, true);
  assert.equal(result.gates[0].credential_alternatives.find((item) => item.name === "LICENSECC_ACCESS_USE_CLOUDFLARED").secret, false);
});

test("external gate preflight accepts cached cloudflared token mode", () => {
  const result = analyzeExternalGateEnv({
    LICENSECC_ADMIN_URL: "https://admin.example",
    LICENSECC_ACCESS_USE_CLOUDFLARED: "1",
    LICENSECC_R2_BACKUP_BUCKET: "bucket",
    LICENSECC_R2_BACKUP_OBJECT_KEY: "backup.sql",
    LICENSECC_RESTORE_SCRATCH_D1: "scratch-db",
    LICENSECC_BACKUP_URL: "https://backup.example",
    LICENSECC_BACKUP_WORKER_NAME: "licensecc-d1-backup",
    LICENSECC_VERIFIER_URL: "https://verifier.example",
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
});

test("external gate preflight requires a truthy cloudflared token flag", () => {
  const result = analyzeExternalGateEnv({
    LICENSECC_ADMIN_URL: "https://admin.example",
    LICENSECC_ACCESS_USE_CLOUDFLARED: "0",
    LICENSECC_R2_BACKUP_BUCKET: "bucket",
    LICENSECC_R2_BACKUP_OBJECT_KEY: "backup.sql",
    LICENSECC_RESTORE_SCRATCH_D1: "scratch-db",
    LICENSECC_BACKUP_URL: "https://backup.example",
    LICENSECC_BACKUP_WORKER_NAME: "licensecc-d1-backup",
    LICENSECC_VERIFIER_URL: "https://verifier.example",
  });
  assert.equal(result.ready, false);
  assert.equal(result.gates.find((gate) => gate.id === "access_admin").ready, false);
});

test("external gate preflight treats optional inputs as non-blocking", () => {
  const result = analyzeExternalGateEnv({
    LICENSECC_ADMIN_URL: "https://admin.example",
    LICENSECC_ACCESS_JWT: "secret-token-value",
    LICENSECC_NON_ADMIN_ACCESS_JWT: "optional-secret-token-value",
    LICENSECC_R2_BACKUP_BUCKET: "bucket",
    LICENSECC_R2_BACKUP_OBJECT_KEY: "backup.sql",
    LICENSECC_RESTORE_SCRATCH_D1: "scratch-db",
    LICENSECC_RESTORE_SOURCE_D1: "source-db",
    LICENSECC_BACKUP_URL: "https://backup.example",
    LICENSECC_BACKUP_WORKER_NAME: "licensecc-d1-backup",
    LICENSECC_BACKUP_WORKFLOW_NAME: "licensecc-d1-backup-workflow",
    LICENSECC_VERIFIER_URL: "https://verifier.example",
  });
  assert.equal(result.ready, true);
  assert.equal(JSON.stringify(result).includes("optional-secret-token-value"), false);
  const accessGate = result.gates.find((gate) => gate.id === "access_admin");
  assert.equal(accessGate.optional[0].present, true);
  const backupGate = result.gates.find((gate) => gate.id === "backup_deploy");
  assert.equal(backupGate.optional[0].present, true);
});
