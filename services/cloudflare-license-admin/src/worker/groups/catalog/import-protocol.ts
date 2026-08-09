// Server-bound preview/apply protocol for portable catalog imports.
//
// A manifest is never re-read during Apply. Preview reads every live dependency
// in one D1 snapshot, stores the normalized manifest and exact effects, and
// binds that capability to one actor and catalog generation. Apply then claims
// it and carries every catalog write/audit/assertion/idempotency/consume step in
// one batch. This is intentionally admin-local: no other deployable consumes
// the catalog-import transition.
import {
  CATALOG_IMPORT_MAX_MUTABLE_ACTIONS,
  catalogImportManifestDigest,
  isCatalogImportPreviewId,
  normalizeCatalogImportManifest,
  type CatalogImportApplyResult,
  type CatalogImportEffect,
  type CatalogImportEffectCounter,
  type CatalogImportEffectKind,
  type CatalogImportEffects,
  type CatalogImportPreviewResponse,
  type NormalizedCatalogImportManifest,
} from "@licensecc/licensing-domain/catalog/import_preview";
import type { Actor, D1DatabaseLike, MutationContext } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";

import type { Env } from "../../env.js";
import {
  CATALOG_FEATURE_COLUMNS,
  CATALOG_PLAN_COLUMNS,
  CATALOG_PLAN_FEATURE_COLUMNS,
  catalogActor,
  catalogJsonObject,
} from "./operations.js";
import type {
  CatalogFeatureInput,
  CatalogImportInput,
  CatalogPlanFeatureInput,
  CatalogPlanInput,
} from "./validation.js";

const PREVIEW_SCOPE = "catalog";
const PREVIEW_TTL_SECONDS = 300;
const PREVIEW_CLEANUP_BATCH_SIZE = 25;
const APPLY_CODE = "catalog_import_applied";

// Apply uses 7 fixed batch statements plus exactly three statements for every
// mutable action (DML, audit, assertion). At 13 actions this is 46 statements;
// the replay lookup and immutable-preview read make 48 winner queries. A same
// key concurrent loser retries its replay cache after the gated batch, making
// 49. Both are strictly below the 50-query Workers Free limit. Do not chunk
// imports: an oversized Preview is rejected before any cleanup/persist write.
export const MAX_ATOMIC_CATALOG_IMPORT_ACTIONS = CATALOG_IMPORT_MAX_MUTABLE_ACTIONS;

type StoredRow = Record<string, unknown>;
type CatalogEntity = "feature" | "plan" | "plan_feature";

interface CatalogImportAction {
  target: CatalogImportEffect["target"];
  effect: Exclude<CatalogImportEffectKind, "unchanged">;
  before: StoredRow | null;
  after: StoredRow;
}

interface ImportSnapshot {
  sourceGeneration: number;
  features: Map<string, StoredRow>;
  plans: Map<string, StoredRow>;
  planFeatures: Map<string, StoredRow>;
  referencedFeatures: Set<string>;
  policies: Map<string, StoredRow>;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function resultsOf(result: unknown): StoredRow[] {
  const rows = (result as { results?: unknown } | null)?.results;
  return Array.isArray(rows) ? rows.filter((row): row is StoredRow => typeof row === "object" && row !== null) : [];
}

function firstResult(result: unknown): StoredRow | null {
  return resultsOf(result)[0] ?? null;
}

function parseJson(value: unknown, errorCode: string): unknown {
  if (typeof value !== "string") throw new Error(errorCode);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(errorCode);
  }
}

function requireBatch(env: Env): void {
  if (typeof env.DB.batch !== "function") throw new Error("catalog_import_batch_required");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function rowString(row: StoredRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new Error("catalog_import_preview_invalid");
  return value;
}

function rowInteger(row: StoredRow, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("catalog_import_preview_invalid");
  return value;
}

function nullableInteger(row: StoredRow, field: string): number | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("catalog_import_preview_invalid");
  return value;
}

function key(...parts: Array<string | number>): string {
  // Catalog request validation rejects U+001F as well, but this representation
  // stays collision-free for pre-existing rows and never depends on a delimiter.
  return JSON.stringify(parts);
}

function qualifiedColumns(columns: string, alias: string): string {
  return columns.split(", ").map((column) => `${alias}.${column}`).join(", ");
}

function featureRow(row: StoredRow): StoredRow {
  return {
    id: rowString(row, "id"),
    project: rowString(row, "project"),
    feature_key: rowString(row, "feature_key"),
    name: rowString(row, "name"),
    description: rowString(row, "description"),
    category: rowString(row, "category"),
    status: rowString(row, "status"),
    created_at: rowInteger(row, "created_at"),
    updated_at: rowInteger(row, "updated_at"),
  };
}

function planRow(row: StoredRow): StoredRow {
  return {
    id: rowString(row, "id"),
    project: rowString(row, "project"),
    plan_key: rowString(row, "plan_key"),
    name: rowString(row, "name"),
    status: rowString(row, "status"),
    version: rowInteger(row, "version"),
    description: rowString(row, "description"),
    created_at: rowInteger(row, "created_at"),
    updated_at: rowInteger(row, "updated_at"),
  };
}

