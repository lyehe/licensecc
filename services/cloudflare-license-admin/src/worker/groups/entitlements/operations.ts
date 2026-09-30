import { INVALID_IDEMPOTENCY_KEY, mutationResponse, readIdempotencyKey } from "../../idempotency.js";
import { createReplayAdmission, createWithEnforcement, validateEntitlementCreate } from "./create-enforcement.js";
import { patchDeviceLimit } from "./device-limit.js";
import { envelope } from "../../responses.js";
import {
  batchReturnedRow,
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
import {
  ENTITLEMENT_BATCH_MAX_IDS,
  ENTITLEMENT_BATCH_TOO_LARGE_CODE,
  ENTITLEMENT_BATCH_TOO_LARGE_GUIDANCE,
} from "../../../shared/api.js";
import type { EntitlementRecord, Policy } from "../../../shared/api";
import type { Env } from "../../env.js";
import { requireAdmin } from "../../auth.js";
import { parseJsonBody, safeNotes } from "../../request.js";
import { safeString } from "@licensecc/cloudflare-runtime/http/kit";
import { MAX_FEATURE_SIZE, MAX_PROJECT_SIZE, nullableEpoch, nullableSafeString, validateEntitlementPatch } from "./validation.js";
import { clientIp } from "../../support.js";
import { CSV_ROW_CAP, boundedCursor, boundedEventsCursor, csvResponse, encodeEventsCursor, epochQueryParam, wantsCsv } from "../../query.js";

const HEX_64 = /^[0-9a-fA-F]{64}$/;

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
  for (const [query, column] of [["project", "project"], ["feature", "feature"], ["status", "status"], ["customer_id", "customer_id"], ["license_id", "license_id"]] as const) {
    const value = url.searchParams.get(query);
    if (value !== null && value !== "") {
      filters.push(`${column} = ?`);
      values.push(value);
    }
  }
  const selectedId = url.searchParams.get("id");
  if (selectedId) {
    const selected = decodeEntitlementId(selectedId);
    if (!selected) return envelope(requestIdValue, "invalid_request", undefined, 400);
    filters.push("project = ? AND feature = ? AND license_fingerprint = ?");
    values.push(selected.project, selected.feature, selected.license_fingerprint);
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
  // project/feature/event_type/actor are exact-match filters, validated the same (presence-only)
  // way listEntitlements validates its own project/feature/status/customer_id/license_id filters:
  // an unrecognized event_type or actor simply matches zero rows rather than 400ing, exactly like
  // an unrecognized status does today.
  const filters: string[] = [];
  const values: unknown[] = [];
  for (const [query, column] of [["project", "project"], ["feature", "feature"], ["event_type", "event_type"], ["actor", "actor"]] as const) {
    const value = url.searchParams.get(query);
    if (value !== null && value !== "") {
      filters.push(`${column} = ?`);
      values.push(value);
    }
  }
  const entitlementIdParam = url.searchParams.get("entitlement_id");
  if (entitlementIdParam) {
    const decoded = decodeEntitlementId(entitlementIdParam);
    if (decoded === null) return envelope(requestIdValue, "invalid_request", undefined, 400);
    filters.push("project = ? AND feature = ? AND license_fingerprint = ?");
    values.push(decoded.project, decoded.feature, decoded.license_fingerprint);
  }
  const since = epochQueryParam(url, "since");
  const until = epochQueryParam(url, "until");
  if (since === null || until === null) return envelope(requestIdValue, "invalid_request", undefined, 400);
  if (since !== undefined) { filters.push("created_at >= ?"); values.push(since); }
  if (until !== undefined) { filters.push("created_at <= ?"); values.push(until); }
  const pagination = boundedEventsCursor(url);
  if (pagination === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  // `detail` carries the writer's attribution (for example "order:<intent>" on an order-driven row);
  // surface it so the console and CSV say what caused each change.
  const eventColumns = "id, project, feature, license_fingerprint, event_type, status, revocation_seq, actor, actor_type, source, request_id, reason, detail, created_at";
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  if (wantsCsv(url)) {
    // CSV export: SAME filters, but bounded by the CSV cap instead of a page cursor.
    const csvRows = await env.DB.prepare(
      `SELECT ${eventColumns} FROM entitlement_events ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(...values, CSV_ROW_CAP).all<Record<string, unknown>>();
    return csvResponse(
      "events.csv",
      ["id", "project", "feature", "license_fingerprint", "event_type", "status", "revocation_seq", "actor", "actor_type", "source", "request_id", "reason", "detail", "created_at"],
      csvRows.results,
    );
  }
  const { limit, cursor } = pagination;
  const pageFilters = [...filters];
  const pageValues = [...values];
  if (cursor !== null) {
    // Keyset, not an offset: anchored to the last row's own (created_at, id) identity, so a page
    // boundary landing on several equal created_at values neither skips nor repeats a row.
    pageFilters.push("(created_at < ? OR (created_at = ? AND id < ?))");
    pageValues.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const pageWhere = pageFilters.length === 0 ? "" : `WHERE ${pageFilters.join(" AND ")}`;
  pageValues.push(limit + 1);
  const rows = await env.DB.prepare(
    `SELECT ${eventColumns} FROM entitlement_events ${pageWhere} ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(...pageValues).all<{ id: number; created_at: number }>();
  const items = rows.results.slice(0, limit);
  const last = items.at(-1);
  const nextCursor = rows.results.length > limit && last !== undefined ? encodeEventsCursor(last.created_at, last.id) : null;
  return envelope(requestIdValue, "events_listed", { items, next_cursor: nextCursor });
}

export async function createFromPolicy(request: Request, env: Env, ctx: MutationContext, body: unknown, requestIdValue: string): Promise<Response> {
  const selected = validateEntitlementCreate(body);
  if (selected === null) return envelope(requestIdValue, "invalid_request", undefined, 400);
  const admitReplay = createReplayAdmission(selected);
  return mutationResponse(request, env, ctx, "entitlement_saved", async (idempotency) => {
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
    // validateEntitlementCreate has already refused a device hash or an assertion TTL.
    const validFrom = input.valid_from === undefined ? undefined : nullableEpoch(input.valid_from);
    const validUntil = input.valid_until === undefined ? undefined : nullableEpoch(input.valid_until);
    const notes = input.notes === undefined ? undefined : safeNotes(input.notes);
    const customerId = input.customer_id === undefined ? undefined : nullableSafeString(input.customer_id, 128);
    const licenseId = input.license_id === undefined ? undefined : nullableSafeString(input.license_id, 128);
    if (
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
    if (input.valid_from !== undefined) overrides.valid_from = validFrom;
    if (input.valid_until !== undefined) overrides.valid_until = validUntil;
    if (notes !== undefined) overrides.notes = notes;
    if (customerId !== undefined) overrides.customer_id = customerId;
    if (licenseId !== undefined) overrides.license_id = licenseId;
    const stamp = stampFromPolicy(policy as never, overrides as never, now);
    // The stamp's input also names a device hash and the policy's assertion TTL; a protected grant
    // takes neither, so the create keeps the empty hash and the default TTL.
    const { device_hash: _deviceHash, assertion_ttl_seconds: _assertionTtl, ...stamped } = stamp.input;
    const key = { project, feature, license_fingerprint: licenseFingerprint };
    return createWithEnforcement(env, { ...stamped, enforcement_mode: selected.enforcement_mode }, ctx, idempotency, [
        buildPolicyStampStatement(env as never, key, policy.id, stamp.capacity, stamp.trial),
      ], policy);
  }, admitReplay);
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
    const input = validateEntitlementCreate(body);
    if (input === null) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    return mutationResponse(request, env, ctx, "entitlement_saved", (idempotency) =>
      createWithEnforcement(env, input, ctx, idempotency), createReplayAdmission(input));
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
  if (body === null || typeof body !== "object" || Array.isArray(body)) return envelope(requestIdValue, "invalid_request", undefined, 400);
  const expected = body as Record<string, unknown>;
  if (expected.expected_customer_id !== undefined || expected.expected_revocation_seq !== undefined) {
    if ((expected.expected_customer_id !== null && (typeof expected.expected_customer_id !== "string" || expected.expected_customer_id.length > 128)) ||
      !Number.isSafeInteger(expected.expected_revocation_seq) || Number(expected.expected_revocation_seq) < 0) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    ctx.expectedEntitlement = { customer_id: expected.expected_customer_id as string | null, revocation_seq: expected.expected_revocation_seq as number };
  }
  if (request.method === "PATCH" && action === undefined) {
    const patch = validateEntitlementPatch(body);
    if (patch === null) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    const { max_active_devices: limit, ...fields } = patch;
    if (limit !== undefined) {
      // The device limit is its own audited capacity write, so it is patched alone.
      if (Object.keys(fields).length > 0) return envelope(requestIdValue, "invalid_request", undefined, 400);
      return mutationResponse(request, env, ctx, "entitlement_patched", (idempotency) =>
        patchDeviceLimit(env, key, limit, ctx, idempotency));
    }
    return mutationResponse(request, env, ctx, "entitlement_patched", (idempotency) =>
      patchEntitlement(env, key, fields, ctx, idempotency));
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
  if (!Array.isArray(ids) || ids.length === 0) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  // This check must remain above decoding, idempotency reads, and every D1
  // side effect. Four rows leave deterministic headroom below Free D1's 50
  // query limit even on same-target guarded-CAS races, while fitting the
  // Worker-wide 8 KiB JSON parser budget for canonical encoded ids.
  if (ids.length > ENTITLEMENT_BATCH_MAX_IDS) {
    return envelope(requestIdValue, ENTITLEMENT_BATCH_TOO_LARGE_CODE, {
      max_ids: ENTITLEMENT_BATCH_MAX_IDS,
      guidance: ENTITLEMENT_BATCH_TOO_LARGE_GUIDANCE,
    }, 400);
  }
  if (ids.some((id) => typeof id !== "string")) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
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
        // A same-row concurrent winner can publish this key between the first
        // replay lookup and our guarded no-op result. Treat it as the winner's
        // replay rather than overwrite/duplicate the cache.
        const racedReplay = await readIdempotentResponse(env.DB, scope, rowKey);
        if (racedReplay !== null) {
          results.push({ id, ok: true, code: `entitlement_${transition}d` });
          continue;
        }
        const rowBody = { ok: true, code: `entitlement_${transition}d`, request_id: requestIdValue, data: result.data };
        const stored = await writeIdempotentResponse(env.DB, scope, rowKey, JSON.stringify(rowBody), Math.floor(Date.now() / 1000));
        if (stored !== null && stored !== JSON.stringify(rowBody)) {
          results.push({ id, ok: true, code: `entitlement_${transition}d` });
          continue;
        }
      }
      results.push({ id, ok: true, code: `entitlement_${transition}d` });
    } catch (error) {
      if (error instanceof Error && error.message === "idempotency_conflict") {
        const racedReplay = await readIdempotentResponse(env.DB, scope, rowKey);
        if (racedReplay !== null) {
          results.push({ id, ok: true, code: `entitlement_${transition}d` });
          continue;
        }
        results.push({ id, ok: false, code: "mutation_failed" });
        continue;
      }
      if (error instanceof Error && error.message === "stale_transition") {
        // Match mutationResponse's post-claim replay check for a same-key
        // concurrent winner. A different mutation really is a row conflict.
        const racedReplay = await readIdempotentResponse(env.DB, scope, rowKey);
        if (racedReplay !== null) {
          results.push({ id, ok: true, code: `entitlement_${transition}d` });
          continue;
        }
        results.push({ id, ok: false, code: "stale_transition" });
        continue;
      }
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
