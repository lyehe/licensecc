import {
  isPlanProjectionPreviewId,
  MAX_SUPPORT_UNTIL_EPOCH_SECONDS,
  type PlanProjectionApplyInput,
  type PlanProjectionInput,
} from "@licensecc/licensing-domain/catalog/plan_projection";
import { isCatalogImportPreviewId, type CatalogImportApplyInput } from "@licensecc/licensing-domain/catalog/import_preview";
import { safeString } from "@licensecc/cloudflare-runtime/http/kit";

const HEX_64 = /^[0-9a-fA-F]{64}$/;
export const MAX_PROJECT_SIZE = 127;
export const MAX_FEATURE_SIZE = 15;
const MAX_NOTES_SIZE = 1000;
export const MAX_NAME_SIZE = 127;
const CATALOG_TUPLE_CONTROL = "\u001f";
// A generous-but-bounded ceiling for the policy duration/offset/borrow integers
// (~100 years in seconds). Keeps validators from accepting absurd or overflow values.
export const MAX_DURATION_SECONDS = 3_153_600_000;
const INVALID = Symbol("invalid");
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "";
}

export function envFlag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function splitCsv(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => item !== ""));
}

export function safeNotes(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_NOTES_SIZE) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return null;
  }
  return value;
}

export function nullableSafeString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  return safeString(value, maxLength);
}

function catalogIdentifier(value: unknown, maxLength: number): string | null {
  const parsed = safeString(value, maxLength);
  return parsed === null || parsed.includes(CATALOG_TUPLE_CONTROL) ? null : parsed;
}

function nullableCatalogIdentifier(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return catalogIdentifier(value, maxLength);
}

function catalogTupleKey(...parts: string[]): string {
  return JSON.stringify(parts);
}

export function boundedInt(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

export function nullableEpoch(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    return undefined;
  }
  return value;
}

export function validatePlanProjectionInput(value: unknown): PlanProjectionInput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const project = safeString(input.project, MAX_PROJECT_SIZE);
  const licenseId = safeString(input.license_id, 128);
  const licenseFingerprint = typeof input.license_fingerprint === "string" && HEX_64.test(input.license_fingerprint)
    ? input.license_fingerprint
    : null;
  const customerId = input.customer_id === undefined ? undefined : nullableSafeString(input.customer_id, 128);
  const planId = input.plan_id === undefined ? undefined : nullableSafeString(input.plan_id, 128);
  const planKey = input.plan_key === undefined ? undefined : nullableSafeString(input.plan_key, 128);
  const supportUntil = input.support_until === undefined ? undefined : nullableEpoch(input.support_until, MAX_SUPPORT_UNTIL_EPOCH_SECONDS);
  const notes = input.notes === undefined ? undefined : safeNotes(input.notes);
  if (
    project === null || licenseId === null || licenseFingerprint === null ||
    (input.customer_id !== undefined && customerId === undefined) ||
    (input.plan_id !== undefined && planId === undefined) ||
    (input.plan_key !== undefined && planKey === undefined) ||
    ((planId ?? null) === null && (planKey ?? null) === null) ||
    (input.support_until !== undefined && supportUntil === undefined) ||
    notes === null
  ) {
    return null;
  }
  const out: PlanProjectionInput = {
    project,
    license_id: licenseId,
    license_fingerprint: licenseFingerprint,
  };
  if (customerId !== undefined) out.customer_id = customerId;
  if (planId !== undefined) out.plan_id = planId;
  if (planKey !== undefined) out.plan_key = planKey;
  if (supportUntil !== undefined) out.support_until = supportUntil;
  if (notes !== undefined) out.notes = notes;

  if (input.addons !== undefined) {
    if (!Array.isArray(input.addons) || input.addons.length > 100) {
      return null;
    }
    const addons: string[] = [];
    const seen = new Set<string>();
    for (const item of input.addons) {
      const addon = safeString(item, 128);
      if (addon === null) {
        return null;
      }
      if (!seen.has(addon)) {
        seen.add(addon);
        addons.push(addon);
      }
    }
    out.addons = addons;
  }
  return out;
}

export function validatePlanProjectionApplyInput(value: unknown): PlanProjectionApplyInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (!hasOnlyKeys(input, new Set(["preview_id"]))) {
    return null;
  }
  const previewId = safeString(input.preview_id, 128);
  if (previewId === null || !isPlanProjectionPreviewId(previewId)) {
    return null;
  }
  return { preview_id: previewId };
}

export interface CatalogFeatureInput {
  project: string;
  feature_key: string;
  name: string;
  description: string;
  category: string;
  status: "active" | "disabled";
}

export interface CatalogFeaturePatch {
  name?: string;
  description?: string;
  category?: string;
}

export interface CatalogPlanInput {
  project: string;
  plan_key: string;
  name: string;
  description: string;
  status: "active" | "disabled";
  version: number;
}

export interface CatalogPlanPatch {
  name?: string;
  description?: string;
}

