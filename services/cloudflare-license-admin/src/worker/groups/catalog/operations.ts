import { INVALID_IDEMPOTENCY_KEY, mutationResponse, readIdempotencyKey } from "../../idempotency.js";
import { envelope } from "../../responses.js";
import { batchReturnedRow } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Actor, D1DatabaseLike, MutationContext } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { applyPlanProjection, previewPlanProjection } from "@licensecc/cloudflare-runtime/d1/plan_projection";
import type { PlanProjectionInput } from "@licensecc/licensing-domain/catalog/plan_projection";
import type { Env } from "../../env.js";
import { requireAdmin } from "../../auth.js";
import { parseJsonBody } from "../../request.js";
import { type CatalogFeatureInput, type CatalogFeaturePatch, type CatalogPlanFeatureInput, type CatalogPlanInput, validateCatalogFeatureInput, validateCatalogFeaturePatch, validateCatalogPlanInput, validatePlanProjectionInput } from "./validation.js";
import { clientIp } from "../../support.js";
import { boundedCursor } from "../../query.js";
export function planProjectionError(error: unknown, requestIdValue: string): Response {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("invalid_")) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  if (message === "plan_not_found") {
    return envelope(requestIdValue, "plan_not_found", undefined, 404);
  }
  if (message === "plan_disabled") {
    return envelope(requestIdValue, "plan_disabled", undefined, 409);
  }
  if (message.startsWith("unknown_addon:")) {
    return envelope(requestIdValue, "unknown_addon", undefined, 400);
  }
  if (message.startsWith("policy_not_found:")) {
    return envelope(requestIdValue, "policy_not_found", undefined, 404);
  }
  if (message.startsWith("policy_disabled:")) {
    return envelope(requestIdValue, "policy_disabled", undefined, 409);
  }
  if (message.startsWith("policy_project_mismatch:")) {
    return envelope(requestIdValue, "invalid_plan_config", undefined, 409);
  }
  if (message === "projection_blocked_revoked_entitlement") {
    return envelope(requestIdValue, "plan_projection_blocked", undefined, 409);
  }
  if (message === "revoked_terminal") {
    return envelope(requestIdValue, "revoked_entitlement_is_terminal", undefined, 409);
  }
  return envelope(requestIdValue, "plan_projection_failed", undefined, 500);
}

export const CATALOG_FEATURE_COLUMNS = "id, project, feature_key, name, description, category, status, created_at, updated_at";
export const CATALOG_PLAN_COLUMNS = "id, project, plan_key, name, status, version, description, created_at, updated_at";
export const CATALOG_PLAN_FEATURE_COLUMNS =
  "project, plan_id, feature_key, feature_inclusion, addon_key, policy_id, status, display_order, assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, meter_quota, meter_period_sec, created_at, updated_at";

export function catalogJsonObject(columns: string): string {
  return columns.split(", ").map((column) => `'${column}', ${column}`).join(", ");
}

export function catalogActor(actor: Actor): string {
  return actor.email || actor.subject;
}

export async function writeCatalogWithAudit(
  env: Env,
  mutationStatement: ReturnType<D1DatabaseLike["prepare"]>,
  auditStatement: ReturnType<D1DatabaseLike["prepare"]>,
): Promise<Record<string, unknown> | null> {
  if (typeof env.DB.batch !== "function") {
    return null;
  }
  const results = await env.DB.batch([mutationStatement, auditStatement]);
  return batchReturnedRow<Record<string, unknown>>(results[0]);
}

export function catalogFeatureAudit(
  env: Env,
  id: string,
  project: string,
  eventType: "create" | "update" | "disable" | "reenable",
  prevJson: string,
  reason: string,
  actor: Actor,
  requestIdValue: string,
  now: number,
): ReturnType<D1DatabaseLike["prepare"]> {
  return env.DB.prepare(
    `INSERT INTO catalog_events
       (entity_type, entity_id, project, event_type, actor, actor_type, source, reason, request_id, prev_json, next_json, created_at)
     SELECT 'feature', ?, ?, ?, ?, ?, 'admin', ?, ?, ?, json_object(${catalogJsonObject(CATALOG_FEATURE_COLUMNS)}), ?
     FROM catalog_features WHERE id = ?`,
  ).bind(id, project, eventType, catalogActor(actor), actor.actorType, reason, requestIdValue, prevJson, now, id);
}