function planFeatureRow(row: StoredRow): StoredRow {
  return {
    project: rowString(row, "project"),
    plan_id: rowString(row, "plan_id"),
    feature_key: rowString(row, "feature_key"),
    feature_inclusion: rowString(row, "feature_inclusion"),
    addon_key: row.addon_key === null ? null : rowString(row, "addon_key"),
    policy_id: row.policy_id === null ? null : rowString(row, "policy_id"),
    status: rowString(row, "status"),
    display_order: rowInteger(row, "display_order"),
    assertion_ttl_seconds: nullableInteger(row, "assertion_ttl_seconds"),
    pool_size: nullableInteger(row, "pool_size"),
    max_active_devices: nullableInteger(row, "max_active_devices"),
    max_borrow_sec: nullableInteger(row, "max_borrow_sec"),
    meter_quota: nullableInteger(row, "meter_quota"),
    meter_period_sec: nullableInteger(row, "meter_period_sec"),
    created_at: rowInteger(row, "created_at"),
    updated_at: rowInteger(row, "updated_at"),
  };
}

function featureMatches(row: StoredRow, input: CatalogFeatureInput): boolean {
  return row.name === input.name &&
    row.description === input.description &&
    row.category === input.category &&
    row.status === input.status;
}

function planMatches(row: StoredRow, input: CatalogPlanInput): boolean {
  return row.name === input.name &&
    row.description === input.description &&
    row.status === input.status &&
    row.version === input.version;
}

function planFeatureMatches(row: StoredRow, input: CatalogPlanFeatureInput): boolean {
  return row.project === input.project &&
    row.feature_key === input.feature_key &&
    row.feature_inclusion === input.feature_inclusion &&
    (row.addon_key ?? null) === input.addon_key &&
    (row.policy_id ?? null) === input.policy_id &&
    row.status === input.status &&
    row.display_order === input.display_order &&
    (row.assertion_ttl_seconds ?? null) === input.assertion_ttl_seconds &&
    (row.pool_size ?? null) === input.pool_size &&
    (row.max_active_devices ?? null) === input.max_active_devices &&
    (row.max_borrow_sec ?? null) === input.max_borrow_sec &&
    (row.meter_quota ?? null) === input.meter_quota &&
    (row.meter_period_sec ?? null) === input.meter_period_sec;
}

function catalogEffect(existing: StoredRow | null, matches: boolean, nextStatus: string): CatalogImportEffectKind {
  if (existing === null) return "create";
  if (matches) return "unchanged";
  if (existing.status === "active" && nextStatus === "disabled") return "disable";
  if (existing.status === "disabled" && nextStatus === "active") return "reenable";
  return "update";
}

function emptyCounter(): CatalogImportEffectCounter {
  return { create: 0, update: 0, disable: 0, reenable: 0, unchanged: 0 };
}

function emptyEffects(): CatalogImportEffects {
  return {
    features: [],
    plans: [],
    plan_features: [],
    summary: {
      features: emptyCounter(),
      plans: emptyCounter(),
      plan_features: emptyCounter(),
    },
  };
}

function appendEffect(
  effects: CatalogImportEffects,
  collection: "features" | "plans" | "plan_features",
  effect: CatalogImportEffect,
  actions: CatalogImportAction[],
): void {
  effects[collection].push(effect);
  effects.summary[collection][effect.effect] += 1;
  if (effect.effect !== "unchanged") {
    actions.push({
      target: effect.target,
      effect: effect.effect,
      before: effect.before,
      after: effect.after,
    });
  }
}

function featureAfter(input: CatalogFeatureInput, existing: StoredRow | null, effectiveAt: number): StoredRow {
  return {
    id: existing === null ? `feat_${crypto.randomUUID()}` : rowString(existing, "id"),
    project: input.project,
    feature_key: input.feature_key,
    name: input.name,
    description: input.description,
    category: input.category,
    status: input.status,
    created_at: existing === null ? effectiveAt : rowInteger(existing, "created_at"),
    updated_at: effectiveAt,
  };
}

function planAfter(input: CatalogPlanInput, existing: StoredRow | null, effectiveAt: number): StoredRow {
  return {
    id: existing === null ? `plan_${crypto.randomUUID()}` : rowString(existing, "id"),
    project: input.project,
    plan_key: input.plan_key,
    name: input.name,
    status: input.status,
    version: input.version,
    description: input.description,
    created_at: existing === null ? effectiveAt : rowInteger(existing, "created_at"),
    updated_at: effectiveAt,
  };
}

function planFeatureAfter(input: CatalogPlanFeatureInput, planId: string, existing: StoredRow | null, effectiveAt: number): StoredRow {
  return {
    project: input.project,
    plan_id: planId,
    feature_key: input.feature_key,
    feature_inclusion: input.feature_inclusion,
    addon_key: input.addon_key,
    policy_id: input.policy_id,
    status: input.status,
    display_order: input.display_order,
    assertion_ttl_seconds: input.assertion_ttl_seconds,
    pool_size: input.pool_size,
    max_active_devices: input.max_active_devices,
    max_borrow_sec: input.max_borrow_sec,
    meter_quota: input.meter_quota,
    meter_period_sec: input.meter_period_sec,
    created_at: existing === null ? effectiveAt : rowInteger(existing, "created_at"),
    updated_at: effectiveAt,
  };
}

function featureInputs(manifest: NormalizedCatalogImportManifest): CatalogFeatureInput[] {
  return manifest.features as CatalogFeatureInput[];
}

