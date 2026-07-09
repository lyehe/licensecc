// ── Webhook endpoint domain module (extracted from index.ts; migration 0020) ──
// CRUD over webhook_endpoints (the dispatcher's config rows) + a read/redrive view over
// webhook_deliveries (the cron-drained outbox). Reads are reader+admin; writes require
// requireAdmin. The signing secret is NEVER stored or surfaced here — it lives only in the
// Worker-env WEBHOOK_SIGNING_SECRETS map. There is no webhook audit table, so create/patch/
// disable/reenable are single-statement RETURNING mutations (idempotent), NOT a write+audit
// batch (audit "where applicable" — it is not applicable to a config row with no event log).

import { envelope, json } from "./responses.js";
import {
  INVALID_IDEMPOTENCY_KEY,
  idempotentReplay,
  readIdempotencyKey,
  rememberIdempotency,
} from "./idempotency.js";
import { boundedCursor, parseJsonBody, requireAdmin } from "./index.js";
import type { Env } from "./index.js";
import type {
  WebhookEndpoint,
  WebhookEndpointInput,
  WebhookEndpointPatch,
} from "../shared/api";
import type { Actor } from "@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation";

// Sentinel distinguishing a present-but-invalid value from an absent one, module-local to the
// webhook validators (mirrors index.ts's INVALID symbol; compared only within this module).
const INVALID = Symbol("invalid");

// ── Webhook endpoint validation (migration 0020) ──────────────────────────────
// An endpoint is a CONFIG row: an https URL + a csv event_types filter ("" = all) +
// a description. NO signing secret lives here — it is only in the env secret map. URL
// validation is the security gate: https-only (else 400 invalid_url) so a delivery can
// never POST to plaintext http. event_types is bounded csv (each entry a bare token).

const MAX_WEBHOOK_URL_SIZE = 2048;
const MAX_WEBHOOK_EVENT_TYPES_SIZE = 1024;
const MAX_WEBHOOK_DESCRIPTION_SIZE = 500;

// A valid webhook URL is a parseable absolute https:// URL within the size bound and
// free of control characters. The INVALID sentinel distinguishes a bad URL (-> 400
// invalid_url) from a merely-absent one. Returns the normalized href on success.
function safeWebhookUrl(value: unknown): string | typeof INVALID {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_WEBHOOK_URL_SIZE) {
    return INVALID;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0") || /\s/.test(value)) {
    return INVALID;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return INVALID;
  }
  // https-only: never let a delivery POST to plaintext http (or any other scheme).
  if (parsed.protocol !== "https:") {
    return INVALID;
  }
  return parsed.href;
}

// event_types is a csv allow-list filter; "" means "all event types". Each entry must be
// a bare, non-empty token (no comma/newline/NUL) — the dispatcher splits on comma and
// trims. We re-serialize the trimmed tokens so storage is canonical. undefined -> "".
function safeWebhookEventTypes(value: unknown): string | null {
  if (value === undefined || value === "" || value === null) {
    return "";
  }
  if (typeof value !== "string" || value.length > MAX_WEBHOOK_EVENT_TYPES_SIZE) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return null;
  }
  const tokens = value.split(",").map((token) => token.trim()).filter((token) => token.length > 0);
  // Reject a token carrying a stray comma-equivalent or whitespace (split already removed
  // commas; guard internal whitespace so "a b" can never masquerade as one event type).
  for (const token of tokens) {
    if (/\s/.test(token)) {
      return null;
    }
  }
  return tokens.join(",");
}

function safeWebhookDescription(value: unknown): string | null {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || value.length > MAX_WEBHOOK_DESCRIPTION_SIZE) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return null;
  }
  return value;
}

// A per-tenant scope value (audit R2.2): "" (global) or a bounded single-line token (a project name
// or customer id). Returns "" for absent/blank, the token for a valid string, or null when invalid.
function safeWebhookScope(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value !== "string" || value.length > 128) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0") || value.includes(",")) {
    return null;
  }
  return value;
}

// Validate a create body. `url` is required and must be https. Returns null on ANY invalid
// field (the caller emits 400 invalid_request); a bad URL is reported separately as
// invalid_url, so the caller distinguishes the two.
export function validateWebhookInput(value: unknown): WebhookEndpointInput | "invalid_url" | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const url = safeWebhookUrl(input.url);
  const eventTypes = safeWebhookEventTypes(input.event_types);
  const description = safeWebhookDescription(input.description);
  const scopeProject = safeWebhookScope(input.scope_project);
  const scopeCustomer = safeWebhookScope(input.scope_customer_id);
  if (eventTypes === null || description === null || scopeProject === null || scopeCustomer === null) {
    return null;
  }
  if (scopeProject !== "" && scopeCustomer !== "") {
    return null;
  }
  if (url === INVALID) {
    return "invalid_url";
  }
  return { url, event_types: eventTypes, description, scope_project: scopeProject, scope_customer_id: scopeCustomer };
}

