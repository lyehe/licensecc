import { INVALID_IDEMPOTENCY_KEY, mutationResponse, readIdempotencyKey } from "../../idempotency.js";
import { envelope, json } from "../../responses.js";
import type { Actor, MutationContext } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Env } from "../../env.js";
import { requireAdmin } from "../../auth.js";
import { parseJsonBody } from "../../request.js";
import { type CatalogFeatureInput, type CatalogImportInput, type CatalogPlanFeatureInput, type CatalogPlanInput, validateCatalogImportInput } from "./validation.js";
import { clientIp } from "../../support.js";
import {
  CATALOG_FEATURE_COLUMNS,
  CATALOG_PLAN_COLUMNS,
  CATALOG_PLAN_FEATURE_COLUMNS,
  catalogFeatureAudit,
  catalogFeatureInsertStatement,
  catalogPlanAudit,
  catalogPlanInsertStatement,
  catalogPlanFeatureAudit,
  catalogPlanFeatureUpsertStatement,
  writeCatalogWithAudit,
} from "./operations.js";
import { findCatalogPlan, findCatalogPlanFeature, getCatalogPlanFeatureView } from "./plan-operations.js";
export async function findCatalogFeatureByKey(env: Env, project: string, featureKey: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(`SELECT ${CATALOG_FEATURE_COLUMNS} FROM catalog_features WHERE project = ? AND feature_key = ? LIMIT 1`)
    .bind(project, featureKey)
    .first<Record<string, unknown>>();
}

export async function findCatalogPlanByKey(env: Env, project: string, planKey: string, version: number): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(`SELECT ${CATALOG_PLAN_COLUMNS} FROM catalog_plans WHERE project = ? AND plan_key = ? AND version = ? LIMIT 1`)
    .bind(project, planKey, version)
    .first<Record<string, unknown>>();
}

export type CatalogImportKind = "created" | "updated" | "unchanged";

export interface CatalogImportResult {
  features: Record<CatalogImportKind, number>;
  plans: Record<CatalogImportKind, number>;
  plan_features: Record<CatalogImportKind, number>;
}

export function emptyCatalogImportResult(): CatalogImportResult {
  return {
    features: { created: 0, updated: 0, unchanged: 0 },
    plans: { created: 0, updated: 0, unchanged: 0 },
    plan_features: { created: 0, updated: 0, unchanged: 0 },
  };
}

export function catalogImportKey(...parts: Array<string | number>): string {
  return parts.join("\u001f");
}

export function catalogEventForStatus(
  currentStatus: unknown,
  nextStatus: "active" | "disabled",
): "update" | "disable" | "reenable" {
  if (currentStatus === "active" && nextStatus === "disabled") return "disable";
  if (currentStatus === "disabled" && nextStatus === "active") return "reenable";
  return "update";
}

export function catalogFeatureMatches(row: Record<string, unknown>, input: CatalogFeatureInput): boolean {
  return row.name === input.name &&
    row.description === input.description &&
    row.category === input.category &&
    row.status === input.status;
}

export function catalogPlanMatches(row: Record<string, unknown>, input: CatalogPlanInput): boolean {
  return row.name === input.name &&
    row.description === input.description &&
    row.status === input.status;
}

