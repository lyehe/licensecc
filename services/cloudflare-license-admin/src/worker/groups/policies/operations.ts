import { INVALID_IDEMPOTENCY_KEY, mutationResponse, readIdempotencyKey } from "../../idempotency.js";
import { POLICY_PATCHABLE_FIELDS, validatePolicyInput, validatePolicyPatch } from "../../policy_validation.js";
import { envelope } from "../../responses.js";
import { batchReturnedRow } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Actor, D1DatabaseLike, MutationContext } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Policy } from "../../../shared/api";
import { transitionWithGuard } from "../../transitions.js";
import type { Env } from "../../env.js";
import { requireAdmin } from "../../auth.js";
import { parseJsonBody, safeNotes } from "../../request.js";
import { clientIp } from "../../support.js";
import { boundedCursor } from "../../query.js";
// What a policy stamps onto a protected grant: its device limit, validity and trial rules.
const POLICY_COLUMNS =
  "id, project, name, type, status, valid_from_offset_sec, duration_sec, max_active_devices, expiry_strategy, trial_expiration_basis, trial_duration_sec, trial_one_per_device, notes, created_at, updated_at";

function policyStampOn(env: Env): boolean {
  return env.POLICY_STAMP_MODE === "on";
}

export async function findPolicy(env: Env, policyId: string): Promise<Policy | null> {
  return env.DB.prepare(`SELECT ${POLICY_COLUMNS} FROM entitlement_policies WHERE id = ? LIMIT 1`)
    .bind(policyId)
    .first<Policy>();
}

