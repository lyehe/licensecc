import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { openApiJson } from "./openapi.js";
import { docsHtml } from "./docs_page.js";
import type {
  EntitlementInput,
  EntitlementPatch,
  EntitlementRecord,
  EntitlementStatus,
  Policy,
  PolicyInput,
  PolicyPatch,
  PolicyType,
  ExpiryStrategy,
  TrialExpirationBasis,
  WebhookEndpoint,
  WebhookEndpointInput,
  WebhookEndpointPatch,
  TimeseriesBucket,
  ExpiringEntitlement,
} from "../shared/api";
import {
  entitlementId,
  decodeEntitlementId,
  withId,
  entitlementSelectSql,
  findEntitlement,
  createEntitlement,
  patchEntitlement,
  transitionEntitlement,
  transitionEntitlementDevice,
  listEntitlementDevices,
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
import { stampFromPolicy, buildPolicyStampStatement } from "@licensecc/cloudflare-licensing-backend/entitlements/policy";
import { verifyAuditChain } from "@licensecc/cloudflare-licensing-backend/audit/audit_digest";

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
  // off (default) | on. Always lets operators CRUD policy templates (managing rows is
  // harmless); gates only whether POST /api/admin/entitlements HONORS a policy_id.
  POLICY_STAMP_MODE?: string;
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const MAX_PROJECT_SIZE = 127;
const MAX_FEATURE_SIZE = 15;
const MAX_NOTES_SIZE = 1000;
const MAX_NAME_SIZE = 127;
const MAX_BODY_BYTES = 8192;
// A generous-but-bounded ceiling for the policy duration/offset/borrow integers
// (~100 years in seconds). Keeps validators from accepting absurd or overflow values.
const MAX_DURATION_SECONDS = 3_153_600_000;
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

// ── Policy validation (Stage 3) ──────────────────────────────────────────────
// A nullable bounded integer: undefined -> keep default; null -> SQL NULL; otherwise an
// integer in [min,max]. `undefined`-sentinel signals "invalid" (distinct from a valid null).
function nullableBoundedInt(value: unknown, min: number, max: number): number | null | typeof INVALID {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return INVALID;
  }
  return value;
}
const INVALID = Symbol("invalid");

const POLICY_TYPES: ReadonlyArray<PolicyType> = ["trial", "node_locked", "floating", "subscription"];
const EXPIRY_STRATEGIES: ReadonlyArray<ExpiryStrategy> = ["fixed_window", "non_expiring"];
const TRIAL_BASES: ReadonlyArray<TrialExpirationBasis> = ["from_issue", "from_first_activation", "from_first_use"];

// Resolve the per-policy default columns. Each is "undefined -> default; else validate".
// Returns null on ANY invalid field so the caller emits a single 400 invalid_request.
function readPolicyColumns(input: Record<string, unknown>): {
  valid_from_offset_sec: number | null;
  duration_sec: number | null;
  assertion_ttl_seconds: number;
  pool_size: number;
  max_active_devices: number;
  max_borrow_sec: number;
  expiry_strategy: ExpiryStrategy;
  trial_expiration_basis: TrialExpirationBasis;
  trial_duration_sec: number;
  trial_one_per_device: number;
  trial_require_device_proof: number;
} | null {
  const validFromOffset = input.valid_from_offset_sec === undefined ? null : nullableBoundedInt(input.valid_from_offset_sec, -MAX_DURATION_SECONDS, MAX_DURATION_SECONDS);
  const duration = input.duration_sec === undefined ? null : nullableBoundedInt(input.duration_sec, 0, MAX_DURATION_SECONDS);
  const assertionTtl = boundedInt(input.assertion_ttl_seconds ?? 300, 1, 3600);
  const poolSize = boundedInt(input.pool_size ?? 0, 0, 1_000_000);
  const maxActiveDevices = boundedInt(input.max_active_devices ?? 1, 0, 1_000_000);
  const maxBorrow = boundedInt(input.max_borrow_sec ?? 0, 0, MAX_DURATION_SECONDS);
  const expiryStrategy = input.expiry_strategy === undefined ? "fixed_window" : input.expiry_strategy;
  const trialBasis = input.trial_expiration_basis === undefined ? "from_issue" : input.trial_expiration_basis;
  const trialDuration = boundedInt(input.trial_duration_sec ?? 0, 0, MAX_DURATION_SECONDS);
  const trialOnePerDevice = boundedInt(input.trial_one_per_device ?? 0, 0, 1);
  const trialRequireProof = boundedInt(input.trial_require_device_proof ?? 0, 0, 1);
  if (
    validFromOffset === INVALID || duration === INVALID || assertionTtl === undefined ||
    poolSize === undefined || maxActiveDevices === undefined || maxBorrow === undefined ||
    !EXPIRY_STRATEGIES.includes(expiryStrategy as ExpiryStrategy) ||
    !TRIAL_BASES.includes(trialBasis as TrialExpirationBasis) ||
    trialDuration === undefined || trialOnePerDevice === undefined || trialRequireProof === undefined
  ) {
    return null;
  }
  return {
    valid_from_offset_sec: validFromOffset,
    duration_sec: duration,
    assertion_ttl_seconds: assertionTtl,
    pool_size: poolSize,
    max_active_devices: maxActiveDevices,
    max_borrow_sec: maxBorrow,
    expiry_strategy: expiryStrategy as ExpiryStrategy,
    trial_expiration_basis: trialBasis as TrialExpirationBasis,
    trial_duration_sec: trialDuration,
    trial_one_per_device: trialOnePerDevice,
    trial_require_device_proof: trialRequireProof,
  };
}