export function catalogPlanAudit(
  env: Env,
  id: string,
  project: string,
  eventType: "create" | "update" | "disable" | "reenable",
  prevJson: string,
  reason: string,
  actor: Actor,
  requestIdValue: string,
  now: number,
): ReturnType<D1DatabaseLike["prepare"]> {
  return env.DB.prepare(
    `INSERT INTO catalog_events
       (entity_type, entity_id, project, event_type, actor, actor_type, source, reason, request_id, prev_json, next_json, created_at)
     SELECT 'plan', ?, ?, ?, ?, ?, 'admin', ?, ?, ?, json_object(${catalogJsonObject(CATALOG_PLAN_COLUMNS)}), ?
     FROM catalog_plans WHERE id = ?`,
  ).bind(id, project, eventType, catalogActor(actor), actor.actorType, reason, requestIdValue, prevJson, now, id);
}

export function catalogPlanFeatureAudit(
  env: Env,
  planId: string,
  featureKey: string,
  project: string,
  eventType: "create" | "update" | "disable" | "reenable",
  prevJson: string,
  reason: string,
  actor: Actor,
  requestIdValue: string,
  now: number,
): ReturnType<D1DatabaseLike["prepare"]> {
  const entityId = `${planId}:${featureKey}`;
  return env.DB.prepare(
    `INSERT INTO catalog_events
       (entity_type, entity_id, project, event_type, actor, actor_type, source, reason, request_id, prev_json, next_json, created_at)
     SELECT 'plan_feature', ?, ?, ?, ?, ?, 'admin', ?, ?, ?, json_object(${catalogJsonObject(CATALOG_PLAN_FEATURE_COLUMNS)}), ?
     FROM catalog_plan_features WHERE plan_id = ? AND feature_key = ?`,
  ).bind(entityId, project, eventType, catalogActor(actor), actor.actorType, reason, requestIdValue, prevJson, now, planId, featureKey);
}

export function catalogFeatureInsertStatement(
  env: Env,
  id: string,
  input: CatalogFeatureInput,
  now: number,
): ReturnType<D1DatabaseLike["prepare"]> {
  return env.DB.prepare(
    `INSERT INTO catalog_features
        (id, project, feature_key, name, description, category, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${CATALOG_FEATURE_COLUMNS}`,
  ).bind(id, input.project, input.feature_key, input.name, input.description, input.category, input.status, now, now);
}

export function catalogPlanInsertStatement(
  env: Env,
  id: string,
  input: CatalogPlanInput,
  now: number,
): ReturnType<D1DatabaseLike["prepare"]> {
  return env.DB.prepare(
    `INSERT INTO catalog_plans
        (id, project, plan_key, name, status, version, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${CATALOG_PLAN_COLUMNS}`,
  ).bind(id, input.project, input.plan_key, input.name, input.status, input.version, input.description, now, now);
}

export function catalogPlanFeatureUpsertStatement(
  env: Env,
  planId: string,
  input: CatalogPlanFeatureInput,
  now: number,
): ReturnType<D1DatabaseLike["prepare"]> {
  return env.DB.prepare(
    `INSERT INTO catalog_plan_features
        (project, plan_id, feature_key, feature_inclusion, addon_key, policy_id, status, display_order,
         assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, meter_quota, meter_period_sec,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(plan_id, feature_key) DO UPDATE SET
         feature_inclusion = excluded.feature_inclusion,
         addon_key = excluded.addon_key,
         policy_id = excluded.policy_id,
         status = excluded.status,
         display_order = excluded.display_order,
         assertion_ttl_seconds = excluded.assertion_ttl_seconds,
         pool_size = excluded.pool_size,
         max_active_devices = excluded.max_active_devices,
         max_borrow_sec = excluded.max_borrow_sec,
         meter_quota = excluded.meter_quota,
         meter_period_sec = excluded.meter_period_sec,
         updated_at = excluded.updated_at
       RETURNING ${CATALOG_PLAN_FEATURE_COLUMNS}`,
  ).bind(
    input.project,
    planId,
    input.feature_key,
    input.feature_inclusion,
    input.addon_key,
    input.policy_id,
    input.status,
    input.display_order,
    input.assertion_ttl_seconds,
    input.pool_size,
    input.max_active_devices,
    input.max_borrow_sec,
    input.meter_quota,
    input.meter_period_sec,
    now,
    now,
  );
}

