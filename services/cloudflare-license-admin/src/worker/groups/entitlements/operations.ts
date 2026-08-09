import { INVALID_IDEMPOTENCY_KEY, mutationResponse, readIdempotencyKey } from "../../idempotency.js";
import { envelope } from "../../responses.js";
import {
  batchReturnedRow,
  createEntitlement,
  decodeEntitlementId,
  entitlementId,
  entitlementSelectSql,
  findEntitlement,
  patchEntitlement,
  transitionEntitlement,
  withId,
} from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Actor, MutationContext } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { stampFromPolicy } from "@licensecc/licensing-domain/entitlements/policy";
import { buildPolicyStampStatement } from "@licensecc/cloudflare-runtime/entitlements/policy_store";
import { readIdempotentResponse, writeIdempotentResponse } from "@licensecc/cloudflare-runtime/d1/idempotency_store";
import type { EntitlementRecord, Policy } from "../../../shared/api";
import type { Env } from "../../env.js";
import { requireAdmin } from "../../auth.js";
import { parseJsonBody, safeNotes } from "../../request.js";
import { safeString } from "@licensecc/cloudflare-runtime/http/kit";
import { MAX_FEATURE_SIZE, MAX_PROJECT_SIZE, boundedInt, nullableEpoch, nullableSafeString, validateEntitlementInput, validateEntitlementPatch } from "./validation.js";
import { clientIp } from "../../support.js";
import { CSV_ROW_CAP, boundedCursor, csvResponse, wantsCsv } from "../../query.js";

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const BATCH_MAX_IDS = 100;

function policyStampOn(env: Env): boolean {
  return env.POLICY_STAMP_MODE === "on";
}

