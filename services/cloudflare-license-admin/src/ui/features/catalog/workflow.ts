import type {
  CatalogFeature,
  CatalogFeatureInput,
  CatalogFeaturePatch,
  CatalogPlan,
  CatalogPlanFeatureInput,
  CatalogPlanInput,
  CatalogPlanPatch,
  PlanProjectionApplyInput,
  PlanProjectionInput,
} from "../../../shared/api";
import { isPlanProjectionPreviewId } from "@licensecc/licensing-domain/catalog/plan_projection";
import { dateInputToEpoch } from "../../shared/dates";

export interface CatalogFilter {
  project: string;
  status: string;
}

export interface CatalogFeatureFormState {
  project: string;
  feature_key: string;
  name: string;
  description: string;
  category: string;
  status: "active" | "disabled";
}

export interface CatalogPlanFormState {
  project: string;
  plan_key: string;
  name: string;
  description: string;
  status: "active" | "disabled";
  version: number;
}

export interface CatalogPlanFeatureFormState {
  project: string;
  feature_key: string;
  feature_inclusion: "included" | "addon";
  addon_key: string;
  policy_id: string;
  status: "active" | "disabled";
  display_order: number;
  assertion_ttl_seconds: string;
  pool_size: string;
  max_active_devices: string;
  max_borrow_sec: string;
  meter_quota: string;
  meter_period_sec: string;
}

export interface PlanProjectionFormState {
  project: string;
  license_id: string;
  license_fingerprint: string;
  customer_id: string;
  plan_id: string;
  plan_key: string;
  support_until: string;
  addons: string;
  notes: string;
}

export const emptyCatalogFeatureForm: CatalogFeatureFormState = {
  project: "DEFAULT",
  feature_key: "",
  name: "",
  description: "",
  category: "",
  status: "active",
};

export const emptyCatalogPlanForm: CatalogPlanFormState = {
  project: "DEFAULT",
  plan_key: "",
  name: "",
  description: "",
  status: "active",
  version: 1,
};

export const emptyCatalogPlanFeatureForm: CatalogPlanFeatureFormState = {
  project: "DEFAULT",
  feature_key: "",
  feature_inclusion: "included",
  addon_key: "",
  policy_id: "",
  status: "active",
  display_order: 0,
  assertion_ttl_seconds: "",
  pool_size: "",
  max_active_devices: "",
  max_borrow_sec: "",
  meter_quota: "",
  meter_period_sec: "",
};

export const emptyPlanProjectionForm: PlanProjectionFormState = {
  project: "DEFAULT",
  license_id: "",
  license_fingerprint: "",
  customer_id: "",
  plan_id: "",
  plan_key: "",
  support_until: "",
  addons: "",
  notes: "",
};

export function catalogFeaturesPath(filter: CatalogFilter): string {
  const params = new URLSearchParams();
  if (filter.project !== "") params.set("project", filter.project);
  if (filter.status !== "") params.set("status", filter.status);
  return `/api/admin/catalog/features${params.size === 0 ? "" : `?${params.toString()}`}`;
}

export function catalogPlansPath(filter: CatalogFilter): string {
  const params = new URLSearchParams();
  if (filter.project !== "") params.set("project", filter.project);
  if (filter.status !== "") params.set("status", filter.status);
  return `/api/admin/catalog/plans${params.size === 0 ? "" : `?${params.toString()}`}`;
}

export function catalogPlanFeaturesPath(planId: string): string {
  return `/api/admin/catalog/plans/${encodeURIComponent(planId)}/features`;
}

export function catalogFeaturePath(id: string): string {
  return `/api/admin/catalog/features/${encodeURIComponent(id)}`;
}

export function catalogPlanPath(id: string): string {
  return `/api/admin/catalog/plans/${encodeURIComponent(id)}`;
}

export type CatalogAction = "disable" | "reenable";

export function catalogFeatureTransitionPath(id: string, action: CatalogAction): string {
  return `/api/admin/catalog/features/${encodeURIComponent(id)}/${action}`;
}

export function catalogPlanTransitionPath(id: string, action: CatalogAction): string {
  return `/api/admin/catalog/plans/${encodeURIComponent(id)}/${action}`;
}

export function catalogPlanFeatureTransitionPath(planId: string, featureKey: string, action: CatalogAction): string {
  return `/api/admin/catalog/plans/${encodeURIComponent(planId)}/features/${encodeURIComponent(featureKey)}/${action}`;
}

export function catalogPlanExportPath(planId: string): string {
  return `/api/admin/catalog/plans/${encodeURIComponent(planId)}/export`;
}

export function catalogImportPath(dryRun = false): string {
  return `/api/admin/catalog/import${dryRun ? "?dry_run=1" : ""}`;
}

