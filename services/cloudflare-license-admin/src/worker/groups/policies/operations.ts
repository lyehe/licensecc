import { INVALID_IDEMPOTENCY_KEY, mutationResponse, readIdempotencyKey } from "../../idempotency.js";
import { policyTypeCapacityIsValid, validatePolicyInput, validatePolicyPatch } from "../../policy_validation.js";
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
const POLICY_COLUMNS =
  "id, project, name, type, status, valid_from_offset_sec, duration_sec, assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, expiry_strategy, trial_expiration_basis, trial_duration_sec, trial_one_per_device, trial_require_device_proof, notes, created_at, updated_at, meter_quota, meter_period_sec";

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
      `INSERT INTO entitlement_policies (id, project, name, type, status, valid_from_offset_sec, duration_sec, assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, expiry_strategy, trial_expiration_basis, trial_duration_sec, trial_one_per_device, trial_require_device_proof, notes, created_at, updated_at, meter_quota, meter_period_sec)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${POLICY_COLUMNS}`,
    ).bind(
      id, input.project, input.name, input.type,
      input.valid_from_offset_sec ?? null, input.duration_sec ?? null, input.assertion_ttl_seconds ?? 300,
      input.pool_size ?? 0, input.max_active_devices ?? 1, input.max_borrow_sec ?? 0,
      input.expiry_strategy ?? "fixed_window", input.trial_expiration_basis ?? "from_issue",
      input.trial_duration_sec ?? 0, input.trial_one_per_device ?? 0, input.trial_require_device_proof ?? 0,
      input.notes ?? "", now, now, input.meter_quota ?? 0, input.meter_period_sec ?? 2592000,
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
    const nextPoolSize = patch.pool_size ?? Number(existing.pool_size);
    if (!policyTypeCapacityIsValid(existing.type, nextPoolSize)) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    if (typeof env.DB.batch !== "function") {
      return envelope(requestIdValue, "mutation_failed", undefined, 500);
    }
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const field of [
      "valid_from_offset_sec", "duration_sec", "assertion_ttl_seconds", "pool_size", "max_active_devices",
      "max_borrow_sec", "meter_quota", "meter_period_sec", "expiry_strategy", "trial_expiration_basis",
      "trial_duration_sec", "trial_one_per_device", "trial_require_device_proof", "notes",
    ] as const) {
      const value = (patch as Record<string, unknown>)[field];
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

// ── Workstream F: usage-analytics reports + stuck-seat force-release ───────────
// Three routes over the SAME backend-owned D1. The two reports are reader+admin reads
// (GET /api/admin/report/timeseries, /api/admin/report/expiring); the force-release WRITE
// (POST /api/admin/entitlements/:id/release-seats) is admin-only + reason-required + audited.
// Design: the existing GET /api/admin/report (point-in-time counts) is the closest pattern.
// The sweep-line peak_concurrent stays the point-in-time card — the time-series is a separate,
// single-pass GROUP-BY aggregation and deliberately does NOT re-derive concurrency.

// Default time-series window when ?from/?to are omitted: the last 7 days.
const TIMESERIES_DEFAULT_WINDOW_SECS = 604800;
// Bucket count bounds: default 24 (an hour each over a day), hard ceiling 200 (keeps the
// computed GROUP BY index small and the response bounded).
const TIMESERIES_DEFAULT_BUCKETS = 24;
const TIMESERIES_MAX_BUCKETS = 200;
// within_days bounds for the expiring report (default 30, hard ceiling 365).
const EXPIRING_DEFAULT_WITHIN_DAYS = 30;
const EXPIRING_MAX_WITHIN_DAYS = 365;
const SECONDS_PER_DAY = 86400;

// Parse a non-negative epoch-seconds query param, or null when absent/blank/malformed.
