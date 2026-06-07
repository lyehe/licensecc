import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCESS_DRILL_COMMAND_TEMPLATE,
  BACKUP_DEPLOY_COMMAND_REQUIRED_TOKENS,
  BOOLEAN_SUMMARY_KEYS,
  EXTERNAL_GATE_ENV_NAMES,
  EXTERNAL_GATE_GROUPS,
  EXTERNAL_INPUT_KEYS,
  PUBLIC_VERIFIER_ABUSE_COMMAND_TEMPLATE,
  R2_RESTORE_COMMAND_OPTIONAL_PLACEHOLDERS,
  R2_RESTORE_COMMAND_OPTIONAL_STATUS_VALUES,
  R2_RESTORE_COMMAND_REQUIRED_TOKENS,
  REQUIRED_EXTERNAL_RESULTS,
  REQUIRED_LOCAL_COMMANDS,
  REQUIRED_LOCAL_RESULTS,
  SKIPPED_EXTERNAL_COMMANDS,
} from "./release_gate_contract.mjs";

function assertUniqueTrimmedStrings(values, label) {
  assert.equal(Array.isArray(values), true, `${label} must be an array`);
  const seen = new Set();
  for (const value of values) {
    assert.equal(typeof value, "string", `${label} values must be strings`);
    assert.equal(value, value.trim(), `${label} values must be trimmed`);
    assert.notEqual(value, "", `${label} values must be nonempty`);
    assert.equal(seen.has(value), false, `${label} values must be unique: ${value}`);
    seen.add(value);
  }
}

test("release gate contract labels are unique and disjoint", () => {
  assertUniqueTrimmedStrings(REQUIRED_LOCAL_RESULTS, "required local results");
  assertUniqueTrimmedStrings(REQUIRED_EXTERNAL_RESULTS, "required external results");
  for (const label of REQUIRED_EXTERNAL_RESULTS) {
    assert.equal(REQUIRED_LOCAL_RESULTS.includes(label), false, `${label} must not be local and external`);
  }
  assert.equal(REQUIRED_LOCAL_RESULTS.includes("workspace hygiene checker tests"), true);
  assert.equal(REQUIRED_LOCAL_RESULTS.includes("release gate contract tests"), true);
  assert.equal(REQUIRED_EXTERNAL_RESULTS.includes("Cloudflare Access admin staging drill"), true);
  assert.equal(REQUIRED_EXTERNAL_RESULTS.includes("Cloudflare R2 backup restore staging drill"), true);
  assert.equal(REQUIRED_EXTERNAL_RESULTS.includes("Cloudflare backup deployment staging drill"), true);
  assert.equal(REQUIRED_EXTERNAL_RESULTS.includes("Cloudflare public verifier abuse staging drill"), true);
});

test("release gate contract external gate groups are authoritative", () => {
  assert.deepEqual(EXTERNAL_GATE_GROUPS.map((group) => group.id), [
    "access_admin",
    "r2_restore",
    "backup_deploy",
    "public_verifier_abuse",
  ]);
  assert.deepEqual(EXTERNAL_GATE_GROUPS.map((group) => group.label), REQUIRED_EXTERNAL_RESULTS);
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
  for (const group of EXTERNAL_GATE_GROUPS) {
    assert.equal(Array.isArray(group.required), true);
    assert.notEqual(group.required.length, 0);
    assert.equal(Array.isArray(group.credential_alternatives ?? []), true);
    assert.equal(Array.isArray(group.optional), true);
    for (const variable of [...group.required, ...(group.credential_alternatives ?? []), ...group.optional]) {
      assert.equal(typeof variable.name, "string");
      assert.match(variable.name, /^LICENSECC_[A-Z0-9_]+$/);
      assert.equal(typeof variable.secret, "boolean");
    }
  }
});

test("release gate contract summary and external input keys are stable", () => {
  assert.deepEqual(BOOLEAN_SUMMARY_KEYS, [
    "ok",
    "complete",
    "production_ready",
    "quick",
    "full",
    "external",
    "require_external",
  ]);
  assert.deepEqual(EXTERNAL_INPUT_KEYS, [
    "access_admin",
    "access_non_admin_jwt",
    "r2_restore",
    "backup_deploy",
    "public_verifier_abuse",
  ]);
});

