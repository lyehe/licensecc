import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { openApiJson } from "./openapi.js";
import { docsHtml } from "./docs_page.js";
import type { EntitlementInput, EntitlementPatch, EntitlementRecord, EntitlementStatus } from "../shared/api";
import {
  entitlementId,
  decodeEntitlementId,
  withId,
  entitlementSelectSql,
  findEntitlement,
  createEntitlement,
  patchEntitlement,
  transitionEntitlement,
  syncEntitlement,
  batchReturnedRow,
} from "@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation";
import type {
  D1DatabaseLike,
  Actor,
  MutationContext,
  IdempotencyCommit,
  MutationResult,
} from "@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation";

export interface Env {
  DB: D1DatabaseLike;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  ENVIRONMENT?: string;
  ADMIN_DEV_BEARER_ENABLED?: string;
  ADMIN_DEV_BEARER?: string;
  ADMIN_ACCESS_ISSUER?: string;
  ADMIN_ACCESS_AUDIENCE?: string;
  ADMIN_ACCESS_JWKS_URL?: string;
  ADMIN_ACCESS_ADMIN_EMAILS?: string;
  ADMIN_ACCESS_READER_EMAILS?: string;
  PUBLIC_VERIFIER_URL?: string;
  SYNC_API_TOKEN?: string;
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const MAX_PROJECT_SIZE = 127;
const MAX_FEATURE_SIZE = 15;
const MAX_NOTES_SIZE = 1000;
const MAX_BODY_BYTES = 8192;
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function json<T>(body: T, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function envelope<T>(requestId: string, code: string, data?: T, status = 200): Response {
  return json({ ok: status >= 200 && status < 300, code, request_id: requestId, data }, status);
}

function requestId(request: Request): string {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "";
}

function envFlag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function splitCsv(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => item !== ""));
}

function safeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return null;
  }
  return value;
}

function safeNotes(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_NOTES_SIZE) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return null;
  }
  return value;
}

function nullableSafeString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  return safeString(value, maxLength);
}

function boundedInt(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

function nullableEpoch(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const leftDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(a)));
  const rightDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(b)));
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < leftDigest.length; ++i) {
    diff |= (leftDigest[i] ?? 0) ^ (rightDigest[i] ?? 0);
  }
  return diff === 0;
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null) {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(authorization);
  return match?.[1] ?? null;
}

function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(url);
  if (cached !== undefined) {
    return cached;
  }
  const jwks = createRemoteJWKSet(new URL(url));
  jwksCache.set(url, jwks);
  return jwks;
}

function roleForEmail(email: string, env: Env): "reader" | "admin" | null {
  const normalized = email.toLowerCase();
  if (splitCsv(env.ADMIN_ACCESS_ADMIN_EMAILS).has(normalized)) {
    return "admin";
  }
  if (splitCsv(env.ADMIN_ACCESS_READER_EMAILS).has(normalized)) {
    return "reader";
  }
  return null;
}

