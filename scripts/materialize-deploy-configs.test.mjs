import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { materializeDeploymentConfigs } from "./materialize-deploy-configs.mjs";

const encoded = (value) => Buffer.from(value, "utf8").toString("base64");
const decoded = (value) => Buffer.from(value, "base64").toString("utf8");
const fixtureAccountId = "abcdef0123456789abcdef0123456789";

const profileValues = Object.freeze({
  production: Object.freeze({
    suffix: "",
    environment: "production",
    databaseId: "0123456789abcdef0123456789abcdef",
    databaseName: "licensecc-online-verifier",
    audience: "licensecc-production",
    backendHost: "api.licensecc-prod.net",
    adminHost: "admin.licensecc-prod.net",
    portalHost: "portal.licensecc-prod.net",
    backupHost: "backup.licensecc-prod.net",
    bucket: "licensecc-d1-backups",
  }),
  staging: Object.freeze({
    suffix: "-staging",
    environment: "staging",
    databaseId: "1123456789abcdef0123456789abcdef",
    databaseName: "licensecc-online-verifier-staging",
    audience: "licensecc-staging",
    backendHost: "api.staging.licensecc-prod.net",
    adminHost: "admin.staging.licensecc-prod.net",
    portalHost: "portal.staging.licensecc-prod.net",
    backupHost: "backup.staging.licensecc-prod.net",
    bucket: "licensecc-d1-backups-staging",
  }),
});

function observability() {
  return {
    enabled: true,
    logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true, persist: true, redact_query_string: true },
  };
}

function routedConfig(name, main, hostname) {
  return {
    name,
    main,
    account_id: fixtureAccountId,
    compatibility_date: "2026-08-30",
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: hostname, custom_domain: true }],
    observability: observability(),
  };
}

function backendConfig(values) {
  return `# Comments do not satisfy requirements or embed values.
# ORDER_HMAC_SECRETS = "comment-only"
# database_id = "replace-with-comment-only-id"
name = "licensecc-online-verifier${values.suffix}"
main = "src/index.ts"
compatibility_date = "2026-08-30"
workers_dev = false
preview_urls = false
routes = [{ pattern = "${values.backendHost}", custom_domain = true }]

[triggers]
crons = ["*/5 * * * *"]

[vars]
REQUEST_SIGNATURE_MODE = "required"
REQUEST_SIGNATURE_MAX_SKEW_SECONDS = "300"
DEVICE_PROOF_MODE = "off"
ACCOUNT_TOKEN_MODE = "required"
ACCOUNT_TOKEN_ACTIVE_PEPPER_ID = "p1"
ORDER_INGEST_MODE = "required"
ORDER_INGEST_AUDIENCE = "${values.audience}"
ORDER_MAX_SKEW_SECONDS = "300"
ORDER_SIGNER_SCOPE_MODE = "required"

[observability]
enabled = true

[observability.logs]
enabled = true
head_sampling_rate = 1
invocation_logs = true
persist = true
redact_query_string = true

[[d1_databases]]
binding = "DB"
database_name = "${values.databaseName}"
database_id = "${values.databaseId}"
migrations_dir = "migrations"

[[ratelimits]]
name = "VERIFY_RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 20, period = 60 }
`;
}

function adminConfig(values) {
  return {
    ...routedConfig(`licensecc-admin${values.suffix}`, "src/worker/index.ts", values.adminHost),
    assets: { directory: "./dist", binding: "ASSETS", not_found_handling: "single-page-application" },
    d1_databases: [{
      binding: "DB",
      database_name: values.databaseName,
      database_id: values.databaseId,
      migrations_dir: "../cloudflare-licensing-backend/migrations",
    }],
    vars: {
      ENVIRONMENT: values.environment,
      ADMIN_DEV_BEARER_ENABLED: "0",
      ADMIN_ACCESS_ISSUER: "https://licensecc.cloudflareaccess.com",
      ADMIN_ACCESS_AUDIENCE: values.environment === "production"
        ? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        : "1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ADMIN_ACCESS_ADMIN_EMAILS: "admin@licensecc-prod.net",
      ADMIN_ACCESS_READER_EMAILS: "reader@licensecc-prod.net",
      PUBLIC_VERIFIER_URL: `https://${values.backendHost}`,
    },
  };
}