export function catalogPlanFeatureMatches(row: Record<string, unknown>, input: CatalogPlanFeatureInput): boolean {
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

export async function preflightCatalogImport(env: Env, input: CatalogImportInput, requestIdValue: string): Promise<Response | null> {
  const importedFeatures = new Set(input.features.map((feature) => catalogImportKey(feature.project, feature.feature_key)));
  for (const plan of input.plans) {
    for (const feature of plan.features ?? []) {
      if (!importedFeatures.has(catalogImportKey(feature.project, feature.feature_key))) {
        const existingFeature = await findCatalogFeatureByKey(env, feature.project, feature.feature_key);
        if (existingFeature === null) {
          return envelope(requestIdValue, "catalog_feature_not_found", { feature_key: feature.feature_key }, 404);
        }
      }
      if (feature.policy_id !== null) {
        const policy = await env.DB.prepare(
          "SELECT project, status FROM entitlement_policies WHERE id = ? LIMIT 1",
        ).bind(feature.policy_id).first<{ project: string; status: string }>();
        if (policy === null) {
          return envelope(requestIdValue, "policy_not_found", { policy_id: feature.policy_id }, 404);
        }
        if (policy.project !== feature.project) {
          return envelope(requestIdValue, "invalid_plan_config", { policy_id: feature.policy_id }, 409);
        }
        if (policy.status !== "active") {
          return envelope(requestIdValue, "policy_disabled", { policy_id: feature.policy_id }, 409);
        }
      }
    }
  }
  return null;
}

export async function applyCatalogFeatureImport(
  env: Env,
  input: CatalogFeatureInput,
  actor: Actor,
  requestIdValue: string,
  now: number,
): Promise<{ kind: CatalogImportKind; row: Record<string, unknown> | null }> {
  const existing = await findCatalogFeatureByKey(env, input.project, input.feature_key);
  if (existing === null) {
    const id = `feat_${crypto.randomUUID()}`;
    const insert = catalogFeatureInsertStatement(env, id, input, now);
    return {
      kind: "created",
      row: await writeCatalogWithAudit(env, insert, catalogFeatureAudit(env, id, input.project, "create", "", "catalog import", actor, requestIdValue, now)),
    };
  }
  if (catalogFeatureMatches(existing, input)) {
    return { kind: "unchanged", row: existing };
  }
  const update = env.DB.prepare(
    `UPDATE catalog_features
     SET name = ?, description = ?, category = ?, status = ?, updated_at = ?
     WHERE id = ? RETURNING ${CATALOG_FEATURE_COLUMNS}`,
  ).bind(input.name, input.description, input.category, input.status, now, existing.id);
  const eventType = catalogEventForStatus(existing.status, input.status);
  return {
    kind: "updated",
    row: await writeCatalogWithAudit(
      env,
      update,
      catalogFeatureAudit(env, String(existing.id), input.project, eventType, JSON.stringify(existing), "catalog import", actor, requestIdValue, now),
    ),
  };
}

export async function applyCatalogPlanImport(
  env: Env,
  input: CatalogPlanInput,
  actor: Actor,
  requestIdValue: string,
  now: number,
): Promise<{ kind: CatalogImportKind; row: Record<string, unknown> | null }> {
  const existing = await findCatalogPlanByKey(env, input.project, input.plan_key, input.version);
  if (existing === null) {
    const id = `plan_${crypto.randomUUID()}`;
    const insert = catalogPlanInsertStatement(env, id, input, now);
    return {
      kind: "created",
      row: await writeCatalogWithAudit(env, insert, catalogPlanAudit(env, id, input.project, "create", "", "catalog import", actor, requestIdValue, now)),
    };
  }
  if (catalogPlanMatches(existing, input)) {
    return { kind: "unchanged", row: existing };
  }
  const update = env.DB.prepare(
    `UPDATE catalog_plans
     SET name = ?, status = ?, description = ?, updated_at = ?
     WHERE id = ? RETURNING ${CATALOG_PLAN_COLUMNS}`,
  ).bind(input.name, input.status, input.description, now, existing.id);
  const eventType = catalogEventForStatus(existing.status, input.status);
  return {
    kind: "updated",
    row: await writeCatalogWithAudit(
      env,
      update,
      catalogPlanAudit(env, String(existing.id), input.project, eventType, JSON.stringify(existing), "catalog import", actor, requestIdValue, now),
    ),
  };
}

export async function applyCatalogPlanFeatureImport(
  env: Env,
  planId: string,
  input: CatalogPlanFeatureInput,
  actor: Actor,
  requestIdValue: string,
  now: number,
): Promise<{ kind: CatalogImportKind; row: Record<string, unknown> | null }> {
  const existing = await findCatalogPlanFeature(env, planId, input.feature_key);
  if (existing !== null && catalogPlanFeatureMatches(existing, input)) {
    return { kind: "unchanged", row: existing };
  }
  const upsert = catalogPlanFeatureUpsertStatement(env, planId, input, now);
  const eventType = existing === null ? "create" : catalogEventForStatus(existing.status, input.status);
  return {
    kind: existing === null ? "created" : "updated",
    row: await writeCatalogWithAudit(
      env,
      upsert,
      catalogPlanFeatureAudit(
        env,
        planId,
        input.feature_key,
        input.project,
        eventType,
        existing === null ? "" : JSON.stringify(existing),
        "catalog import",
        actor,
        requestIdValue,
        now,
      ),
    ),
  };
}

export async function previewCatalogImport(env: Env, input: CatalogImportInput): Promise<CatalogImportResult> {
  const result = emptyCatalogImportResult();
  for (const feature of input.features) {
    const existing = await findCatalogFeatureByKey(env, feature.project, feature.feature_key);
    result.features[existing === null ? "created" : catalogFeatureMatches(existing, feature) ? "unchanged" : "updated"] += 1;
  }
  for (const plan of input.plans) {
    const existing = await findCatalogPlanByKey(env, plan.project, plan.plan_key, plan.version);
    result.plans[existing === null ? "created" : catalogPlanMatches(existing, plan) ? "unchanged" : "updated"] += 1;
    for (const feature of plan.features ?? []) {
      if (existing === null) {
        result.plan_features.created += 1;
        continue;
      }
      const existingFeature = await findCatalogPlanFeature(env, String(existing.id), feature.feature_key);
      result.plan_features[existingFeature === null ? "created" : catalogPlanFeatureMatches(existingFeature, feature) ? "unchanged" : "updated"] += 1;
    }
  }
  return result;
}

export async function importCatalog(request: Request, env: Env, actor: Actor, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) return adminError;
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry_run") === "1" || url.searchParams.get("dry_run") === "true";
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  const body = await parseJsonBody(request, requestIdValue);
  if (body instanceof Response) return body;
  const input = validateCatalogImportInput(body);
  if (input === null) return envelope(requestIdValue, "invalid_request", undefined, 400);
  const preflightError = await preflightCatalogImport(env, input, requestIdValue);
  if (preflightError !== null) return preflightError;
  if (dryRun) {
    return envelope(requestIdValue, "catalog_import_previewed", await previewCatalogImport(env, input));
  }
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, "catalog_import_applied", async () => {
    const result = emptyCatalogImportResult();
    const now = Math.floor(Date.now() / 1000);
    try {
      for (const feature of input.features) {
        const applied = await applyCatalogFeatureImport(env, feature, actor, requestIdValue, now);
        if (applied.row === null) return envelope(requestIdValue, "catalog_mutation_failed", undefined, 500);
        result.features[applied.kind] += 1;
      }
      for (const plan of input.plans) {
        const applied = await applyCatalogPlanImport(env, plan, actor, requestIdValue, now);
        if (applied.row === null) return envelope(requestIdValue, "catalog_mutation_failed", undefined, 500);
        result.plans[applied.kind] += 1;
        const planId = String(applied.row.id);
        for (const feature of plan.features ?? []) {
          const featureApplied = await applyCatalogPlanFeatureImport(env, planId, feature, actor, requestIdValue, now);
          if (featureApplied.row === null) return envelope(requestIdValue, "catalog_mutation_failed", undefined, 500);
          result.plan_features[featureApplied.kind] += 1;
        }
      }
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) {
        return envelope(requestIdValue, "catalog_import_conflict", undefined, 409);
      }
      return envelope(requestIdValue, "catalog_mutation_failed", undefined, 500);
    }
    return { data: result, idempotencyRecorded: false };
  });
}

