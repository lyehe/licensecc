const ACCESS_ADMIN_GATE_ID = "access_admin";
const R2_RESTORE_GATE_ID = "r2_restore";
const BACKUP_DEPLOY_GATE_ID = "backup_deploy";
const PUBLIC_VERIFIER_ABUSE_GATE_ID = "public_verifier_abuse";
const STAGING_CATALOG_GATE_ID = "staging_catalog";
const CUSTOMER_PORTAL_GATE_ID = "customer_portal";

const ACCESS_ADMIN_URL_ENV = "LICENSECC_ADMIN_URL";
const ACCESS_JWT_ENV = "LICENSECC_ACCESS_JWT";
const ACCESS_USE_CLOUDFLARED_ENV = "LICENSECC_ACCESS_USE_CLOUDFLARED";
const ACCESS_NON_ADMIN_JWT_ENV = "LICENSECC_NON_ADMIN_ACCESS_JWT";

const R2_BACKUP_BUCKET_ENV = "LICENSECC_R2_BACKUP_BUCKET";
const R2_BACKUP_OBJECT_KEY_ENV = "LICENSECC_R2_BACKUP_OBJECT_KEY";
const R2_RESTORE_SCRATCH_D1_ENV = "LICENSECC_RESTORE_SCRATCH_D1";
const R2_RESTORE_SOURCE_D1_ENV = "LICENSECC_RESTORE_SOURCE_D1";
const R2_RESTORE_SCRATCH_CONFIG_ENV = "LICENSECC_RESTORE_SCRATCH_CONFIG";
const R2_RESTORE_SOURCE_CONFIG_ENV = "LICENSECC_RESTORE_SOURCE_CONFIG";
const R2_RESTORE_R2_CONFIG_ENV = "LICENSECC_RESTORE_R2_CONFIG";
const R2_RESTORE_REQUIRE_STATUSES_ENV = "LICENSECC_RESTORE_REQUIRE_STATUSES";

const BACKUP_DEPLOY_URL_ENV = "LICENSECC_BACKUP_URL";
const BACKUP_DEPLOY_WORKER_NAME_ENV = "LICENSECC_BACKUP_WORKER_NAME";
const BACKUP_DEPLOY_WORKFLOW_NAME_ENV = "LICENSECC_BACKUP_WORKFLOW_NAME";

const PUBLIC_VERIFIER_URL_ENV = "LICENSECC_VERIFIER_URL";

const CATALOG_PLAN_ID_ENV = "LICENSECC_CATALOG_PLAN_ID";
const CATALOG_PLAN_KEY_ENV = "LICENSECC_CATALOG_PLAN_KEY";
const CATALOG_LICENSE_ID_ENV = "LICENSECC_CATALOG_LICENSE_ID";
const CATALOG_LICENSE_FINGERPRINT_ENV = "LICENSECC_CATALOG_LICENSE_FINGERPRINT";
const CATALOG_PROJECT_ENV = "LICENSECC_CATALOG_PROJECT";
const CATALOG_CUSTOMER_ID_ENV = "LICENSECC_CATALOG_CUSTOMER_ID";
const CATALOG_SUPPORT_UNTIL_ENV = "LICENSECC_CATALOG_SUPPORT_UNTIL";
const CATALOG_ADDONS_ENV = "LICENSECC_CATALOG_ADDONS";
const CATALOG_IMPORT_MANIFEST_JSON_ENV = "LICENSECC_CATALOG_IMPORT_MANIFEST_JSON";
const CATALOG_ALLOW_MUTATION_ENV = "LICENSECC_CATALOG_ALLOW_MUTATION";