function planInputs(manifest: NormalizedCatalogImportManifest): Array<CatalogPlanInput & { features: CatalogPlanFeatureInput[] }> {
  return manifest.plans as Array<CatalogPlanInput & { features: CatalogPlanFeatureInput[] }>;
}

function importFeatureReferences(manifest: NormalizedCatalogImportManifest): Array<{ project: string; feature_key: string }> {
  return planInputs(manifest).flatMap((plan) => plan.features.map((feature) => ({ project: feature.project, feature_key: feature.feature_key })));
}

function importPolicyIds(manifest: NormalizedCatalogImportManifest): string[] {
  return [...new Set(planInputs(manifest).flatMap((plan) => plan.features.map((feature) => feature.policy_id).filter((id): id is string => id !== null)))];
}

async function buildSnapshot(env: Env, manifest: NormalizedCatalogImportManifest): Promise<ImportSnapshot> {
  const batch = env.DB.batch;
  if (typeof batch !== "function") throw new Error("catalog_import_batch_required");
  const references = importFeatureReferences(manifest);
  const policyIds = importPolicyIds(manifest);
  const [generationResult, featuresResult, plansResult, planFeaturesResult, referencedFeaturesResult, policiesResult] = await batch.call(env.DB, [
    env.DB.prepare("SELECT generation FROM license_plan_projection_generations WHERE scope = ? LIMIT 1").bind(PREVIEW_SCOPE),
    env.DB.prepare(
      `SELECT ${qualifiedColumns(CATALOG_FEATURE_COLUMNS, "f")}
       FROM catalog_features f
       JOIN json_each(?) AS wanted
         ON f.project = json_extract(wanted.value, '$.project')
        AND f.feature_key = json_extract(wanted.value, '$.feature_key')
       ORDER BY f.project, f.feature_key`,
    ).bind(JSON.stringify(featureInputs(manifest))),
    env.DB.prepare(
      `SELECT ${qualifiedColumns(CATALOG_PLAN_COLUMNS, "cp")}
       FROM catalog_plans cp
       JOIN json_each(?) AS wanted
         ON cp.project = json_extract(wanted.value, '$.project')
        AND cp.plan_key = json_extract(wanted.value, '$.plan_key')
       ORDER BY cp.project, cp.plan_key`,
    ).bind(JSON.stringify(planInputs(manifest))),
    env.DB.prepare(
      `WITH wanted AS (
         SELECT json_extract(plan.value, '$.project') AS project,
                json_extract(plan.value, '$.plan_key') AS plan_key,
                feature.value AS feature
         FROM json_each(?) AS plan
         JOIN json_each(json_extract(plan.value, '$.features')) AS feature ON 1 = 1
       )
       SELECT ${qualifiedColumns(CATALOG_PLAN_FEATURE_COLUMNS, "pf")}
       FROM catalog_plan_features pf
       JOIN catalog_plans cp ON cp.project = pf.project AND cp.id = pf.plan_id
       JOIN wanted w
         ON w.project = cp.project
        AND w.plan_key = cp.plan_key
        AND json_extract(w.feature, '$.feature_key') = pf.feature_key
       ORDER BY pf.project, pf.plan_id, pf.feature_key`,
    ).bind(JSON.stringify(planInputs(manifest))),
    env.DB.prepare(
      `SELECT f.project, f.feature_key
       FROM catalog_features f
       JOIN json_each(?) AS wanted
         ON f.project = json_extract(wanted.value, '$.project')
        AND f.feature_key = json_extract(wanted.value, '$.feature_key')`,
    ).bind(JSON.stringify(references)),
    env.DB.prepare(
      `SELECT p.id, p.project, p.status
       FROM entitlement_policies p
       JOIN json_each(?) AS wanted ON p.id = wanted.value`,
    ).bind(JSON.stringify(policyIds)),
  ]);

  const generation = Number(firstResult(generationResult)?.generation);
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("catalog_import_generation_missing");
  return {
    sourceGeneration: generation,
    features: new Map(resultsOf(featuresResult).map((row) => {
      const value = featureRow(row);
      return [key(rowString(value, "project"), rowString(value, "feature_key")), value];
    })),
    plans: new Map(resultsOf(plansResult).map((row) => {
      const value = planRow(row);
      return [key(rowString(value, "project"), rowString(value, "plan_key")), value];
    })),
    planFeatures: new Map(resultsOf(planFeaturesResult).map((row) => {
      const value = planFeatureRow(row);
      return [key(rowString(value, "plan_id"), rowString(value, "feature_key")), value];
    })),
    referencedFeatures: new Set(resultsOf(referencedFeaturesResult).map((row) => key(rowString(row, "project"), rowString(row, "feature_key")))),
    policies: new Map(resultsOf(policiesResult).map((row) => [rowString(row, "id"), row])),
  };
}

function validateSnapshotDependencies(snapshot: ImportSnapshot, manifest: NormalizedCatalogImportManifest): void {
  const importedFeatures = new Set(featureInputs(manifest).map((feature) => key(feature.project, feature.feature_key)));
  for (const plan of planInputs(manifest)) {
    for (const feature of plan.features) {
      const featureKey = key(feature.project, feature.feature_key);
      if (!importedFeatures.has(featureKey) && !snapshot.referencedFeatures.has(featureKey)) {
        throw new Error(`catalog_feature_not_found:${feature.feature_key}`);
      }
      if (feature.policy_id === null) continue;
      const policy = snapshot.policies.get(feature.policy_id);
      if (policy === undefined) throw new Error(`policy_not_found:${feature.policy_id}`);
      if (policy.project !== feature.project) throw new Error(`invalid_plan_config:${feature.policy_id}`);
      if (policy.status !== "active") throw new Error(`policy_disabled:${feature.policy_id}`);
    }
  }
}