export interface CatalogPlanFeatureInput {
  project: string;
  feature_key: string;
  feature_inclusion: "included" | "addon";
  addon_key: string | null;
  policy_id: string | null;
  status: "active" | "disabled";
  display_order: number;
  assertion_ttl_seconds: number | null;
  pool_size: number | null;
  max_active_devices: number | null;
  max_borrow_sec: number | null;
  meter_quota: number | null;
  meter_period_sec: number | null;
}

export interface CatalogImportInput {
  format_version: 1;
  features: CatalogFeatureInput[];
  plans: Array<CatalogPlanInput & { features?: CatalogPlanFeatureInput[] }>;
}

export function validateCatalogImportApplyInput(value: unknown): CatalogImportApplyInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (!hasOnlyKeys(input, new Set(["preview_id"]))) {
    return null;
  }
  const previewId = safeString(input.preview_id, 128);
  return previewId !== null && isCatalogImportPreviewId(previewId) ? { preview_id: previewId } : null;
}

export function isCatalogImportManifestPayload(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(input, "features") ||
    Object.prototype.hasOwnProperty.call(input, "plans") ||
    Object.prototype.hasOwnProperty.call(input, "format_version");
}

export function catalogStatus(value: unknown): "active" | "disabled" | null {
  if (value === undefined) {
    return "active";
  }
  return value === "active" || value === "disabled" ? value : null;
}

export function optionalNotes(value: unknown, defaultValue = ""): string | null {
  if (value === undefined) {
    return defaultValue;
  }
  return safeNotes(value);
}

export function optionalCatalogText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length > maxLength) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return null;
  }
  return value;
}

export function hasOnlyKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(input).every((key) => allowed.has(key));
}

export function readNullableNonNegativeInt(input: Record<string, unknown>, field: string, max = 1_000_000_000): number | null | typeof INVALID {
  if (input[field] === undefined || input[field] === null || input[field] === "") {
    return null;
  }
  const value = boundedInt(input[field], 0, max);
  return value === undefined ? INVALID : value;
}

export function validateCatalogFeatureInput(value: unknown): CatalogFeatureInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (!hasOnlyKeys(input, new Set(["project", "feature_key", "name", "description", "category", "status"]))) {
    return null;
  }
  const project = catalogIdentifier(input.project, MAX_PROJECT_SIZE);
  const featureKey = catalogIdentifier(input.feature_key, MAX_FEATURE_SIZE);
  const name = safeString(input.name, MAX_NAME_SIZE);
  const description = optionalNotes(input.description);
  const category = input.category === undefined ? "" : safeString(input.category, MAX_NAME_SIZE);
  const status = catalogStatus(input.status);
  if (project === null || featureKey === null || name === null || description === null || category === null || status === null) {
    return null;
  }
  return { project, feature_key: featureKey, name, description, category, status };
}

export function validateCatalogFeaturePatch(value: unknown): CatalogFeaturePatch | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (!hasOnlyKeys(input, new Set(["name", "description", "category"]))) {
    return null;
  }
  const patch: CatalogFeaturePatch = {};
  if (input.name !== undefined) {
    const name = safeString(input.name, MAX_NAME_SIZE);
    if (name === null) return null;
    patch.name = name;
  }
  if (input.description !== undefined) {
    const description = safeNotes(input.description);
    if (description === null) return null;
    patch.description = description;
  }
  if (input.category !== undefined) {
    const category = optionalCatalogText(input.category, MAX_NAME_SIZE);
    if (category === null) return null;
    patch.category = category;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

export function validateCatalogPlanInput(value: unknown, allowFeatures = false): CatalogPlanInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const allowed = allowFeatures
    ? new Set(["project", "plan_key", "name", "description", "status", "version", "features"])
    : new Set(["project", "plan_key", "name", "description", "status", "version"]);
  if (!hasOnlyKeys(input, allowed)) {
    return null;
  }
  const project = catalogIdentifier(input.project, MAX_PROJECT_SIZE);
  const planKey = catalogIdentifier(input.plan_key, 128);
  const name = safeString(input.name, MAX_NAME_SIZE);
  const description = optionalNotes(input.description);
  const status = catalogStatus(input.status);
  const version = boundedInt(input.version ?? 1, 1, 1_000_000);
  if (project === null || planKey === null || name === null || description === null || status === null || version === undefined) {
    return null;
  }
  return { project, plan_key: planKey, name, description, status, version };
}