const PORTAL_URL_ENV = "LICENSECC_PORTAL_URL";
const PORTAL_EMAIL_ENV = "LICENSECC_PORTAL_EMAIL";
const PORTAL_BOOTSTRAP_BEARER_ENV = "LICENSECC_PORTAL_BOOTSTRAP_BEARER";
const PORTAL_ACCESS_JWT_ENV = "LICENSECC_PORTAL_ACCESS_JWT";
const PORTAL_ALLOW_SEAT_MUTATION_ENV = "LICENSECC_PORTAL_ALLOW_SEAT_MUTATION";
const PORTAL_FLOATING_ENTITLEMENT_ID_ENV = "LICENSECC_PORTAL_FLOATING_ENTITLEMENT_ID";
const PORTAL_ALLOW_DOWNLOAD_ENV = "LICENSECC_PORTAL_ALLOW_DOWNLOAD";
const PORTAL_DOWNLOAD_ENTITLEMENT_ID_ENV = "LICENSECC_PORTAL_DOWNLOAD_ENTITLEMENT_ID";
const PORTAL_DEVICE_KEY_ID_ENV = "LICENSECC_PORTAL_DEVICE_KEY_ID";

const EXTERNAL_GATE_GROUPS = [
  {
    id: ACCESS_ADMIN_GATE_ID,
    label: "Cloudflare Access admin staging drill",
    required: [
      { name: ACCESS_ADMIN_URL_ENV, secret: false },
    ],
    credential_alternatives: [
      { name: ACCESS_JWT_ENV, secret: true },
      { name: ACCESS_USE_CLOUDFLARED_ENV, secret: false, truthy: true },
    ],
    optional: [
      { name: ACCESS_NON_ADMIN_JWT_ENV, secret: true },
    ],
  },
  {
    id: R2_RESTORE_GATE_ID,
    label: "Cloudflare R2 backup restore staging drill",
    required: [
      { name: R2_BACKUP_BUCKET_ENV, secret: false },
      { name: R2_BACKUP_OBJECT_KEY_ENV, secret: false },
      { name: R2_RESTORE_SCRATCH_D1_ENV, secret: false },
    ],
    optional: [
      { name: R2_RESTORE_SOURCE_D1_ENV, secret: false },
      { name: R2_RESTORE_SCRATCH_CONFIG_ENV, secret: false },
      { name: R2_RESTORE_SOURCE_CONFIG_ENV, secret: false },
      { name: R2_RESTORE_R2_CONFIG_ENV, secret: false },
      { name: R2_RESTORE_REQUIRE_STATUSES_ENV, secret: false },
    ],
  },
  {
    id: BACKUP_DEPLOY_GATE_ID,
    label: "Cloudflare backup deployment staging drill",
    required: [
      { name: BACKUP_DEPLOY_URL_ENV, secret: false },
      { name: BACKUP_DEPLOY_WORKER_NAME_ENV, secret: false },
    ],
    optional: [
      { name: BACKUP_DEPLOY_WORKFLOW_NAME_ENV, secret: false },
    ],
  },
  {
    id: PUBLIC_VERIFIER_ABUSE_GATE_ID,
    label: "Cloudflare public verifier abuse staging drill",
    required: [
      { name: PUBLIC_VERIFIER_URL_ENV, secret: false },
    ],
    optional: [],
  },
  {
    id: STAGING_CATALOG_GATE_ID,
    label: "Cloudflare catalog projection staging drill",
    required: [
      { name: ACCESS_ADMIN_URL_ENV, secret: false },
      { name: ACCESS_JWT_ENV, secret: true },
      { name: CATALOG_PLAN_ID_ENV, secret: false },
      { name: CATALOG_LICENSE_ID_ENV, secret: false },
      { name: CATALOG_LICENSE_FINGERPRINT_ENV, secret: false },
    ],
    optional: [
      { name: CATALOG_PLAN_KEY_ENV, secret: false },
      { name: CATALOG_PROJECT_ENV, secret: false },
      { name: CATALOG_CUSTOMER_ID_ENV, secret: false },
      { name: CATALOG_SUPPORT_UNTIL_ENV, secret: false },
      { name: CATALOG_ADDONS_ENV, secret: false },
      { name: CATALOG_IMPORT_MANIFEST_JSON_ENV, secret: false },
      { name: CATALOG_ALLOW_MUTATION_ENV, secret: false },
    ],
  },
  {
    id: CUSTOMER_PORTAL_GATE_ID,
    label: "Cloudflare customer portal staging drill",
    required: [
      { name: PORTAL_URL_ENV, secret: false },
      { name: PORTAL_EMAIL_ENV, secret: false },
      { name: PORTAL_BOOTSTRAP_BEARER_ENV, secret: true },
    ],
    optional: [
      { name: PORTAL_ACCESS_JWT_ENV, secret: true },
      { name: PORTAL_ALLOW_SEAT_MUTATION_ENV, secret: false },
      { name: PORTAL_FLOATING_ENTITLEMENT_ID_ENV, secret: false },
      { name: PORTAL_ALLOW_DOWNLOAD_ENV, secret: false },
      { name: PORTAL_DOWNLOAD_ENTITLEMENT_ID_ENV, secret: false },
      { name: PORTAL_DEVICE_KEY_ID_ENV, secret: false },
    ],
  },
];