export function canRunCatalogAction(status: string, action: CatalogAction): boolean {
  return action === "disable" ? status === "active" : status === "disabled";
}

export function normalizeCatalogFeatureForm(form: CatalogFeatureFormState): CatalogFeatureInput {
  const body: CatalogFeatureInput = {
    project: parseRequiredText(form.project, "project", MAX_CATALOG_PROJECT_SIZE),
    feature_key: parseRequiredText(form.feature_key, "feature_key", MAX_CATALOG_FEATURE_SIZE),
    name: parseRequiredText(form.name, "name", MAX_CATALOG_NAME_SIZE),
    status: form.status,
  };
  const description = parseNotes(form.description);
  if (description !== "") body.description = description;
  const category = parseOptionalCatalogText(form.category, "category", MAX_CATALOG_NAME_SIZE);
  if (category !== undefined) body.category = category;
  return body;
}

export function catalogFeatureFormFromRecord(feature: CatalogFeature): CatalogFeatureFormState {
  return {
    project: feature.project,
    feature_key: feature.feature_key,
    name: feature.name,
    description: feature.description,
    category: feature.category,
    status: feature.status,
  };
}

export function normalizeCatalogFeaturePatch(form: CatalogFeatureFormState): CatalogFeaturePatch {
  return {
    name: parseRequiredText(form.name, "name", MAX_CATALOG_NAME_SIZE),
    description: parseNotes(form.description),
    category: parseCatalogText(form.category, "category", MAX_CATALOG_NAME_SIZE),
  };
}

export function normalizeCatalogPlanForm(form: CatalogPlanFormState): CatalogPlanInput {
  const body: CatalogPlanInput = {
    project: parseRequiredText(form.project, "project", MAX_CATALOG_PROJECT_SIZE),
    plan_key: parseRequiredText(form.plan_key, "plan_key", MAX_CATALOG_PLAN_KEY_SIZE),
    name: parseRequiredText(form.name, "name", MAX_CATALOG_NAME_SIZE),
    status: form.status,
    version: parseBoundedInteger(form.version, "version", 1, 1_000_000),
  };
  const description = parseNotes(form.description);
  if (description !== "") body.description = description;
  return body;
}

export function catalogPlanFormFromRecord(plan: CatalogPlan): CatalogPlanFormState {
  return {
    project: plan.project,
    plan_key: plan.plan_key,
    name: plan.name,
    description: plan.description,
    status: plan.status,
    version: plan.version,
  };
}

export function normalizeCatalogPlanPatch(form: CatalogPlanFormState): CatalogPlanPatch {
  return {
    name: parseRequiredText(form.name, "name", MAX_CATALOG_NAME_SIZE),
    description: parseNotes(form.description),
  };
}

export function normalizeCatalogPlanFeatureForm(form: CatalogPlanFeatureFormState): CatalogPlanFeatureInput {
  const body: CatalogPlanFeatureInput = {
    project: parseRequiredText(form.project, "project", MAX_CATALOG_PROJECT_SIZE),
    feature_key: parseRequiredText(form.feature_key, "feature_key", MAX_CATALOG_FEATURE_SIZE),
    feature_inclusion: form.feature_inclusion,
    policy_id: parseNullableIdentifier(form.policy_id, "policy_id"),
    status: form.status,
    display_order: parseBoundedInteger(form.display_order, "display_order", 0, 1_000_000),
  };
  if (form.feature_inclusion === "addon") {
    const addonKey = parseNullableIdentifier(form.addon_key, "addon_key");
    if (addonKey === null) {
      throw new Error("addon_key_required");
    }
    body.addon_key = addonKey;
  }
  body.assertion_ttl_seconds = parseOptionalBoundedInteger(form.assertion_ttl_seconds, "assertion_ttl_seconds", 0, 3600);
  body.pool_size = parseOptionalBoundedInteger(form.pool_size, "pool_size", 0, 1_000_000);
  body.max_active_devices = parseOptionalBoundedInteger(form.max_active_devices, "max_active_devices", 0, 1_000_000);
  body.max_borrow_sec = parseOptionalBoundedInteger(form.max_borrow_sec, "max_borrow_sec", 0, MAX_POLICY_DURATION_SECONDS);
  body.meter_quota = parseOptionalBoundedInteger(form.meter_quota, "meter_quota", 0, 1_000_000_000);
  body.meter_period_sec = parseOptionalBoundedInteger(form.meter_period_sec, "meter_period_sec", 0, MAX_POLICY_DURATION_SECONDS);
  return body;
}

