export const CATALOG_IMPORT_PREVIEW_ID_PATTERN: RegExp;
export const CATALOG_IMPORT_MAX_MUTABLE_ACTIONS: 13;
export const CATALOG_IMPORT_TOO_LARGE_GUIDANCE: "narrow the manifest and preview again";
export function isCatalogImportPreviewId(value: unknown): value is string;

export type CatalogImportStatus = "active" | "disabled";
export type CatalogImportEffectKind = "create" | "update" | "disable" | "reenable" | "unchanged";
export type CatalogImportEntityType = "feature" | "plan" | "plan_feature";

export interface CatalogImportFeatureInput {
  project: string;
  feature_key: string;
  name: string;
  description?: string;
  category?: string;
  status?: CatalogImportStatus;
}

export interface CatalogImportPlanFeatureInput {
  project: string;
  feature_key: string;
  feature_inclusion?: "included" | "addon";
  addon_key?: string | null;
  policy_id?: string | null;
  status?: CatalogImportStatus;
  display_order?: number;
  assertion_ttl_seconds?: number | null;
  pool_size?: number | null;
  max_active_devices?: number | null;
  max_borrow_sec?: number | null;
  meter_quota?: number | null;
  meter_period_sec?: number | null;
}

export interface CatalogImportPlanInput {
  project: string;
  plan_key: string;
  name: string;
  description?: string;
  status?: CatalogImportStatus;
  version?: number;
  features?: CatalogImportPlanFeatureInput[];
}

export interface CatalogImportManifest {
  format_version?: 1;
  features: CatalogImportFeatureInput[];
  plans: CatalogImportPlanInput[];
}

export interface NormalizedCatalogImportFeature {
  project: string;
  feature_key: string;
  name: string;
  description: string;
  category: string;
  status: CatalogImportStatus;
}

export interface NormalizedCatalogImportPlanFeature {
  project: string;
  feature_key: string;
  feature_inclusion: "included" | "addon";
  addon_key: string | null;
  policy_id: string | null;
  status: CatalogImportStatus;
  display_order: number;
  assertion_ttl_seconds: number | null;
  pool_size: number | null;
  max_active_devices: number | null;
  max_borrow_sec: number | null;
  meter_quota: number | null;
  meter_period_sec: number | null;
}

export interface NormalizedCatalogImportPlan {
  project: string;
  plan_key: string;
  name: string;
  description: string;
  status: CatalogImportStatus;
  version: number;
  features: NormalizedCatalogImportPlanFeature[];
}

export interface NormalizedCatalogImportManifest {
  format_version: 1;
  features: NormalizedCatalogImportFeature[];
  plans: NormalizedCatalogImportPlan[];
}

export function normalizeCatalogImportManifest(value: CatalogImportManifest): NormalizedCatalogImportManifest;
export function catalogImportManifestSnapshot(value: CatalogImportManifest): string;
export function catalogImportManifestDigest(value: CatalogImportManifest): Promise<string>;

export interface CatalogImportEffectTarget {
  entity: CatalogImportEntityType;
  project: string;
  feature_key?: string;
  plan_key?: string;
  plan_id?: string;
}

export interface CatalogImportEffect {
  target: CatalogImportEffectTarget;
  effect: CatalogImportEffectKind;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}

export interface CatalogImportEffectCounter {
  create: number;
  update: number;
  disable: number;
  reenable: number;
  unchanged: number;
}

export interface CatalogImportEffects {
  features: CatalogImportEffect[];
  plans: CatalogImportEffect[];
  plan_features: CatalogImportEffect[];
  summary: {
    features: CatalogImportEffectCounter;
    plans: CatalogImportEffectCounter;
    plan_features: CatalogImportEffectCounter;
  };
}

export interface CatalogImportPreviewResponse {
  preview_id: string;
  manifest_digest: string;
  manifest: NormalizedCatalogImportManifest;
  effects: CatalogImportEffects;
  effective_at: number;
  expires_at: number;
  source_generation: number;
}

export interface CatalogImportApplyInput {
  preview_id: string;
}

export type CatalogImportApplyResult = CatalogImportPreviewResponse;