function portalConfig(values) {
  return {
    ...routedConfig(`licensecc-customer-portal${values.suffix}`, "src/worker/index.ts", values.portalHost),
    assets: { directory: "./dist", binding: "ASSETS", not_found_handling: "single-page-application" },
    d1_databases: [{
      binding: "DB",
      database_name: values.databaseName,
      database_id: values.databaseId,
      migrations_dir: "../cloudflare-licensing-backend/migrations",
    }],
    vars: {
      ENVIRONMENT: values.environment,
      PORTAL_PUBLIC_ORIGIN: `https://${values.portalHost}`,
      BACKEND_ORIGIN: `https://${values.backendHost}`,
      PORTAL_EMAIL_FROM: "support@licensecc-prod.net",
      PORTAL_EMAIL_API_BASE: "https://api.resend.com",
      PORTAL_BOOTSTRAP_REQUIRE_ACCESS: "1",
    },
  };
}

function backupConfig(values) {
  return {
    ...routedConfig(`licensecc-d1-backup${values.suffix}`, "src/index.ts", values.backupHost),
    compatibility_flags: ["nodejs_compat"],
    vars: {
      ACCOUNT_ID: fixtureAccountId,
      DATABASE_ID: values.databaseId,
      DATABASE_NAME: values.databaseName,
      BACKUP_PREFIX: `d1/${values.databaseName}`,
      BACKUP_RETENTION_DAYS: "90",
    },
    workflows: [{
      name: `licensecc-d1-backup${values.suffix}`,
      binding: "D1_BACKUP_WORKFLOW",
      class_name: "D1BackupWorkflow",
    }],
    triggers: { crons: ["*/30 * * * *"] },
    r2_buckets: [{ binding: "BACKUP_BUCKET", bucket_name: values.bucket }],
  };
}

function validEnvironment(profile = "production") {
  const values = profileValues[profile];
  return {
    LICENSECC_BACKEND_WRANGLER_CONFIG_B64: encoded(backendConfig(values)),
    LICENSECC_ADMIN_WRANGLER_CONFIG_B64: encoded(JSON.stringify(adminConfig(values))),
    LICENSECC_PORTAL_WRANGLER_CONFIG_B64: encoded(JSON.stringify(portalConfig(values))),
    LICENSECC_BACKUP_WRANGLER_CONFIG_B64: encoded(JSON.stringify(backupConfig(values))),
    LICENSECC_EXPECTED_CLOUDFLARE_ACCOUNT_ID: fixtureAccountId,
    LICENSECC_EXPECTED_D1_DATABASE_ID: values.databaseId,
  };
}

function bindExpectedOrigins(environment, profile = "production") {
  const values = profileValues[profile];
  return Object.assign(environment, {
    LICENSECC_EXPECTED_BACKEND_ORIGIN: `https://${values.backendHost}`,
    LICENSECC_EXPECTED_ADMIN_ORIGIN: `https://${values.adminHost}`,
    LICENSECC_EXPECTED_PORTAL_ORIGIN: `https://${values.portalHost}`,
    LICENSECC_EXPECTED_BACKUP_ORIGIN: `https://${values.backupHost}`,
  });
}

function mutateJson(environment, key, mutation) {
  const config = JSON.parse(decoded(environment[key]));
  mutation(config);
  environment[key] = encoded(JSON.stringify(config));
}

function mutateBackend(environment, mutation) {
  environment.LICENSECC_BACKEND_WRANGLER_CONFIG_B64 = encoded(mutation(decoded(environment.LICENSECC_BACKEND_WRANGLER_CONFIG_B64)));
}

function assertNoConfigsWritten(root, name) {
  for (const path of [
    "services/cloudflare-licensing-backend/wrangler.toml",
    "services/cloudflare-license-admin/wrangler.jsonc",
    "services/cloudflare-customer-portal/wrangler.jsonc",
    "services/cloudflare-d1-backup/wrangler.jsonc",
  ]) {
    assert.equal(existsSync(join(root, path)), false, `${name} must fail before any config is written`);
  }
}

