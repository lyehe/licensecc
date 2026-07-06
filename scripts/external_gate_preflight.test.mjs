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
    "LICENSECC_CATALOG_PLAN_ID",
    "LICENSECC_CATALOG_LICENSE_ID",
    "LICENSECC_CATALOG_LICENSE_FINGERPRINT",
    "LICENSECC_CATALOG_PLAN_KEY",
    "LICENSECC_CATALOG_PROJECT",
    "LICENSECC_CATALOG_CUSTOMER_ID",
    "LICENSECC_CATALOG_SUPPORT_UNTIL",
    "LICENSECC_CATALOG_ADDONS",
    "LICENSECC_CATALOG_IMPORT_MANIFEST_JSON",
    "LICENSECC_CATALOG_ALLOW_MUTATION",
    "LICENSECC_PORTAL_URL",
    "LICENSECC_PORTAL_EMAIL",
    "LICENSECC_PORTAL_BOOTSTRAP_BEARER",
    "LICENSECC_PORTAL_ACCESS_JWT",
    "LICENSECC_PORTAL_ALLOW_SEAT_MUTATION",
    "LICENSECC_PORTAL_FLOATING_ENTITLEMENT_ID",
    "LICENSECC_PORTAL_ALLOW_DOWNLOAD",
    "LICENSECC_PORTAL_DOWNLOAD_ENTITLEMENT_ID",
    "LICENSECC_PORTAL_DEVICE_KEY_ID",
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
    "LICENSECC_ADMIN_URL",
    "LICENSECC_ACCESS_JWT",
    "LICENSECC_CATALOG_PLAN_ID",
    "LICENSECC_CATALOG_LICENSE_ID",
    "LICENSECC_CATALOG_LICENSE_FINGERPRINT",
    "LICENSECC_PORTAL_URL",
    "LICENSECC_PORTAL_EMAIL",
    "LICENSECC_PORTAL_BOOTSTRAP_BEARER",
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
    LICENSECC_CATALOG_PLAN_ID: "plan_1",
    LICENSECC_CATALOG_LICENSE_ID: "lic_1",
    LICENSECC_CATALOG_LICENSE_FINGERPRINT: "a".repeat(64),
    LICENSECC_PORTAL_URL: "https://portal.example",
    LICENSECC_PORTAL_EMAIL: "customer@example.com",
    LICENSECC_PORTAL_BOOTSTRAP_BEARER: "portal-bootstrap-secret",
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
    LICENSECC_CATALOG_PLAN_ID: "plan_1",
    LICENSECC_CATALOG_LICENSE_ID: "lic_1",
    LICENSECC_CATALOG_LICENSE_FINGERPRINT: "a".repeat(64),
    LICENSECC_PORTAL_URL: "https://portal.example",
    LICENSECC_PORTAL_EMAIL: "customer@example.com",
    LICENSECC_PORTAL_BOOTSTRAP_BEARER: "portal-bootstrap-secret",
  });
  assert.equal(result.gates.find((gate) => gate.id === "access_admin").ready, true);
  assert.equal(result.gates.find((gate) => gate.id === "staging_catalog").ready, false);
  assert.deepEqual(result.missing, ["LICENSECC_ACCESS_JWT"]);
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
    LICENSECC_CATALOG_PLAN_ID: "plan_1",
    LICENSECC_CATALOG_LICENSE_ID: "lic_1",
    LICENSECC_CATALOG_LICENSE_FINGERPRINT: "a".repeat(64),
    LICENSECC_PORTAL_URL: "https://portal.example",
    LICENSECC_PORTAL_EMAIL: "customer@example.com",
    LICENSECC_PORTAL_BOOTSTRAP_BEARER: "portal-bootstrap-secret",
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
    LICENSECC_CATALOG_PLAN_ID: "plan_1",
    LICENSECC_CATALOG_LICENSE_ID: "lic_1",
    LICENSECC_CATALOG_LICENSE_FINGERPRINT: "a".repeat(64),
    LICENSECC_CATALOG_PLAN_KEY: "pro",
    LICENSECC_PORTAL_URL: "https://portal.example",
    LICENSECC_PORTAL_EMAIL: "customer@example.com",
    LICENSECC_PORTAL_BOOTSTRAP_BEARER: "portal-bootstrap-secret",
    LICENSECC_PORTAL_ACCESS_JWT: "portal-access-jwt",
  });
  assert.equal(result.ready, true);
  assert.equal(JSON.stringify(result).includes("optional-secret-token-value"), false);
  assert.equal(JSON.stringify(result).includes("portal-access-jwt"), false);
  const accessGate = result.gates.find((gate) => gate.id === "access_admin");
  assert.equal(accessGate.optional[0].present, true);
  const backupGate = result.gates.find((gate) => gate.id === "backup_deploy");
  assert.equal(backupGate.optional[0].present, true);
  const catalogGate = result.gates.find((gate) => gate.id === "staging_catalog");
  assert.equal(catalogGate.optional.find((item) => item.name === "LICENSECC_CATALOG_PLAN_KEY").present, true);
  const portalGate = result.gates.find((gate) => gate.id === "customer_portal");
  assert.equal(portalGate.optional.find((item) => item.name === "LICENSECC_PORTAL_ACCESS_JWT").present, true);
});
