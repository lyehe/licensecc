import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { accessHeaders, requestJson } from "./validate-access-admin.mjs";

const HEX_64 = /^[0-9a-fA-F]{64}$/;

function configured(env) {
  return [
    "STAGING_ADMIN_BASE_URL",
    "STAGING_ACCESS_TOKEN",
    "STAGING_PLAN_ID",
    "STAGING_PLAN_KEY",
    "STAGING_LICENSE_ID",
    "STAGING_LICENSE_FINGERPRINT",
  ].some((key) => typeof env[key] === "string" && env[key] !== "");
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function requiredFingerprint(value) {
  const fingerprint = required(value, "STAGING_LICENSE_FINGERPRINT").toLowerCase();
  if (!HEX_64.test(fingerprint)) {
    throw new Error("STAGING_LICENSE_FINGERPRINT must be exactly 64 hex characters");
  }
  return fingerprint;
}

function csv(value) {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

function optionalUnixSeconds(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("STAGING_SUPPORT_UNTIL must be a positive Unix timestamp");
  }
  return parsed;
}

function catalogManifest(env) {
  const raw = env.STAGING_CATALOG_IMPORT_MANIFEST_JSON;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { source: "empty", body: { format_version: 1, features: [], plans: [] } };
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("STAGING_CATALOG_IMPORT_MANIFEST_JSON must be valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("STAGING_CATALOG_IMPORT_MANIFEST_JSON must be a catalog manifest object");
  }
  return { source: "env", body };
}

function validateOptions(env = process.env) {
  if (!configured(env)) {
    return { skipped: true, reason: "staging catalog drill environment is not configured" };
  }
  const planId = optionalText(env.STAGING_PLAN_ID);
  const planKey = optionalText(env.STAGING_PLAN_KEY);
  if (planId === undefined && planKey === undefined) {
    throw new Error("STAGING_PLAN_ID or STAGING_PLAN_KEY is required");
  }
  return {
    skipped: false,
    baseUrl: new URL(required(env.STAGING_ADMIN_BASE_URL, "STAGING_ADMIN_BASE_URL")),
    accessToken: required(env.STAGING_ACCESS_TOKEN, "STAGING_ACCESS_TOKEN"),
    project: optionalText(env.STAGING_PROJECT) ?? "DEFAULT",
    planId,
    planKey,
    licenseId: required(env.STAGING_LICENSE_ID, "STAGING_LICENSE_ID"),
    fingerprint: requiredFingerprint(env.STAGING_LICENSE_FINGERPRINT),
    customerId: optionalText(env.STAGING_CUSTOMER_ID),
    supportUntil: optionalUnixSeconds(env.STAGING_SUPPORT_UNTIL),
    addons: csv(env.STAGING_ADDONS),
    importManifest: catalogManifest(env),
    allowMutation: env.STAGING_ALLOW_MUTATION === "1",
  };
}

function assertEnvelope(response, expectedCode, label) {
  if (!response.ok || response.body?.ok !== true || response.body?.code !== expectedCode) {
    throw new Error(`${label} failed: ${JSON.stringify(response)}`);
  }
  return response.body;
}

async function resolvePlanId(options, headers) {
  if (options.planId !== undefined) {
    return options.planId;
  }
  const listed = assertEnvelope(await requestJson(
    options.baseUrl,
    `/api/admin/catalog/plans?project=${encodeURIComponent(options.project)}`,
    { headers },
  ), "catalog_plans_listed", "catalog plan lookup");
  const match = listed.data?.items?.find((plan) => plan.plan_key === options.planKey && plan.project === options.project);
  if (match === undefined || typeof match.id !== "string") {
    throw new Error(`could not resolve STAGING_PLAN_KEY=${options.planKey} in project ${options.project}`);
  }
  return match.id;
}

function projectionBody(options, planId) {
  const body = {
    project: options.project,
    license_id: options.licenseId,
    license_fingerprint: options.fingerprint,
    plan_id: planId,
    addons: options.addons,
    notes: "staging catalog projection drill",
  };
  if (options.planKey !== undefined) body.plan_key = options.planKey;
  if (options.customerId !== undefined) body.customer_id = options.customerId;
  if (options.supportUntil !== undefined) body.support_until = options.supportUntil;
  return body;
}

async function runStagingCatalogDrill(options) {
  if (options.skipped) {
    return { ok: true, skipped: true, reason: options.reason };
  }
  const headers = accessHeaders(options.accessToken);
  const summary = assertEnvelope(await requestJson(options.baseUrl, "/api/admin/summary", { headers }), "summary", "admin summary");

  const importDryRun = assertEnvelope(await requestJson(options.baseUrl, "/api/admin/catalog/import?dry_run=1", {
    method: "POST",
    headers,
    body: JSON.stringify(options.importManifest.body),
  }), "catalog_import_previewed", "catalog import dry-run");

  const planId = await resolvePlanId(options, headers);
  const exported = assertEnvelope(await requestJson(
    options.baseUrl,
    `/api/admin/catalog/plans/${encodeURIComponent(planId)}/export`,
    { headers },
  ), "catalog_plan_exported", "catalog export");

  const projection = projectionBody(options, planId);
  const preview = assertEnvelope(await requestJson(options.baseUrl, "/api/admin/license-plans/preview", {
    method: "POST",
    headers,
    body: JSON.stringify(projection),
  }), "license_plan_projection_previewed", "plan projection preview");

  let applied = null;
  if (options.allowMutation) {
    applied = assertEnvelope(await requestJson(options.baseUrl, "/api/admin/license-plans/apply", {
      method: "POST",
      headers: accessHeaders(options.accessToken, { "idempotency-key": `staging-plan-${randomUUID()}` }),
      body: JSON.stringify(projection),
    }), "license_plan_projection_applied", "plan projection apply");
  }

  return {
    ok: true,
    skipped: false,
    admin_url: options.baseUrl.toString(),
    project: options.project,
    plan_id: planId,
    plan_key: options.planKey ?? exported.data?.plans?.[0]?.plan_key ?? null,
    import_manifest_source: options.importManifest.source,
    summary_code: summary.code,
    import_counts: importDryRun.data,
    exported_features: exported.data?.features?.length ?? null,
    exported_plan_features: exported.data?.plans?.[0]?.features?.length ?? null,
    projection_summary: preview.data?.summary ?? null,
    applied_summary: applied?.data?.summary ?? null,
    mutation_enabled: options.allowMutation,
  };
}

async function main() {
  const result = await runStagingCatalogDrill(validateOptions());
  console.log(JSON.stringify(result, null, 2));
}

export {
  runStagingCatalogDrill,
  validateOptions,
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