function deriveEffects(snapshot: ImportSnapshot, manifest: NormalizedCatalogImportManifest, effectiveAt: number): { effects: CatalogImportEffects; actions: CatalogImportAction[] } {
  validateSnapshotDependencies(snapshot, manifest);
  const effects = emptyEffects();
  const actions: CatalogImportAction[] = [];
  const plannedIds = new Map<string, string>();

  for (const input of featureInputs(manifest)) {
    const existing = snapshot.features.get(key(input.project, input.feature_key)) ?? null;
    const matches = existing !== null && featureMatches(existing, input);
    const after = matches ? existing : featureAfter(input, existing, effectiveAt);
    const effect = catalogEffect(existing, matches, input.status);
    appendEffect(effects, "features", {
      target: { entity: "feature", project: input.project, feature_key: input.feature_key },
      effect,
      before: existing,
      after,
    }, actions);
  }

  for (const input of planInputs(manifest)) {
    const identity = key(input.project, input.plan_key);
    const existing = snapshot.plans.get(identity) ?? null;
    const matches = existing !== null && planMatches(existing, input);
    const after = matches ? existing : planAfter(input, existing, effectiveAt);
    plannedIds.set(identity, rowString(after, "id"));
    const effect = catalogEffect(existing, matches, input.status);
    appendEffect(effects, "plans", {
      target: { entity: "plan", project: input.project, plan_key: input.plan_key, plan_id: rowString(after, "id") },
      effect,
      before: existing,
      after,
    }, actions);
  }

  for (const plan of planInputs(manifest)) {
    const planId = plannedIds.get(key(plan.project, plan.plan_key));
    if (planId === undefined) throw new Error("catalog_import_preview_invalid");
    for (const input of plan.features) {
      const existing = snapshot.planFeatures.get(key(planId, input.feature_key)) ?? null;
      const matches = existing !== null && planFeatureMatches(existing, input);
      const after = matches ? existing : planFeatureAfter(input, planId, existing, effectiveAt);
      const effect = catalogEffect(existing, matches, input.status);
      appendEffect(effects, "plan_features", {
        target: { entity: "plan_feature", project: input.project, plan_key: plan.plan_key, plan_id: planId, feature_key: input.feature_key },
        effect,
        before: existing,
        after,
      }, actions);
    }
  }

  return { effects, actions };
}

function assertAtomicCapacity(actions: CatalogImportAction[]): void {
  if (actions.length > MAX_ATOMIC_CATALOG_IMPORT_ACTIONS) throw new Error("catalog_import_too_large");
}

function cleanupExpiredPreviewsStatement(env: Env, now: number): ReturnType<D1DatabaseLike["prepare"]> {
  return env.DB.prepare(
    `DELETE FROM catalog_import_previews
     WHERE id IN (
       SELECT id
       FROM catalog_import_previews
       WHERE expires_at <= ? OR consumed_at IS NOT NULL
       ORDER BY expires_at ASC, id ASC
       LIMIT ?
     )`,
  ).bind(now, PREVIEW_CLEANUP_BATCH_SIZE);
}

function insertPreviewStatement(
  env: Env,
  preview: CatalogImportPreviewResponse,
  actorSubject: string,
  actions: CatalogImportAction[],
): ReturnType<D1DatabaseLike["prepare"]> {
  return env.DB.prepare(
    `INSERT INTO catalog_import_previews
       (id, actor_subject, source_generation, normalized_manifest_json, manifest_digest, preview_json, actions_json,
        effective_at, expires_at, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM license_plan_projection_generations
       WHERE scope = ? AND generation = ?
     )
     RETURNING id`,
  ).bind(
    preview.preview_id,
    actorSubject,
    preview.source_generation,
    JSON.stringify(preview.manifest),
    preview.manifest_digest,
    JSON.stringify(preview),
    JSON.stringify(actions),
    preview.effective_at,
    preview.expires_at,
    preview.effective_at,
    PREVIEW_SCOPE,
    preview.source_generation,
  );
}

export async function previewCatalogImport(
  env: Env,
  input: CatalogImportInput,
  actorSubject: string,
  now = nowSeconds(),
): Promise<CatalogImportPreviewResponse> {
  requireBatch(env);
  if (!nonEmptyString(actorSubject)) throw new Error("invalid_actor");
  const manifest = normalizeCatalogImportManifest(input);
  const effectiveAt = now;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await buildSnapshot(env, manifest);
    const { effects, actions } = deriveEffects(snapshot, manifest, effectiveAt);
    assertAtomicCapacity(actions);
    const preview: CatalogImportPreviewResponse = {
      preview_id: `civ_${crypto.randomUUID()}`,
      manifest_digest: await catalogImportManifestDigest(manifest),
      manifest,
      effects,
      effective_at: effectiveAt,
      expires_at: effectiveAt + PREVIEW_TTL_SECONDS,
      source_generation: snapshot.sourceGeneration,
    };
    // Capacity is intentionally checked before cleanup/persist. A too-large
    // import therefore remains entirely read-only and tells the operator to
    // narrow the manifest rather than silently chunking a partial transition.
    const batch = env.DB.batch;
    if (typeof batch !== "function") throw new Error("catalog_import_batch_required");
    const persisted = await batch.call(env.DB, [
      cleanupExpiredPreviewsStatement(env, effectiveAt),
      insertPreviewStatement(env, preview, actorSubject, actions),
    ]);
    if (resultsOf(persisted[1]).length === 1) return preview;
  }
  throw new Error("catalog_import_snapshot_stale");
}