for (const profile of ["production", "staging"]) {
  test(`materializes one structurally validated ${profile} four-Worker topology`, () => {
    const root = mkdtempSync(join(tmpdir(), `licensecc-deploy-configs-${profile}-`));
    try {
      const written = materializeDeploymentConfigs({ root, environment: validEnvironment(profile), profile });
      assert.equal(written.length, 4);
      assert.match(readFileSync(join(root, "services/cloudflare-licensing-backend/wrangler.toml"), "utf8"), new RegExp(`ORDER_INGEST_AUDIENCE = "licensecc-${profile}"`, "u"));
      assert.equal(JSON.parse(readFileSync(join(root, "services/cloudflare-license-admin/wrangler.jsonc"), "utf8")).vars.ENVIRONMENT, profile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("keeps the omitted profile backward-compatible with production", () => {
  const root = mkdtempSync(join(tmpdir(), "licensecc-deploy-configs-default-"));
  try {
    materializeDeploymentConfigs({ root, environment: validEnvironment() });
    assert.equal(JSON.parse(readFileSync(join(root, "services/cloudflare-d1-backup/wrangler.jsonc"), "utf8")).name, "licensecc-d1-backup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binds every credential-bearing drill origin to the validated Worker route", () => {
  const acceptedRoot = mkdtempSync(join(tmpdir(), "licensecc-deploy-bound-origins-ok-"));
  try {
    const environment = bindExpectedOrigins(validEnvironment());
    assert.equal(materializeDeploymentConfigs({ root: acceptedRoot, environment }).length, 4);
  } finally {
    rmSync(acceptedRoot, { recursive: true, force: true });
  }

  const cases = [
    ["partial origin binding", (environment) => { delete environment.LICENSECC_EXPECTED_PORTAL_ORIGIN; }, /requires all four/u],
    ["cross-wired origin", (environment) => { environment.LICENSECC_EXPECTED_BACKUP_ORIGIN = environment.LICENSECC_EXPECTED_ADMIN_ORIGIN; }, /exactly match the validated backup Worker route/u],
    ["origin with a path", (environment) => { environment.LICENSECC_EXPECTED_ADMIN_ORIGIN += "/api"; }, /canonical HTTPS origin/u],
    ["placeholder origin", (environment) => { environment.LICENSECC_EXPECTED_BACKEND_ORIGIN = "https://attacker.example.com"; }, /placeholder hostname/u],
  ];
  for (const [name, mutation, expected] of cases) {
    const root = mkdtempSync(join(tmpdir(), "licensecc-deploy-bound-origins-fail-"));
    try {
      const environment = bindExpectedOrigins(validEnvironment());
      mutation(environment);
      assert.throws(() => materializeDeploymentConfigs({ root, environment }), expected, name);
      assertNoConfigsWritten(root, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("binds a single credential-bearing backend target without weakening four-service deployment binding", () => {
  const acceptedRoot = mkdtempSync(join(tmpdir(), "licensecc-deploy-capacity-origin-ok-"));
  try {
    const environment = validEnvironment("staging");
    environment.LICENSECC_EXPECTED_BACKEND_CREDENTIAL_ORIGIN = `https://${profileValues.staging.backendHost}`;
    assert.equal(materializeDeploymentConfigs({ root: acceptedRoot, environment, profile: "staging" }).length, 4);
  } finally {
    rmSync(acceptedRoot, { recursive: true, force: true });
  }

  for (const [name, value, expected] of [
    ["wrong route", `https://${profileValues.staging.adminHost}`, /exactly match the validated backend/u],
    ["path", `https://${profileValues.staging.backendHost}/verify`, /canonical HTTPS origin/u],
  ]) {
    const root = mkdtempSync(join(tmpdir(), "licensecc-deploy-capacity-origin-fail-"));
    try {
      const environment = validEnvironment("staging");
      environment.LICENSECC_EXPECTED_BACKEND_CREDENTIAL_ORIGIN = value;
      assert.throws(() => materializeDeploymentConfigs({ root, environment, profile: "staging" }), expected, name);
      assertNoConfigsWritten(root, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rejects malformed encodings and unknown or cross-wired profiles before writing", () => {
  const cases = [
    ["missing config", (env) => { delete env.LICENSECC_BACKEND_WRANGLER_CONFIG_B64; }, /strict base64/u],
    ["noncanonical base64", (env) => { env.LICENSECC_BACKEND_WRANGLER_CONFIG_B64 = "YQ"; }, /strict base64|canonical/u],
    ["invalid UTF-8", (env) => { env.LICENSECC_BACKEND_WRANGLER_CONFIG_B64 = Buffer.from([0xff]).toString("base64"); }, /UTF-8/u],
    ["malformed JSONC", (env) => { env.LICENSECC_ADMIN_WRANGLER_CONFIG_B64 = encoded('{"name":'); }, /valid Wrangler JSONC/u],
    ["malformed TOML", (env) => { mutateBackend(env, (source) => source.replace('name = "licensecc-online-verifier"', 'name = "unterminated')); }, /unterminated|string|valid Wrangler TOML/u],
    ["production passed as staging", () => {}, /must set name to "licensecc-online-verifier-staging"/u, "staging"],
  ];
  for (const [name, mutate, pattern, profile = "production"] of cases) {
    const root = mkdtempSync(join(tmpdir(), "licensecc-deploy-configs-malformed-"));
    try {
      const environment = validEnvironment();
      mutate(environment);
      assert.throws(() => materializeDeploymentConfigs({ root, environment, profile }), pattern, name);
      assertNoConfigsWritten(root, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.throws(() => materializeDeploymentConfigs({ environment: validEnvironment(), profile: "preview" }), /profile must be one of/u);
});

test("rejects unsafe identities, routes, origins, assets, Access, and observability", () => {
  const cases = [
    ["wrong service name", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { config.name = "other-admin"; }), /must set name/u],
    ["wrong entrypoint", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.main = "src/other.ts"; }), /must set main/u],
    ["workers.dev enabled", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.workers_dev = true; }), /disable workers_dev/u],
    ["preview URLs enabled", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { config.preview_urls = true; }), /disable preview_urls/u],
    ["missing route", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.routes = []; }), /at least one production-safe route/u],
    ["wildcard route", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.routes[0].pattern = "*.licensecc-prod.net"; }), /route one HTTPS hostname/u],
    ["placeholder route", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { config.routes[0].pattern = "admin.example.com"; }), /placeholder hostname/u],
    ["two route hosts", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.routes.push({ pattern: "portal-alt.licensecc-prod.net", custom_domain: true }); }), /exactly one canonical service hostname/u],
    ["duplicate service route", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.routes[0].pattern = profileValues.production.portalHost; }), /distinct service routes/u],
    ["portal public origin drift", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.vars.PORTAL_PUBLIC_ORIGIN = "https://portal-alt.licensecc-prod.net"; }), /PORTAL_PUBLIC_ORIGIN must match/u],
    ["portal backend origin drift", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.vars.BACKEND_ORIGIN = "https://api-alt.licensecc-prod.net"; }), /BACKEND_ORIGIN must match/u],
    ["admin verifier origin drift", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { config.vars.PUBLIC_VERIFIER_URL = "https://api-alt.licensecc-prod.net"; }), /PUBLIC_VERIFIER_URL must match/u],
    ["origin has a path", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.vars.BACKEND_ORIGIN += "/v1"; }), /canonical HTTPS origin/u],
    ["missing Access audience", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { config.vars.ADMIN_ACCESS_AUDIENCE = ""; }), /ADMIN_ACCESS_AUDIENCE/u],
    ["wrong Access issuer", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { config.vars.ADMIN_ACCESS_ISSUER = "https://access.licensecc-prod.net"; }), /cloudflareaccess.com/u],
    ["no Access admins", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { config.vars.ADMIN_ACCESS_ADMIN_EMAILS = ""; }), /ADMIN_ACCESS_ADMIN_EMAILS/u],
    ["development bearer enabled", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { config.vars.ADMIN_DEV_BEARER_ENABLED = "1"; }), /ADMIN_DEV_BEARER_ENABLED/u],
    ["wrong environment", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.vars.ENVIRONMENT = "development"; }), /vars.ENVIRONMENT/u],
    ["bootstrap not Access-gated", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.vars.PORTAL_BOOTSTRAP_REQUIRE_ACCESS = "0"; }), /PORTAL_BOOTSTRAP_REQUIRE_ACCESS/u],
    ["missing UI assets", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { delete config.assets; }), /must define assets/u],
    ["wrong SPA assets", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.assets.not_found_handling = "404-page"; }), /assets.not_found_handling/u],
    ["observability disabled", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.observability.enabled = false; }), /enable observability/u],
    ["invocation logs disabled", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { config.observability.logs.invocation_logs = false; }), /persisted invocation logs/u],
    ["log persistence disabled", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.observability.logs.persist = false; }), /persisted invocation logs/u],
    ["query strings not redacted", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.observability.logs.redact_query_string = false; }), /redact query strings/u],
    ["zero log sample", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.observability.logs.head_sampling_rate = 0; }), /head_sampling_rate/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    const root = mkdtempSync(join(tmpdir(), "licensecc-deploy-configs-shape-"));
    try {
      const environment = validEnvironment();
      mutate(environment);
      assert.throws(() => materializeDeploymentConfigs({ root, environment }), pattern, name);
      assertNoConfigsWritten(root, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rejects D1 split-brain and unsafe backend or backup operations", () => {
  const cases = [
    ["admin D1 mismatch", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { config.d1_databases[0].database_id = "2123456789abcdef0123456789abcdef"; }), /share one D1/u],
    ["portal database-name drift", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.d1_databases[0].database_name = "other-database"; }), /database_name/u],
    ["backup D1 mismatch", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.vars.DATABASE_ID = "3123456789abcdef0123456789abcdef"; }), /share one D1/u],
    ["workflow D1 identity mismatch", (env) => { env.LICENSECC_EXPECTED_D1_DATABASE_ID = "4123456789abcdef0123456789abcdef"; }, /D1 identity must match/u],
    ["partial expected resource binding", (env) => { delete env.LICENSECC_EXPECTED_D1_DATABASE_ID; }, /requires both/u],
    ["Worker account override", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { config["account_id"] = "11111111111111111111111111111111"; }), /account_id must match/u],
    ["backup export account mismatch", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.vars.ACCOUNT_ID = "11111111111111111111111111111111"; }), /vars\.ACCOUNT_ID must match/u],
    ["preview database", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { config.d1_databases[0].preview_database_id = config.d1_databases[0].database_id; }), /preview D1 identity/u],
    ["wrong migrations owner", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.d1_databases[0].migrations_dir = "migrations"; }), /migrations_dir/u],
    ["request proof soft", (env) => mutateBackend(env, (source) => source.replace('REQUEST_SIGNATURE_MODE = "required"', 'REQUEST_SIGNATURE_MODE = "soft"')), /REQUEST_SIGNATURE_MODE/u],
    ["device proof globally required before portal proof support", (env) => mutateBackend(env, (source) => source.replace('DEVICE_PROOF_MODE = "off"', 'DEVICE_PROOF_MODE = "required"')), /DEVICE_PROOF_MODE/u],
    ["missing active pepper selector", (env) => mutateBackend(env, (source) => source.replace('ACCOUNT_TOKEN_ACTIVE_PEPPER_ID = "p1"', 'ACCOUNT_TOKEN_ACTIVE_PEPPER_ID = ""')), /ACCOUNT_TOKEN_ACTIVE_PEPPER_ID/u],
    ["unsafe request skew", (env) => mutateBackend(env, (source) => source.replace('REQUEST_SIGNATURE_MAX_SKEW_SECONDS = "300"', 'REQUEST_SIGNATURE_MAX_SKEW_SECONDS = "0"')), /REQUEST_SIGNATURE_MAX_SKEW_SECONDS/u],
    ["order audience reused", (env) => mutateBackend(env, (source) => source.replace('ORDER_INGEST_AUDIENCE = "licensecc-production"', 'ORDER_INGEST_AUDIENCE = "licensecc-staging"')), /ORDER_INGEST_AUDIENCE/u],
    ["missing rate limiter", (env) => mutateBackend(env, (source) => source.replace('name = "VERIFY_RATE_LIMITER"', 'name = "OTHER_LIMITER"')), /VERIFY_RATE_LIMITER/u],
    ["backup account placeholder", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.vars.ACCOUNT_ID = "replace-with-account-id"; }), /placeholder/u],
    ["invalid backup retention", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.vars.BACKUP_RETENTION_DAYS = "0"; }), /BACKUP_RETENTION_DAYS/u],
    ["wrong backup prefix", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.vars.BACKUP_PREFIX = "d1/other"; }), /BACKUP_PREFIX/u],
    ["wrong Workflow class", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.workflows[0].class_name = "OtherWorkflow"; }), /class_name/u],
    ["wrong backup bucket", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.r2_buckets[0].bucket_name = "other-backups"; }), /bucket_name/u],
    ["backup cadence too slow", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.triggers.crons[0] = "0 * * * *"; }), /backup cron as "\*\/30 \* \* \* \*"/u],
    ["direct backup D1 binding", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.d1_databases = [{ binding: "DB" }]; }), /least-privilege D1 REST/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    const root = mkdtempSync(join(tmpdir(), "licensecc-deploy-configs-ops-"));
    try {
      const environment = validEnvironment();
      mutate(environment);
      assert.throws(() => materializeDeploymentConfigs({ root, environment }), pattern, name);
      assertNoConfigsWritten(root, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rejects plaintext Worker secrets in every service while ignoring comment-only examples", () => {
  const cases = [
    ["backend secret", (env) => mutateBackend(env, (source) => source.replace('[vars]', '[vars]\nORDER_HMAC_SECRETS = "plaintext"')), /Worker secret/u],
    ["backend lease private key", (env) => mutateBackend(env, (source) => source.replace('[vars]', '[vars]\nLEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM = "plaintext"')), /Worker secret/u],
    ["admin secret", (env) => mutateJson(env, "LICENSECC_ADMIN_WRANGLER_CONFIG_B64", (config) => { config.vars.SYNC_API_TOKEN = "plaintext"; }), /Worker secret/u],
    ["portal secret", (env) => mutateJson(env, "LICENSECC_PORTAL_WRANGLER_CONFIG_B64", (config) => { config.vars.PORTAL_OTP_PEPPERS = "plaintext"; }), /Worker secret/u],
    ["backup secret", (env) => mutateJson(env, "LICENSECC_BACKUP_WRANGLER_CONFIG_B64", (config) => { config.vars.D1_REST_API_TOKEN = "plaintext"; }), /Worker secret/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    const root = mkdtempSync(join(tmpdir(), "licensecc-deploy-configs-secret-"));
    try {
      const environment = validEnvironment();
      mutate(environment);
      assert.throws(() => materializeDeploymentConfigs({ root, environment }), pattern, name);
      assertNoConfigsWritten(root, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const root = mkdtempSync(join(tmpdir(), "licensecc-deploy-configs-comment-"));
  try {
    const environment = validEnvironment();
    const admin = decoded(environment.LICENSECC_ADMIN_WRANGLER_CONFIG_B64).replace('{', '{\n// "SYNC_API_TOKEN": "comment-only",\n');
    environment.LICENSECC_ADMIN_WRANGLER_CONFIG_B64 = encoded(admin);
    assert.equal(materializeDeploymentConfigs({ root, environment }).length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rolls back only files created by a partial write failure", () => {
  const root = mkdtempSync(join(tmpdir(), "licensecc-deploy-configs-rollback-"));
  try {
    const blocked = join(root, "services/cloudflare-license-admin/wrangler.jsonc");
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "owned-by-fixture"), "keep", "utf8");
    assert.throws(() => materializeDeploymentConfigs({ root, environment: validEnvironment() }));
    assert.equal(existsSync(join(root, "services/cloudflare-licensing-backend/wrangler.toml")), false);
    assert.equal(readFileSync(join(blocked, "owned-by-fixture"), "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
