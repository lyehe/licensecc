import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { experimental_readRawConfig as readRawWranglerConfig } from "wrangler";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const targets = Object.freeze([
  Object.freeze({
    id: "backend",
    env: "LICENSECC_BACKEND_WRANGLER_CONFIG_B64",
    path: "services/cloudflare-licensing-backend/wrangler.toml",
    format: "toml",
    main: "src/index.ts",
  }),
  Object.freeze({
    id: "admin",
    env: "LICENSECC_ADMIN_WRANGLER_CONFIG_B64",
    path: "services/cloudflare-license-admin/wrangler.jsonc",
    format: "jsonc",
    main: "src/worker/index.ts",
  }),
  Object.freeze({
    id: "portal",
    env: "LICENSECC_PORTAL_WRANGLER_CONFIG_B64",
    path: "services/cloudflare-customer-portal/wrangler.jsonc",
    format: "jsonc",
    main: "src/worker/index.ts",
  }),
  Object.freeze({
    id: "backup",
    env: "LICENSECC_BACKUP_WRANGLER_CONFIG_B64",
    path: "services/cloudflare-d1-backup/wrangler.jsonc",
    format: "jsonc",
    main: "src/index.ts",
  }),
]);

const expectedOriginEnvironment = Object.freeze({
  backend: "LICENSECC_EXPECTED_BACKEND_ORIGIN",
  admin: "LICENSECC_EXPECTED_ADMIN_ORIGIN",
  portal: "LICENSECC_EXPECTED_PORTAL_ORIGIN",
  backup: "LICENSECC_EXPECTED_BACKUP_ORIGIN",
});

const deploymentProfiles = Object.freeze({
  production: Object.freeze({
    environment: "production",
    databaseName: "licensecc-online-verifier",
    orderAudience: "licensecc-production",
    serviceNames: Object.freeze({
      backend: "licensecc-online-verifier",
      admin: "licensecc-admin",
      portal: "licensecc-customer-portal",
      backup: "licensecc-d1-backup",
    }),
    backupBucketName: "licensecc-d1-backups",
  }),
  staging: Object.freeze({
    environment: "staging",
    databaseName: "licensecc-online-verifier-staging",
    orderAudience: "licensecc-staging",
    serviceNames: Object.freeze({
      backend: "licensecc-online-verifier-staging",
      admin: "licensecc-admin-staging",
      portal: "licensecc-customer-portal-staging",
      backup: "licensecc-d1-backup-staging",
    }),
    backupBucketName: "licensecc-d1-backups-staging",
  }),
});

const workerSecretNames = new Set([
  "ACCOUNT_TOKEN_PEPPERS",
  "ADMIN_DEV_BEARER",
  "BACKUP_TRIGGER_TOKEN",
  "D1_REST_API_TOKEN",
  "EMERGENCY_OPERATOR_BEARER",
  "LEASE_ISSUE_BEARER",
  "LEASE_SIGNING_KEY_ID",
  "LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM",
  "ONLINE_SIGNING_KEY_ID",
  "ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM",
  "ORDER_HMAC_SECRETS",
  "ORDER_SIGNER_SCOPES",
  "PORTAL_BOOTSTRAP_BEARER",
  "PORTAL_EMAIL_API_KEY",
  "PORTAL_OTP_PEPPERS",
  "PORTAL_SESSION_PEPPERS",
  "SYNC_API_TOKEN",
  "WEBHOOK_SIGNING_KEY_ID",
  "WEBHOOK_SIGNING_SECRETS",
]);

const forbiddenAssignment = new RegExp(
  `(?:["']?)(?:${[...workerSecretNames].join("|")})(?:["']?)\\s*[=:]`,
  "iu",
);
const placeholderText = /(?:replace[-_ ]?with|change[-_ ]?me|placeholder|<[^>]+>|your[-_ ](?:account|database|domain|id))/iu;
const resourceId = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u;
const accountId = /^[a-f0-9]{32}$/u;
const accessAudience = /^[A-Za-z0-9._-]{16,128}$/u;
const emailAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function fail(target, detail) {
  throw new Error(`${target.env} ${detail}`);
}