async function storedPreview(env: Env, previewId: string): Promise<{ preview: CatalogImportPreviewResponse; actions: CatalogImportAction[] }> {
  const row = await env.DB.prepare(
    "SELECT preview_json, actions_json FROM catalog_import_previews WHERE id = ? LIMIT 1",
  ).bind(previewId).first<StoredRow>();
  if (row === null) throw new Error("stale_catalog_import_preview");
  const preview = parseJson(row.preview_json, "catalog_import_preview_invalid");
  const actions = parseJson(row.actions_json, "catalog_import_preview_invalid");
  if (typeof preview !== "object" || preview === null || Array.isArray(preview) || !Array.isArray(actions)) {
    throw new Error("catalog_import_preview_invalid");
  }
  const parsedPreview = preview as CatalogImportPreviewResponse;
  const parsedActions = actions as CatalogImportAction[];
  if (parsedPreview.preview_id !== previewId || !parsedActions.every((action: unknown) => {
    const candidate = action as { effect?: unknown; target?: unknown; after?: unknown } | null;
    return typeof candidate === "object" && candidate !== null &&
      typeof candidate.effect === "string" && candidate.effect !== "unchanged" &&
      typeof candidate.target === "object" && candidate.target !== null &&
      typeof candidate.after === "object" && candidate.after !== null;
  })) {
    throw new Error("catalog_import_preview_invalid");
  }
  assertAtomicCapacity(parsedActions);
  return { preview: parsedPreview, actions: parsedActions };
}

function claimGuardSql(): string {
  return "EXISTS (SELECT 1 FROM catalog_import_previews p WHERE p.id = ? AND p.claim_token = ? AND p.consumed_at IS NULL)";
}

function claimStatement(env: Env, previewId: string, actorSubject: string, claimToken: string, now: number): ReturnType<D1DatabaseLike["prepare"]> {
  return env.DB.prepare(
    `UPDATE catalog_import_previews AS p
     SET claim_token = ?, claimed_at = ?
     WHERE p.id = ?
       AND p.actor_subject = ?
       AND p.claim_token IS NULL
       AND p.consumed_at IS NULL
       AND p.expires_at > ?
       AND p.source_generation = (
         SELECT generation FROM license_plan_projection_generations WHERE scope = ?
       )
     RETURNING id`,
  ).bind(claimToken, now, previewId, actorSubject, now, PREVIEW_SCOPE);
}

function claimFailureStatement(env: Env, previewId: string, actorSubject: string, now: number): ReturnType<D1DatabaseLike["prepare"]> {
  // This classifier lives in the same batch as the conditional claim. It can
  // explain a zero-row claim without reopening a TOCTOU gap; no later statement
  // can write unless the unique claim token exists.
  return env.DB.prepare(
    `SELECT CASE
       WHEN NOT EXISTS (
         SELECT 1 FROM catalog_import_previews p WHERE p.id = ? AND p.actor_subject = ?
       ) THEN 'stale_catalog_import_preview'
       WHEN EXISTS (
         SELECT 1 FROM catalog_import_previews p
         WHERE p.id = ? AND p.actor_subject = ? AND p.expires_at <= ?
       ) THEN 'expired_catalog_import_preview'
       WHEN EXISTS (
         SELECT 1 FROM catalog_import_previews p
         WHERE p.id = ? AND p.actor_subject = ? AND (p.claim_token IS NOT NULL OR p.consumed_at IS NOT NULL)
       ) THEN 'claimed_catalog_import_preview'
       ELSE 'stale_catalog_import_preview'
     END AS catalog_import_claim_error`,
  ).bind(previewId, actorSubject, previewId, actorSubject, now, previewId, actorSubject);
}

function entityFor(action: CatalogImportAction): CatalogEntity {
  const entity = action.target.entity;
  if (entity !== "feature" && entity !== "plan" && entity !== "plan_feature") throw new Error("catalog_import_preview_invalid");
  return entity;
}

function featureMatchSql(alias: string): string {
  return `${alias}.id IS ? AND ${alias}.project IS ? AND ${alias}.feature_key IS ? AND ${alias}.name IS ?
    AND ${alias}.description IS ? AND ${alias}.category IS ? AND ${alias}.status IS ?
    AND ${alias}.created_at IS ? AND ${alias}.updated_at IS ?`;
}

function featureMatchValues(after: StoredRow): unknown[] {
  return [
    rowString(after, "id"), rowString(after, "project"), rowString(after, "feature_key"), rowString(after, "name"),
    rowString(after, "description"), rowString(after, "category"), rowString(after, "status"),
    rowInteger(after, "created_at"), rowInteger(after, "updated_at"),
  ];
}

