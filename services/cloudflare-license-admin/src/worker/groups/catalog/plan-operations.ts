import { INVALID_IDEMPOTENCY_KEY, mutationResponse, readIdempotencyKey } from "../../idempotency.js";
import { envelope } from "../../responses.js";
import type { Actor, MutationContext } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Env } from "../../env.js";
import { requireAdmin } from "../../auth.js";
import { parseJsonBody, safeNotes } from "../../request.js";
import { type CatalogPlanFeatureInput, type CatalogPlanPatch, validateCatalogPlanFeatureInput, validateCatalogPlanInput, validateCatalogPlanPatch } from "./validation.js";
import { clientIp } from "../../support.js";
import { boundedCursor } from "../../query.js";
import {
  CATALOG_FEATURE_COLUMNS,
  CATALOG_PLAN_COLUMNS,
  CATALOG_PLAN_FEATURE_COLUMNS,
  catalogFeatureAudit,
  catalogPlanAudit,
  catalogPlanFeatureAudit,
  catalogPlanFeatureUpsertStatement,
  catalogPlanInsertStatement,
  findCatalogFeature,
  writeCatalogWithAudit,
} from "./operations.js";
import { transitionWithGuard } from "../../transitions.js";
export async function transitionCatalogFeature(request: Request, env: Env, actor: Actor, featureId: string, action: "disable" | "reenable", requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) return adminError;
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  const body = await parseJsonBody(request, requestIdValue);
  if (body instanceof Response) return body;
  const reason = safeNotes((body as Record<string, unknown>).reason) ?? "";
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, `catalog_feature_${action}d`, () =>
    transitionWithGuard(env, {
      table: "catalog_features",
      columns: CATALOG_FEATURE_COLUMNS,
      idClause: "id = ?",
      idValues: [featureId],
      action,
      conflictCode: "catalog_status_conflict",
      notFoundCode: "catalog_feature_not_found",
      mutationFailedCode: "catalog_mutation_failed",
      reason,
      requireReason: true,
      auditStatement: (existing, _nextStatus, now) =>
        catalogFeatureAudit(env, featureId, String(existing.project), action, JSON.stringify(existing), reason, actor, requestIdValue, now),
    }, requestIdValue),
  );
}

export async function listCatalogPlans(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const { limit, cursor } = boundedCursor(url);
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
    `SELECT id, project, plan_key, name, status, version, description, created_at, updated_at
     FROM catalog_plans ${where}
     ORDER BY project, plan_key, version DESC
     LIMIT ? OFFSET ?`,
  ).bind(...values, limit + 1, cursor).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  return envelope(requestIdValue, "catalog_plans_listed", {
    items: rows.slice(0, limit),
    next_cursor: rows.length > limit ? String(cursor + limit) : null,
  });
}

export async function findCatalogPlan(env: Env, planId: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(`SELECT ${CATALOG_PLAN_COLUMNS} FROM catalog_plans WHERE id = ? LIMIT 1`)
    .bind(planId)
    .first<Record<string, unknown>>();
}

export async function getCatalogPlan(env: Env, planId: string, requestIdValue: string): Promise<Response> {
  const row = await findCatalogPlan(env, planId);
  return row === null ? envelope(requestIdValue, "catalog_plan_not_found", undefined, 404) : envelope(requestIdValue, "catalog_plan", row);
}

export async function createCatalogPlan(request: Request, env: Env, actor: Actor, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, "catalog_plan_created", async () => {
    const body = await parseJsonBody(request, requestIdValue);
    if (body instanceof Response) {
      return body;
    }
    const input = validateCatalogPlanInput(body);
    if (input === null) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const id = `plan_${crypto.randomUUID()}`;
    const insert = catalogPlanInsertStatement(env, id, input, now);
    let row: Record<string, unknown> | null;
    try {
      row = await writeCatalogWithAudit(env, insert, catalogPlanAudit(env, id, input.project, "create", "", "", actor, requestIdValue, now));
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) {
        return envelope(requestIdValue, "catalog_plan_conflict", undefined, 409);
      }
      return envelope(requestIdValue, "catalog_mutation_failed", undefined, 500);
    }
    if (row === null) return envelope(requestIdValue, "catalog_mutation_failed", undefined, 500);
    return { data: row, idempotencyRecorded: false };
  });
}