export async function handlePlanProjection(request: Request, env: Env, actor: Actor, requestIdValue: string, action: "preview" | "apply"): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const parsedIdempotencyKey = readIdempotencyKey(request);
  if (action === "apply" && parsedIdempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const idempotencyKey = parsedIdempotencyKey === INVALID_IDEMPOTENCY_KEY ? null : parsedIdempotencyKey;
  const body = await parseJsonBody(request, requestIdValue);
  if (body instanceof Response) {
    return body;
  }
  const input = validatePlanProjectionInput(body);
  if (input === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  if (action === "preview") {
    try {
      return envelope(requestIdValue, "license_plan_projection_previewed", await previewPlanProjection(env, input));
    } catch (error) {
      return planProjectionError(error, requestIdValue);
    }
  }
  const ctx: MutationContext = {
    actor,
    requestId: requestIdValue,
    ip: clientIp(request),
    idempotencyKey,
    source: "admin",
  };
  return mutationResponse(request, env, ctx, "license_plan_projection_applied", async () => {
    try {
      return { data: await applyPlanProjection(env, input, ctx), idempotencyRecorded: false };
    } catch (error) {
      return planProjectionError(error, requestIdValue);
    }
  });
}

export async function listCatalogFeatures(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const pagination = boundedCursor(url);
  if (pagination === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const { limit, cursor } = pagination;
  const filters: string[] = [];
  const values: unknown[] = [];
  const project = url.searchParams.get("project");
  const status = url.searchParams.get("status");
  if (project !== null && project !== "") {
    filters.push("project = ?");
    values.push(project);
  }
  if (status !== null && status !== "") {
    if (status !== "active" && status !== "disabled") {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    filters.push("status = ?");
    values.push(status);
  }
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  const result = await env.DB.prepare(
    `SELECT id, project, feature_key, name, description, category, status, created_at, updated_at
     FROM catalog_features ${where}
     ORDER BY project, feature_key
     LIMIT ? OFFSET ?`,
  ).bind(...values, limit + 1, cursor).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return envelope(requestIdValue, "catalog_features_listed", {
    items: rows.slice(0, limit),
    next_cursor: rows.length > limit ? String(cursor + limit) : null,
  });
}

export async function findCatalogFeature(env: Env, featureId: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(`SELECT ${CATALOG_FEATURE_COLUMNS} FROM catalog_features WHERE id = ? LIMIT 1`)
    .bind(featureId)
    .first<Record<string, unknown>>();
}

export async function getCatalogFeature(env: Env, featureId: string, requestIdValue: string): Promise<Response> {
  const row = await findCatalogFeature(env, featureId);
  return row === null ? envelope(requestIdValue, "catalog_feature_not_found", undefined, 404) : envelope(requestIdValue, "catalog_feature", row);
}

export async function createCatalogFeature(request: Request, env: Env, actor: Actor, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, "catalog_feature_created", async () => {
    const body = await parseJsonBody(request, requestIdValue);
    if (body instanceof Response) {
      return body;
    }
    const input = validateCatalogFeatureInput(body);
    if (input === null) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const id = `feat_${crypto.randomUUID()}`;
    const insert = catalogFeatureInsertStatement(env, id, input, now);
    let row: Record<string, unknown> | null;
    try {
      row = await writeCatalogWithAudit(env, insert, catalogFeatureAudit(env, id, input.project, "create", "", "", actor, requestIdValue, now));
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) {
        return envelope(requestIdValue, "catalog_feature_conflict", undefined, 409);
      }
      return envelope(requestIdValue, "catalog_mutation_failed", undefined, 500);
    }
    if (row === null) {
      return envelope(requestIdValue, "catalog_mutation_failed", undefined, 500);
    }
    return { data: row, idempotencyRecorded: false };
  });
}

export async function patchCatalogFeature(request: Request, env: Env, actor: Actor, featureId: string, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) return adminError;
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, "catalog_feature_patched", async () => {
    const body = await parseJsonBody(request, requestIdValue);
    if (body instanceof Response) return body;
    const patch = validateCatalogFeaturePatch(body);
    if (patch === null) return envelope(requestIdValue, "invalid_request", undefined, 400);
    const existing = await findCatalogFeature(env, featureId);
    if (existing === null) return envelope(requestIdValue, "catalog_feature_not_found", undefined, 404);
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const field of ["name", "description", "category"] as const) {
      if (patch[field] !== undefined) {
        assignments.push(`${field} = ?`);
        values.push(patch[field]);
      }
    }
    const now = Math.floor(Date.now() / 1000);
    assignments.push("updated_at = ?");
    values.push(now, featureId);
    const update = env.DB.prepare(`UPDATE catalog_features SET ${assignments.join(", ")} WHERE id = ? RETURNING ${CATALOG_FEATURE_COLUMNS}`).bind(...values);
    let row: Record<string, unknown> | null;
    try {
      row = await writeCatalogWithAudit(env, update, catalogFeatureAudit(env, featureId, String(existing.project), "update", JSON.stringify(existing), "", actor, requestIdValue, now));
    } catch {
      return envelope(requestIdValue, "catalog_mutation_failed", undefined, 500);
    }
    if (row === null) return envelope(requestIdValue, "catalog_feature_not_found", undefined, 404);
    return { data: row, idempotencyRecorded: false };
  });
}