export function validateCatalogPlanPatch(value: unknown): CatalogPlanPatch | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (!hasOnlyKeys(input, new Set(["name", "description"]))) {
    return null;
  }
  const patch: CatalogPlanPatch = {};
  if (input.name !== undefined) {
    const name = safeString(input.name, MAX_NAME_SIZE);
    if (name === null) return null;
    patch.name = name;
  }
  if (input.description !== undefined) {
    const description = safeNotes(input.description);
    if (description === null) return null;
    patch.description = description;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

export function validateCatalogPlanFeatureInput(value: unknown): CatalogPlanFeatureInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (!hasOnlyKeys(input, new Set([
    "project",
    "feature_key",
    "feature_inclusion",
    "addon_key",
    "policy_id",
    "status",
    "display_order",
    "assertion_ttl_seconds",
    "pool_size",
    "max_active_devices",
    "max_borrow_sec",
    "meter_quota",
    "meter_period_sec",
  ]))) {
    return null;
  }
  const project = catalogIdentifier(input.project, MAX_PROJECT_SIZE);
  const featureKey = catalogIdentifier(input.feature_key, MAX_FEATURE_SIZE);
  const inclusion = input.feature_inclusion === undefined ? "included" : input.feature_inclusion;
  const addonKey = input.addon_key === undefined ? null : nullableCatalogIdentifier(input.addon_key, 128);
  const policyId = input.policy_id === undefined ? null : nullableCatalogIdentifier(input.policy_id, 128);
  const status = catalogStatus(input.status);
  const displayOrder = boundedInt(input.display_order ?? 0, 0, 1_000_000);
  const assertionTtl = readNullableNonNegativeInt(input, "assertion_ttl_seconds", 3600);
  const poolSize = readNullableNonNegativeInt(input, "pool_size");
  const maxActiveDevices = readNullableNonNegativeInt(input, "max_active_devices");
  const maxBorrow = readNullableNonNegativeInt(input, "max_borrow_sec", MAX_DURATION_SECONDS);
  const meterQuota = readNullableNonNegativeInt(input, "meter_quota");
  const meterPeriod = readNullableNonNegativeInt(input, "meter_period_sec", MAX_DURATION_SECONDS);
  if (
    project === null || featureKey === null ||
    (inclusion !== "included" && inclusion !== "addon") ||
    (inclusion === "addon" && addonKey === null) ||
    addonKey === undefined || policyId === undefined || status === null || displayOrder === undefined ||
    assertionTtl === INVALID || poolSize === INVALID || maxActiveDevices === INVALID ||
    maxBorrow === INVALID || meterQuota === INVALID || meterPeriod === INVALID
  ) {
    return null;
  }
  return {
    project,
    feature_key: featureKey,
    feature_inclusion: inclusion,
    addon_key: inclusion === "addon" ? addonKey : null,
    policy_id: policyId,
    status,
    display_order: displayOrder,
    assertion_ttl_seconds: assertionTtl,
    pool_size: poolSize,
    max_active_devices: maxActiveDevices,
    max_borrow_sec: maxBorrow,
    meter_quota: meterQuota,
    meter_period_sec: meterPeriod,
  };
}

export function validateCatalogImportInput(value: unknown): CatalogImportInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (!hasOnlyKeys(input, new Set(["format_version", "features", "plans"]))) {
    return null;
  }
  if (input.format_version !== undefined && input.format_version !== 1) {
    return null;
  }
  if (!Array.isArray(input.features) || !Array.isArray(input.plans) || input.features.length > 200 || input.plans.length > 200) {
    return null;
  }
  const features: CatalogFeatureInput[] = [];
  const seenFeatures = new Set<string>();
  for (const feature of input.features) {
    const parsed = validateCatalogFeatureInput(feature);
    if (parsed === null) return null;
    const key = catalogTupleKey(parsed.project, parsed.feature_key);
    if (seenFeatures.has(key)) return null;
    seenFeatures.add(key);
    features.push(parsed);
  }
  const plans: Array<CatalogPlanInput & { features?: CatalogPlanFeatureInput[] }> = [];
  const seenPlans = new Set<string>();
  let featureRows = 0;
  for (const rawPlan of input.plans) {
    const parsedPlan = validateCatalogPlanInput(rawPlan, true);
    if (parsedPlan === null || typeof rawPlan !== "object" || rawPlan === null || Array.isArray(rawPlan)) {
      return null;
    }
    // `catalog_plans` is uniquely identified by (project, plan_key), not its
    // mutable version. A manifest therefore cannot contain two transitions
    // for the same server entity with differing versions.
    const planKey = catalogTupleKey(parsedPlan.project, parsedPlan.plan_key);
    if (seenPlans.has(planKey)) return null;
    seenPlans.add(planKey);
    const rawFeatures = (rawPlan as Record<string, unknown>).features;
    const planFeatures: CatalogPlanFeatureInput[] = [];
    const seenPlanFeatures = new Set<string>();
    if (rawFeatures !== undefined) {
      if (!Array.isArray(rawFeatures)) return null;
      featureRows += rawFeatures.length;
      if (featureRows > 500) return null;
      for (const rawFeature of rawFeatures) {
        const parsedFeature = validateCatalogPlanFeatureInput(rawFeature);
        if (parsedFeature === null || parsedFeature.project !== parsedPlan.project) return null;
        if (seenPlanFeatures.has(parsedFeature.feature_key)) return null;
        seenPlanFeatures.add(parsedFeature.feature_key);
        planFeatures.push(parsedFeature);
      }
    }
    plans.push({ ...parsedPlan, features: planFeatures });
  }
  return { format_version: 1, features, plans };
}