export async function patchCatalogPlan(request: Request, env: Env, actor: Actor, planId: string, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) return adminError;
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, "catalog_plan_patched", async () => {
    const body = await parseJsonBody(request, requestIdValue);
    if (body instanceof Response) return body;
    const patch = validateCatalogPlanPatch(body);
    if (patch === null) return envelope(requestIdValue, "invalid_request", undefined, 400);
    const existing = await findCatalogPlan(env, planId);
    if (existing === null) return envelope(requestIdValue, "catalog_plan_not_found", undefined, 404);
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const field of ["name", "description"] as const) {
      if (patch[field] !== undefined) {
        assignments.push(`${field} = ?`);
        values.push(patch[field]);
      }
    }
    const now = Math.floor(Date.now() / 1000);
    assignments.push("updated_at = ?");
    values.push(now, planId);
    const update = env.DB.prepare(`UPDATE catalog_plans SET ${assignments.join(", ")} WHERE id = ? RETURNING ${CATALOG_PLAN_COLUMNS}`).bind(...values);
    let row: Record<string, unknown> | null;
    try {
      row = await writeCatalogWithAudit(env, update, catalogPlanAudit(env, planId, String(existing.project), "update", JSON.stringify(existing), "", actor, requestIdValue, now));
    } catch {
      return envelope(requestIdValue, "catalog_mutation_failed", undefined, 500);
    }
    if (row === null) return envelope(requestIdValue, "catalog_plan_not_found", undefined, 404);
    return { data: row, idempotencyRecorded: false };
  });
}

export async function transitionCatalogPlan(request: Request, env: Env, actor: Actor, planId: string, action: "disable" | "reenable", requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) return adminError;
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  const body = await parseJsonBody(request, requestIdValue);
  if (body instanceof Response) return body;
  const reason = safeNotes((body as Record<string, unknown>).reason) ?? "";
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, `catalog_plan_${action}d`, () =>
    transitionWithGuard(env, {
      table: "catalog_plans",
      columns: CATALOG_PLAN_COLUMNS,
      idClause: "id = ?",
      idValues: [planId],
      action,
      conflictCode: "catalog_status_conflict",
      notFoundCode: "catalog_plan_not_found",
      mutationFailedCode: "catalog_mutation_failed",
      reason,
      requireReason: true,
      auditStatement: (existing, _nextStatus, now) =>
        catalogPlanAudit(env, planId, String(existing.project), action, JSON.stringify(existing), reason, actor, requestIdValue, now),
    }, requestIdValue),
  );
}

export async function listCatalogPlanFeatures(request: Request, env: Env, planId: string, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const project = url.searchParams.get("project");
  const values: unknown[] = [planId];
  let projectFilter = "";
  if (project !== null && project !== "") {
    projectFilter = "AND pf.project = ?";
    values.push(project);
  }
  const result = await env.DB.prepare(
    `SELECT pf.project, pf.plan_id, p.plan_key, pf.feature_key, f.name AS feature_name,
            pf.feature_inclusion, pf.addon_key, pf.policy_id, pf.status, pf.display_order,
            pf.assertion_ttl_seconds, pf.pool_size, pf.max_active_devices, pf.max_borrow_sec,
            pf.meter_quota, pf.meter_period_sec, pf.created_at, pf.updated_at
     FROM catalog_plan_features pf
     JOIN catalog_plans p ON p.id = pf.plan_id
     JOIN catalog_features f ON f.project = pf.project AND f.feature_key = pf.feature_key
     WHERE pf.plan_id = ? ${projectFilter}
     ORDER BY pf.display_order ASC, pf.feature_key ASC`,
  ).bind(...values).all();
  return envelope(requestIdValue, "catalog_plan_features_listed", { items: Array.isArray(result.results) ? result.results : [] });
}

export async function findCatalogPlanFeature(env: Env, planId: string, featureKey: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(`SELECT ${CATALOG_PLAN_FEATURE_COLUMNS} FROM catalog_plan_features WHERE plan_id = ? AND feature_key = ? LIMIT 1`)
    .bind(planId, featureKey)
    .first<Record<string, unknown>>();
}

export async function getCatalogPlanFeatureView(env: Env, planId: string, featureKey: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(
    `SELECT pf.project, pf.plan_id, p.plan_key, pf.feature_key, f.name AS feature_name,
            pf.feature_inclusion, pf.addon_key, pf.policy_id, pf.status, pf.display_order,
            pf.assertion_ttl_seconds, pf.pool_size, pf.max_active_devices, pf.max_borrow_sec,
            pf.meter_quota, pf.meter_period_sec, pf.created_at, pf.updated_at
     FROM catalog_plan_features pf
     JOIN catalog_plans p ON p.id = pf.plan_id
     JOIN catalog_features f ON f.project = pf.project AND f.feature_key = pf.feature_key
     WHERE pf.plan_id = ? AND pf.feature_key = ? LIMIT 1`,
  ).bind(planId, featureKey).first<Record<string, unknown>>();
}