export async function listPolicies(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const filters: string[] = [];
  const values: unknown[] = [];
  for (const [query, column] of [["project", "project"], ["type", "type"], ["status", "status"]] as const) {
    const value = url.searchParams.get(query);
    if (value !== null && value !== "") {
      filters.push(`${column} = ?`);
      values.push(value);
    }
  }
  const pagination = boundedCursor(url);
  if (pagination === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const { limit, cursor } = pagination;
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  values.push(limit + 1, cursor);
  const rows = await env.DB.prepare(
    `SELECT ${POLICY_COLUMNS} FROM entitlement_policies ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
  ).bind(...values).all();
  return envelope(requestIdValue, "policies_listed", {
    items: rows.results.slice(0, limit),
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

export async function getPolicy(env: Env, policyId: string, requestIdValue: string): Promise<Response> {
  const policy = await findPolicy(env, policyId);
  return policy === null ? envelope(requestIdValue, "not_found", undefined, 404) : envelope(requestIdValue, "policy", policy);
}

// Shared atomic write: INSERT/UPDATE the policy row + INSERT a policy_events audit row in one
// batch, returning the persisted row. `eventType` is the audit verb; `reason` the audit reason.
// The policy_events audit INSERT (next_json snapshots the row AFTER the batch's mutation lands).
// Shared by the create/patch path (writePolicyWithAudit) and the disable/reenable transition
// (transitionWithGuard's audit callback) so both write the same audit shape.
function policyEventAudit(
  env: Env,
  policyId: string,
  project: string,
  eventType: "create" | "update" | "disable" | "reenable",
  reason: string,
  actor: Actor,
  requestIdValue: string,
  now: number,
): ReturnType<D1DatabaseLike["prepare"]> {
  return env.DB.prepare(
    `INSERT INTO policy_events (policy_id, project, event_type, actor, actor_type, source, reason, request_id, prev_json, next_json, created_at)
     SELECT ?, ?, ?, ?, ?, 'admin', ?, ?, '', json_object(${POLICY_COLUMNS.split(", ").map((c) => `'${c}', ${c}`).join(", ")}), ?
     FROM entitlement_policies WHERE id = ?`,
  ).bind(policyId, project, eventType, actor.email || actor.subject, actor.actorType, reason, requestIdValue, now, policyId);
}

export async function writePolicyWithAudit(
  env: Env,
  policyStatement: ReturnType<D1DatabaseLike["prepare"]>,
  policyId: string,
  project: string,
  eventType: "create" | "update" | "disable" | "reenable",
  reason: string,
  actor: Actor,
  requestIdValue: string,
  now: number,
): Promise<Record<string, unknown> | null> {
  if (typeof env.DB.batch !== "function") {
    return null;
  }
  const auditStatement = policyEventAudit(env, policyId, project, eventType, reason, actor, requestIdValue, now);
  const results = await env.DB.batch([policyStatement, auditStatement]);
  return batchReturnedRow<Record<string, unknown>>(results[0]);
}

export async function handlePolicyCreate(request: Request, env: Env, actor: Actor, body: unknown, requestIdValue: string): Promise<Response> {
  const input = validatePolicyInput(body);
  if (input === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, "policy_created", async () => {
    if (typeof env.DB.batch !== "function") {
      return envelope(requestIdValue, "mutation_failed", undefined, 500);
    }
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const insert = env.DB.prepare(
      `INSERT INTO entitlement_policies (id, project, name, type, status, valid_from_offset_sec, duration_sec, max_active_devices, expiry_strategy, trial_expiration_basis, trial_duration_sec, trial_one_per_device, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${POLICY_COLUMNS}`,
    ).bind(
      id, input.project, input.name, input.type,
      input.valid_from_offset_sec, input.duration_sec, input.max_active_devices,
      input.expiry_strategy, input.trial_expiration_basis, input.trial_duration_sec, input.trial_one_per_device,
      input.notes, now, now,
    );
    let row: Record<string, unknown> | null;
    try {
      row = await writePolicyWithAudit(env, insert, id, input.project, "create", "", actor, requestIdValue, now);
    } catch (error) {
      // The UNIQUE(project, lower(name)) index rejects a duplicate name within a project.
      if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
        return envelope(requestIdValue, "policy_name_conflict", undefined, 409);
      }
      return envelope(requestIdValue, "mutation_failed", undefined, 500);
    }
    if (row === null) {
      return envelope(requestIdValue, "mutation_failed", undefined, 500);
    }
    return { data: row, idempotencyRecorded: false };
  });
}

export async function handlePolicyPatch(request: Request, env: Env, actor: Actor, policyId: string, body: unknown, requestIdValue: string): Promise<Response> {
  const patch = validatePolicyPatch(body);
  if (patch === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, "policy_patched", async () => {
    const existing = await findPolicy(env, policyId);
    if (existing === null) {
      return envelope(requestIdValue, "not_found", undefined, 404);
    }
    if (typeof env.DB.batch !== "function") {
      return envelope(requestIdValue, "mutation_failed", undefined, 500);
    }
    const assignments: string[] = [];
    const values: unknown[] = [];
    // Exactly the fields the validator admits, so a validated field is never dropped here.
    for (const field of POLICY_PATCHABLE_FIELDS) {
      const value = patch[field];
      if (value !== undefined) {
        assignments.push(`${field} = ?`);
        values.push(value);
      }
    }
    const now = Math.floor(Date.now() / 1000);
    assignments.push("updated_at = ?");
    values.push(now, policyId);
    const update = env.DB.prepare(
      `UPDATE entitlement_policies SET ${assignments.join(", ")} WHERE id = ? RETURNING ${POLICY_COLUMNS}`,
    ).bind(...values);
    let row: Record<string, unknown> | null;
    try {
      row = await writePolicyWithAudit(env, update, policyId, existing.project, "update", "", actor, requestIdValue, now);
    } catch {
      return envelope(requestIdValue, "mutation_failed", undefined, 500);
    }
    if (row === null) {
      return envelope(requestIdValue, "not_found", undefined, 404);
    }
    return { data: row, idempotencyRecorded: false };
  });
}

// Policy disable/reenable kill-switch: a guarded UPDATE (status flips only from the expected
// prior status) + an audit row, atomic. Disabling a policy only blocks NEW stamps; it never
// retro-mutates already-stamped entitlements (those are frozen copies).
export async function handlePolicyTransition(request: Request, env: Env, actor: Actor, policyId: string, action: "disable" | "reenable", body: unknown, requestIdValue: string): Promise<Response> {
  const reason = safeNotes((body as Record<string, unknown>).reason) ?? "";
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, `policy_${action}d`, () =>
    transitionWithGuard(env, {
      table: "entitlement_policies",
      columns: POLICY_COLUMNS,
      idClause: "id = ?",
      idValues: [policyId],
      action,
      conflictCode: "policy_status_conflict",
      reason,
      requireReason: true,
      auditStatement: (existing, _nextStatus, now) =>
        policyEventAudit(env, policyId, String(existing.project), action, reason, actor, requestIdValue, now),
    }, requestIdValue),
  );
}

// Dispatch the policy writes (POST create, PATCH :id, POST :id/disable|reenable). All require
// the admin role (requireAdmin) so reader RBAC blocks every write.
export async function handlePolicyMutation(request: Request, env: Env, actor: Actor, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const url = new URL(request.url);
  const body = await parseJsonBody(request, requestIdValue);
  if (body instanceof Response) {
    return body;
  }
  if (request.method === "POST" && url.pathname === "/api/admin/policies") {
    return handlePolicyCreate(request, env, actor, body, requestIdValue);
  }
  const match = /^\/api\/admin\/policies\/([^/]+)(?:\/(disable|reenable))?$/.exec(url.pathname);
  if (match === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  const policyId = decodeURIComponent(match[1] ?? "");
  if (policyId.length === 0 || policyId.length > 128) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const action = match[2];
  if (request.method === "PATCH" && action === undefined) {
    return handlePolicyPatch(request, env, actor, policyId, body, requestIdValue);
  }
  if (request.method === "POST" && (action === "disable" || action === "reenable")) {
    return handlePolicyTransition(request, env, actor, policyId, action, body, requestIdValue);
  }
  return envelope(requestIdValue, "not_found", undefined, 404);
}