export async function exportCatalogPlan(env: Env, planId: string, requestIdValue: string): Promise<Response> {
  const plan = await findCatalogPlan(env, planId);
  if (plan === null) return envelope(requestIdValue, "catalog_plan_not_found", undefined, 404);
  const planFeaturesResult = await env.DB.prepare(
    `SELECT ${CATALOG_PLAN_FEATURE_COLUMNS}
     FROM catalog_plan_features
     WHERE plan_id = ?
     ORDER BY display_order ASC, feature_key ASC`,
  ).bind(planId).all<Record<string, unknown>>();
  const planFeatures = Array.isArray(planFeaturesResult.results) ? planFeaturesResult.results : [];
  const featureKeys = new Set<string>();
  const features: CatalogFeatureInput[] = [];
  for (const row of planFeatures) {
    const featureKey = String(row.feature_key);
    const key = catalogImportKey(String(row.project), featureKey);
    if (featureKeys.has(key)) continue;
    featureKeys.add(key);
    const feature = await findCatalogFeatureByKey(env, String(row.project), featureKey);
    if (feature !== null) {
      features.push({
        project: String(feature.project),
        feature_key: String(feature.feature_key),
        name: String(feature.name),
        description: String(feature.description ?? ""),
        category: String(feature.category ?? ""),
        status: feature.status === "disabled" ? "disabled" : "active",
      });
    }
  }
  return envelope(requestIdValue, "catalog_plan_exported", {
    format_version: 1,
    features,
    plans: [
      {
        project: String(plan.project),
        plan_key: String(plan.plan_key),
        name: String(plan.name),
        description: String(plan.description ?? ""),
        status: plan.status === "disabled" ? "disabled" : "active",
        version: Number(plan.version),
        features: planFeatures.map((feature) => ({
          project: String(feature.project),
          feature_key: String(feature.feature_key),
          feature_inclusion: feature.feature_inclusion === "addon" ? "addon" : "included",
          addon_key: feature.addon_key === null || feature.addon_key === undefined ? null : String(feature.addon_key),
          policy_id: feature.policy_id === null || feature.policy_id === undefined ? null : String(feature.policy_id),
          status: feature.status === "disabled" ? "disabled" : "active",
          display_order: Number(feature.display_order),
          assertion_ttl_seconds: feature.assertion_ttl_seconds === null || feature.assertion_ttl_seconds === undefined ? null : Number(feature.assertion_ttl_seconds),
          pool_size: feature.pool_size === null || feature.pool_size === undefined ? null : Number(feature.pool_size),
          max_active_devices: feature.max_active_devices === null || feature.max_active_devices === undefined ? null : Number(feature.max_active_devices),
          max_borrow_sec: feature.max_borrow_sec === null || feature.max_borrow_sec === undefined ? null : Number(feature.max_borrow_sec),
          meter_quota: feature.meter_quota === null || feature.meter_quota === undefined ? null : Number(feature.meter_quota),
          meter_period_sec: feature.meter_period_sec === null || feature.meter_period_sec === undefined ? null : Number(feature.meter_period_sec),
        })),
      },
    ],
  });
}

// ── Slice 4: operator console ────────────────────────────────────────────────
// Read surface over the already-isolated tables (customers / licenses / orders /
// account_tokens) + the customer kill-switch. All reads are reader+admin; the only
// write (customer disable/reenable) is gated by requireAdmin so reader RBAC blocks it.
// Design: docs/superpowers/plans/2026-06-24-slice4-operator-console-blueprint.md.

// Turn a user search term into a LIKE pattern, escaping the wildcards so input matches
// literally (paired with `LIKE ? ESCAPE '\'`). Returns null for over-long/unsafe input.