export async function createCatalogPlanFeature(request: Request, env: Env, actor: Actor, planId: string, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, "catalog_plan_feature_saved", async () => {
    const body = await parseJsonBody(request, requestIdValue);
    if (body instanceof Response) {
      return body;
    }
    const input = validateCatalogPlanFeatureInput(body);
    if (input === null) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    const plan = await env.DB.prepare("SELECT id, project FROM catalog_plans WHERE id = ? LIMIT 1").bind(planId).first<{ id: string; project: string }>();
    if (plan === null) {
      return envelope(requestIdValue, "catalog_plan_not_found", undefined, 404);
    }
    if (plan.project !== input.project) {
      return envelope(requestIdValue, "invalid_plan_config", undefined, 409);
    }
    const feature = await env.DB.prepare(
      "SELECT feature_key FROM catalog_features WHERE project = ? AND feature_key = ? LIMIT 1",
    ).bind(input.project, input.feature_key).first();
    if (feature === null) {
      return envelope(requestIdValue, "catalog_feature_not_found", undefined, 404);
    }
    if (input.policy_id !== null) {
      const policy = await env.DB.prepare(
        "SELECT project, status FROM entitlement_policies WHERE id = ? LIMIT 1",
      ).bind(input.policy_id).first<{ project: string; status: string }>();
      if (policy === null) {
        return envelope(requestIdValue, "policy_not_found", undefined, 404);
      }
      if (policy.project !== input.project) {
        return envelope(requestIdValue, "invalid_plan_config", undefined, 409);
      }
      if (policy.status !== "active") {
        return envelope(requestIdValue, "policy_disabled", undefined, 409);
      }
    }
    const existing = await findCatalogPlanFeature(env, planId, input.feature_key);
    const eventType = existing === null ? "create" : "update";
    const now = Math.floor(Date.now() / 1000);
    const upsert = catalogPlanFeatureUpsertStatement(env, planId, input, now);
    try {
      const audit = catalogPlanFeatureAudit(env, planId, input.feature_key, input.project, eventType, existing === null ? "" : JSON.stringify(existing), "", actor, requestIdValue, now);
      const written = await writeCatalogWithAudit(env, upsert, audit);
      if (written === null) {
        return envelope(requestIdValue, "catalog_mutation_failed", undefined, 500);
      }
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) {
        return envelope(requestIdValue, "catalog_plan_feature_conflict", undefined, 409);
      }
      return envelope(requestIdValue, "catalog_mutation_failed", undefined, 500);
    }
    const row = await getCatalogPlanFeatureView(env, planId, input.feature_key);
    return { data: row, idempotencyRecorded: false };
  });
}

export async function transitionCatalogPlanFeature(request: Request, env: Env, actor: Actor, planId: string, featureKey: string, action: "disable" | "reenable", requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) return adminError;
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  const body = await parseJsonBody(request, requestIdValue);
  if (body instanceof Response) return body;
  const reason = safeNotes((body as Record<string, unknown>).reason) ?? "";
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, `catalog_plan_feature_${action}d`, async () => {
    const result = await transitionWithGuard(env, {
      table: "catalog_plan_features",
      columns: CATALOG_PLAN_FEATURE_COLUMNS,
      idClause: "plan_id = ? AND feature_key = ?",
      idValues: [planId, featureKey],
      action,
      conflictCode: "catalog_status_conflict",
      notFoundCode: "catalog_plan_feature_not_found",
      mutationFailedCode: "catalog_mutation_failed",
      reason,
      requireReason: true,
      auditStatement: (existing, _nextStatus, now) =>
        catalogPlanFeatureAudit(env, planId, featureKey, String(existing.project), action, JSON.stringify(existing), reason, actor, requestIdValue, now),
    }, requestIdValue);
    if (result instanceof Response) return result;
    // The guarded flip + audit landed; surface the joined VIEW (plan_key + feature_name) as data.
    const row = await getCatalogPlanFeatureView(env, planId, featureKey);
    return { data: row, idempotencyRecorded: false };
  });
}