function planMatchSql(alias: string): string {
  return `${alias}.id IS ? AND ${alias}.project IS ? AND ${alias}.plan_key IS ? AND ${alias}.name IS ?
    AND ${alias}.status IS ? AND ${alias}.version IS ? AND ${alias}.description IS ?
    AND ${alias}.created_at IS ? AND ${alias}.updated_at IS ?`;
}

function planMatchValues(after: StoredRow): unknown[] {
  return [
    rowString(after, "id"), rowString(after, "project"), rowString(after, "plan_key"), rowString(after, "name"),
    rowString(after, "status"), rowInteger(after, "version"), rowString(after, "description"),
    rowInteger(after, "created_at"), rowInteger(after, "updated_at"),
  ];
}

function planFeatureMatchSql(alias: string): string {
  return `${alias}.project IS ? AND ${alias}.plan_id IS ? AND ${alias}.feature_key IS ? AND ${alias}.feature_inclusion IS ?
    AND ${alias}.addon_key IS ? AND ${alias}.policy_id IS ? AND ${alias}.status IS ? AND ${alias}.display_order IS ?
    AND ${alias}.assertion_ttl_seconds IS ? AND ${alias}.pool_size IS ? AND ${alias}.max_active_devices IS ?
    AND ${alias}.max_borrow_sec IS ? AND ${alias}.meter_quota IS ? AND ${alias}.meter_period_sec IS ?
    AND ${alias}.created_at IS ? AND ${alias}.updated_at IS ?`;
}

function planFeatureMatchValues(after: StoredRow): unknown[] {
  return [
    rowString(after, "project"), rowString(after, "plan_id"), rowString(after, "feature_key"), rowString(after, "feature_inclusion"),
    after.addon_key ?? null, after.policy_id ?? null, rowString(after, "status"), rowInteger(after, "display_order"),
    after.assertion_ttl_seconds ?? null, after.pool_size ?? null, after.max_active_devices ?? null,
    after.max_borrow_sec ?? null, after.meter_quota ?? null, after.meter_period_sec ?? null,
    rowInteger(after, "created_at"), rowInteger(after, "updated_at"),
  ];
}

function actionEntityId(action: CatalogImportAction): string {
  const after = action.after;
  switch (entityFor(action)) {
    case "feature":
    case "plan":
      return rowString(after, "id");
    case "plan_feature":
      return `${rowString(after, "plan_id")}:${rowString(after, "feature_key")}`;
  }
}

function actionProject(action: CatalogImportAction): string {
  return rowString(action.after, "project");
}

function mutationStatement(env: Env, action: CatalogImportAction, previewId: string, claimToken: string): ReturnType<D1DatabaseLike["prepare"]> {
  const after = action.after;
  switch (entityFor(action)) {
    case "feature":
      if (action.effect === "create") {
        return env.DB.prepare(
          `INSERT INTO catalog_features
             (id, project, feature_key, name, description, category, status, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE ${claimGuardSql()}
           RETURNING id`,
        ).bind(...featureMatchValues(after), previewId, claimToken);
      }
      return env.DB.prepare(
        `UPDATE catalog_features
         SET name = ?, description = ?, category = ?, status = ?, updated_at = ?
         WHERE id = ? AND project = ? AND feature_key = ? AND ${claimGuardSql()}
         RETURNING id`,
      ).bind(
        rowString(after, "name"), rowString(after, "description"), rowString(after, "category"), rowString(after, "status"), rowInteger(after, "updated_at"),
        rowString(after, "id"), rowString(after, "project"), rowString(after, "feature_key"), previewId, claimToken,
      );
    case "plan":
      if (action.effect === "create") {
        return env.DB.prepare(
          `INSERT INTO catalog_plans
             (id, project, plan_key, name, status, version, description, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE ${claimGuardSql()}
           RETURNING id`,
        ).bind(...planMatchValues(after), previewId, claimToken);
      }
      return env.DB.prepare(
        `UPDATE catalog_plans
         SET name = ?, status = ?, version = ?, description = ?, updated_at = ?
         WHERE id = ? AND project = ? AND plan_key = ? AND ${claimGuardSql()}
         RETURNING id`,
      ).bind(
        rowString(after, "name"), rowString(after, "status"), rowInteger(after, "version"), rowString(after, "description"), rowInteger(after, "updated_at"),
        rowString(after, "id"), rowString(after, "project"), rowString(after, "plan_key"), previewId, claimToken,
      );
    case "plan_feature":
      if (action.effect === "create") {
        return env.DB.prepare(
          `INSERT INTO catalog_plan_features
             (project, plan_id, feature_key, feature_inclusion, addon_key, policy_id, status, display_order,
              assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, meter_quota, meter_period_sec,
              created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE ${claimGuardSql()}`,
        ).bind(...planFeatureMatchValues(after), previewId, claimToken);
      }
      return env.DB.prepare(
        `UPDATE catalog_plan_features
         SET feature_inclusion = ?, addon_key = ?, policy_id = ?, status = ?, display_order = ?,
             assertion_ttl_seconds = ?, pool_size = ?, max_active_devices = ?, max_borrow_sec = ?,
             meter_quota = ?, meter_period_sec = ?, updated_at = ?
         WHERE project = ? AND plan_id = ? AND feature_key = ? AND ${claimGuardSql()}`,
      ).bind(
        rowString(after, "feature_inclusion"), after.addon_key ?? null, after.policy_id ?? null, rowString(after, "status"), rowInteger(after, "display_order"),
        after.assertion_ttl_seconds ?? null, after.pool_size ?? null, after.max_active_devices ?? null, after.max_borrow_sec ?? null,
        after.meter_quota ?? null, after.meter_period_sec ?? null, rowInteger(after, "updated_at"),
        rowString(after, "project"), rowString(after, "plan_id"), rowString(after, "feature_key"), previewId, claimToken,
      );
  }
}

