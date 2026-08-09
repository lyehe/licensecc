import { INVALID_IDEMPOTENCY_KEY, idempotentReplay, mutationResponse, readIdempotencyKey } from "../../idempotency.js";
import { envelope } from "../../responses.js";
import type { Actor, MutationContext } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Env } from "../../env.js";
import { requireAdmin } from "../../auth.js";
import { parseJsonBody } from "../../request.js";
import { type CatalogFeatureInput, isCatalogImportManifestPayload, validateCatalogImportApplyInput, validateCatalogImportInput } from "./validation.js";
import { clientIp } from "../../support.js";
import {
  CATALOG_FEATURE_COLUMNS,
  CATALOG_PLAN_FEATURE_COLUMNS,
} from "./operations.js";
import { findCatalogPlan } from "./plan-operations.js";
import { CATALOG_IMPORT_TOO_LARGE_GUIDANCE } from "@licensecc/licensing-domain/catalog/import_preview";
import { applyCatalogImport, MAX_ATOMIC_CATALOG_IMPORT_ACTIONS, previewCatalogImport as previewCatalogImportProtocol } from "./import-protocol.js";
export async function findCatalogFeatureByKey(env: Env, project: string, featureKey: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(`SELECT ${CATALOG_FEATURE_COLUMNS} FROM catalog_features WHERE project = ? AND feature_key = ? LIMIT 1`)
    .bind(project, featureKey)
    .first<Record<string, unknown>>();
}

export function catalogImportKey(...parts: Array<string | number>): string {
  return JSON.stringify(parts);
}

function catalogImportProtocolError(error: unknown, requestIdValue: string): Response {
  const message = error instanceof Error ? error.message : "";
  if (message === "catalog_import_idempotency_required") {
    return envelope(requestIdValue, "idempotency_key_required", undefined, 400);
  }
  if (message.startsWith("invalid_plan_config:")) {
    return envelope(requestIdValue, "invalid_plan_config", { policy_id: message.slice("invalid_plan_config:".length) }, 409);
  }
  if (message === "invalid_preview_id" || message.startsWith("invalid_")) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  if (message.startsWith("catalog_feature_not_found:")) {
    return envelope(requestIdValue, "catalog_feature_not_found", { feature_key: message.slice("catalog_feature_not_found:".length) }, 404);
  }
  if (message.startsWith("policy_not_found:")) {
    return envelope(requestIdValue, "policy_not_found", { policy_id: message.slice("policy_not_found:".length) }, 404);
  }
  if (message.startsWith("policy_disabled:")) {
    return envelope(requestIdValue, "policy_disabled", { policy_id: message.slice("policy_disabled:".length) }, 409);
  }
  if (message === "catalog_import_too_large") {
    return envelope(requestIdValue, message, {
      max_mutable_actions: MAX_ATOMIC_CATALOG_IMPORT_ACTIONS,
      guidance: CATALOG_IMPORT_TOO_LARGE_GUIDANCE,
    }, 409);
  }
  if ([
    "catalog_import_snapshot_stale",
    "stale_catalog_import_preview",
    "expired_catalog_import_preview",
    "claimed_catalog_import_preview",
  ].includes(message)) {
    return envelope(requestIdValue, message, undefined, 409);
  }
  return envelope(requestIdValue, "catalog_mutation_failed", undefined, 500);
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
  if (dryRun) {
    const input = validateCatalogImportInput(body);
    if (input === null) return envelope(requestIdValue, "invalid_request", undefined, 400);
    try {
      return envelope(requestIdValue, "catalog_import_previewed", await previewCatalogImportProtocol(env, input, actor.subject));
    } catch (error) {
      return catalogImportProtocolError(error, requestIdValue);
    }
  }
  if (isCatalogImportManifestPayload(body)) return envelope(requestIdValue, "preview_required", undefined, 409);
  const apply = validateCatalogImportApplyInput(body);
  if (apply === null) return envelope(requestIdValue, "invalid_request", undefined, 400);
  if (idempotencyKey === null) return envelope(requestIdValue, "idempotency_key_required", undefined, 400);
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, "catalog_import_applied", async (idempotency) => {
    try {
      return {
        data: await applyCatalogImport(env, apply.preview_id, ctx),
        idempotencyRecorded: true,
      };
    } catch (error) {
      // A same-key concurrent request may have read the replay cache before its
      // winner committed. Its conditional claim remains write-free; re-check
      // the persisted response so it becomes a normal idempotent replay.
      if (error instanceof Error && error.message === "claimed_catalog_import_preview" && idempotency !== null) {
        const replay = await idempotentReplay(env, idempotency.scope, ctx.idempotencyKey);
        if (replay !== null) return replay;
      }
      return catalogImportProtocolError(error, requestIdValue);
    }
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