function validatePolicyInput(value: unknown): PolicyInput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const project = safeString(input.project, MAX_PROJECT_SIZE);
  const name = safeString(input.name, MAX_NAME_SIZE);
  const type = input.type;
  const notes = input.notes === undefined ? "" : safeNotes(input.notes);
  const columns = readPolicyColumns(input);
  if (
    project === null || name === null || !POLICY_TYPES.includes(type as PolicyType) ||
    notes === null || columns === null
  ) {
    return null;
  }
  return { project, name, type: type as PolicyType, notes, ...columns };
}

function validatePolicyPatch(value: unknown): PolicyPatch | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  // project/name/type/status are NOT patchable — reject if present so callers can't
  // believe they changed identity or flipped status outside disable/reenable.
  if (input.project !== undefined || input.name !== undefined || input.type !== undefined || input.status !== undefined) {
    return null;
  }
  const patch: PolicyPatch = {};
  if (input.valid_from_offset_sec !== undefined) {
    const v = nullableBoundedInt(input.valid_from_offset_sec, -MAX_DURATION_SECONDS, MAX_DURATION_SECONDS);
    if (v === INVALID) return null;
    patch.valid_from_offset_sec = v;
  }
  if (input.duration_sec !== undefined) {
    const v = nullableBoundedInt(input.duration_sec, 0, MAX_DURATION_SECONDS);
    if (v === INVALID) return null;
    patch.duration_sec = v;
  }
  for (const [field, min, max] of [
    ["assertion_ttl_seconds", 1, 3600],
    ["pool_size", 0, 1_000_000],
    ["max_active_devices", 0, 1_000_000],
    ["max_borrow_sec", 0, MAX_DURATION_SECONDS],
    ["trial_duration_sec", 0, MAX_DURATION_SECONDS],
    ["trial_one_per_device", 0, 1],
    ["trial_require_device_proof", 0, 1],
  ] as const) {
    if (input[field] !== undefined) {
      const v = boundedInt(input[field], min, max);
      if (v === undefined) return null;
      patch[field] = v;
    }
  }
  if (input.expiry_strategy !== undefined) {
    if (!EXPIRY_STRATEGIES.includes(input.expiry_strategy as ExpiryStrategy)) return null;
    patch.expiry_strategy = input.expiry_strategy as ExpiryStrategy;
  }
  if (input.trial_expiration_basis !== undefined) {
    if (!TRIAL_BASES.includes(input.trial_expiration_basis as TrialExpirationBasis)) return null;
    patch.trial_expiration_basis = input.trial_expiration_basis as TrialExpirationBasis;
  }
  if (input.notes !== undefined) {
    const notes = safeNotes(input.notes);
    if (notes === null) return null;
    patch.notes = notes;
  }
  return patch;
}

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
function validateWebhookInput(value: unknown): WebhookEndpointInput | "invalid_url" | null {
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
  if (url === INVALID) {
    return "invalid_url";
  }
  return { url, event_types: eventTypes, description, scope_project: scopeProject, scope_customer_id: scopeCustomer };
}

// Validate a patch body. Only url / event_types / description are mutable; status / id /
// timestamps are NOT patchable (reject if present). All fields optional. A present-but-bad
// url returns "invalid_url"; any other invalid field returns null.
function validateWebhookPatch(value: unknown): WebhookEndpointPatch | "invalid_url" | null {
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
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 100);
  const cursor = Math.max(Number(url.searchParams.get("cursor") ?? "0") || 0, 0);
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