function auditStatement(
  env: Env,
  action: CatalogImportAction,
  ctx: MutationContext,
  effectiveAt: number,
  previewId: string,
  claimToken: string,
): ReturnType<D1DatabaseLike["prepare"]> {
  const entity = entityFor(action);
  const base = [
    entity,
    actionEntityId(action),
    actionProject(action),
    action.effect,
    catalogActor(ctx.actor),
    ctx.actor.actorType,
    ctx.requestId,
    action.before === null ? "" : JSON.stringify(action.before),
    effectiveAt,
  ];
  if (entity === "feature") {
    const after = action.after;
    return env.DB.prepare(
      `INSERT INTO catalog_events
         (entity_type, entity_id, project, event_type, actor, actor_type, source, reason, request_id, prev_json, next_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, 'admin', 'catalog import', ?, ?, json_object(${catalogJsonObject(CATALOG_FEATURE_COLUMNS)}), ?
       FROM catalog_features f
       WHERE ${featureMatchSql("f")} AND ${claimGuardSql()}`,
    ).bind(...base, ...featureMatchValues(after), previewId, claimToken);
  }
  if (entity === "plan") {
    const after = action.after;
    return env.DB.prepare(
      `INSERT INTO catalog_events
         (entity_type, entity_id, project, event_type, actor, actor_type, source, reason, request_id, prev_json, next_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, 'admin', 'catalog import', ?, ?, json_object(${catalogJsonObject(CATALOG_PLAN_COLUMNS)}), ?
       FROM catalog_plans p
       WHERE ${planMatchSql("p")} AND ${claimGuardSql()}`,
    ).bind(...base, ...planMatchValues(after), previewId, claimToken);
  }
  const after = action.after;
  return env.DB.prepare(
    `INSERT INTO catalog_events
       (entity_type, entity_id, project, event_type, actor, actor_type, source, reason, request_id, prev_json, next_json, created_at)
     SELECT ?, ?, ?, ?, ?, ?, 'admin', 'catalog import', ?, ?, json_object(${catalogJsonObject(CATALOG_PLAN_FEATURE_COLUMNS)}), ?
     FROM catalog_plan_features pf
     WHERE ${planFeatureMatchSql("pf")} AND ${claimGuardSql()}`,
  ).bind(...base, ...planFeatureMatchValues(after), previewId, claimToken);
}

function assertionStatement(env: Env, action: CatalogImportAction, ctx: MutationContext, effectiveAt: number, previewId: string, claimToken: string): ReturnType<D1DatabaseLike["prepare"]> {
  const entity = entityFor(action);
  const entityId = actionEntityId(action);
  const project = actionProject(action);
  let table: string;
  let alias: string;
  let match: string;
  let values: unknown[];
  if (entity === "feature") {
    table = "catalog_features";
    alias = "f";
    match = featureMatchSql(alias);
    values = featureMatchValues(action.after);
  } else if (entity === "plan") {
    table = "catalog_plans";
    alias = "p";
    match = planMatchSql(alias);
    values = planMatchValues(action.after);
  } else {
    table = "catalog_plan_features";
    alias = "pf";
    match = planFeatureMatchSql(alias);
    values = planFeatureMatchValues(action.after);
  }
  return env.DB.prepare(
    `SELECT CASE
       WHEN NOT ${claimGuardSql()} THEN 1
       WHEN EXISTS (SELECT 1 FROM ${table} ${alias} WHERE ${match})
        AND EXISTS (
          SELECT 1 FROM catalog_events e
          WHERE e.entity_type = ? AND e.entity_id = ? AND e.project = ? AND e.event_type = ?
            AND e.request_id = ? AND e.prev_json = ? AND e.created_at = ?
        ) THEN 1
       ELSE json('catalog_import_action_not_applied')
     END`,
  ).bind(
    previewId,
    claimToken,
    ...values,
    entity,
    entityId,
    project,
    action.effect,
    ctx.requestId,
    action.before === null ? "" : JSON.stringify(action.before),
    effectiveAt,
  );
}

function responseStatement(env: Env, previewId: string, claimToken: string, requestId: string): ReturnType<D1DatabaseLike["prepare"]> {
  return env.DB.prepare(
    `UPDATE catalog_import_previews AS p
     SET applied_response_json = json_object(
       'ok', json('true'),
       'code', ?,
       'request_id', ?,
       'data', json(p.preview_json)
     )
     WHERE p.id = ? AND p.claim_token = ? AND p.consumed_at IS NULL`,
  ).bind(APPLY_CODE, requestId, previewId, claimToken);
}