export function normalizePlanProjectionForm(form: PlanProjectionFormState): PlanProjectionInput {
  const planId = parseNullableIdentifier(form.plan_id, "plan_id");
  const planKey = parseNullableIdentifier(form.plan_key, "plan_key");
  if (planId === null && planKey === null) {
    throw new Error("plan_id_or_plan_key_required");
  }
  const body: PlanProjectionInput = {
    project: form.project,
    license_id: parseNullableIdentifier(form.license_id, "license_id") ?? "",
    license_fingerprint: form.license_fingerprint,
    customer_id: parseNullableIdentifier(form.customer_id, "customer_id"),
    addons: splitCsvIdentifiers(form.addons, "addon"),
    notes: parseNotes(form.notes),
  };
  if (body.license_id === "") {
    throw new Error("license_id_required");
  }
  if (planId !== null) body.plan_id = planId;
  if (planKey !== null) body.plan_key = planKey;
  if (form.support_until !== "") body.support_until = dateInputToEpoch(form.support_until, "support_until");
  return body;
}

export function planProjectionInputSnapshot(input: PlanProjectionInput): string {
  const snapshot: Record<string, unknown> = {
    project: input.project,
    license_id: input.license_id,
    license_fingerprint: input.license_fingerprint,
    customer_id: input.customer_id ?? null,
    plan_id: input.plan_id ?? null,
    plan_key: input.plan_key ?? null,
    support_until: input.support_until ?? null,
    support_until_provided: Object.prototype.hasOwnProperty.call(input, "support_until"),
    addons: input.addons ?? [],
    notes: input.notes ?? "",
  };
  return JSON.stringify(snapshot);
}

export async function planProjectionInputDigest(input: PlanProjectionInput): Promise<string> {
  const bytes = new TextEncoder().encode(planProjectionInputSnapshot(input));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function planProjectionPreviewPath(): string {
  return "/api/admin/license-plans/preview";
}

export function planProjectionApplyPath(): string {
  return "/api/admin/license-plans/apply";
}

export function planProjectionApplyBody(previewId: string): PlanProjectionApplyInput {
  if (!isPlanProjectionPreviewId(previewId)) {
    throw new Error("preview_id_required_or_invalid");
  }
  return { preview_id: previewId };
}

export function disableCatalogFeatureConfirm(feature: { name: string; feature_key: string; project: string }): string {
  return `Disable feature "${feature.name}" (${feature.project} / ${feature.feature_key}). New plan projections skip disabled feature definitions until re-enabled.`;
}

export function disableCatalogPlanConfirm(plan: { name: string; plan_key: string; project: string; version: number }): string {
  return `Disable plan "${plan.name}" (${plan.project} / ${plan.plan_key} v${plan.version}). New plan projections using this plan are blocked until re-enabled.`;
}

export function disableCatalogPlanFeatureConfirm(row: { feature_key: string; plan_key: string; feature_inclusion: string }): string {
  return `Disable ${row.feature_inclusion} row "${row.feature_key}" on plan "${row.plan_key}". New projections skip this row until it is re-enabled.`;
}

const MAX_CATALOG_PROJECT_SIZE = 127;
const MAX_CATALOG_FEATURE_SIZE = 15;
const MAX_CATALOG_NAME_SIZE = 127;
const MAX_CATALOG_PLAN_KEY_SIZE = 128;
const MAX_POLICY_DURATION_SECONDS = 3_153_600_000;

function parseBoundedInteger(value: number, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}_must_be_between_${min}_and_${max}`);
  }
  return parsed;
}

function parseOptionalBoundedInteger(value: string, label: string, min: number, max: number): number | null {
  if (value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}_must_be_between_${min}_and_${max}`);
  }
  return parsed;
}

function parseNotes(value: string): string {
  if (value.length > 1000 || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error("notes_must_be_at_most_1000_chars");
  }
  return value;
}

function parseNullableIdentifier(value: string, label: string): string | null {
  if (value === "") {
    return null;
  }
  if (value.length > 128 || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error(`${label}_must_be_at_most_128_chars`);
  }
  return value;
}

function parseRequiredText(value: string, label: string, maxLength: number): string {
  if (value.length === 0 || value.length > maxLength || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error(`${label}_required_or_too_long`);
  }
  return value;
}

function parseOptionalCatalogText(value: string, label: string, maxLength: number): string | undefined {
  if (value === "") {
    return undefined;
  }
  return parseRequiredText(value, label, maxLength);
}

function parseCatalogText(value: string, label: string, maxLength: number): string {
  if (value.length > maxLength || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error(`${label}_too_long_or_invalid`);
  }
  return value;
}

function splitCsvIdentifiers(value: string, label: string): string[] {
  if (value.trim() === "") {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const item = raw.trim();
    if (item === "") {
      continue;
    }
    const parsed = parseNullableIdentifier(item, label);
    if (parsed !== null && !seen.has(parsed)) {
      seen.add(parsed);
      out.push(parsed);
    }
  }
  return out;
}