async function authenticate(request: Request, env: Env, requestIdValue: string): Promise<Actor | Response> {
  if (envFlag(env.ADMIN_DEV_BEARER_ENABLED)) {
    if (env.ENVIRONMENT !== "development") {
      return envelope(requestIdValue, "dev_bearer_forbidden_in_environment", undefined, 500);
    }
    const configured = env.ADMIN_DEV_BEARER;
    const token = bearerToken(request);
    if (configured !== undefined && token !== null && await timingSafeEqual(token, configured)) {
      return { subject: "dev", email: "dev.local", role: "admin", actorType: "dev" };
    }
  }

  if (!env.ADMIN_ACCESS_ISSUER || !env.ADMIN_ACCESS_AUDIENCE) {
    return envelope(requestIdValue, "admin_auth_not_configured", undefined, 401);
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (token === null || token === "") {
    return envelope(requestIdValue, "missing_access_jwt", undefined, 401);
  }

  let payload: JWTPayload;
  try {
    const jwksUrl = env.ADMIN_ACCESS_JWKS_URL || `${env.ADMIN_ACCESS_ISSUER.replace(/\/$/, "")}/cdn-cgi/access/certs`;
    const result = await jwtVerify(token, jwksFor(jwksUrl), {
      issuer: env.ADMIN_ACCESS_ISSUER,
      audience: env.ADMIN_ACCESS_AUDIENCE,
    });
    payload = result.payload;
  } catch {
    return envelope(requestIdValue, "invalid_access_jwt", undefined, 403);
  }

  const email = typeof payload.email === "string" ? payload.email : "";
  const subject = typeof payload.sub === "string" ? payload.sub : email;
  const role = roleForEmail(email, env);
  if (email === "" || subject === "" || role === null) {
    return envelope(requestIdValue, "admin_role_denied", undefined, 403);
  }
  return { subject, email, role, actorType: "access" };
}

async function authenticateSync(request: Request, env: Env, requestIdValue: string): Promise<Actor | Response> {
  if (env.SYNC_API_TOKEN === undefined || env.SYNC_API_TOKEN === "") {
    return envelope(requestIdValue, "sync_auth_not_configured", undefined, 401);
  }
  const token = bearerToken(request);
  if (token === null || !await timingSafeEqual(token, env.SYNC_API_TOKEN)) {
    return envelope(requestIdValue, "invalid_sync_token", undefined, 403);
  }
  return { subject: "sync", email: "sync", role: "admin", actorType: "sync" };
}

function requireAdmin(actor: Actor, requestIdValue: string): Response | null {
  return actor.role === "admin" ? null : envelope(requestIdValue, "admin_role_required", undefined, 403);
}

async function parseJsonBody(request: Request, requestIdValue: string): Promise<unknown | Response> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return envelope(requestIdValue, "body_too_large", undefined, 413);
  }
  try {
    return text === "" ? {} : JSON.parse(text);
  } catch {
    return envelope(requestIdValue, "invalid_json", undefined, 400);
  }
}

function validateEntitlementInput(value: unknown): EntitlementInput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const project = safeString(input.project, MAX_PROJECT_SIZE);
  const feature = safeString(input.feature, MAX_FEATURE_SIZE);
  const licenseFingerprint = typeof input.license_fingerprint === "string" && HEX_64.test(input.license_fingerprint)
    ? input.license_fingerprint
    : null;
  const deviceHash = input.device_hash === undefined || input.device_hash === ""
    ? ""
    : typeof input.device_hash === "string" && HEX_64.test(input.device_hash)
      ? input.device_hash
      : null;
  const status = input.status === undefined ? "active" : input.status;
  const assertionTtl = boundedInt(input.assertion_ttl_seconds ?? 300, 1, 3600);
  const validFrom = input.valid_from === undefined ? null : nullableEpoch(input.valid_from);
  const validUntil = input.valid_until === undefined ? null : nullableEpoch(input.valid_until);
  const notes = input.notes === undefined ? "" : safeNotes(input.notes);
  const customerId = input.customer_id === undefined ? null : nullableSafeString(input.customer_id, 128);
  const licenseId = input.license_id === undefined ? null : nullableSafeString(input.license_id, 128);
  if (
    project === null || feature === null || licenseFingerprint === null || deviceHash === null ||
    !["active", "disabled", "revoked"].includes(String(status)) || assertionTtl === undefined ||
    validFrom === undefined || validUntil === undefined ||
    (validFrom !== null && validUntil !== null && validFrom >= validUntil) || notes === null ||
    customerId === undefined || licenseId === undefined
  ) {
    return null;
  }
  return {
    project,
    feature,
    license_fingerprint: licenseFingerprint,
    device_hash: deviceHash,
    status: status as EntitlementStatus,
    assertion_ttl_seconds: assertionTtl,
    valid_from: validFrom,
    valid_until: validUntil,
    notes,
    customer_id: customerId,
    license_id: licenseId,
  };
}