function idempotencyStatement(env: Env, ctx: MutationContext, now: number, previewId: string, claimToken: string): ReturnType<D1DatabaseLike["prepare"]> {
  if (ctx.idempotencyKey === null) throw new Error("catalog_import_idempotency_required");
  const scope = `POST:/api/admin/catalog/import:${ctx.actor.subject}`;
  return env.DB.prepare(
    `INSERT INTO mutation_idempotency (scope, idempotency_key, response_json, created_at)
     SELECT ?, ?, p.applied_response_json, ?
     FROM catalog_import_previews p
     WHERE p.id = ? AND p.claim_token = ? AND p.consumed_at IS NULL AND p.applied_response_json IS NOT NULL
     ON CONFLICT(scope, idempotency_key) DO NOTHING`,
  ).bind(scope, ctx.idempotencyKey, now, previewId, claimToken);
}

function idempotencyAssertionStatement(env: Env, ctx: MutationContext, previewId: string, claimToken: string): ReturnType<D1DatabaseLike["prepare"]> {
  if (ctx.idempotencyKey === null) throw new Error("catalog_import_idempotency_required");
  const scope = `POST:/api/admin/catalog/import:${ctx.actor.subject}`;
  return env.DB.prepare(
    `SELECT CASE
       WHEN NOT ${claimGuardSql()} THEN 1
       WHEN EXISTS (
         SELECT 1
         FROM mutation_idempotency i
         JOIN catalog_import_previews p ON p.id = ? AND p.claim_token = ? AND p.consumed_at IS NULL
         WHERE i.scope = ? AND i.idempotency_key = ? AND i.response_json = p.applied_response_json
       ) THEN 1
       ELSE json('catalog_import_idempotency_conflict')
     END`,
  ).bind(previewId, claimToken, previewId, claimToken, scope, ctx.idempotencyKey);
}

function consumeStatement(env: Env, previewId: string, claimToken: string, now: number): ReturnType<D1DatabaseLike["prepare"]> {
  return env.DB.prepare(
    `UPDATE catalog_import_previews
     SET consumed_at = ?
     WHERE id = ? AND claim_token = ? AND consumed_at IS NULL AND applied_response_json IS NOT NULL`,
  ).bind(now, previewId, claimToken);
}

function finalResponseStatement(env: Env, previewId: string, claimToken: string, now: number): ReturnType<D1DatabaseLike["prepare"]> {
  return env.DB.prepare(
    `SELECT CASE
       WHEN EXISTS (
         SELECT 1 FROM catalog_import_previews p
         WHERE p.id = ? AND p.claim_token = ? AND p.consumed_at = ? AND p.applied_response_json IS NOT NULL
       ) THEN (
         SELECT p.applied_response_json FROM catalog_import_previews p
         WHERE p.id = ? AND p.claim_token = ? AND p.consumed_at = ? LIMIT 1
       )
       WHEN EXISTS (
         SELECT 1 FROM catalog_import_previews p WHERE p.id = ? AND p.claim_token = ?
       ) THEN json('catalog_import_preview_not_finalized')
       ELSE NULL
     END AS applied_response_json`,
  ).bind(previewId, claimToken, now, previewId, claimToken, now, previewId, claimToken);
}

export async function applyCatalogImport(
  env: Env,
  previewId: string,
  ctx: MutationContext,
  now = nowSeconds(),
): Promise<CatalogImportApplyResult> {
  requireBatch(env);
  if (!isCatalogImportPreviewId(previewId)) throw new Error("invalid_preview_id");
  if (ctx.idempotencyKey === null) throw new Error("catalog_import_idempotency_required");
  const { preview, actions } = await storedPreview(env, previewId);
  const claimToken = crypto.randomUUID();
  const statements: Array<ReturnType<D1DatabaseLike["prepare"]>> = [
    claimStatement(env, previewId, ctx.actor.subject, claimToken, now),
    claimFailureStatement(env, previewId, ctx.actor.subject, now),
  ];
  for (const action of actions) {
    statements.push(mutationStatement(env, action, previewId, claimToken));
    statements.push(auditStatement(env, action, ctx, preview.effective_at, previewId, claimToken));
    statements.push(assertionStatement(env, action, ctx, preview.effective_at, previewId, claimToken));
  }
  statements.push(responseStatement(env, previewId, claimToken, ctx.requestId));
  statements.push(idempotencyStatement(env, ctx, now, previewId, claimToken));
  statements.push(idempotencyAssertionStatement(env, ctx, previewId, claimToken));
  statements.push(consumeStatement(env, previewId, claimToken, now));
  statements.push(finalResponseStatement(env, previewId, claimToken, now));

  const batch = env.DB.batch;
  if (typeof batch !== "function") throw new Error("catalog_import_batch_required");
  const results = await batch.call(env.DB, statements);
  if (firstResult(results[0]) === null) {
    const failure = firstResult(results[1]);
    const code = typeof failure?.catalog_import_claim_error === "string"
      ? failure.catalog_import_claim_error
      : "stale_catalog_import_preview";
    throw new Error(code);
  }
  const final = firstResult(results.at(-1));
  if (final === null || typeof final.applied_response_json !== "string") throw new Error("catalog_import_apply_failed");
  const response = parseJson(final.applied_response_json, "catalog_import_apply_failed") as { code?: unknown; data?: unknown };
  if (response.code !== APPLY_CODE || response.data === undefined || typeof response.data !== "object" || response.data === null) {
    throw new Error("catalog_import_apply_failed");
  }
  return response.data as CatalogImportApplyResult;
}