async function findPolicy(env: Env, policyId: string): Promise<Policy | null> {
  return env.DB.prepare("SELECT * FROM entitlement_policies WHERE id = ?").bind(policyId).first<Policy>();
}
export async function listEntitlements(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const filters: string[] = [];
  const values: unknown[] = [];
  for (const [query, column] of [["project", "project"], ["feature", "feature"], ["status", "status"]] as const) {
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
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  if (wantsCsv(url)) {
    // CSV export: SAME filters, but bounded by the CSV cap instead of a page cursor.
    const csvRows = await env.DB.prepare(`${entitlementSelectSql(where)} ORDER BY updated_at DESC LIMIT ?`)
      .bind(...values, CSV_ROW_CAP)
      .all<Omit<EntitlementRecord, "id">>();
    return csvResponse(
      "entitlements.csv",
      ["id", "project", "feature", "license_fingerprint", "device_hash", "status", "assertion_ttl_seconds", "revocation_seq", "valid_from", "valid_until", "notes", "customer_id", "license_id", "created_at", "updated_at"],
      csvRows.results.map(withId) as unknown as ReadonlyArray<Record<string, unknown>>,
    );
  }
  const { limit, cursor } = pagination;
  values.push(limit + 1, cursor);
  const rows = await env.DB.prepare(`${entitlementSelectSql(where)} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...values)
    .all<Omit<EntitlementRecord, "id">>();
  const items = rows.results.slice(0, limit).map(withId);
  return envelope(requestIdValue, "entitlements_listed", {
    items,
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

export async function listEvents(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const pagination = boundedCursor(url);
  if (pagination === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  // `detail` carries the device-transition attribution ("device-revoke <keyId>: <reason>") that a
  // device revoke/disable writes on an event_type='update' row (audit R6.5); surface it so the console
  // + CSV distinguish a device revocation from a plain entitlement edit.
  const eventColumns = "id, project, feature, license_fingerprint, event_type, status, revocation_seq, actor, actor_type, source, request_id, reason, detail, created_at";
  if (wantsCsv(url)) {
    // CSV export: same ORDER BY, bounded by the CSV cap (the `limit` page size does not apply).
    const csvRows = await env.DB.prepare(
      `SELECT ${eventColumns} FROM entitlement_events ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(CSV_ROW_CAP).all<Record<string, unknown>>();
    return csvResponse(
      "events.csv",
      ["id", "project", "feature", "license_fingerprint", "event_type", "status", "revocation_seq", "actor", "actor_type", "source", "request_id", "reason", "detail", "created_at"],
      csvRows.results,
    );
  }
  const { limit } = pagination;
  const rows = await env.DB.prepare(
    `SELECT ${eventColumns} FROM entitlement_events ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(limit).all();
  return envelope(requestIdValue, "events_listed", { items: rows.results });
}

export async function createFromPolicy(request: Request, env: Env, ctx: MutationContext, body: unknown, requestIdValue: string): Promise<Response> {
  if (!policyStampOn(env)) {
    return envelope(requestIdValue, "policy_stamping_disabled", undefined, 400);
  }
  const input = body as Record<string, unknown>;
  // Validate the target tuple the stamp MUST carry (the same constraints as a direct create).
  const project = safeString(input.project, MAX_PROJECT_SIZE);
  const feature = safeString(input.feature, MAX_FEATURE_SIZE);
  const licenseFingerprint = typeof input.license_fingerprint === "string" && HEX_64.test(input.license_fingerprint)
    ? input.license_fingerprint
    : null;
  const policyId = typeof input.policy_id === "string" ? input.policy_id : null;
  if (project === null || feature === null || licenseFingerprint === null || policyId === null || policyId.length > 128) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  // Optional per-field overrides; each is "absent (undefined) -> fall back to policy" or
  // "present-but-malformed -> 400". valid_from/valid_until are only validated when present
  // (nullableEpoch returns undefined for both absent AND malformed, so gate on presence).
  const deviceHash = input.device_hash === undefined || input.device_hash === ""
    ? undefined
    : typeof input.device_hash === "string" && HEX_64.test(input.device_hash)
      ? input.device_hash
      : null;
  const assertionTtl = input.assertion_ttl_seconds === undefined ? undefined : boundedInt(input.assertion_ttl_seconds, 1, 3600);
  const validFrom = input.valid_from === undefined ? undefined : nullableEpoch(input.valid_from);
  const validUntil = input.valid_until === undefined ? undefined : nullableEpoch(input.valid_until);
  const notes = input.notes === undefined ? undefined : safeNotes(input.notes);
  const customerId = input.customer_id === undefined ? undefined : nullableSafeString(input.customer_id, 128);
  const licenseId = input.license_id === undefined ? undefined : nullableSafeString(input.license_id, 128);
  if (
    deviceHash === null ||
    (input.assertion_ttl_seconds !== undefined && assertionTtl === undefined) ||
    (input.valid_from !== undefined && validFrom === undefined) ||
    (input.valid_until !== undefined && validUntil === undefined) ||
    (typeof validFrom === "number" && typeof validUntil === "number" && validFrom >= validUntil) ||
    (input.notes !== undefined && notes === null) ||
    (input.customer_id !== undefined && customerId === undefined) ||
    (input.license_id !== undefined && licenseId === undefined)
  ) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const policy = await findPolicy(env, policyId);
  if (policy === null || policy.status !== "active") {
    return envelope(requestIdValue, "policy_not_found", undefined, 404);
  }
  const now = Math.floor(Date.now() / 1000);
  // Build the override set; undefined fields fall back to the policy default inside stampFromPolicy.
  const overrides: Record<string, unknown> = { project, feature, license_fingerprint: licenseFingerprint };
  if (deviceHash !== undefined) overrides.device_hash = deviceHash;
  if (assertionTtl !== undefined) overrides.assertion_ttl_seconds = assertionTtl;
  if (input.valid_from !== undefined) overrides.valid_from = validFrom;
  if (input.valid_until !== undefined) overrides.valid_until = validUntil;
  if (notes !== undefined) overrides.notes = notes;
  if (customerId !== undefined) overrides.customer_id = customerId;
  if (licenseId !== undefined) overrides.license_id = licenseId;
  const stamp = stampFromPolicy(policy as never, overrides as never, now);
  const key = { project, feature, license_fingerprint: licenseFingerprint };
  return mutationResponse(request, env, ctx, "entitlement_saved", (idempotency) =>
    createEntitlement(env, stamp.input, ctx, "", undefined, idempotency, [
      buildPolicyStampStatement(env as never, key, policy.id, stamp.capacity, stamp.trial),
    ]));
}

export async function handleMutation(request: Request, env: Env, actor: Actor, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const url = new URL(request.url);
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const ctx: MutationContext = {
    actor,
    requestId: requestIdValue,
    ip: clientIp(request),
    idempotencyKey: idempotencyKey ?? null,
    source: "admin",
  };
  const body = await parseJsonBody(request, requestIdValue);
  if (body instanceof Response) {
    return body;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/entitlements") {
    const policyId = (body as Record<string, unknown>).policy_id;
    if (policyId !== undefined && policyId !== null && policyId !== "") {
      return createFromPolicy(request, env, ctx, body, requestIdValue);
    }
    const input = validateEntitlementInput(body);
    if (input === null) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    return mutationResponse(request, env, ctx, "entitlement_saved", (idempotency) =>
      createEntitlement(env, input, ctx, "", undefined, idempotency));
  }

  const match = /^\/api\/admin\/entitlements\/([^/]+)(?:\/(disable|reenable|revoke))?$/.exec(url.pathname);
  if (match === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  const key = decodeEntitlementId(match[1] ?? "");
  if (key === null) {
    return envelope(requestIdValue, "invalid_entitlement_id", undefined, 400);
  }
  const action = match[2];
  if (request.method === "PATCH" && action === undefined) {
    const patch = validateEntitlementPatch(body);
    if (patch === null) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    return mutationResponse(request, env, ctx, "entitlement_patched", (idempotency) =>
      patchEntitlement(env, key, patch, ctx, idempotency));
  }
  if (request.method === "POST" && action !== undefined) {
    const reason = safeNotes((body as Record<string, unknown>).reason) ?? "";
    if ((action === "disable" || action === "revoke") && reason === "") {
      return envelope(requestIdValue, "reason_required", undefined, 400);
    }
    const transition = action as "disable" | "reenable" | "revoke";
    const targetStatus = transition === "reenable" ? "active" : transition === "disable" ? "disabled" : "revoked";
    return mutationResponse(request, env, ctx, `entitlement_${action}d`, (idempotency) =>
      transitionEntitlement(env, key, targetStatus, transition, reason, ctx, idempotency));
  }
  return envelope(requestIdValue, "not_found", undefined, 404);
}

export async function handleBatchTransition(request: Request, env: Env, actor: Actor, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const headerKey = readIdempotencyKey(request);
  if (headerKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const body = await parseJsonBody(request, requestIdValue);
  if (body instanceof Response) {
    return body;
  }
  const input = body as Record<string, unknown>;
  const action = input.action;
  if (action !== "disable" && action !== "reenable" && action !== "revoke") {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const reason = safeNotes(input.reason) ?? "";
  if ((action === "disable" || action === "revoke") && reason === "") {
    return envelope(requestIdValue, "reason_required", undefined, 400);
  }
  const ids = input.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string")) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  if (ids.length > BATCH_MAX_IDS) {
    return envelope(requestIdValue, "too_many", undefined, 400);
  }
  // The per-row idempotency BASE: the caller's key, or a stable per-request batch id when absent
  // (a generated base means no cross-request replay, but the rows are still mutually distinct).
  const baseKey = headerKey ?? `batch:${crypto.randomUUID()}`;
  const targetStatus = action === "reenable" ? "active" : action === "disable" ? "disabled" : "revoked";
  const transition = action as "disable" | "reenable" | "revoke";
  const scope = `POST:${new URL(request.url).pathname}:${actor.subject}`;
  const results: Array<{ id: string; ok: boolean; code: string }> = [];
  for (const id of ids as string[]) {
    const key = decodeEntitlementId(id);
    if (key === null) {
      results.push({ id, ok: false, code: "invalid_entitlement_id" });
      continue;
    }
    // DISTINCT per-row sub-key — the heart of the footgun guard.
    const rowKey = `${baseKey}:${id}`;
    const ctx: MutationContext = {
      actor,
      requestId: requestIdValue,
      ip: clientIp(request),
      idempotencyKey: rowKey,
      source: "admin",
    };
    const replay = await readIdempotentResponse(env.DB, scope, rowKey);
    if (replay !== null) {
      results.push({ id, ok: true, code: `entitlement_${transition}d` });
      continue;
    }
    try {
      const idempotency = { scope, responseCode: `entitlement_${transition}d` };
      const result = await transitionEntitlement(env, key, targetStatus, transition, reason, ctx, idempotency);
      if (result === null) {
        results.push({ id, ok: false, code: "not_found" });
        continue;
      }
      if (!result.idempotencyRecorded) {
        const rowBody = { ok: true, code: `entitlement_${transition}d`, request_id: requestIdValue, data: result.data };
        await writeIdempotentResponse(env.DB, scope, rowKey, JSON.stringify(rowBody), Math.floor(Date.now() / 1000));
      }
      results.push({ id, ok: true, code: `entitlement_${transition}d` });
    } catch (error) {
      if (error instanceof Error && error.message === "revoked_terminal") {
        results.push({ id, ok: false, code: "revoked_entitlement_is_terminal" });
        continue;
      }
      results.push({ id, ok: false, code: "mutation_failed" });
    }
  }
  return envelope(requestIdValue, "batch_done", { results });
}

// ── Global search (Workstream C) ──────────────────────────────────────────────
// GET /api/admin/search?q=&limit= — reader+admin. Fans out an escaped LIKE across the
// already-isolated tables (customers/licenses/entitlements/orders), bounded per type, so the
// UI can deep-link a single typed result. No oracle concern: the route is admin-authenticated.
export async function entitlementDetail(env: Env, encodedId: string, requestIdValue: string): Promise<Response> {
  const key = decodeEntitlementId(encodedId);
  if (key === null) {
    return envelope(requestIdValue, "invalid_entitlement_id", undefined, 400);
  }
  const row = await findEntitlement(env, key);
  return row === null ? envelope(requestIdValue, "not_found", undefined, 404) : envelope(requestIdValue, "entitlement", row);
}