// Validate a patch body. Only url / event_types / description are mutable; status / id /
// timestamps are NOT patchable (reject if present). All fields optional. A present-but-bad
// url returns "invalid_url"; any other invalid field returns null.
export function validateWebhookPatch(value: unknown): WebhookEndpointPatch | "invalid_url" | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (input.status !== undefined || input.id !== undefined || input.created_at !== undefined || input.updated_at !== undefined) {
    return null;
  }
  const patch: WebhookEndpointPatch = {};
  if (input.url !== undefined) {
    const url = safeWebhookUrl(input.url);
    if (url === INVALID) {
      return "invalid_url";
    }
    patch.url = url;
  }
  if (input.event_types !== undefined) {
    const eventTypes = safeWebhookEventTypes(input.event_types);
    if (eventTypes === null) {
      return null;
    }
    patch.event_types = eventTypes;
  }
  if (input.description !== undefined) {
    const description = safeWebhookDescription(input.description);
    if (description === null) {
      return null;
    }
    patch.description = description;
  }
  for (const field of ["scope_project", "scope_customer_id"] as const) {
    if (input[field] !== undefined) {
      const scope = safeWebhookScope(input[field]);
      if (scope === null) {
        return null;
      }
      patch[field] = scope;
    }
  }
  return patch;
}

const WEBHOOK_ENDPOINT_COLUMNS =
  "id, url, event_types, status, description, created_at, updated_at, scope_project, scope_customer_id";
const WEBHOOK_DELIVERY_COLUMNS =
  "id, endpoint_id, event_source, event_id, event_type, status, attempts, last_status, last_error, next_attempt_at, created_at, delivered_at";

async function findWebhookEndpoint(env: Env, endpointId: string): Promise<WebhookEndpoint | null> {
  return env.DB.prepare(`SELECT ${WEBHOOK_ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE id = ? LIMIT 1`)
    .bind(endpointId)
    .first<WebhookEndpoint>();
}