const REQUIRED_EXTERNAL_RESULTS = EXTERNAL_GATE_GROUPS.map((group) => group.label);

const EXTERNAL_GATE_ENV_NAMES = [...new Set(EXTERNAL_GATE_GROUPS.flatMap((group) => [
  ...group.required.map((variable) => variable.name),
  ...(group.credential_alternatives ?? []).map((variable) => variable.name),
  ...group.optional.map((variable) => variable.name),
]))];

const REQUIRED_LOCAL_RESULTS = [
  "repository whitespace check",
  "workspace hygiene checker tests",
  "secret hygiene scanner tests",
  "secret hygiene scan",
  "release readiness assertion tests",
  "external gate preflight tests",
  "release gate contract tests",
  "release gates workflow coverage tests",
  "release gate runner tests",
  "online verifier/admin local e2e",
  "admin Worker tests",
  "admin Worker lint",
  "admin UI build",
  "admin UI workflow tests",
  "admin UI browser e2e",
  "customer portal tests",
  "customer portal lint",
  "customer portal UI build",
  "customer portal UI workflow tests",
  "customer portal browser e2e",
  "online verifier tests",
  "online verifier schema parity",
  "online verifier lint",
  "D1 backup tests",
  "D1 backup lint",
  "Access admin validator help",
  "Access admin drill help",
  "D1 restore drill help",
  "documentation link check",
  "documentation build",
  "admin Worker dry-run",
  "customer portal dry-run",
  "online verifier dry-run",
  "D1 backup dry-run",
  "focused C++ security/API tests",
  "full CTest suite",
];