async function listEvents(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const eventColumns = "id, project, feature, license_fingerprint, event_type, status, revocation_seq, actor, actor_type, source, request_id, reason, created_at";
  if (wantsCsv(url)) {
    // CSV export: same ORDER BY, bounded by the CSV cap (the `limit` page size does not apply).
    const csvRows = await env.DB.prepare(
      `SELECT ${eventColumns} FROM entitlement_events ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(CSV_ROW_CAP).all<Record<string, unknown>>();
    return csvResponse(
      "events.csv",
      ["id", "project", "feature", "license_fingerprint", "event_type", "status", "revocation_seq", "actor", "actor_type", "source", "request_id", "reason", "created_at"],
      csvRows.results,
    );
  }
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 100);
  const rows = await env.DB.prepare(
    `SELECT ${eventColumns} FROM entitlement_events ORDER BY created_at DESC, id DESC LIMIT ?`,
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
    if (error instanceof Error && error.message === "device_not_found") {
      return envelope(ctx.requestId, "device_not_found", undefined, 404);
    }
    if (error instanceof Error && error.message === "device_revoked_terminal") {
      return envelope(ctx.requestId, "device_is_terminal", undefined, 409);
    }
    return envelope(ctx.requestId, "mutation_failed", undefined, 500);
  }
}

// Create an entitlement by STAMPING a policy (POST /api/admin/entitlements with a policy_id).
// Gated by POLICY_STAMP_MODE: off (default) rejects 400 policy_stamping_disabled; on stamps.
// The policy must exist and be status=active (else 404 policy_not_found). stampFromPolicy yields
// the EXACT EntitlementInput createEntitlement already writes byte-identically PLUS the capacity +
// frozen-trial side-state, which rides createEntitlement's extraStatements seam to land in the SAME
// atomic batch as the INSERT. The body's target tuple + any per-field overrides flow through `overrides`.
async function createFromPolicy(request: Request, env: Env, ctx: MutationContext, body: unknown, requestIdValue: string): Promise<Response> {
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

// ── Workstream C BACKEND: CSV export, global search, bulk transitions ─────────
// CSV export rides ?format=csv on the EXISTING list routes (no new routes, so the
// OpenAPI cross-check is undisturbed). Global search and bulk transitions are the
// only TWO new routes. Design: admin Worker conventions in CLAUDE.md (Slice 4 +
// entitlement transitions are the closest existing patterns).

// Hard ceiling on a single CSV export. A list endpoint with ?format=csv streams up to
// this many rows (the SAME filters as the JSON list), then appends a trailing comment row
// noting the cap so an operator can tell a truncated export from a complete one.
const CSV_ROW_CAP = 10000;
// Cap on the number of ids a single bulk transition may carry (over -> 400 too_many).
const BATCH_MAX_IDS = 100;
// Per-type fan-out cap for global search (bounded so no single type floods the result).
const SEARCH_PER_TYPE_LIMIT = 10;

// CSV-escape one field: stringify, then quote + double any embedded quote. null/undefined
// render as the empty string. Always quoted so commas/newlines/quotes in data are inert.
function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

// Render header + rows (each a record keyed by `columns`) as a CSV body, then append a
// trailing comment row when the export hit the cap so truncation is visible to the reader.
function toCsv(columns: ReadonlyArray<string>, rows: ReadonlyArray<Record<string, unknown>>, capped: boolean): string {
  const lines = [columns.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvField(row[column])).join(","));
  }
  if (capped) {
    lines.push(csvField(`# export truncated at the ${CSV_ROW_CAP}-row cap; narrow your filters for the full set`));
  }
  return `${lines.join("\r\n")}\r\n`;
}

// Build the streaming text/csv Response with an attachment Content-Disposition.
function csvResponse(filename: string, columns: ReadonlyArray<string>, rows: ReadonlyArray<Record<string, unknown>>): Response {
  const capped = rows.length >= CSV_ROW_CAP;
  return new Response(toCsv(columns, rows.slice(0, CSV_ROW_CAP), capped), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

function wantsCsv(url: URL): boolean {
  return url.searchParams.get("format") === "csv";
}

// Turn a user search term into a PREFIX LIKE pattern (`q%`), escaping the wildcards so the
// literal term anchors at the start. Used for the hex license_fingerprint prefix search.
function likePrefix(value: unknown): string | null {
  const term = safeString(value, 128);
  if (term === null) {
    return null;
  }
  return `${term.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
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
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  const projection =
    `SELECT c.id, c.name, c.email, c.status, c.external_ref, c.created_at, c.updated_at,
       (SELECT COUNT(*) FROM entitlements e WHERE e.customer_id = c.id) AS entitlement_count,
       (SELECT COUNT(*) FROM entitlements e WHERE e.customer_id = c.id AND e.status = 'active') AS active_entitlement_count
     FROM customers c ${where}`;
  if (wantsCsv(url)) {
    const csvRows = await env.DB.prepare(`${projection} ORDER BY c.updated_at DESC, c.id LIMIT ?`)
      .bind(...values, CSV_ROW_CAP).all<Record<string, unknown>>();
    return csvResponse(
      "customers.csv",
      ["id", "name", "email", "status", "external_ref", "entitlement_count", "active_entitlement_count", "created_at", "updated_at"],
      csvRows.results,
    );
  }
  const { limit, cursor } = boundedCursor(url);
  values.push(limit + 1, cursor);
  const rows = await env.DB.prepare(`${projection} ORDER BY c.updated_at DESC, c.id LIMIT ? OFFSET ?`)
    .bind(...values).all();
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

// ── Bulk entitlement transitions (Workstream C) ──────────────────────────────
// POST /api/admin/entitlements/batch — admin-only. Body { action, reason, ids[] }.
// Composes the SHARED transitionEntitlement once per id; one bad row never aborts the
// others (per-row success/failure is collected). createEntitlement is NOT touched.
//
// FOOTGUN guarded here: mutation_idempotency is keyed by (scope, idempotency_key). If every
// row reused the SAME idempotency key, the FIRST row's cached response would be replayed for
// every subsequent row (mergeable only by accident). So each row gets a DISTINCT sub-key
// `<base>:<id>` derived from the request's Idempotency-Key (or a generated batch id), and the
// scope mirrors the single mutations (METHOD:pathname:actor.subject) so a re-POST of the same
// batch with the same Idempotency-Key replays each row's OWN cached response — not row #1's.
async function handleBatchTransition(request: Request, env: Env, actor: Actor, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const headerKey = safeString(request.headers.get("idempotency-key"), 128);
  if (request.headers.has("idempotency-key") && headerKey === null) {
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
    const replay = await idempotentReplay(env, scope, rowKey);
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
        await rememberIdempotency(env, scope, rowKey, rowBody, Math.floor(Date.now() / 1000));
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
async function globalSearch(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const rawQ = url.searchParams.get("q");
  if (rawQ === null || rawQ === "") {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const like = likeContains(rawQ);
  const prefix = likePrefix(rawQ);
  if (like === null || prefix === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const perType = Math.min(Number(url.searchParams.get("limit") ?? String(SEARCH_PER_TYPE_LIMIT)) || SEARCH_PER_TYPE_LIMIT, SEARCH_PER_TYPE_LIMIT);
  const [customers, licenses, entitlements, orders] = await Promise.all([
    env.DB.prepare(
      "SELECT id, name, email, external_ref, status FROM customers WHERE lower(id) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\' OR lower(external_ref) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, id LIMIT ?",
    ).bind(like, like, like, like, perType).all<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT id, project, label, customer_id FROM licenses WHERE lower(id) LIKE ? ESCAPE '\\' OR lower(label) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, id LIMIT ?",
    ).bind(like, like, perType).all<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT project, feature, license_fingerprint, status, customer_id FROM entitlements WHERE license_fingerprint LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?",
    ).bind(prefix, perType).all<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT subscription_id, project, feature, license_fingerprint, customer_id FROM orders WHERE lower(subscription_id) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?",
    ).bind(like, perType).all<Record<string, unknown>>(),
  ]);
  const results: Array<Record<string, unknown>> = [];
  for (const row of customers.results) {
    results.push({ type: "customer", id: row.id, label: row.name, email: row.email, status: row.status, external_ref: row.external_ref });
  }
  for (const row of licenses.results) {
    results.push({ type: "license", id: row.id, label: row.label, project: row.project, customer_id: row.customer_id });
  }
  for (const row of entitlements.results) {
    const id = entitlementId(String(row.project), String(row.feature), String(row.license_fingerprint));
    results.push({ type: "entitlement", id, label: row.license_fingerprint, project: row.project, feature: row.feature, status: row.status, customer_id: row.customer_id });
  }
  for (const row of orders.results) {
    results.push({ type: "order", id: row.subscription_id, label: row.subscription_id, project: row.project, feature: row.feature, license_fingerprint: row.license_fingerprint, customer_id: row.customer_id });
  }
  return envelope(requestIdValue, "search_results", { results });
}

// ── License-policy templates (Stage 3) ───────────────────────────────────────
// CRUD over entitlement_policies. Reads are reader+admin; writes require requireAdmin.
// Each write (create/patch/disable/reenable) commits the row mutation + a policy_events
// audit row in ONE atomic batch, mirroring the customer kill-switch's guarded-UPDATE+audit
// shape. Policy CRUD is ALWAYS available regardless of POLICY_STAMP_MODE — managing template
// rows is harmless; the mode only gates whether a create HONORS a policy_id.

// The full policy column projection, in storage order — every policy SELECT/RETURNING renders these.
const POLICY_COLUMNS =
  "id, project, name, type, status, valid_from_offset_sec, duration_sec, assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, expiry_strategy, trial_expiration_basis, trial_duration_sec, trial_one_per_device, trial_require_device_proof, notes, created_at, updated_at";

function policyStampOn(env: Env): boolean {
  return env.POLICY_STAMP_MODE === "on";
}

async function findPolicy(env: Env, policyId: string): Promise<Policy | null> {
  return env.DB.prepare(`SELECT ${POLICY_COLUMNS} FROM entitlement_policies WHERE id = ? LIMIT 1`)
    .bind(policyId)
    .first<Policy>();
}

async function listPolicies(request: Request, env: Env, requestIdValue: string): Promise<Response> {
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
  const { limit, cursor } = boundedCursor(url);
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

async function getPolicy(env: Env, policyId: string, requestIdValue: string): Promise<Response> {
  const policy = await findPolicy(env, policyId);
  return policy === null ? envelope(requestIdValue, "not_found", undefined, 404) : envelope(requestIdValue, "policy", policy);
}

// Shared atomic write: INSERT/UPDATE the policy row + INSERT a policy_events audit row in one
// batch, returning the persisted row. `eventType` is the audit verb; `reason` the audit reason.
async function writePolicyWithAudit(
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
  const auditStatement = env.DB.prepare(
    `INSERT INTO policy_events (policy_id, project, event_type, actor, actor_type, source, reason, request_id, prev_json, next_json, created_at)
     SELECT ?, ?, ?, ?, ?, 'admin', ?, ?, '', json_object(${POLICY_COLUMNS.split(", ").map((c) => `'${c}', ${c}`).join(", ")}), ?
     FROM entitlement_policies WHERE id = ?`,
  ).bind(policyId, project, eventType, actor.email || actor.subject, actor.actorType, reason, requestIdValue, now, policyId);
  const results = await env.DB.batch([policyStatement, auditStatement]);
  return batchReturnedRow<Record<string, unknown>>(results[0]);
}

async function handlePolicyCreate(request: Request, env: Env, actor: Actor, body: unknown, requestIdValue: string): Promise<Response> {
  const input = validatePolicyInput(body);
  if (input === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const idempotencyKey = safeString(request.headers.get("idempotency-key"), 128);
  if (request.headers.has("idempotency-key") && idempotencyKey === null) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const scope = `POST:/api/admin/policies:${actor.subject}`;
  const replay = await idempotentReplay(env, scope, idempotencyKey);
  if (replay !== null) {
    return replay;
  }
  if (typeof env.DB.batch !== "function") {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const insert = env.DB.prepare(
    `INSERT INTO entitlement_policies (id, project, name, type, status, valid_from_offset_sec, duration_sec, assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, expiry_strategy, trial_expiration_basis, trial_duration_sec, trial_one_per_device, trial_require_device_proof, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${POLICY_COLUMNS}`,
  ).bind(
    id, input.project, input.name, input.type,
    input.valid_from_offset_sec ?? null, input.duration_sec ?? null, input.assertion_ttl_seconds ?? 300,
    input.pool_size ?? 0, input.max_active_devices ?? 1, input.max_borrow_sec ?? 0,
    input.expiry_strategy ?? "fixed_window", input.trial_expiration_basis ?? "from_issue",
    input.trial_duration_sec ?? 0, input.trial_one_per_device ?? 0, input.trial_require_device_proof ?? 0,
    input.notes ?? "", now, now,
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
  const responseBody = { ok: true, code: "policy_created", request_id: requestIdValue, data: row };
  await rememberIdempotency(env, scope, idempotencyKey, responseBody, now);
  return json(responseBody);
}

async function handlePolicyPatch(request: Request, env: Env, actor: Actor, policyId: string, body: unknown, requestIdValue: string): Promise<Response> {
  const patch = validatePolicyPatch(body);
  if (patch === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const idempotencyKey = safeString(request.headers.get("idempotency-key"), 128);
  if (request.headers.has("idempotency-key") && idempotencyKey === null) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const scope = `PATCH:/api/admin/policies/:id:${actor.subject}`;
  const replay = await idempotentReplay(env, scope, idempotencyKey);
  if (replay !== null) {
    return replay;
  }
  const existing = await findPolicy(env, policyId);
  if (existing === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  if (typeof env.DB.batch !== "function") {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const field of [
    "valid_from_offset_sec", "duration_sec", "assertion_ttl_seconds", "pool_size", "max_active_devices",
    "max_borrow_sec", "expiry_strategy", "trial_expiration_basis", "trial_duration_sec", "trial_one_per_device",
    "trial_require_device_proof", "notes",
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
  const responseBody = { ok: true, code: "policy_patched", request_id: requestIdValue, data: row };
  await rememberIdempotency(env, scope, idempotencyKey, responseBody, now);
  return json(responseBody);
}

// Policy disable/reenable kill-switch: a guarded UPDATE (status flips only from the expected
// prior status) + an audit row, atomic. Disabling a policy only blocks NEW stamps; it never
// retro-mutates already-stamped entitlements (those are frozen copies).
async function handlePolicyTransition(request: Request, env: Env, actor: Actor, policyId: string, action: "disable" | "reenable", body: unknown, requestIdValue: string): Promise<Response> {
  const reason = safeNotes((body as Record<string, unknown>).reason) ?? "";
  if (action === "disable" && reason === "") {
    return envelope(requestIdValue, "reason_required", undefined, 400);
  }
  const idempotencyKey = safeString(request.headers.get("idempotency-key"), 128);
  if (request.headers.has("idempotency-key") && idempotencyKey === null) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const scope = `POST:/api/admin/policies/${action}:${actor.subject}`;
  const replay = await idempotentReplay(env, scope, idempotencyKey);
  if (replay !== null) {
    return replay;
  }
  const existing = await findPolicy(env, policyId);
  if (existing === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  const expectedPrev = action === "disable" ? "active" : "disabled";
  const next = action === "disable" ? "disabled" : "active";
  if (existing.status !== expectedPrev) {
    return envelope(requestIdValue, "policy_status_conflict", { status: existing.status }, 409);
  }
  if (typeof env.DB.batch !== "function") {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  const now = Math.floor(Date.now() / 1000);
  const update = env.DB.prepare(
    `UPDATE entitlement_policies SET status = ?, updated_at = ? WHERE id = ? AND status = ? RETURNING ${POLICY_COLUMNS}`,
  ).bind(next, now, policyId, expectedPrev);
  let row: Record<string, unknown> | null;
  try {
    row = await writePolicyWithAudit(env, update, policyId, existing.project, action, reason, actor, requestIdValue, now);
  } catch {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  if (row === null) {
    // Lost the guarded race — status changed between the pre-read and the UPDATE.
    return envelope(requestIdValue, "policy_status_conflict", undefined, 409);
  }
  const responseBody = { ok: true, code: `policy_${action}d`, request_id: requestIdValue, data: row };
  await rememberIdempotency(env, scope, idempotencyKey, responseBody, now);
  return json(responseBody);
}

// Dispatch the policy writes (POST create, PATCH :id, POST :id/disable|reenable). All require
// the admin role (requireAdmin) so reader RBAC blocks every write.
async function handlePolicyMutation(request: Request, env: Env, actor: Actor, requestIdValue: string): Promise<Response> {
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

// ── Webhook endpoint CRUD + delivery status view (migration 0020) ─────────────
// CRUD over webhook_endpoints (the dispatcher's config rows) + a read/redrive view over
// webhook_deliveries (the cron-drained outbox). Reads are reader+admin; writes require
// requireAdmin. The signing secret is NEVER stored or surfaced here — it lives only in the
// Worker-env WEBHOOK_SIGNING_SECRETS map. There is no webhook audit table, so create/patch/
// disable/reenable are single-statement RETURNING mutations (idempotent), NOT a write+audit
// batch (audit "where applicable" — it is not applicable to a config row with no event log).

const WEBHOOK_ENDPOINT_COLUMNS =
  "id, url, event_types, status, description, created_at, updated_at, scope_project, scope_customer_id";
const WEBHOOK_DELIVERY_COLUMNS =
  "id, endpoint_id, event_source, event_id, event_type, status, attempts, last_status, last_error, next_attempt_at, created_at, delivered_at";

async function findWebhookEndpoint(env: Env, endpointId: string): Promise<WebhookEndpoint | null> {
  return env.DB.prepare(`SELECT ${WEBHOOK_ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE id = ? LIMIT 1`)
    .bind(endpointId)
    .first<WebhookEndpoint>();
}

async function listWebhooks(request: Request, env: Env, requestIdValue: string): Promise<Response> {
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

async function getWebhook(env: Env, endpointId: string, requestIdValue: string): Promise<Response> {
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
async function listWebhookDeliveries(request: Request, env: Env, requestIdValue: string): Promise<Response> {
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
  const idempotencyKey = safeString(request.headers.get("idempotency-key"), 128);
  if (request.headers.has("idempotency-key") && idempotencyKey === null) {
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
  const idempotencyKey = safeString(request.headers.get("idempotency-key"), 128);
  if (request.headers.has("idempotency-key") && idempotencyKey === null) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const scope = `PATCH:/api/admin/webhooks/:id:${actor.subject}`;
  const replay = await idempotentReplay(env, scope, idempotencyKey);
  if (replay !== null) {
    return replay;
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
  const idempotencyKey = safeString(request.headers.get("idempotency-key"), 128);
  if (request.headers.has("idempotency-key") && idempotencyKey === null) {
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
  const idempotencyKey = safeString(request.headers.get("idempotency-key"), 128);
  if (request.headers.has("idempotency-key") && idempotencyKey === null) {
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
async function handleWebhookMutation(request: Request, env: Env, actor: Actor, requestIdValue: string): Promise<Response> {
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
function epochParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// GET /api/admin/report/timeseries?from=&to=&buckets= (reader+admin). Bucket [from,to] into N
// equal buckets and aggregate, per bucket, usage_events (checkout/release+reclaim/denied by ts)
// and order_events (fulfillment_events by received_at) in a SINGLE-PASS GROUP BY over a computed
// bucket index. The bucket index is CAST((ts - from) * buckets / span) clamped to [0, buckets-1];
// the time window itself bounds the scan (indexed on ts / received_at).
async function reportTimeseries(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  const to = epochParam(url, "to") ?? now;
  const from = epochParam(url, "from") ?? to - TIMESERIES_DEFAULT_WINDOW_SECS;
  // A non-positive window is a client error: there is nothing to bucket.
  if (from >= to) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const buckets = Math.min(
    Math.max(Number(url.searchParams.get("buckets") ?? String(TIMESERIES_DEFAULT_BUCKETS)) || TIMESERIES_DEFAULT_BUCKETS, 1),
    TIMESERIES_MAX_BUCKETS,
  );
  const span = to - from;
  // bucket_seconds is the nominal width; the LAST bucket absorbs any integer remainder so the
  // window is fully covered (the clamp on the computed index keeps a ts == to inside bucket N-1).
  const bucketSeconds = Math.max(1, Math.floor(span / buckets));

  // The computed bucket index, shared by both aggregations. (? = from, ? = buckets, ? = span).
  // CAST(... AS INTEGER) truncates toward zero; MIN(..., buckets-1) clamps the right edge so a
  // row exactly at `to` (or any half-open boundary rounding) lands in the final bucket, never N.
  const bucketIndexExpr = (tsColumn: string): string =>
    `MIN(CAST((${tsColumn} - ?) * ? / ? AS INTEGER), ?)`;

  // Usage events: one GROUP BY over the window, counting each event_type per bucket.
  const usageRows = await env.DB.prepare(
    `SELECT ${bucketIndexExpr("ts")} AS bucket,
       SUM(CASE WHEN event_type = 'checkout' THEN 1 ELSE 0 END) AS checkouts,
       SUM(CASE WHEN event_type IN ('release', 'reclaim') THEN 1 ELSE 0 END) AS releases,
       SUM(CASE WHEN event_type = 'denied' THEN 1 ELSE 0 END) AS denials
     FROM usage_events WHERE ts >= ? AND ts < ? GROUP BY bucket`,
  ).bind(from, buckets, span, buckets - 1, from, to).all<{ bucket: number; checkouts: number; releases: number; denials: number }>();

  // Fulfillment events: order_events bucketed by received_at over the same window.
  const orderRows = await env.DB.prepare(
    `SELECT ${bucketIndexExpr("received_at")} AS bucket, COUNT(*) AS fulfillment_events
     FROM order_events WHERE received_at >= ? AND received_at < ? GROUP BY bucket`,
  ).bind(from, buckets, span, buckets - 1, from, to).all<{ bucket: number; fulfillment_events: number }>();

  // Dense the sparse GROUP BY results into a fixed [0..buckets-1] array (zero-filled gaps).
  const out: TimeseriesBucket[] = [];
  for (let i = 0; i < buckets; ++i) {
    out.push({ start: from + i * bucketSeconds, checkouts: 0, releases: 0, denials: 0, denial_rate: 0, fulfillment_events: 0 });
  }
  for (const row of usageRows.results) {
    const bucket = out[row.bucket];
    if (bucket === undefined) {
      continue;
    }
    bucket.checkouts = Number(row.checkouts) || 0;
    bucket.releases = Number(row.releases) || 0;
    bucket.denials = Number(row.denials) || 0;
    const attempts = bucket.checkouts + bucket.denials;
    // denial_rate = denials / (checkouts + denials); 0 when the bucket saw no attempts. Mirrors
    // usage_report.mjs (denials / checkout-attempts is the upsell signal).
    bucket.denial_rate = attempts === 0 ? 0 : bucket.denials / attempts;
  }
  for (const row of orderRows.results) {
    const bucket = out[row.bucket];
    if (bucket !== undefined) {
      bucket.fulfillment_events = Number(row.fulfillment_events) || 0;
    }
  }
  return envelope(requestIdValue, "report_timeseries", { from, to, bucket_seconds: bucketSeconds, buckets: out });
}

// GET /api/admin/report/expiring?within_days=&limit=&cursor= (reader+admin). Active entitlements
// whose valid_until is in the open window (now, now + within_days*86400], ordered soonest-first,
// cursor-paginated. days_left is ceil((valid_until - now)/86400) so a row expiring in <1 day still
// reports 1, never 0.
// GET /api/admin/audit/verify (reader+admin). Replays the tamper-evident hash chain over
// entitlement_events (audit R6.4) and reports whether it verifies. status 200 = the check ran; the
// tamper signal is data.audit_chain.ok (false + brokenAt/reason when a covered event was altered/deleted).
async function auditVerify(env: Env, requestIdValue: string): Promise<Response> {
  try {
    const result = await verifyAuditChain(env);
    return envelope(requestIdValue, result.ok ? "audit_chain_ok" : "audit_chain_broken", { audit_chain: result }, 200);
  } catch {
    return envelope(requestIdValue, "audit_verify_failed", undefined, 503);
  }
}

async function reportExpiring(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  const withinDays = Math.min(
    Math.max(Number(url.searchParams.get("within_days") ?? String(EXPIRING_DEFAULT_WITHIN_DAYS)) || EXPIRING_DEFAULT_WITHIN_DAYS, 1),
    EXPIRING_MAX_WITHIN_DAYS,
  );
  const horizon = now + withinDays * SECONDS_PER_DAY;
  const { limit, cursor } = boundedCursor(url);
  const rows = await env.DB.prepare(
    `SELECT project, feature, license_fingerprint, customer_id, valid_until
       FROM entitlements
      WHERE status = 'active' AND valid_until IS NOT NULL AND valid_until > ? AND valid_until <= ?
      ORDER BY valid_until ASC, project, feature, license_fingerprint
      LIMIT ? OFFSET ?`,
  ).bind(now, horizon, limit + 1, cursor).all<Omit<ExpiringEntitlement, "days_left">>();
  const items: ExpiringEntitlement[] = rows.results.slice(0, limit).map((row) => ({
    project: row.project,
    feature: row.feature,
    license_fingerprint: row.license_fingerprint,
    customer_id: row.customer_id ?? null,
    valid_until: row.valid_until,
    days_left: Math.max(1, Math.ceil((row.valid_until - now) / SECONDS_PER_DAY)),
  }));
  return envelope(requestIdValue, "report_expiring", {
    items,
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

// POST /api/admin/entitlements/:id/release-seats (ADMIN-ONLY, reason REQUIRED). The operator lever
// for "a seat is stuck on a dead machine": atomically DELETE the LIVE seat_checkouts (heartbeat_deadline
// > now) for the entitlement tuple RETURNING seat_id, and INSERT one 'reclaim' usage_events row per
// reclaimed seat (reason='force_release') in the SAME batch — mirroring the backend's reclaim discipline
// so peak_concurrent stays accurate. 0 released is a valid idempotent {ok:true}. Idempotency-Key supported.
async function handleReleaseSeats(request: Request, env: Env, actor: Actor, encodedId: string, requestIdValue: string): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const key = decodeEntitlementId(encodedId);
  if (key === null) {
    return envelope(requestIdValue, "invalid_entitlement_id", undefined, 400);
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
  if (reason === "") {
    return envelope(requestIdValue, "reason_required", undefined, 400);
  }
  const scope = `POST:/api/admin/entitlements/release-seats:${actor.subject}`;
  const replay = await idempotentReplay(env, scope, idempotencyKey);
  if (replay !== null) {
    return replay;
  }
  if (typeof env.DB.batch !== "function") {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  const now = Math.floor(Date.now() / 1000);
  // First, learn which LIVE seats we will reclaim (a SELECT scoped to the tuple, heartbeat_deadline
  // > now). We then DELETE exactly those seat_ids and write a matching 'reclaim' row for each in ONE
  // atomic batch — the DELETE re-guards heartbeat_deadline > now so a seat that lapsed/renewed between
  // the read and the batch is consistently handled (the reclaim rows are built from the DELETE's
  // RETURNING set in the live-seat-count path; here we mirror it via the pre-read + guarded DELETE).
  const live = await env.DB.prepare(
    "SELECT seat_id FROM seat_checkouts WHERE project = ? AND feature = ? AND license_fingerprint = ? AND heartbeat_deadline > ? ORDER BY seat_id",
  ).bind(key.project, key.feature, key.license_fingerprint, now).all<{ seat_id: string }>();
  const seatIds = live.results.map((row) => row.seat_id);
  if (seatIds.length === 0) {
    // Idempotent no-op: nothing live to reclaim. Still a success (the dead machine left no live seat,
    // or a prior release already swept them). Record under the idempotency key so a replay is stable.
    const responseBody = { ok: true, code: "seats_released", request_id: requestIdValue, data: { released: 0, seat_ids: [] } };
    await rememberIdempotency(env, scope, idempotencyKey, responseBody, now);
    return json(responseBody);
  }
  // Atomic batch: a guarded DELETE RETURNING the reclaimed seat_ids, then one best-effort-shaped
  // 'reclaim' usage_events INSERT per seat (device_key_id NULL, reason='force_release', ts=now) —
  // identical column discipline to the backend's quantity-downgrade reclaim, so the usage analytics
  // and peak_concurrent sweep stay accurate.
  const statements = [
    env.DB.prepare(
      "DELETE FROM seat_checkouts WHERE project = ? AND feature = ? AND license_fingerprint = ? AND heartbeat_deadline > ? RETURNING seat_id",
    ).bind(key.project, key.feature, key.license_fingerprint, now),
    ...seatIds.map((seat) =>
      env.DB.prepare(
        "INSERT INTO usage_events (project, feature, license_fingerprint, event_type, seat_id, device_key_id, reason, ts) VALUES (?, ?, ?, 'reclaim', ?, NULL, 'force_release', ?)",
      ).bind(key.project, key.feature, key.license_fingerprint, seat, now),
    ),
  ];
  let deletedRows: Array<{ seat_id: string }>;
  try {
    const results = await env.DB.batch(statements);
    const first = results[0] as { results?: Array<{ seat_id: string }> } | undefined;
    deletedRows = first?.results ?? [];
  } catch {
    return envelope(requestIdValue, "mutation_failed", undefined, 500);
  }
  // Report the seats the guarded DELETE actually removed (authoritative over the pre-read).
  const released = deletedRows.map((row) => row.seat_id).sort();
  const responseBody = { ok: true, code: "seats_released", request_id: requestIdValue, data: { released: released.length, seat_ids: released } };
  await rememberIdempotency(env, scope, idempotencyKey, responseBody, now);
  return json(responseBody);
}

// GET /api/admin/entitlements/:id/devices (reader+admin). Lists the entitlement's registered
// relay-resistance device keys (entitlement_devices). 404 if the entitlement itself is absent, so a
// bad id is never silently an empty list.
async function handleDeviceList(env: Env, encodedId: string, requestIdValue: string): Promise<Response> {
  const key = decodeEntitlementId(encodedId);
  if (key === null) {
    return envelope(requestIdValue, "invalid_entitlement_id", undefined, 400);
  }
  const ent = await findEntitlement(env, key);
  if (ent === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  const devices = await listEntitlementDevices(env, key);
  return envelope(requestIdValue, "devices_listed", { items: devices });
}

const DEVICE_KEY_ID_RE = /^sha256:[0-9a-f]{64}$/;

// POST /api/admin/entitlements/:id/devices/:deviceKeyId/(revoke|disable|reenable) (ADMIN-ONLY; reason
// REQUIRED for revoke/disable). The console equivalent of the CLI device-revoke/device-disable: it
// flips ONE device key's status and bumps the entitlement's revocation_seq so the online-verify path
// refuses that device on its next proof-carrying check (pre-TTL, non-coarse revoke — closes the R6.1
// loop). transitionEntitlementDevice commits the device UPDATE + seq bump + audit event atomically.
async function handleDeviceTransition(
  request: Request,
  env: Env,
  actor: Actor,
  encodedId: string,
  encodedDeviceKeyId: string,
  action: "revoke" | "disable" | "reenable",
  requestIdValue: string,
): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  const key = decodeEntitlementId(encodedId);
  if (key === null) {
    return envelope(requestIdValue, "invalid_entitlement_id", undefined, 400);
  }
  const deviceKeyId = decodeURIComponent(encodedDeviceKeyId);
  if (!DEVICE_KEY_ID_RE.test(deviceKeyId)) {
    return envelope(requestIdValue, "invalid_device_key_id", undefined, 400);
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
  if ((action === "revoke" || action === "disable") && reason === "") {
    return envelope(requestIdValue, "reason_required", undefined, 400);
  }
  const ctx: MutationContext = {
    actor,
    requestId: requestIdValue,
    ip: clientIp(request),
    idempotencyKey: idempotencyKey ?? null,
    source: "admin",
  };
  const targetStatus = action === "revoke" ? "revoked" : action === "disable" ? "disabled" : "active";
  return mutationResponse(request, env, ctx, `device_${action}d`, (idempotency) =>
    transitionEntitlementDevice(env, key, deviceKeyId, targetStatus, reason, ctx, idempotency));
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
  if (request.method === "GET" && url.pathname === "/api/admin/report/timeseries") {
    return reportTimeseries(request, env, id);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/report/expiring") {
    return reportExpiring(request, env, id);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/audit/verify") {
    return auditVerify(env, id);
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
  if (request.method === "GET" && url.pathname === "/api/admin/search") {
    return globalSearch(request, env, id);
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
  if (request.method === "GET" && url.pathname === "/api/admin/policies") {
    return listPolicies(request, env, id);
  }
  const policyDetail = /^\/api\/admin\/policies\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && policyDetail !== null) {
    return getPolicy(env, decodeURIComponent(policyDetail[1] ?? ""), id);
  }
  if (["POST", "PATCH"].includes(request.method) && url.pathname.startsWith("/api/admin/policies")) {
    return handlePolicyMutation(request, env, auth, id);
  }
  // ── Webhooks. /deliveries (status view) is matched BEFORE the /webhooks/:id detail so
  //    "deliveries" can never be read as an endpoint id. Writes go to handleWebhookMutation.
  if (request.method === "GET" && url.pathname === "/api/admin/webhooks") {
    return listWebhooks(request, env, id);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/webhooks/deliveries") {
    return listWebhookDeliveries(request, env, id);
  }
  const webhookDetail = /^\/api\/admin\/webhooks\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && webhookDetail !== null && webhookDetail[1] !== "deliveries") {
    return getWebhook(env, decodeURIComponent(webhookDetail[1] ?? ""), id);
  }
  if (["POST", "PATCH"].includes(request.method) && url.pathname.startsWith("/api/admin/webhooks")) {
    return handleWebhookMutation(request, env, auth, id);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/entitlements") {
    return listEntitlements(request, env, id);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/events") {
    return listEvents(request, env, id);
  }
  const deviceList = /^\/api\/admin\/entitlements\/([^/]+)\/devices$/.exec(url.pathname);
  if (request.method === "GET" && deviceList !== null) {
    return handleDeviceList(env, deviceList[1] ?? "", id);
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
  if (request.method === "POST" && url.pathname === "/api/admin/entitlements/batch") {
    return handleBatchTransition(request, env, auth, id);
  }
  // Force-release lives at /entitlements/:id/release-seats — match it before the generic
  // entitlement mutation dispatch so the encoded id (which can contain '/') is not misrouted.
  const releaseSeats = /^\/api\/admin\/entitlements\/([^/]+)\/release-seats$/.exec(url.pathname);
  if (request.method === "POST" && releaseSeats !== null) {
    return handleReleaseSeats(request, env, auth, releaseSeats[1] ?? "", id);
  }
  // Device transition lives at /entitlements/:id/devices/:deviceKeyId/(revoke|disable|reenable) —
  // match it before the generic entitlement mutation dispatch (whose regex would otherwise 404 it).
  const deviceTransition = /^\/api\/admin\/entitlements\/([^/]+)\/devices\/([^/]+)\/(revoke|disable|reenable)$/.exec(url.pathname);
  if (request.method === "POST" && deviceTransition !== null) {
    return handleDeviceTransition(request, env, auth, deviceTransition[1] ?? "", deviceTransition[2] ?? "", deviceTransition[3] as "revoke" | "disable" | "reenable", id);
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
  validatePolicyInput,
  validatePolicyPatch,
  validateWebhookInput,
  validateWebhookPatch,
};