test("release gate contract pins required local command evidence", () => {
  assert.deepEqual([...REQUIRED_LOCAL_COMMANDS.keys()], REQUIRED_LOCAL_RESULTS);
  assert.equal(REQUIRED_LOCAL_COMMANDS.get("repository whitespace check"), "node scripts/workspace_hygiene_check.mjs");
  assert.equal(REQUIRED_LOCAL_COMMANDS.get("admin UI build"), "npm --prefix services/cloudflare-license-admin run build:ui");
  assert.equal(REQUIRED_LOCAL_COMMANDS.get("admin UI workflow tests"), "npm --prefix services/cloudflare-license-admin run test:ui");
  assert.equal(REQUIRED_LOCAL_COMMANDS.get("admin UI browser e2e"), "npm --prefix services/cloudflare-license-admin run test:e2e");
  assert.equal(REQUIRED_LOCAL_COMMANDS.get("documentation build"), "uv run --no-project python scripts/build_docs.py");
  assert.equal(
    REQUIRED_LOCAL_COMMANDS.get("focused C++ security/API tests"),
    "ctest --test-dir build -C Debug -R test_(public_api|anti_tamper|online_verification|ctest_label_audit)$ --output-on-failure",
  );
  assert.equal(REQUIRED_LOCAL_COMMANDS.get("full CTest suite"), "ctest --test-dir build -C Debug --output-on-failure --timeout 900");
  for (const command of REQUIRED_LOCAL_COMMANDS.values()) {
    assert.equal(typeof command, "string");
    assert.equal(command, command.trim());
    assert.notEqual(command, "");
    assert.equal(command.includes("LICENSECC_ACCESS_JWT"), false);
    assert.equal(command.includes("ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM"), false);
  }
});

test("release gate contract command templates stay redacted", () => {
  assert.equal(ACCESS_DRILL_COMMAND_TEMPLATE, "node services/cloudflare-license-admin/scripts/access-admin-drill.mjs --url <redacted-admin-url>");
  assert.equal(ACCESS_DRILL_COMMAND_TEMPLATE.includes("https://"), false);
  assert.equal(ACCESS_DRILL_COMMAND_TEMPLATE.includes("<redacted-admin-url>"), true);

  assert.deepEqual(R2_RESTORE_COMMAND_REQUIRED_TOKENS, [
    "node",
    "services/cloudflare-d1-backup/scripts/restore-drill.mjs",
    "--bucket",
    "<redacted-r2-bucket>",
    "--object-key",
    "<redacted-r2-object-key>",
    "--scratch-database",
    "<redacted-scratch-d1>",
    "--confirm-scratch",
    "--remote",
  ]);
  for (const token of R2_RESTORE_COMMAND_REQUIRED_TOKENS) {
    assert.equal(token.includes("licensecc-d1-backups"), false);
    assert.equal(token.includes("backup.sql"), false);
  }
  for (const [flag, placeholder] of R2_RESTORE_COMMAND_OPTIONAL_PLACEHOLDERS.entries()) {
    assert.match(flag, /^--[a-z0-9-]+$/);
    assert.match(placeholder, /^<redacted-[a-z0-9-]+>$/);
  }
  assert.deepEqual([...R2_RESTORE_COMMAND_OPTIONAL_STATUS_VALUES].sort(), ["active", "disabled", "revoked"]);

  assert.deepEqual(BACKUP_DEPLOY_COMMAND_REQUIRED_TOKENS, [
    "node",
    "services/cloudflare-d1-backup/scripts/validate-deploy.mjs",
    "--url",
    "<redacted-backup-url>",
    "--worker-name",
    "<redacted-backup-worker>",
    "--workflow-name",
    "<redacted-backup-workflow>",
    "--require-d1-rest-token",
    "--json",
  ]);
  for (const token of BACKUP_DEPLOY_COMMAND_REQUIRED_TOKENS) {
    assert.equal(token.includes("workers.dev"), false);
    assert.equal(token.includes("licensecc-d1-backup-test"), false);
  }

  assert.equal(PUBLIC_VERIFIER_ABUSE_COMMAND_TEMPLATE, "node services/cloudflare-online-verifier/scripts/public-verifier-drill.mjs --url <redacted-verifier-url> --expect-rate-limit --json");
  assert.equal(PUBLIC_VERIFIER_ABUSE_COMMAND_TEMPLATE.includes("https://"), false);
  assert.equal(PUBLIC_VERIFIER_ABUSE_COMMAND_TEMPLATE.includes("<redacted-verifier-url>"), true);
});

test("release gate contract skipped external commands stay generic", () => {
  assert.deepEqual([...SKIPPED_EXTERNAL_COMMANDS.keys()], REQUIRED_EXTERNAL_RESULTS);
  assert.deepEqual([...SKIPPED_EXTERNAL_COMMANDS.values()], [
    "not run: Cloudflare Access admin staging drill",
    "not run: Cloudflare R2 backup restore staging drill",
    "not run: Cloudflare backup deployment staging drill",
    "not run: Cloudflare public verifier abuse staging drill",
  ]);
  for (const command of SKIPPED_EXTERNAL_COMMANDS.values()) {
    assert.equal(command.includes("https://"), false);
    assert.equal(command.includes("--bucket"), false);
    assert.equal(command.includes("--object-key"), false);
    assert.equal(command.includes("--scratch-database"), false);
    assert.equal(command.includes("--worker-name"), false);
  }
});