function validateEntitlementPatch(value: unknown): EntitlementPatch | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const patch: EntitlementPatch = {};
  if (input.device_hash !== undefined) {
    if (input.device_hash === "") {
      patch.device_hash = "";
    } else if (typeof input.device_hash === "string" && HEX_64.test(input.device_hash)) {
      patch.device_hash = input.device_hash;
    } else {
      return null;
    }
  }
  const assertionTtl = boundedInt(input.assertion_ttl_seconds, 1, 3600);
  if (input.assertion_ttl_seconds !== undefined && assertionTtl === undefined) {
    return null;
  }
  if (assertionTtl !== undefined) {
    patch.assertion_ttl_seconds = assertionTtl;
  }
  if (input.valid_from !== undefined) {
    const validFrom = nullableEpoch(input.valid_from);
    if (validFrom === undefined) {
      return null;
    }
    patch.valid_from = validFrom;
  }
  if (input.valid_until !== undefined) {
    const validUntil = nullableEpoch(input.valid_until);
    if (validUntil === undefined) {
      return null;
    }
    patch.valid_until = validUntil;
  }
  const notes = input.notes === undefined ? undefined : safeNotes(input.notes);
  if (notes === null) {
    return null;
  }
  if (notes !== undefined) {
    patch.notes = notes;
  }
  if (input.customer_id !== undefined) {
    const customerId = nullableSafeString(input.customer_id, 128);
    if (customerId === undefined) {
      return null;
    }
    patch.customer_id = customerId;
  }
  if (input.license_id !== undefined) {
    const licenseId = nullableSafeString(input.license_id, 128);
    if (licenseId === undefined) {
      return null;
    }
    patch.license_id = licenseId;
  }
  return patch;
}

