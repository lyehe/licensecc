// Portable catalog-import preview values. The admin deployable owns the D1
// protocol, while this module owns the opaque ID grammar and canonical manifest
// representation that the Worker and browser both bind to.

export const CATALOG_IMPORT_PREVIEW_ID_PATTERN = /^civ_[A-Za-z0-9_-]{1,124}$/;
// One server-side Apply is deliberately bounded below the Workers Free D1
// invocation limit. Keep the public too-large response exact and single-sourced
// for the Worker, OpenAPI document, and browser guidance.
export const CATALOG_IMPORT_MAX_MUTABLE_ACTIONS = 13;
export const CATALOG_IMPORT_TOO_LARGE_GUIDANCE = "narrow the manifest and preview again";

export function isCatalogImportPreviewId(value) {
  return typeof value === "string" && CATALOG_IMPORT_PREVIEW_ID_PATTERN.test(value);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeFeature(value) {
  return {
    project: value.project,
    feature_key: value.feature_key,
    name: value.name,
    description: value.description ?? "",
    category: value.category ?? "",
    status: value.status ?? "active",
  };
}

function normalizePlanFeature(value) {
  const featureInclusion = value.feature_inclusion ?? "included";
  return {
    project: value.project,
    feature_key: value.feature_key,
    feature_inclusion: featureInclusion,
    addon_key: featureInclusion === "addon" ? value.addon_key ?? null : null,
    policy_id: value.policy_id ?? null,
    status: value.status ?? "active",
    display_order: value.display_order ?? 0,
    assertion_ttl_seconds: value.assertion_ttl_seconds ?? null,
    pool_size: value.pool_size ?? null,
    max_active_devices: value.max_active_devices ?? null,
    max_borrow_sec: value.max_borrow_sec ?? null,
    meter_quota: value.meter_quota ?? null,
    meter_period_sec: value.meter_period_sec ?? null,
  };
}

function normalizePlan(value) {
  const features = Array.isArray(value.features) ? value.features.map(normalizePlanFeature) : [];
  features.sort((left, right) => compareStrings(left.feature_key, right.feature_key));
  return {
    project: value.project,
    plan_key: value.plan_key,
    name: value.name,
    description: value.description ?? "",
    status: value.status ?? "active",
    version: value.version ?? 1,
    features,
  };
}

/**
 * Canonicalize a validated catalog import without retaining client field order
 * or omitted defaults. This is deliberately data-only and has no Worker/D1
 * dependency, so browser code can bind an Apply button to the exact manifest
 * that the server previewed.
 */
export function normalizeCatalogImportManifest(value) {
  const features = Array.isArray(value?.features) ? value.features.map(normalizeFeature) : [];
  const plans = Array.isArray(value?.plans) ? value.plans.map(normalizePlan) : [];
  features.sort((left, right) => compareStrings(left.project, right.project) || compareStrings(left.feature_key, right.feature_key));
  plans.sort((left, right) => compareStrings(left.project, right.project) || compareStrings(left.plan_key, right.plan_key) || left.version - right.version);
  return { format_version: 1, features, plans };
}

export function catalogImportManifestSnapshot(value) {
  return JSON.stringify(normalizeCatalogImportManifest(value));
}

export async function catalogImportManifestDigest(value) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(catalogImportManifestSnapshot(value)),
  );
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}