const REQUIRED_LOCAL_COMMANDS = new Map([
  ["repository whitespace check", "node scripts/workspace_hygiene_check.mjs"],
  ["workspace hygiene checker tests", "node --test scripts/workspace_hygiene_check.test.mjs"],
  ["secret hygiene scanner tests", "node --test scripts/secret_hygiene_scan.test.mjs"],
  ["secret hygiene scan", "node scripts/secret_hygiene_scan.mjs"],
  ["release readiness assertion tests", "node --test scripts/assert_release_ready.test.mjs"],
  ["external gate preflight tests", "node --test scripts/external_gate_preflight.test.mjs"],
  ["release gate contract tests", "node --test scripts/release_gate_contract.test.mjs"],
  ["release gates workflow coverage tests", "node --test scripts/release_gates_workflow.test.mjs"],
  ["release gate runner tests", "node --test scripts/validate_release_gates.test.mjs"],
  ["online verifier/admin local e2e", "npm --prefix services/cloudflare-licensing-backend run test:e2e"],
  ["admin Worker tests", "npm --prefix services/cloudflare-license-admin test"],
  ["admin Worker lint", "npm --prefix services/cloudflare-license-admin run lint"],
  ["admin UI build", "npm --prefix services/cloudflare-license-admin run build:ui"],
  ["admin UI workflow tests", "npm --prefix services/cloudflare-license-admin run test:ui"],
  ["admin UI browser e2e", "npm --prefix services/cloudflare-license-admin run test:e2e"],
  ["customer portal tests", "npm --prefix services/cloudflare-customer-portal test"],
  ["customer portal lint", "npm --prefix services/cloudflare-customer-portal run lint"],
  ["customer portal UI build", "npm --prefix services/cloudflare-customer-portal run build:ui"],
  ["customer portal UI workflow tests", "npm --prefix services/cloudflare-customer-portal run test:ui"],
  ["customer portal browser e2e", "npm --prefix services/cloudflare-customer-portal run test:e2e"],
  ["online verifier tests", "npm --prefix services/cloudflare-licensing-backend test"],
  ["online verifier schema parity", "npm --prefix services/cloudflare-licensing-backend run schema:parity"],
  ["online verifier lint", "npm --prefix services/cloudflare-licensing-backend run lint"],
  ["D1 backup tests", "npm --prefix services/cloudflare-d1-backup test"],
  ["D1 backup lint", "npm --prefix services/cloudflare-d1-backup run lint"],
  ["Access admin validator help", "node services/cloudflare-license-admin/scripts/validate-access-admin.mjs --help"],
  ["Access admin drill help", "node services/cloudflare-license-admin/scripts/access-admin-drill.mjs --help"],
  ["D1 restore drill help", "node services/cloudflare-d1-backup/scripts/restore-drill.mjs --help"],
  ["documentation link check", "uv run --no-project python scripts/check_docs_links.py doc"],
  ["documentation build", "uv run --no-project python scripts/build_docs.py"],
  ["admin Worker dry-run", "npm --prefix services/cloudflare-license-admin run dry-run"],
  ["customer portal dry-run", "npm --prefix services/cloudflare-customer-portal run dry-run"],
  ["online verifier dry-run", "npm --prefix services/cloudflare-licensing-backend run dry-run"],
  ["D1 backup dry-run", "npm --prefix services/cloudflare-d1-backup run dry-run"],
  [
    "focused C++ security/API tests",
    "ctest --test-dir build -C Debug -R test_(public_api|anti_tamper|online_verification|online_callback_failover|ctest_label_audit)$ --output-on-failure",
  ],
  ["full CTest suite", "ctest --test-dir build -C Debug --output-on-failure --timeout 900"],
]);

const EXTERNAL_INPUT_KEYS = [
  "access_admin",
  "access_non_admin_jwt",
  "r2_restore",
  "backup_deploy",
  "public_verifier_abuse",
  "staging_catalog",
  "customer_portal",
];

const BOOLEAN_SUMMARY_KEYS = [
  "ok",
  "complete",
  "production_ready",
  "quick",
  "full",
  "external",
  "require_external",
];

const ACCESS_DRILL_COMMAND_TEMPLATE =
  "node services/cloudflare-license-admin/scripts/access-admin-drill.mjs --url <redacted-admin-url>";

const SKIPPED_EXTERNAL_COMMANDS = new Map(
  REQUIRED_EXTERNAL_RESULTS.map((label) => [label, `not run: ${label}`]),
);

const R2_RESTORE_COMMAND_REQUIRED_TOKENS = [
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
];

const R2_RESTORE_COMMAND_OPTIONAL_PLACEHOLDERS = new Map([
  ["--source-database", "<redacted-source-d1>"],
  ["--scratch-config", "<redacted-scratch-config>"],
  ["--source-config", "<redacted-source-config>"],
  ["--r2-config", "<redacted-r2-config>"],
]);

const R2_RESTORE_COMMAND_OPTIONAL_STATUS_VALUES = new Set(["active", "revoked", "disabled"]);

const BACKUP_DEPLOY_COMMAND_REQUIRED_TOKENS = [
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
];

const PUBLIC_VERIFIER_ABUSE_COMMAND_TEMPLATE =
  "node services/cloudflare-licensing-backend/scripts/public-verifier-drill.mjs --url <redacted-verifier-url> --expect-rate-limit --json";

