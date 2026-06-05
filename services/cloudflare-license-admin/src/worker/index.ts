import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import type { EntitlementInput, EntitlementPatch, EntitlementRecord, EntitlementStatus } from "../shared/api";

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch?(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
}

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
}

interface Actor {
  subject: string;
  email: string;
  role: "reader" | "admin";
  actorType: "access" | "dev";
}

interface MutationContext {
  requestId: string;
  actor: Actor;
  ip: string;
  idempotencyKey: string | null;
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

function entitlementId(project: string, feature: string, licenseFingerprint: string): string {
  const raw = JSON.stringify([project, feature, licenseFingerprint]);
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeEntitlementId(id: string): { project: string; feature: string; license_fingerprint: string } | null {
  try {
    const padded = id.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(id.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) {
      return null;
    }
    const [project, feature, licenseFingerprint] = parsed;
    if (typeof project !== "string" || typeof feature !== "string" || typeof licenseFingerprint !== "string") {
      return null;
    }
    return { project, feature, license_fingerprint: licenseFingerprint };
  } catch {
    return null;
  }
}

function withId(row: Omit<EntitlementRecord, "id"> & { cache_ttl_seconds?: number }): EntitlementRecord {
  const publicRow = { ...row };
  delete publicRow.cache_ttl_seconds;
  return {
    ...publicRow,
    id: entitlementId(row.project, row.feature, row.license_fingerprint),
  };
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const max = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < max; ++i) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  await crypto.subtle.digest("SHA-256", left);
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
  const notes = input.notes === undefined ? "" : safeString(input.notes, MAX_NOTES_SIZE);
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
  const notes = input.notes === undefined ? undefined : safeString(input.notes, MAX_NOTES_SIZE);
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

function entitlementSelectSql(where: string): string {
  return `SELECT project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, created_at, updated_at FROM entitlements ${where}`;
}

async function findEntitlement(env: Env, key: { project: string; feature: string; license_fingerprint: string }): Promise<EntitlementRecord | null> {
  const row = await env.DB.prepare(entitlementSelectSql("WHERE project = ? AND feature = ? AND license_fingerprint = ? LIMIT 1"))
    .bind(key.project, key.feature, key.license_fingerprint)
    .first<Omit<EntitlementRecord, "id">>();
  return row === null ? null : withId(row);
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

function eventFromCurrentStatement(
  env: Env,
  ctx: MutationContext,
  eventType: "create" | "update" | "disable" | "reenable" | "revoke",
  key: { project: string; feature: string; license_fingerprint: string },
  prev: EntitlementRecord | null,
  reason: string,
  now: number,
): D1PreparedStatementLike {
  return env.DB.prepare(
    `INSERT INTO entitlement_events (project, feature, license_fingerprint, device_hash, event_type, status, revocation_seq, detail, actor, actor_type, source, request_id, ip, prev_json, next_json, reason, idempotency_key, created_at)
     SELECT project, feature, license_fingerprint, device_hash, ?, status, revocation_seq, ?, ?, ?, 'admin', ?, ?, ?,
       json_object(
         'project', project,
         'feature', feature,
         'license_fingerprint', license_fingerprint,
         'device_hash', device_hash,
         'status', status,
         'assertion_ttl_seconds', assertion_ttl_seconds,
         'cache_ttl_seconds', cache_ttl_seconds,
         'revocation_seq', revocation_seq,
         'valid_from', valid_from,
         'valid_until', valid_until,
         'notes', notes,
         'customer_id', customer_id,
         'license_id', license_id,
         'created_at', created_at,
         'updated_at', updated_at,
         'id', ?
       ),
       ?, ?, ?
     FROM entitlements
     WHERE project = ? AND feature = ? AND license_fingerprint = ?`,
  ).bind(
    eventType,
    reason,
    ctx.actor.email || ctx.actor.subject,
    ctx.actor.actorType,
    ctx.requestId,
    ctx.ip,
    prev === null ? "" : JSON.stringify(prev),
    entitlementId(key.project, key.feature, key.license_fingerprint),
    reason,
    ctx.idempotencyKey,
    now,
    key.project,
    key.feature,
    key.license_fingerprint,
  );
}

function batchReturnedRow<T>(result: unknown): T | null {
  if (typeof result !== "object" || result === null || !("results" in result)) {
    return null;
  }
  const rows = (result as { results?: unknown }).results;
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  return rows[0] as T;
}

async function writeEntitlementWithAudit(
  env: Env,
  key: { project: string; feature: string; license_fingerprint: string },
  writeStatement: D1PreparedStatementLike,
  ctx: MutationContext,
  eventType: "create" | "update" | "disable" | "reenable" | "revoke",
  prev: EntitlementRecord | null,
  reason: string,
  now: number,
): Promise<EntitlementRecord> {
  if (env.DB.batch === undefined) {
    throw new Error("write_failed");
  }
  const results = await env.DB.batch([
    writeStatement,
    eventFromCurrentStatement(env, ctx, eventType, key, prev, reason, now),
  ]);
  const saved = batchReturnedRow<Omit<EntitlementRecord, "id">>(results[0]);
  if (saved === null) {
    throw new Error("write_failed");
  }
  return withId(saved);
}

async function createEntitlement(env: Env, input: EntitlementInput, ctx: MutationContext): Promise<EntitlementRecord> {
	const now = Math.floor(Date.now() / 1000);
	const prev = await findEntitlement(env, input);
	if (prev?.status === "revoked") {
		throw new Error("revoked_terminal");
	}
	const statement = env.DB.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(revocation_seq) + 1 FROM entitlement_events WHERE project = ? AND feature = ? AND license_fingerprint = ?), 1), ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project, feature, license_fingerprint) DO UPDATE SET device_hash = excluded.device_hash, status = excluded.status, assertion_ttl_seconds = excluded.assertion_ttl_seconds, cache_ttl_seconds = excluded.cache_ttl_seconds, revocation_seq = max(entitlements.revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events WHERE project = entitlements.project AND feature = entitlements.feature AND license_fingerprint = entitlements.license_fingerprint), entitlements.revocation_seq)) + 1, valid_from = excluded.valid_from, valid_until = excluded.valid_until, notes = excluded.notes, customer_id = excluded.customer_id, license_id = excluded.license_id, updated_at = excluded.updated_at RETURNING project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, created_at, updated_at",
  ).bind(
    input.project,
    input.feature,
    input.license_fingerprint,
    input.device_hash ?? "",
    input.status ?? "active",
    input.assertion_ttl_seconds ?? 300,
    input.assertion_ttl_seconds ?? 300,
    input.project,
    input.feature,
    input.license_fingerprint,
    input.valid_from ?? null,
    input.valid_until ?? null,
    input.notes ?? "",
    input.customer_id ?? null,
    input.license_id ?? null,
    prev?.created_at ?? now,
    now,
  );
  return writeEntitlementWithAudit(env, input, statement, ctx, prev === null ? "create" : "update", prev, "", now);
}