export async function listWebhooks(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const filters: string[] = [];
  const values: unknown[] = [];
  const status = url.searchParams.get("status");
  if (status === "active" || status === "disabled") {
    filters.push("status = ?");
    values.push(status);
  }
  const { limit, cursor } = boundedCursor(url);
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  values.push(limit + 1, cursor);
  const rows = await env.DB.prepare(
    `SELECT ${WEBHOOK_ENDPOINT_COLUMNS} FROM webhook_endpoints ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
  ).bind(...values).all();
  return envelope(requestIdValue, "webhooks_listed", {
    items: rows.results.slice(0, limit),
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

export async function getWebhook(env: Env, endpointId: string, requestIdValue: string): Promise<Response> {
  const endpoint = await findWebhookEndpoint(env, endpointId);
  if (endpoint === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  // Detail surfaces the endpoint + its most-recent deliveries so an operator can see the
  // delivery health of THIS endpoint at a glance (read-only; never the signing secret).
  const deliveries = await env.DB.prepare(
    `SELECT ${WEBHOOK_DELIVERY_COLUMNS} FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY id DESC LIMIT 50`,
  ).bind(endpointId).all();
  return envelope(requestIdValue, "webhook", { endpoint, deliveries: deliveries.results });
}

// Delivery status view: filter by status / endpoint_id, cursor-paginated. Read-only; the
// payload_json body is deliberately NOT selected (operators see metadata, not the full body).
export async function listWebhookDeliveries(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const filters: string[] = [];
  const values: unknown[] = [];
  const status = url.searchParams.get("status");
  if (status === "pending" || status === "delivered" || status === "failed") {
    filters.push("status = ?");
    values.push(status);
  } else if (status !== null && status !== "") {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const endpointId = url.searchParams.get("endpoint_id");
  if (endpointId !== null && endpointId !== "") {
    if (endpointId.length > 128) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    filters.push("endpoint_id = ?");
    values.push(endpointId);
  }
  const { limit, cursor } = boundedCursor(url);
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  values.push(limit + 1, cursor);
  const rows = await env.DB.prepare(
    `SELECT ${WEBHOOK_DELIVERY_COLUMNS} FROM webhook_deliveries ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).bind(...values).all();
  return envelope(requestIdValue, "webhook_deliveries_listed", {
    items: rows.results.slice(0, limit),
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

async function handleWebhookCreate(request: Request, env: Env, actor: Actor, body: unknown, requestIdValue: string): Promise<Response> {
  const input = validateWebhookInput(body);
  if (input === "invalid_url") {
    return envelope(requestIdValue, "invalid_url", undefined, 400);
  }
  if (input === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const scope = `POST:/api/admin/webhooks:${actor.subject}`;
  const replay = await idempotentReplay(env, scope, idempotencyKey);
  if (replay !== null) {
    return replay;
  }
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  let row: WebhookEndpoint | null;
  try {
    row = await env.DB.prepare(
      `INSERT INTO webhook_endpoints
         (id, url, event_types, status, description, created_at, updated_at, scope_project, scope_customer_id)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?) RETURNING ${WEBHOOK_ENDPOINT_COLUMNS}`,
    )
      .bind(
        id,
        input.url,
        input.event_types ?? "",
        input.description ?? "",
        now,
        now,
        input.scope_project ? input.scope_project : null,
        input.scope_customer_id ? input.scope_customer_id : null,
      )
      .first<WebhookEndpoint>();
  } catch {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  if (row === null) {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  const responseBody = { ok: true, code: "webhook_created", request_id: requestIdValue, data: row };
  await rememberIdempotency(env, scope, idempotencyKey, responseBody, now);
  return json(responseBody);
}

async function handleWebhookPatch(request: Request, env: Env, actor: Actor, endpointId: string, body: unknown, requestIdValue: string): Promise<Response> {
  const patch = validateWebhookPatch(body);
  if (patch === "invalid_url") {
    return envelope(requestIdValue, "invalid_url", undefined, 400);
  }
  if (patch === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const scope = `PATCH:/api/admin/webhooks/:id:${actor.subject}`;
  const replay = await idempotentReplay(env, scope, idempotencyKey);
  if (replay !== null) {
    return replay;
  }
  let existing: WebhookEndpoint | null;
  try {
    existing = await findWebhookEndpoint(env, endpointId);
  } catch {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  if (existing === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  const effectiveScopeProject = patch.scope_project !== undefined ? patch.scope_project : (existing.scope_project ?? "");
  const effectiveScopeCustomer = patch.scope_customer_id !== undefined ? patch.scope_customer_id : (existing.scope_customer_id ?? "");
  if (effectiveScopeProject !== "" && effectiveScopeCustomer !== "") {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const field of ["url", "event_types", "description", "scope_project", "scope_customer_id"] as const) {
    const value = (patch as Record<string, unknown>)[field];
    if (value !== undefined) {
      // A blank scope value clears the scope back to global (NULL); other fields store their string.
      const isScope = field === "scope_project" || field === "scope_customer_id";
      assignments.push(`${field} = ?`);
      values.push(isScope && value === "" ? null : value);
    }
  }
  const now = Math.floor(Date.now() / 1000);
  // Always bump updated_at (even on an empty patch) so the list ordering reflects the touch.
  assignments.push("updated_at = ?");
  values.push(now, endpointId);
  let row: WebhookEndpoint | null;
  try {
    row = await env.DB.prepare(
      `UPDATE webhook_endpoints SET ${assignments.join(", ")} WHERE id = ? RETURNING ${WEBHOOK_ENDPOINT_COLUMNS}`,
    ).bind(...values).first<WebhookEndpoint>();
  } catch {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  if (row === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  const responseBody = { ok: true, code: "webhook_patched", request_id: requestIdValue, data: row };
  await rememberIdempotency(env, scope, idempotencyKey, responseBody, now);
  return json(responseBody);
}

// Disable/reenable kill-switch: a guarded UPDATE (status flips only from the expected prior
// status). Disabling stops the dispatcher from enqueuing/delivering for this endpoint; it
// never deletes already-enqueued deliveries (the deliver pass skips a disabled endpoint).
async function handleWebhookTransition(request: Request, env: Env, actor: Actor, endpointId: string, action: "disable" | "reenable", requestIdValue: string): Promise<Response> {
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const scope = `POST:/api/admin/webhooks/${action}:${actor.subject}`;
  const replay = await idempotentReplay(env, scope, idempotencyKey);
  if (replay !== null) {
    return replay;
  }
  const expectedPrev = action === "disable" ? "active" : "disabled";
  const next = action === "disable" ? "disabled" : "active";
  const existing = await findWebhookEndpoint(env, endpointId);
  if (existing === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  if (existing.status !== expectedPrev) {
    return envelope(requestIdValue, "webhook_status_conflict", { status: existing.status }, 409);
  }
  const now = Math.floor(Date.now() / 1000);
  let row: WebhookEndpoint | null;
  try {
    row = await env.DB.prepare(
      `UPDATE webhook_endpoints SET status = ?, updated_at = ? WHERE id = ? AND status = ? RETURNING ${WEBHOOK_ENDPOINT_COLUMNS}`,
    ).bind(next, now, endpointId, expectedPrev).first<WebhookEndpoint>();
  } catch {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  if (row === null) {
    // Lost the guarded race — status changed between the pre-read and the UPDATE.
    return envelope(requestIdValue, "webhook_status_conflict", undefined, 409);
  }
  const responseBody = { ok: true, code: `webhook_${action}d`, request_id: requestIdValue, data: row };
  await rememberIdempotency(env, scope, idempotencyKey, responseBody, now);
  return json(responseBody);
}

// Redrive: reset a 'failed' delivery back to 'pending' with next_attempt_at = now so the next
// cron tick re-attempts it. A guarded UPDATE (status = 'failed' in the WHERE) makes this safe
// and idempotent: a delivery already pending/delivered is a 409, never silently re-queued.
async function handleWebhookRedrive(request: Request, env: Env, actor: Actor, deliveryId: number, requestIdValue: string): Promise<Response> {
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const scope = `POST:/api/admin/webhooks/deliveries/redrive:${actor.subject}`;
  const replay = await idempotentReplay(env, scope, idempotencyKey);
  if (replay !== null) {
    return replay;
  }
  const existing = await env.DB.prepare(
    `SELECT ${WEBHOOK_DELIVERY_COLUMNS} FROM webhook_deliveries WHERE id = ? LIMIT 1`,
  ).bind(deliveryId).first<{ status: string }>();
  if (existing === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  if (existing.status !== "failed") {
    return envelope(requestIdValue, "webhook_delivery_not_failed", { status: existing.status }, 409);
  }
  const now = Math.floor(Date.now() / 1000);
  let row: Record<string, unknown> | null;
  try {
    row = await env.DB.prepare(
      `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, last_error = '', next_attempt_at = ?
       WHERE id = ? AND status = 'failed' RETURNING ${WEBHOOK_DELIVERY_COLUMNS}`,
    ).bind(now, deliveryId).first<Record<string, unknown>>();
  } catch {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  if (row === null) {
    // Lost the guarded race — status changed between the pre-read and the UPDATE.
    return envelope(requestIdValue, "webhook_delivery_not_failed", undefined, 409);
  }
  const responseBody = { ok: true, code: "webhook_delivery_redriven", request_id: requestIdValue, data: row };
  await rememberIdempotency(env, scope, idempotencyKey, responseBody, now);
  return json(responseBody);
}

// Dispatch the webhook writes (POST create, POST deliveries/:id/redrive, PATCH :id,
// POST :id/disable|reenable). All require the admin role so reader RBAC blocks every write.
// The /deliveries/:id/redrive route is matched BEFORE the generic /webhooks/:id regex.
export async function handleWebhookMutation(request: Request, env: Env, actor: Actor, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const url = new URL(request.url);
  const body = await parseJsonBody(request, requestIdValue);
  if (body instanceof Response) {
    return body;
  }
  if (request.method === "POST" && url.pathname === "/api/admin/webhooks") {
    return handleWebhookCreate(request, env, actor, body, requestIdValue);
  }
  // Redrive lives under /deliveries/:id/redrive — match it before the endpoint :id regex.
  const redrive = /^\/api\/admin\/webhooks\/deliveries\/(\d+)\/redrive$/.exec(url.pathname);
  if (request.method === "POST" && redrive !== null) {
    return handleWebhookRedrive(request, env, actor, Number(redrive[1]), requestIdValue);
  }
  const match = /^\/api\/admin\/webhooks\/([^/]+)(?:\/(disable|reenable))?$/.exec(url.pathname);
  if (match === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  const endpointId = decodeURIComponent(match[1] ?? "");
  // "deliveries" is a reserved sub-collection, not an endpoint id — never let it fall through.
  if (endpointId.length === 0 || endpointId.length > 128 || endpointId === "deliveries") {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const action = match[2];
  if (request.method === "PATCH" && action === undefined) {
    return handleWebhookPatch(request, env, actor, endpointId, body, requestIdValue);
  }
  if (request.method === "POST" && (action === "disable" || action === "reenable")) {
    return handleWebhookTransition(request, env, actor, endpointId, action, requestIdValue);
  }
  return envelope(requestIdValue, "not_found", undefined, 404);
}