const STAGING_CATALOG_COMMAND_TEMPLATE =
  "node services/cloudflare-license-admin/scripts/staging-catalog-drill.mjs";

const CUSTOMER_PORTAL_COMMAND_TEMPLATE =
  "node services/cloudflare-customer-portal/scripts/staging-portal-drill.mjs";

export {
  ACCESS_DRILL_COMMAND_TEMPLATE,
  ACCESS_ADMIN_GATE_ID,
  ACCESS_ADMIN_URL_ENV,
  ACCESS_JWT_ENV,
  ACCESS_USE_CLOUDFLARED_ENV,
  ACCESS_NON_ADMIN_JWT_ENV,
  BACKUP_DEPLOY_COMMAND_REQUIRED_TOKENS,
  BACKUP_DEPLOY_GATE_ID,
  BACKUP_DEPLOY_URL_ENV,
  BACKUP_DEPLOY_WORKER_NAME_ENV,
  BACKUP_DEPLOY_WORKFLOW_NAME_ENV,
  BOOLEAN_SUMMARY_KEYS,
  CATALOG_ADDONS_ENV,
  CATALOG_ALLOW_MUTATION_ENV,
  CATALOG_CUSTOMER_ID_ENV,
  CATALOG_IMPORT_MANIFEST_JSON_ENV,
  CATALOG_LICENSE_FINGERPRINT_ENV,
  CATALOG_LICENSE_ID_ENV,
  CATALOG_PLAN_ID_ENV,
  CATALOG_PLAN_KEY_ENV,
  CATALOG_PROJECT_ENV,
  CATALOG_SUPPORT_UNTIL_ENV,
  CUSTOMER_PORTAL_COMMAND_TEMPLATE,
  CUSTOMER_PORTAL_GATE_ID,
  EXTERNAL_GATE_ENV_NAMES,
  EXTERNAL_GATE_GROUPS,
  EXTERNAL_INPUT_KEYS,
  PUBLIC_VERIFIER_ABUSE_COMMAND_TEMPLATE,
  PUBLIC_VERIFIER_ABUSE_GATE_ID,
  PUBLIC_VERIFIER_URL_ENV,
  PORTAL_ACCESS_JWT_ENV,
  PORTAL_ALLOW_DOWNLOAD_ENV,
  PORTAL_ALLOW_SEAT_MUTATION_ENV,
  PORTAL_BOOTSTRAP_BEARER_ENV,
  PORTAL_DEVICE_KEY_ID_ENV,
  PORTAL_DOWNLOAD_ENTITLEMENT_ID_ENV,
  PORTAL_EMAIL_ENV,
  PORTAL_FLOATING_ENTITLEMENT_ID_ENV,
  PORTAL_URL_ENV,
  R2_BACKUP_BUCKET_ENV,
  R2_BACKUP_OBJECT_KEY_ENV,
  R2_RESTORE_COMMAND_OPTIONAL_PLACEHOLDERS,
  R2_RESTORE_COMMAND_REQUIRED_TOKENS,
  R2_RESTORE_GATE_ID,
  R2_RESTORE_R2_CONFIG_ENV,
  R2_RESTORE_REQUIRE_STATUSES_ENV,
  R2_RESTORE_SCRATCH_CONFIG_ENV,
  R2_RESTORE_SCRATCH_D1_ENV,
  R2_RESTORE_SOURCE_CONFIG_ENV,
  R2_RESTORE_SOURCE_D1_ENV,
  R2_RESTORE_COMMAND_OPTIONAL_STATUS_VALUES,
  REQUIRED_LOCAL_COMMANDS,
  REQUIRED_EXTERNAL_RESULTS,
  REQUIRED_LOCAL_RESULTS,
  SKIPPED_EXTERNAL_COMMANDS,
  STAGING_CATALOG_COMMAND_TEMPLATE,
  STAGING_CATALOG_GATE_ID,
};