async function patchEntitlement(env: Env, key: { project: string; feature: string; license_fingerprint: string }, patch: EntitlementPatch, ctx: MutationContext): Promise<EntitlementRecord | null> {
  const prev = await findEntitlement(env, key);
  if (prev === null) {
    return null;
  }
  if (prev.status === "revoked") {
    throw new Error("revoked_terminal");
  }
  const assertionTtl = patch.assertion_ttl_seconds ?? prev.assertion_ttl_seconds;
  const validFrom = patch.valid_from !== undefined ? patch.valid_from : prev.valid_from;
  const validUntil = patch.valid_until !== undefined ? patch.valid_until : prev.valid_until;
  if (validFrom !== null && validUntil !== null && validFrom >= validUntil) {
    throw new Error("invalid_patch");
  }
	const now = Math.floor(Date.now() / 1000);
	const statement = env.DB.prepare(
    "UPDATE entitlements SET device_hash = ?, assertion_ttl_seconds = ?, cache_ttl_seconds = ?, revocation_seq = max(revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events WHERE project = entitlements.project AND feature = entitlements.feature AND license_fingerprint = entitlements.license_fingerprint), revocation_seq)) + 1, valid_from = ?, valid_until = ?, notes = ?, customer_id = ?, license_id = ?, updated_at = ? WHERE project = ? AND feature = ? AND license_fingerprint = ? RETURNING project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, created_at, updated_at",
  ).bind(
    patch.device_hash ?? prev.device_hash,
    assertionTtl,
    assertionTtl,
    validFrom,
    validUntil,
    patch.notes ?? prev.notes,
    patch.customer_id !== undefined ? patch.customer_id : prev.customer_id,
    patch.license_id !== undefined ? patch.license_id : prev.license_id,
    now,
    key.project,
    key.feature,
    key.license_fingerprint,
  );
  return writeEntitlementWithAudit(env, key, statement, ctx, "update", prev, "", now);
}