function strictBase64(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`${label} must be one strict base64 value`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) throw new Error(`${label} is not canonical base64`);
  return decoded;
}

function strictUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function activeConfigText(source, target) {
  let output = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      }
    } else if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        index += 1;
      } else {
        output += character === "\n" ? "\n" : " ";
      }
    } else if (quote) {
      output += character;
      if (character === "\\" && quote === '"') {
        output += next;
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      output += character;
    } else if (character === "#") {
      lineComment = true;
      output += " ";
    } else if (character === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      index += 1;
    } else {
      output += character;
    }
  }
  if (quote || blockComment) fail(target, "has an unterminated string or comment");
  return output;
}

function parseWranglerConfig(source, target) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "licensecc-wrangler-validate-"));
  const temporaryConfig = join(temporaryRoot, `wrangler.${target.format}`);
  try {
    writeFileSync(temporaryConfig, source, { flag: "wx", mode: 0o600 });
    const result = readRawWranglerConfig({ config: temporaryConfig });
    return result.rawConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message.split(/\r?\n/u)[0] : String(error);
    fail(target, `is not valid Wrangler ${target.format.toUpperCase()} configuration: ${message}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function objectValue(value, target, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(target, `must define ${label} as an object`);
  return value;
}

function arrayValue(value, target, label) {
  if (!Array.isArray(value)) fail(target, `must define ${label} as an array`);
  return value;
}

function exactString(value, expected, target, label) {
  if (value !== expected) fail(target, `must set ${label} to ${JSON.stringify(expected)}`);
  return value;
}

function nonEmptyString(value, target, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) fail(target, `must set ${label} to a non-empty trimmed string`);
  return value;
}

function rejectSecretsAndPlaceholders(value, target, path = "config") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSecretsAndPlaceholders(entry, target, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && placeholderText.test(value)) fail(target, `contains a placeholder at ${path}`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (workerSecretNames.has(key.toUpperCase())) fail(target, `embeds Worker secret ${key} instead of using Wrangler secret storage`);
    rejectSecretsAndPlaceholders(entry, target, `${path}.${key}`);
  }
}

function canonicalHttpsOrigin(value, target, label, { access = false } = {}) {
  const text = nonEmptyString(value, target, label);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    fail(target, `must set ${label} to a canonical HTTPS origin`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== text.replace(/\/$/u, "")) {
    fail(target, `must set ${label} to a canonical HTTPS origin with no credentials, port, path, query, or fragment`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isPlaceholderHostname(hostname)) fail(target, `must not use a placeholder hostname for ${label}`);
  if (access && !hostname.endsWith(".cloudflareaccess.com")) fail(target, `must use a cloudflareaccess.com issuer for ${label}`);
  return parsed.origin;
}

function isPlaceholderHostname(hostname) {
  return hostname === "localhost" || hostname.endsWith(".localhost") || /(?:^|\.)example\.(?:com|net|org)$/u.test(hostname) || /\.(?:example|invalid|test)$/u.test(hostname);
}

function routeOrigin(route, target, index) {
  let pattern;
  let zoneName;
  if (typeof route === "string") {
    pattern = route;
  } else {
    const routeObject = objectValue(route, target, `routes[${index}]`);
    pattern = routeObject.pattern;
    zoneName = routeObject.zone_name;
    if (routeObject.custom_domain !== undefined && routeObject.custom_domain !== true) fail(target, `must set routes[${index}].custom_domain to true when present`);
  }
  const text = nonEmptyString(pattern, target, `routes[${index}].pattern`);
  if (text.includes("://") || text.includes("?") || text.includes("#") || text.includes("@")) fail(target, `has a non-canonical route pattern at routes[${index}]`);
  const host = text.endsWith("/*") ? text.slice(0, -2) : text;
  if (!host || host.includes("/") || host.includes("*") || host.includes(":")) fail(target, `must route one HTTPS hostname (optionally with /*) at routes[${index}]`);
  const origin = canonicalHttpsOrigin(`https://${host}`, target, `routes[${index}].pattern`);
  if (zoneName !== undefined) {
    const zone = nonEmptyString(zoneName, target, `routes[${index}].zone_name`).toLowerCase();
    if (isPlaceholderHostname(zone) || (host.toLowerCase() !== zone && !host.toLowerCase().endsWith(`.${zone}`))) fail(target, `has a route hostname outside routes[${index}].zone_name`);
  }
  return origin;
}

function validateRouting(config, target, profileName) {
  if (config.workers_dev !== false) fail(target, "must explicitly disable workers_dev");
  if (config.preview_urls !== false) fail(target, "must explicitly disable preview_urls");
  const routes = arrayValue(config.routes, target, "routes");
  if (routes.length === 0) fail(target, "must define at least one production-safe route");
  const origins = [...new Set(routes.map((route, index) => routeOrigin(route, target, index)))];
  if (origins.length !== 1) fail(target, "must route exactly one canonical service hostname");
  if (profileName === "staging" && !origins[0].split("//", 2)[1].split(".").includes("staging")) fail(target, "must use a hostname with a staging label for the staging profile");
  return origins[0];
}

function validateObservability(config, target) {
  const observability = objectValue(config.observability, target, "observability");
  if (observability.enabled !== true) fail(target, "must enable observability");
  const logs = objectValue(observability.logs, target, "observability.logs");
  if (logs.enabled !== true || logs.invocation_logs !== true || logs.persist !== true) fail(target, "must enable persisted invocation logs");
  if (logs.redact_query_string !== true) fail(target, "must redact query strings from persisted logs");
  if (typeof logs.head_sampling_rate !== "number" || logs.head_sampling_rate <= 0 || logs.head_sampling_rate > 1) fail(target, "must set observability.logs.head_sampling_rate in (0, 1]");
}

function validateCompatibility(config, target) {
  const date = nonEmptyString(config.compatibility_date, target, "compatibility_date");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) fail(target, "must set compatibility_date to YYYY-MM-DD");
}

function validateOptionalAccountId(config, target) {
  const workerAccountId = config["account_id"];
  if (workerAccountId === undefined) return null;
  const configured = nonEmptyString(workerAccountId, target, "account_id").toLowerCase();
  if (!accountId.test(configured)) fail(target, "must set account_id to a Cloudflare account ID when present");
  return configured;
}

function validateD1(config, target, profile, migrationsDir) {
  const bindings = arrayValue(config.d1_databases, target, "d1_databases");
  if (bindings.length !== 1) fail(target, "must define exactly one D1 binding");
  const binding = objectValue(bindings[0], target, "d1_databases[0]");
  exactString(binding.binding, "DB", target, "d1_databases[0].binding");
  exactString(binding.database_name, profile.databaseName, target, "d1_databases[0].database_name");
  exactString(binding.migrations_dir, migrationsDir, target, "d1_databases[0].migrations_dir");
  const databaseId = nonEmptyString(binding.database_id, target, "d1_databases[0].database_id").toLowerCase();
  if (!resourceId.test(databaseId)) fail(target, "must set d1_databases[0].database_id to a Cloudflare resource ID");
  if (binding.preview_database_id !== undefined) fail(target, "must not mix a preview D1 identity into a protected deployment config");
  return databaseId;
}

function validateAssets(config, target) {
  const assets = objectValue(config.assets, target, "assets");
  exactString(assets.directory, "./dist", target, "assets.directory");
  exactString(assets.binding, "ASSETS", target, "assets.binding");
  exactString(assets.not_found_handling, "single-page-application", target, "assets.not_found_handling");
}

function validateCronList(config, target, label, { exact = undefined } = {}) {
  const triggers = objectValue(config.triggers, target, "triggers");
  const crons = arrayValue(triggers.crons, target, "triggers.crons");
  if (crons.length !== 1 || typeof crons[0] !== "string") fail(target, `must define exactly one ${label} cron trigger`);
  const fields = crons[0].trim().split(/\s+/u);
  if (fields.length !== 5) fail(target, `must define a valid ${label} cron trigger`);
  if (exact !== undefined && crons[0] !== exact) fail(target, `must run the ${label} cron as ${JSON.stringify(exact)}`);
}

function validateBackend(config, target, profile, profileName) {
  const vars = objectValue(config.vars, target, "vars");
  for (const key of ["REQUEST_SIGNATURE_MODE", "ACCOUNT_TOKEN_MODE", "ORDER_INGEST_MODE", "ORDER_SIGNER_SCOPE_MODE"]) {
    exactString(vars[key], "required", target, `vars.${key}`);
  }
  // The shipped portal has no device private key and must never receive one. In the current
  // backend contract, `off` permits a missing proof but still verifies every presented proof.
  // Move the hosted topology to global `required` only with a real client registration/signing UX.
  exactString(vars.DEVICE_PROOF_MODE, "off", target, "vars.DEVICE_PROOF_MODE");
  exactString(vars.ORDER_INGEST_AUDIENCE, profile.orderAudience, target, "vars.ORDER_INGEST_AUDIENCE");
  const activePepperId = nonEmptyString(vars.ACCOUNT_TOKEN_ACTIVE_PEPPER_ID, target, "vars.ACCOUNT_TOKEN_ACTIVE_PEPPER_ID");
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(activePepperId) || placeholderText.test(activePepperId)) fail(target, "must set vars.ACCOUNT_TOKEN_ACTIVE_PEPPER_ID to a safe deployed pepper selector");
  for (const key of ["REQUEST_SIGNATURE_MAX_SKEW_SECONDS", "ORDER_MAX_SKEW_SECONDS"]) {
    if (!/^\d{1,4}$/u.test(String(vars[key] ?? "")) || Number(vars[key]) < 1 || Number(vars[key]) > 3600) {
      fail(target, `must set vars.${key} to an integer in [1, 3600]`);
    }
  }
  const databaseId = validateD1(config, target, profile, "migrations");
  const limiters = arrayValue(config.ratelimits, target, "ratelimits");
  if (limiters.length !== 1) fail(target, "must define exactly one VERIFY_RATE_LIMITER binding");
  const limiter = objectValue(limiters[0], target, "ratelimits[0]");
  exactString(limiter.name, "VERIFY_RATE_LIMITER", target, "ratelimits[0].name");
  if (!/^[1-9]\d*$/u.test(String(limiter.namespace_id ?? ""))) fail(target, "must set a positive ratelimits[0].namespace_id");
  const simple = objectValue(limiter.simple, target, "ratelimits[0].simple");
  if (!Number.isInteger(simple.limit) || simple.limit < 1 || !Number.isInteger(simple.period) || simple.period < 1) fail(target, "must set positive integer rate-limit values");
  validateCronList(config, target, "seat-reclamation");
  if (config.assets !== undefined) fail(target, "must not define static assets for the backend");
  return { databaseId, origin: validateRouting(config, target, profileName) };
}

function validateAccess(vars, target) {
  const issuer = canonicalHttpsOrigin(vars.ADMIN_ACCESS_ISSUER, target, "vars.ADMIN_ACCESS_ISSUER", { access: true });
  const audience = nonEmptyString(vars.ADMIN_ACCESS_AUDIENCE, target, "vars.ADMIN_ACCESS_AUDIENCE");
  if (!accessAudience.test(audience) || placeholderText.test(audience)) fail(target, "must set vars.ADMIN_ACCESS_AUDIENCE to the deployed Access application audience");
  const admins = nonEmptyString(vars.ADMIN_ACCESS_ADMIN_EMAILS, target, "vars.ADMIN_ACCESS_ADMIN_EMAILS").split(",").map((entry) => entry.trim());
  if (admins.some((entry) => !emailAddress.test(entry))) fail(target, "must set vars.ADMIN_ACCESS_ADMIN_EMAILS to valid comma-separated addresses");
  if (vars.ADMIN_ACCESS_READER_EMAILS !== undefined && vars.ADMIN_ACCESS_READER_EMAILS !== "") {
    const readers = nonEmptyString(vars.ADMIN_ACCESS_READER_EMAILS, target, "vars.ADMIN_ACCESS_READER_EMAILS").split(",").map((entry) => entry.trim());
    if (readers.some((entry) => !emailAddress.test(entry))) fail(target, "must set vars.ADMIN_ACCESS_READER_EMAILS to valid comma-separated addresses");
  }
  if (vars.ADMIN_ACCESS_JWKS_URL !== undefined) {
    const expected = `${issuer}/cdn-cgi/access/certs`;
    if (vars.ADMIN_ACCESS_JWKS_URL !== expected) fail(target, `must set vars.ADMIN_ACCESS_JWKS_URL to ${JSON.stringify(expected)} when overriding it`);
  }
}

function validateAdmin(config, target, profile, profileName) {
  const vars = objectValue(config.vars, target, "vars");
  exactString(vars.ENVIRONMENT, profile.environment, target, "vars.ENVIRONMENT");
  exactString(vars.ADMIN_DEV_BEARER_ENABLED, "0", target, "vars.ADMIN_DEV_BEARER_ENABLED");
  validateAccess(vars, target);
  validateAssets(config, target);
  return {
    backendOrigin: canonicalHttpsOrigin(vars.PUBLIC_VERIFIER_URL, target, "vars.PUBLIC_VERIFIER_URL"),
    databaseId: validateD1(config, target, profile, "../cloudflare-licensing-backend/migrations"),
    origin: validateRouting(config, target, profileName),
  };
}

function validatePortal(config, target, profile, profileName) {
  const vars = objectValue(config.vars, target, "vars");
  exactString(vars.ENVIRONMENT, profile.environment, target, "vars.ENVIRONMENT");
  exactString(vars.PORTAL_BOOTSTRAP_REQUIRE_ACCESS, "1", target, "vars.PORTAL_BOOTSTRAP_REQUIRE_ACCESS");
  const publicOrigin = canonicalHttpsOrigin(vars.PORTAL_PUBLIC_ORIGIN, target, "vars.PORTAL_PUBLIC_ORIGIN");
  const backendOrigin = canonicalHttpsOrigin(vars.BACKEND_ORIGIN, target, "vars.BACKEND_ORIGIN");
  if (vars.PORTAL_EMAIL_API_BASE !== undefined) canonicalHttpsOrigin(vars.PORTAL_EMAIL_API_BASE, target, "vars.PORTAL_EMAIL_API_BASE");
  if (vars.PORTAL_EMAIL_FROM !== undefined && vars.PORTAL_EMAIL_FROM !== "" && !emailAddress.test(vars.PORTAL_EMAIL_FROM)) fail(target, "must set vars.PORTAL_EMAIL_FROM to a valid address when enabled");
  validateAssets(config, target);
  return {
    backendOrigin,
    databaseId: validateD1(config, target, profile, "../cloudflare-licensing-backend/migrations"),
    origin: validateRouting(config, target, profileName),
    publicOrigin,
  };
}

function validateBackup(config, target, profile, profileName) {
  if (config.d1_databases !== undefined && (!Array.isArray(config.d1_databases) || config.d1_databases.length !== 0)) fail(target, "must use the least-privilege D1 REST export path rather than a D1 binding");
  if (config.assets !== undefined) fail(target, "must not define static assets for the backup Worker");
  const vars = objectValue(config.vars, target, "vars");
  const configuredAccountId = nonEmptyString(vars.ACCOUNT_ID, target, "vars.ACCOUNT_ID").toLowerCase();
  if (!accountId.test(configuredAccountId)) fail(target, "must set vars.ACCOUNT_ID to a Cloudflare account ID");
  const databaseId = nonEmptyString(vars.DATABASE_ID, target, "vars.DATABASE_ID").toLowerCase();
  if (!resourceId.test(databaseId)) fail(target, "must set vars.DATABASE_ID to a Cloudflare D1 database ID");
  exactString(vars.DATABASE_NAME, profile.databaseName, target, "vars.DATABASE_NAME");
  exactString(vars.BACKUP_PREFIX, `d1/${profile.databaseName}`, target, "vars.BACKUP_PREFIX");
  if (!/^\d+$/u.test(String(vars.BACKUP_RETENTION_DAYS ?? "")) || Number(vars.BACKUP_RETENTION_DAYS) < 1 || Number(vars.BACKUP_RETENTION_DAYS) > 3650) fail(target, "must set vars.BACKUP_RETENTION_DAYS to an integer in [1, 3650]");
  const workflows = arrayValue(config.workflows, target, "workflows");
  if (workflows.length !== 1) fail(target, "must define exactly one backup Workflow binding");
  const workflow = objectValue(workflows[0], target, "workflows[0]");
  exactString(workflow.name, profile.serviceNames.backup, target, "workflows[0].name");
  exactString(workflow.binding, "D1_BACKUP_WORKFLOW", target, "workflows[0].binding");
  exactString(workflow.class_name, "D1BackupWorkflow", target, "workflows[0].class_name");
  const buckets = arrayValue(config.r2_buckets, target, "r2_buckets");
  if (buckets.length !== 1) fail(target, "must define exactly one backup R2 binding");
  const bucket = objectValue(buckets[0], target, "r2_buckets[0]");
  exactString(bucket.binding, "BACKUP_BUCKET", target, "r2_buckets[0].binding");
  exactString(bucket.bucket_name, profile.backupBucketName, target, "r2_buckets[0].bucket_name");
  // A daily export cannot support the declared one-hour RPO. Two attempts per
  // hour leave bounded time for D1 export completion while keeping the schedule
  // itself deterministic across protected environments.
  validateCronList(config, target, "backup", { exact: "*/30 * * * *" });
  return { backupAccountId: configuredAccountId, databaseId, origin: validateRouting(config, target, profileName) };
}

function validateConfig(target, bytes, profile, profileName) {
  const source = strictUtf8(bytes, target.env);
  if (source.includes("\0")) fail(target, "contains a NUL byte");
  const active = activeConfigText(source, target);
  if (forbiddenAssignment.test(active)) fail(target, "embeds a Worker secret instead of using Wrangler secret storage");
  if (placeholderText.test(active)) fail(target, "still contains an active example placeholder");
  const config = parseWranglerConfig(source, target);
  rejectSecretsAndPlaceholders(config, target);
  exactString(config.name, profile.serviceNames[target.id], target, "name");
  exactString(config.main, target.main, target, "main");
  validateCompatibility(config, target);
  validateObservability(config, target);
  const workerAccountId = validateOptionalAccountId(config, target);
  let validation;
  switch (target.id) {
    case "backend": validation = validateBackend(config, target, profile, profileName); break;
    case "admin": validation = validateAdmin(config, target, profile, profileName); break;
    case "portal": validation = validatePortal(config, target, profile, profileName); break;
    case "backup": validation = validateBackup(config, target, profile, profileName); break;
    default: throw new Error(`Unsupported deployment target ${target.id}`);
  }
  return { ...validation, workerAccountId };
}

function normalizeProfile(profileName) {
  if (typeof profileName !== "string" || !Object.hasOwn(deploymentProfiles, profileName)) {
    throw new Error(`deployment profile must be one of: ${Object.keys(deploymentProfiles).join(", ")}`);
  }
  return deploymentProfiles[profileName];
}

function validateTopology(records) {
  const byId = Object.fromEntries(records.map((record) => [record.id, record.validation]));
  const databaseIds = new Set([byId.backend.databaseId, byId.admin.databaseId, byId.portal.databaseId, byId.backup.databaseId]);
  if (databaseIds.size !== 1) throw new Error("protected Wrangler configurations must share one D1 database_id/DATABASE_ID");
  const origins = [byId.backend.origin, byId.admin.origin, byId.portal.origin, byId.backup.origin];
  if (new Set(origins).size !== origins.length) throw new Error("protected Wrangler configurations must use distinct service routes");
  if (byId.portal.publicOrigin !== byId.portal.origin) throw new Error("portal PORTAL_PUBLIC_ORIGIN must match the portal route origin");
  if (byId.portal.backendOrigin !== byId.backend.origin) throw new Error("portal BACKEND_ORIGIN must match the backend route origin");
  if (byId.admin.backendOrigin !== byId.backend.origin) throw new Error("admin PUBLIC_VERIFIER_URL must match the backend route origin");
}

function validateExpectedOrigins(records, environment) {
  const supplied = Object.values(expectedOriginEnvironment).filter((name) => environment[name] !== undefined);
  if (supplied.length === 0) return;
  if (supplied.length !== targets.length) {
    throw new Error("protected drill origin binding requires all four LICENSECC_EXPECTED_*_ORIGIN values");
  }
  for (const record of records) {
    const name = expectedOriginEnvironment[record.id];
    const expected = canonicalHttpsOrigin(environment[name], { env: name }, "to the credential-bearing drill origin");
    if (expected !== record.validation.origin) {
      throw new Error(`${name} must exactly match the validated ${record.id} Worker route`);
    }
  }
}

function validateCredentialTargetOrigins(records, environment) {
  const bindings = Object.freeze({
    backend: "LICENSECC_EXPECTED_BACKEND_CREDENTIAL_ORIGIN",
  });
  for (const [id, name] of Object.entries(bindings)) {
    if (environment[name] === undefined) continue;
    const expected = canonicalHttpsOrigin(environment[name], { env: name }, "to the credential-bearing target origin");
    const record = records.find((candidate) => candidate.id === id);
    if (record.validation.origin !== expected) {
      throw new Error(`${name} must exactly match the validated ${id} Worker route`);
    }
  }
}

function expectedProtectedId(environment, name, pattern, label) {
  const value = environment[name];
  if (typeof value !== "string" || value !== value.trim() || !pattern.test(value.toLowerCase())) {
    throw new Error(`${name} must be an exact ${label}`);
  }
  return value.toLowerCase();
}

function validateExpectedResourceBindings(records, environment) {
  const accountName = "LICENSECC_EXPECTED_CLOUDFLARE_ACCOUNT_ID";
  const databaseName = "LICENSECC_EXPECTED_D1_DATABASE_ID";
  const supplied = [accountName, databaseName].filter((name) => environment[name] !== undefined);
  if (supplied.length === 0) return;
  if (supplied.length !== 2) {
    throw new Error(`protected resource binding requires both ${accountName} and ${databaseName}`);
  }
  const expectedAccountId = expectedProtectedId(environment, accountName, accountId, "Cloudflare account ID");
  const expectedDatabaseId = expectedProtectedId(environment, databaseName, resourceId, "Cloudflare D1 database ID");
  for (const record of records) {
    if (record.validation.workerAccountId !== null && record.validation.workerAccountId !== expectedAccountId) {
      throw new Error(`${record.id} Wrangler account_id must match ${accountName}`);
    }
    if (record.validation.databaseId !== expectedDatabaseId) {
      throw new Error(`${record.id} D1 identity must match ${databaseName}`);
    }
  }
  const backup = records.find((record) => record.id === "backup");
  if (backup.validation.backupAccountId !== expectedAccountId) {
    throw new Error(`backup vars.ACCOUNT_ID must match ${accountName}`);
  }
}

export function materializeDeploymentConfigs({ root = repositoryRoot, environment = process.env, profile: profileName = "production" } = {}) {
  const profile = normalizeProfile(profileName);
  const prepared = targets.map((target) => {
    const bytes = strictBase64(environment[target.env], target.env);
    return {
      bytes,
      destination: resolve(root, target.path),
      id: target.id,
      validation: validateConfig(target, bytes, profile, profileName),
    };
  });
  validateTopology(prepared);
  validateExpectedOrigins(prepared, environment);
  validateCredentialTargetOrigins(prepared, environment);
  validateExpectedResourceBindings(prepared, environment);
  const written = [];
  try {
    for (const { bytes, destination } of prepared) {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
      written.push(destination);
    }
  } catch (error) {
    for (const destination of written.reverse()) {
      try {
        unlinkSync(destination);
      } catch {
        // Preserve the original write failure; every cleanup target was created by this invocation.
      }
    }
    throw error;
  }
  return written;
}

function profileFromArguments(arguments_) {
  if (arguments_.length === 0) return "production";
  if (arguments_.length === 1 && arguments_[0].startsWith("--profile=")) return arguments_[0].slice("--profile=".length);
  if (arguments_.length === 2 && arguments_[0] === "--profile") return arguments_[1];
  throw new Error("usage: node scripts/materialize-deploy-configs.mjs [--profile production|staging]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profile = profileFromArguments(process.argv.slice(2));
  const written = materializeDeploymentConfigs({ profile });
  console.log(`Materialized ${written.length} ${profile} Wrangler configurations.`);
}