async function listEntitlements(request: Request, env: Env, requestIdValue: string): Promise<Response> {
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
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 100);
  const cursor = Math.max(Number(url.searchParams.get("cursor") ?? "0") || 0, 0);
  values.push(limit + 1, cursor);
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  const rows = await env.DB.prepare(`${entitlementSelectSql(where)} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...values)
    .all<Omit<EntitlementRecord, "id">>();
  const items = rows.results.slice(0, limit).map(withId);
  return envelope(requestIdValue, "entitlements_listed", {
    items,
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

async function listEvents(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 100);
  const rows = await env.DB.prepare(
    "SELECT id, project, feature, license_fingerprint, event_type, status, revocation_seq, actor, actor_type, source, request_id, reason, created_at FROM entitlement_events ORDER BY created_at DESC, id DESC LIMIT ?",
  ).bind(limit).all();
  return envelope(requestIdValue, "events_listed", { items: rows.results });
}

async function summary(env: Env, requestIdValue: string): Promise<Response> {
  const total = await env.DB.prepare("SELECT COUNT(*) AS count FROM entitlements").first<{ count: number }>();
  const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'active'").first<{ count: number }>();
  const revoked = await env.DB.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'revoked'").first<{ count: number }>();
  const disabled = await env.DB.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'disabled'").first<{ count: number }>();
  return envelope(requestIdValue, "summary", {
    entitlements: {
      total: total?.count ?? 0,
      active: active?.count ?? 0,
      revoked: revoked?.count ?? 0,
      disabled: disabled?.count ?? 0,
    },
  });
}

async function settings(env: Env, requestIdValue: string): Promise<Response> {
  return envelope(requestIdValue, "settings", {
    environment: env.ENVIRONMENT ?? "development",
    public_verifier_url: env.PUBLIC_VERIFIER_URL ?? "",
    auth: envFlag(env.ADMIN_DEV_BEARER_ENABLED) ? "dev-bearer" : "cloudflare-access",
  });
}

async function idempotentReplay(env: Env, scope: string, key: string | null): Promise<Response | null> {
  if (key === null) {
    return null;
  }
  const row = await env.DB.prepare(
    "SELECT response_json FROM mutation_idempotency WHERE scope = ? AND idempotency_key = ? LIMIT 1",
  ).bind(scope, key).first<{ response_json: string }>();
  if (row === null) {
    return null;
  }
  return json(JSON.parse(row.response_json), 200, { "x-idempotent-replay": "1" });
}

async function rememberIdempotency(env: Env, scope: string, key: string | null, body: unknown, now: number): Promise<void> {
  if (key === null) {
    return;
  }
  await env.DB.prepare(
    "INSERT OR IGNORE INTO mutation_idempotency (scope, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?)",
  ).bind(scope, key, JSON.stringify(body), now).run();
}

async function mutationResponse<T>(request: Request, env: Env, ctx: MutationContext, code: string, fn: (idempotency: IdempotencyCommit | null) => Promise<MutationResult<T> | null>): Promise<Response> {
  const scope = `${request.method}:${new URL(request.url).pathname}:${ctx.actor.subject}`;
  const replay = await idempotentReplay(env, scope, ctx.idempotencyKey);
  if (replay !== null) {
    return replay;
  }
  try {
    const idempotency = ctx.idempotencyKey === null ? null : { scope, responseCode: code };
    const result = await fn(idempotency);
    if (result === null) {
      return envelope(ctx.requestId, "not_found", undefined, 404);
    }
    const body = { ok: true, code, request_id: ctx.requestId, data: result.data };
    if (!result.idempotencyRecorded) {
      await rememberIdempotency(env, scope, ctx.idempotencyKey, body, Math.floor(Date.now() / 1000));
    }
    return json(body);
  } catch (error) {
    if (error instanceof Error && error.message === "revoked_terminal") {
      return envelope(ctx.requestId, "revoked_entitlement_is_terminal", undefined, 409);
    }
    if (error instanceof Error && error.message === "invalid_patch") {
      return envelope(ctx.requestId, "invalid_request", undefined, 400);
    }
    return envelope(ctx.requestId, "mutation_failed", undefined, 500);
  }
}

async function handleMutation(request: Request, env: Env, actor: Actor, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const url = new URL(request.url);
  const idempotencyKey = safeString(request.headers.get("idempotency-key"), 128);
  if (request.headers.has("idempotency-key") && idempotencyKey === null) {
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

function syncReason(value: unknown): string | null {
  if (value === undefined || value === "") {
    return "";
  }
  return safeString(value, MAX_NOTES_SIZE);
}

async function handleSync(request: Request, env: Env): Promise<Response> {
  const id = requestId(request);
  if (request.method !== "POST" || new URL(request.url).pathname !== "/api/sync/entitlements") {
    return envelope(id, "not_found", undefined, 404);
  }
  const auth = await authenticateSync(request, env, id);
  if (auth instanceof Response) {
    return auth;
  }
  const idempotencyKey = safeString(request.headers.get("idempotency-key"), 128);
  if (request.headers.has("idempotency-key") && idempotencyKey === null) {
    return envelope(id, "invalid_idempotency_key", undefined, 400);
  }
  const body = await parseJsonBody(request, id);
  if (body instanceof Response) {
    return body;
  }
  const bodyRecord = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const input = validateEntitlementInput(body);
  const reason = syncReason(bodyRecord.reason);
  if (input === null || reason === null) {
    return envelope(id, "invalid_request", undefined, 400);
  }
  if ((input.status === "disabled" || input.status === "revoked") && reason === "") {
    return envelope(id, "reason_required", undefined, 400);
  }
  const ctx: MutationContext = {
    actor: auth,
    requestId: id,
    ip: clientIp(request),
    idempotencyKey: idempotencyKey ?? null,
    source: "sync",
  };
  return mutationResponse(request, env, ctx, "entitlement_synced", (idempotency) =>
    syncEntitlement(env, input, reason, ctx, idempotency));
}

// ── Slice 4: operator console ────────────────────────────────────────────────
// Read surface over the already-isolated tables (customers / licenses / orders /
// account_tokens) + the customer kill-switch. All reads are reader+admin; the only
// write (customer disable/reenable) is gated by requireAdmin so reader RBAC blocks it.
// Design: docs/superpowers/plans/2026-06-24-slice4-operator-console-blueprint.md.

// Turn a user search term into a LIKE pattern, escaping the wildcards so input matches
// literally (paired with `LIKE ? ESCAPE '\'`). Returns null for over-long/unsafe input.
function likeContains(value: unknown): string | null {
  const term = safeString(value, 128);
  if (term === null) {
    return null;
  }
  return `%${term.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function boundedCursor(url: URL): { limit: number; cursor: number } {
  return {
    limit: Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 100),
    cursor: Math.max(Number(url.searchParams.get("cursor") ?? "0") || 0, 0),
  };
}

async function listCustomers(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const filters: string[] = [];
  const values: unknown[] = [];
  const status = url.searchParams.get("status");
  if (status === "active" || status === "disabled") {
    filters.push("c.status = ?");
    values.push(status);
  }
  const q = url.searchParams.get("q");
  if (q !== null && q !== "") {
    const like = likeContains(q);
    if (like === null) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    filters.push("(lower(c.id) LIKE ? ESCAPE '\\' OR lower(c.email) LIKE ? ESCAPE '\\' OR lower(c.name) LIKE ? ESCAPE '\\')");
    values.push(like, like, like);
  }
  const { limit, cursor } = boundedCursor(url);
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  values.push(limit + 1, cursor);
  const rows = await env.DB.prepare(
    `SELECT c.id, c.name, c.email, c.status, c.external_ref, c.created_at, c.updated_at,
       (SELECT COUNT(*) FROM entitlements e WHERE e.customer_id = c.id) AS entitlement_count,
       (SELECT COUNT(*) FROM entitlements e WHERE e.customer_id = c.id AND e.status = 'active') AS active_entitlement_count
     FROM customers c ${where} ORDER BY c.updated_at DESC, c.id LIMIT ? OFFSET ?`,
  ).bind(...values).all();
  return envelope(requestIdValue, "customers_listed", {
    items: rows.results.slice(0, limit),
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

async function getCustomer(env: Env, customerId: string, requestIdValue: string): Promise<Response> {
  const customer = await env.DB.prepare(
    "SELECT id, name, email, status, external_ref, metadata_json, created_at, updated_at FROM customers WHERE id = ?",
  ).bind(customerId).first();
  if (customer === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  // NOTE: token_hmac / pepper_key_id are deliberately NEVER selected — operators see the
  // display prefix and scope/status only, never the keyed secret material.
  const [entitlements, tokens, licenses, orders, events] = await Promise.all([
    env.DB.prepare(
      "SELECT project, feature, license_fingerprint, status, valid_from, valid_until, revocation_seq, updated_at FROM entitlements WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 200",
    ).bind(customerId).all(),
    env.DB.prepare(
      "SELECT id, token_prefix, name, status, scopes_json, expires_at, last_used_at, created_at FROM account_tokens WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100",
    ).bind(customerId).all(),
    env.DB.prepare(
      "SELECT id, project, label, created_at, updated_at FROM licenses WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100",
    ).bind(customerId).all(),
    env.DB.prepare(
      "SELECT subscription_id, project, feature, license_fingerprint, last_seq, order_epoch, updated_at FROM orders WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 100",
    ).bind(customerId).all(),
    env.DB.prepare(
      "SELECT id, event_type, prev_status, next_status, actor, actor_type, reason, created_at FROM customer_events WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 50",
    ).bind(customerId).all(),
  ]);
  return envelope(requestIdValue, "customer", {
    customer,
    entitlements: entitlements.results,
    account_tokens: tokens.results,
    licenses: licenses.results,
    orders: orders.results,
    events: events.results,
  });
}

async function listLicenses(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const filters: string[] = [];
  const values: unknown[] = [];
  for (const [query, column] of [["project", "project"], ["customer_id", "customer_id"]] as const) {
    const value = url.searchParams.get(query);
    if (value !== null && value !== "") {
      filters.push(`${column} = ?`);
      values.push(value);
    }
  }
  const q = url.searchParams.get("q");
  if (q !== null && q !== "") {
    const like = likeContains(q);
    if (like === null) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    filters.push("(lower(id) LIKE ? ESCAPE '\\' OR lower(label) LIKE ? ESCAPE '\\')");
    values.push(like, like);
  }
  const { limit, cursor } = boundedCursor(url);
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  values.push(limit + 1, cursor);
  const rows = await env.DB.prepare(
    `SELECT id, customer_id, project, label, created_at, updated_at FROM licenses ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
  ).bind(...values).all();
  return envelope(requestIdValue, "licenses_listed", {
    items: rows.results.slice(0, limit),
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

async function listOrders(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  const staleSecs = Math.min(Math.max(Number(url.searchParams.get("stale_secs") ?? "300") || 300, 1), 86400);
  const filters: string[] = [];
  const values: unknown[] = [];
  const status = url.searchParams.get("status");
  if (status !== null && ["accepted", "processed", "superseded", "rejected"].includes(status)) {
    filters.push("status = ?");
    values.push(status);
  }
  const sub = url.searchParams.get("subscription_id");
  if (sub !== null && sub !== "") {
    filters.push("subscription_id = ?");
    values.push(sub);
  }
  const { limit, cursor } = boundedCursor(url);
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  values.push(limit + 1, cursor);
  const rows = await env.DB.prepare(
    `SELECT event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, status, received_at, processed_at FROM order_events ${where} ORDER BY received_at DESC, event_id LIMIT ? OFFSET ?`,
  ).bind(...values).all<Record<string, unknown>>();
  const items = rows.results.slice(0, limit).map((row) => ({
    ...row,
    stale: row.status === "accepted" && row.processed_at === null && Number(row.received_at) < now - staleSecs,
  }));
  const byStatus = await env.DB.prepare("SELECT status, COUNT(*) AS count FROM order_events GROUP BY status")
    .all<{ status: string; count: number }>();
  const stale = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM order_events WHERE status = 'accepted' AND processed_at IS NULL AND received_at < ?",
  ).bind(now - staleSecs).first<{ count: number }>();
  const fulfillmentSummary: Record<string, number> = { accepted: 0, processed: 0, superseded: 0, rejected: 0 };
  for (const row of byStatus.results) {
    fulfillmentSummary[row.status] = row.count;
  }
  fulfillmentSummary.stale_accepted = stale?.count ?? 0;
  return envelope(requestIdValue, "orders_listed", {
    items,
    summary: fulfillmentSummary,
    stale_secs: staleSecs,
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

async function report(env: Env, requestIdValue: string): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const count = async (sql: string, ...binds: unknown[]): Promise<number> =>
    (await env.DB.prepare(sql).bind(...binds).first<{ count: number }>())?.count ?? 0;
  const byStatus = await env.DB.prepare("SELECT status, COUNT(*) AS count FROM order_events GROUP BY status")
    .all<{ status: string; count: number }>();
  const orders: Record<string, number> = { accepted: 0, processed: 0, superseded: 0, rejected: 0 };
  for (const row of byStatus.results) {
    orders[row.status] = row.count;
  }
  return envelope(requestIdValue, "report", {
    generated_at: now,
    entitlements: {
      total: await count("SELECT COUNT(*) AS count FROM entitlements"),
      active: await count("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'active'"),
      revoked: await count("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'revoked'"),
      disabled: await count("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'disabled'"),
    },
    customers: {
      total: await count("SELECT COUNT(*) AS count FROM customers"),
      active: await count("SELECT COUNT(*) AS count FROM customers WHERE status = 'active'"),
      disabled: await count("SELECT COUNT(*) AS count FROM customers WHERE status = 'disabled'"),
    },
    account_tokens: {
      active: await count("SELECT COUNT(*) AS count FROM account_tokens WHERE status = 'active' AND expires_at > ?", now),
    },
    licenses: { total: await count("SELECT COUNT(*) AS count FROM licenses") },
    fulfillment: {
      ...orders,
      stale_accepted: await count(
        "SELECT COUNT(*) AS count FROM order_events WHERE status = 'accepted' AND processed_at IS NULL AND received_at < ?",
        now - 300,
      ),
      events_24h: await count("SELECT COUNT(*) AS count FROM order_events WHERE received_at >= ?", now - 86400),
      events_7d: await count("SELECT COUNT(*) AS count FROM order_events WHERE received_at >= ?", now - 604800),
    },
    customer_suspensions_7d: await count(
      "SELECT COUNT(*) AS count FROM customer_events WHERE event_type = 'disable' AND created_at >= ?",
      now - 604800,
    ),
  });
}

// Customer kill-switch (admin-only). Flipping customers.status to 'disabled' severs that customer's
// account-token auth (resolveAccountToken JOINs customers c ON c.status='active') and portal login.
// Atomic: the guarded UPDATE...RETURNING and the conditional audit INSERT commit in one batch.
async function handleCustomerTransition(
  request: Request,
  env: Env,
  actor: Actor,
  customerId: string,
  action: "disable" | "reenable",
  requestIdValue: string,
): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  if (customerId.length === 0 || customerId.length > 128) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const idempotencyKey = safeString(request.headers.get("idempotency-key"), 128);
  if (request.headers.has("idempotency-key") && idempotencyKey === null) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const body = await parseJsonBody(request, requestIdValue);
  if (body instanceof Response) {
    return body;
  }
  const reason = safeNotes((body as Record<string, unknown>).reason) ?? "";
  if (action === "disable" && reason === "") {
    return envelope(requestIdValue, "reason_required", undefined, 400);
  }
  const scope = `POST:/api/admin/customers/${action}:${actor.subject}`;
  const replay = await idempotentReplay(env, scope, idempotencyKey);
  if (replay !== null) {
    return replay;
  }
  const existing = await env.DB.prepare("SELECT status FROM customers WHERE id = ?").bind(customerId).first<{ status: string }>();
  if (existing === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  const expectedPrev = action === "disable" ? "active" : "disabled";
  const next = action === "disable" ? "disabled" : "active";
  if (existing.status !== expectedPrev) {
    return envelope(requestIdValue, "customer_status_conflict", { status: existing.status }, 409);
  }
  if (typeof env.DB.batch !== "function") {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  const now = Math.floor(Date.now() / 1000);
  let results: unknown[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE customers SET status = ?, updated_at = ? WHERE id = ? AND status = ? RETURNING id, name, email, status, external_ref, created_at, updated_at",
      ).bind(next, now, customerId, expectedPrev),
      env.DB.prepare(
        `INSERT INTO customer_events (customer_id, event_type, prev_status, next_status, actor, actor_type, source, reason, request_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, 'admin', ?, ?, ? WHERE EXISTS (SELECT 1 FROM customers WHERE id = ? AND status = ? AND updated_at = ?)`,
      ).bind(customerId, action, expectedPrev, next, actor.email, actor.actorType, reason, requestIdValue, now, customerId, next, now),
    ]);
  } catch {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  const updated = batchReturnedRow<Record<string, unknown>>(results[0]);
  if (updated === null) {
    // Lost the guarded race — status changed between the pre-read and the UPDATE.
    return envelope(requestIdValue, "customer_status_conflict", undefined, 409);
  }
  const responseBody = { ok: true, code: `customer_${action}d`, request_id: requestIdValue, data: updated };
  await rememberIdempotency(env, scope, idempotencyKey, responseBody, now);
  return json(responseBody);
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const id = requestId(request);
  const auth = await authenticate(request, env, id);
  if (auth instanceof Response) {
    return auth;
  }
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/admin/summary") {
    return summary(env, id);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/report") {
    return report(env, id);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/customers") {
    return listCustomers(request, env, id);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/licenses") {
    return listLicenses(request, env, id);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/orders") {
    return listOrders(request, env, id);
  }
  const customerAction = /^\/api\/admin\/customers\/([^/]+)\/(disable|reenable)$/.exec(url.pathname);
  if (request.method === "POST" && customerAction !== null) {
    return handleCustomerTransition(request, env, auth, decodeURIComponent(customerAction[1] ?? ""), customerAction[2] as "disable" | "reenable", id);
  }
  const customerDetail = /^\/api\/admin\/customers\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && customerDetail !== null) {
    return getCustomer(env, decodeURIComponent(customerDetail[1] ?? ""), id);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/settings") {
    return settings(env, id);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/entitlements") {
    return listEntitlements(request, env, id);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/events") {
    return listEvents(request, env, id);
  }
  const detail = /^\/api\/admin\/entitlements\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && detail !== null) {
    const key = decodeEntitlementId(detail[1] ?? "");
    if (key === null) {
      return envelope(id, "invalid_entitlement_id", undefined, 400);
    }
    const row = await findEntitlement(env, key);
    return row === null ? envelope(id, "not_found", undefined, 404) : envelope(id, "entitlement", row);
  }
  if (["POST", "PATCH"].includes(request.method)) {
    return handleMutation(request, env, auth, id);
  }
  return envelope(id, "not_found", undefined, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Unauthenticated API documentation, served EARLY (before auth) so the spec and
    // the human-readable reference are always reachable. These add no behavior to any
    // existing route — they only respond on /openapi.json and /docs.
    if (request.method === "GET" && url.pathname === "/openapi.json") {
      return new Response(openApiJson, { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (request.method === "GET" && url.pathname === "/docs") {
      return new Response(docsHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname.startsWith("/api/admin/")) {
      return handleApi(request, env);
    }
    if (url.pathname.startsWith("/api/sync/")) {
      return handleSync(request, env);
    }
    if (env.ASSETS !== undefined) {
      return env.ASSETS.fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
};

export const adminInternalsForTests = {
  entitlementId,
  decodeEntitlementId,
  validateEntitlementInput,
  validateEntitlementPatch,
};
