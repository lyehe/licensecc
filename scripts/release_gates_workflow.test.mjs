import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const WORKFLOW_PATH = ".github/workflows/release-gates.yml";

const REQUIRED_TRIGGER_PATHS = [
  ".github/workflows/release-gates.yml",
  ".gitignore",
  "scripts/assert_release_ready.mjs",
  "scripts/assert_release_ready.test.mjs",
  "scripts/build_docs.py",
  "scripts/check_docs_links.py",
  "scripts/external_gate_preflight.mjs",
  "scripts/external_gate_preflight.test.mjs",
  "scripts/release_gate_contract.mjs",
  "scripts/release_gate_contract.test.mjs",
  "scripts/release_gates_workflow.test.mjs",
  "scripts/secret_hygiene_scan.mjs",
  "scripts/secret_hygiene_scan.test.mjs",
  "scripts/validate_release_gates.mjs",
  "scripts/validate_release_gates.test.mjs",
  "scripts/workspace_hygiene_check.mjs",
  "scripts/workspace_hygiene_check.test.mjs",
  "services/cloudflare-d1-backup/package.json",
  "services/cloudflare-d1-backup/scripts/validate-deploy.mjs",
  "services/cloudflare-d1-backup/test/backup-validate-deploy.test.mjs",
  "services/cloudflare-license-admin/scripts/access-admin-drill.mjs",
  "services/cloudflare-license-admin/package.json",
  "services/cloudflare-license-admin/package-lock.json",
  "services/cloudflare-license-admin/playwright.config.mjs",
  "services/cloudflare-license-admin/scripts/staging-catalog-drill.mjs",
  "services/cloudflare-license-admin/src/ui/main.tsx",
  "services/cloudflare-license-admin/src/ui/operatorWorkflow.ts",
  "services/cloudflare-license-admin/src/ui/styles.css",
  "services/cloudflare-license-admin/test/access-validator.test.mjs",
  "services/cloudflare-license-admin/test/admin-ui.e2e.mjs",
  "services/cloudflare-license-admin/test/admin-ui-workflow.test.mjs",
  "services/cloudflare-licensing-backend/package.json",
  "services/cloudflare-licensing-backend/scripts/public-verifier-drill.mjs",
  "services/cloudflare-licensing-backend/test/db/db-conformance.test.mjs",
  "services/cloudflare-licensing-backend/test/e2e/catalog-admin-projection-flow.test.mjs",
  "services/cloudflare-licensing-backend/test/public-verifier-drill.test.mjs",
  "services/cloudflare-customer-portal/package.json",
  "services/cloudflare-customer-portal/package-lock.json",
  "services/cloudflare-customer-portal/scripts/staging-portal-drill.mjs",
  "services/cloudflare-customer-portal/test/staging-portal-drill.test.mjs",
  "doc/analysis/remaining-gap-closure-checklist.rst",
  "doc/usage/cloudflare-backups.rst",
  "README.md",
];

function workflowText() {
  return readFileSync(WORKFLOW_PATH, "utf8");
}

test("release gates workflow triggers on release tooling and ignore-rule changes", () => {
  const text = workflowText();
  for (const path of REQUIRED_TRIGGER_PATHS) {
    const quoted = `"${path}"`;
    const count = text.split(quoted).length - 1;
    assert.equal(count, 2, `${path} should appear once in push paths and once in pull_request paths`);
  }
});

test("release gates workflow runs script tests and secret scan without production secrets", () => {
  const text = workflowText();
  assert.match(text, /node --test/);
  assert.match(text, /scripts\/assert_release_ready\.test\.mjs/);
  assert.match(text, /scripts\/external_gate_preflight\.test\.mjs/);
  assert.match(text, /scripts\/release_gate_contract\.test\.mjs/);
  assert.match(text, /scripts\/release_gates_workflow\.test\.mjs/);
  assert.match(text, /scripts\/secret_hygiene_scan\.test\.mjs/);
  assert.match(text, /scripts\/validate_release_gates\.test\.mjs/);
  assert.match(text, /scripts\/workspace_hygiene_check\.test\.mjs/);
  assert.match(text, /services\/cloudflare-d1-backup\/test\/backup-validate-deploy\.test\.mjs/);
  assert.match(text, /services\/cloudflare-license-admin\/test\/admin-ui-workflow\.test\.mjs/);
  assert.match(text, /services\/cloudflare-license-admin\/test\/access-validator\.test\.mjs/);
  assert.match(text, /services\/cloudflare-licensing-backend\/test\/public-verifier-drill\.test\.mjs/);
  assert.match(text, /services\/cloudflare-customer-portal\/test\/staging-portal-drill\.test\.mjs/);
  assert.match(text, /node scripts\/secret_hygiene_scan\.mjs/);
  assert.match(text, /node scripts\/workspace_hygiene_check\.mjs/);
});

test("release gates workflow exercises strict external fail-fast without secrets", () => {
  const text = workflowText();
  assert.match(text, /Strict external gate fails fast without staging inputs/);
  assert.match(text, /node scripts\/validate_release_gates\.mjs --quick --require-external --json-out "\$summary"/);
  assert.match(text, /external_input_missing/);
  assert.match(text, /CTest metadata check/);
  assert.match(text, /strict external preflight reached local CTest prerequisite/);
});

test("release gates workflow rejects incomplete evidence in CI", () => {
  const text = workflowText();
  assert.match(text, /Incomplete evidence fails readiness assertion/);
  assert.match(text, /production_ready:false/);
  assert.match(text, /generated_at:new Date\(0\)\.toISOString\(\)/);
  assert.match(text, /command:'git diff --check'/);
  assert.match(text, /duration_ms:0/);
  assert.match(text, /external_gate_skipped/);
  assert.match(text, /backup_deploy:false/);
  assert.match(text, /public_verifier_abuse:false/);
  assert.match(text, /staging_catalog:false/);
  assert.match(text, /customer_portal:false/);
  assert.match(text, /node scripts\/assert_release_ready\.mjs "\$summary" >"\$output" 2>&1/);
  assert.match(text, /repository whitespace check command must match the release-gate contract/);
  assert.match(text, /partial release evidence did not exercise local command-contract validation/);
  assert.match(text, /partial release evidence was accepted/);
});

export {
  REQUIRED_TRIGGER_PATHS,
};