async function transitionEntitlement(env: Env, key: { project: string; feature: string; license_fingerprint: string }, status: EntitlementStatus, eventType: "disable" | "reenable" | "revoke", reason: string, ctx: MutationContext): Promise<EntitlementRecord | null> {
  const prev = await findEntitlement(env, key);
  if (prev === null) {
    return null;
  }
  if (prev.status === "revoked" && eventType !== "revoke") {
    throw new Error("revoked_terminal");
  }
  if (prev.status === status) {
    return prev;
  }
	const now = Math.floor(Date.now() / 1000);
  const statement = env.DB.prepare(
    "UPDATE entitlements SET status = ?, revocation_seq = max(revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events WHERE project = entitlements.project AND feature = entitlements.feature AND license_fingerprint = entitlements.license_fingerprint), revocation_seq)) + 1, updated_at = ? WHERE project = ? AND feature = ? AND license_fingerprint = ? RETURNING project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, created_at, updated_at",
  ).bind(status, now, key.project, key.feature, key.license_fingerprint);
  return writeEntitlementWithAudit(env, key, statement, ctx, eventType, prev, reason, now);
}

async function mutationResponse<T>(request: Request, env: Env, ctx: MutationContext, code: string, fn: () => Promise<T | null>): Promise<Response> {
  const scope = `${request.method}:${new URL(request.url).pathname}:${ctx.actor.subject}`;
  const replay = await idempotentReplay(env, scope, ctx.idempotencyKey);
  if (replay !== null) {
    return replay;
  }
  try {
    const result = await fn();
    if (result === null) {
      return envelope(ctx.requestId, "not_found", undefined, 404);
    }
    const body = { ok: true, code, request_id: ctx.requestId, data: result };
    await rememberIdempotency(env, scope, ctx.idempotencyKey, body, Math.floor(Date.now() / 1000));
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
    return mutationResponse(request, env, ctx, "entitlement_saved", () => createEntitlement(env, input, ctx));
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
    return mutationResponse(request, env, ctx, "entitlement_patched", () => patchEntitlement(env, key, patch, ctx));
  }
  if (request.method === "POST" && action !== undefined) {
    const reason = typeof (body as Record<string, unknown>).reason === "string"
      ? String((body as Record<string, unknown>).reason).slice(0, 1000)
      : "";
    if ((action === "disable" || action === "revoke") && reason === "") {
      return envelope(requestIdValue, "reason_required", undefined, 400);
    }
    const transition = action as "disable" | "reenable" | "revoke";
    const targetStatus = transition === "reenable" ? "active" : transition === "disable" ? "disabled" : "revoked";
    return mutationResponse(request, env, ctx, `entitlement_${action}d`, () =>
      transitionEntitlement(env, key, targetStatus, transition, reason, ctx));
  }
  return envelope(requestIdValue, "not_found", undefined, 404);
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
    if (url.pathname.startsWith("/api/admin/")) {
      return handleApi(request, env);
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
