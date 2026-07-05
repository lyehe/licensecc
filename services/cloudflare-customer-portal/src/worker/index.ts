// Customer-portal Worker (Slice 3). Self-serve sign-in (email OTP / magic link) + read-only
// entitlement views + per-action seat operations, all SESSION-SCOPED to one customer.
//
// The 10 invariants (blueprint) enforced here:
//  1. Reads are read-only + customer-scoped; the portal imports only the account-token resolver,
//     the Worker-safe issue builders, and types — never the entitlement MUTATORS.
//  2. customer_id is ALWAYS session-derived (resolveSession). The mint chokepoint mintSessionToken
//     takes the SESSION ONLY; no handler passes a client tuple/customer_id into it.
//  3. The backend lcca_ never reaches the browser / DB: HttpOnly session cookie + ephemeral 120s mint
//     used once and discarded.
//  4. Action/download handlers SERVER-RESOLVE the fingerprint from an opaque entitlement id scoped to
//     the session customer; 0 rows -> generic not_found (no existence oracle).
//  5. Auth throttling is always-on (portalRateLimit, inside the OTP/redeem modules).
//  6. The magic-link secret never rides a mutating GET — /portal/v1/auth/magic is a POST interstitial;
//     the origin for links is PORTAL_PUBLIC_ORIGIN, never the request Host.
//  7. /health asserts ACCOUNT_TOKEN_MODE=required.
//  8. Opaque DB-backed session (no JWT).
//  9. logout bumps account_token_revocations.revocation_seq (kills the in-flight 120s token).
// 10. Operator bootstrap is break-glass: bearer (constant-time, unset -> 404) + network gate +
//     always-on RL + 120s + append-only audit.

// The auth modules are Worker-safe .mjs (no node:/Buffer). allowJs resolves+emits them; their
// exports are inferred from JS defaults, which fights the strict worker tsconfig — so we import the
// namespaces and project them through explicit loose function types (the worker is the typed
// consumer; runtime behavior is the .mjs).
import * as otpModule from "../auth/portal_otp.mjs";
import * as sessionModule from "../auth/portal_session.mjs";
import * as tokenModule from "../auth/portal_token.mjs";
import * as emailModule from "../auth/portal_email.mjs";
import type { ApiEnvelope } from "../shared/api";
import { openApiDocument, DOCS_HTML } from "./openapi.js";

type AnyFn = (...args: any[]) => any;
const requestOtp = (otpModule as { requestOtp: AnyFn }).requestOtp;
const redeemOtp = (otpModule as { redeemOtp: AnyFn }).redeemOtp;
const mintSession = (sessionModule as { mintSession: AnyFn }).mintSession;
const resolveSession = (sessionModule as { resolveSession: AnyFn }).resolveSession;
const revokeSession = (sessionModule as { revokeSession: AnyFn }).revokeSession;
const cookieFromRequest = (sessionModule as { cookieFromRequest: (r: Request) => string | null }).cookieFromRequest;
const setSessionCookie = (sessionModule as { setSessionCookie: (raw: string) => string }).setSessionCookie;
const clearSessionCookie = (sessionModule as { clearSessionCookie: () => string }).clearSessionCookie;
const mintSessionToken = (tokenModule as { mintSessionToken: AnyFn }).mintSessionToken;
const proxyBackend = (tokenModule as { proxyBackend: (env: Env, path: string, token: string, body: unknown) => Promise<Response> }).proxyBackend;
const sendEmail = (emailModule as { sendEmail: AnyFn }).sendEmail;

interface D1Result<T = Record<string, unknown>> {
  results: T[];
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}
interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatement;
  withSession?(mode: string): D1DatabaseLike;
  batch?(statements: D1PreparedStatement[]): Promise<unknown[]>;
}
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  DB: D1DatabaseLike;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  ENVIRONMENT?: string;
  ACCOUNT_TOKEN_MODE?: string;
  PORTAL_PUBLIC_ORIGIN?: string;
  BACKEND_ORIGIN?: string;
  PORTAL_OTP_PEPPERS?: string;
  PORTAL_SESSION_PEPPERS?: string;
  ACCOUNT_TOKEN_PEPPERS?: string;
  ACCOUNT_TOKEN_ACTIVE_PEPPER_ID?: string;
  PORTAL_EMAIL_API_KEY?: string;
  PORTAL_EMAIL_FROM?: string;
  PORTAL_EMAIL_API_BASE?: string;
  PORTAL_BOOTSTRAP_BEARER?: string;
  PORTAL_BOOTSTRAP_REQUIRE_ACCESS?: string;
}

const MAX_BODY_BYTES = 8192;
const PROJECT_RE = /^[A-Za-z0-9_.:-]{1,127}$/;
const FEATURE_RE = /^[A-Za-z0-9_.:-]{1,15}$/;

type LicenseMode = "trial" | "node_locked" | "floating";

interface OwnedEntitlement {
  id: string;
  project: string;
  feature: string;
  license_fingerprint: string;
  status: string;
  valid_from: number | null;
  valid_until: number | null;
  pool_size: number;
  max_active_devices: number;
  max_borrow_sec: number;
  heartbeat_grace_sec: number;
  is_trial: number;
  policy_id: string | null;
  license_mode: LicenseMode;
}

function json<T>(body: T, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function requestId(request: Request): string {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}

function envelope<T>(reqId: string, code: string, data?: T, status = 200, headers: HeadersInit = {}): Response {
  const body: ApiEnvelope<T> = { ok: status >= 200 && status < 300, code, request_id: reqId };
  if (data !== undefined) body.data = data;
  return json(body, status, headers);
}

function entitlementId(project: string, feature: string, licenseFingerprint: string): string {
  const raw = JSON.stringify([project, feature, licenseFingerprint]);
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeEntitlementId(id: string): { project: string; feature: string; license_fingerprint: string } | null {
  try {
    const padded = id.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(id.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [project, feature, licenseFingerprint] = parsed;
    if (typeof project !== "string" || typeof feature !== "string" || typeof licenseFingerprint !== "string") return null;
    if (!PROJECT_RE.test(project) || !FEATURE_RE.test(feature) || !/^[a-fA-F0-9]{64}$/.test(licenseFingerprint)) return null;
    return { project, feature, license_fingerprint: licenseFingerprint };
  } catch {
    return null;
  }
}

function licenseMode(row: { is_trial?: number; pool_size?: number }): LicenseMode {
  if (Number(row.is_trial ?? 0) === 1) return "trial";
  return Number(row.pool_size ?? 0) > 0 ? "floating" : "node_locked";
}

function withPortalEntitlement(row: Omit<OwnedEntitlement, "id" | "license_mode">): OwnedEntitlement {
  return {
    ...row,
    id: entitlementId(row.project, row.feature, row.license_fingerprint),
    license_mode: licenseMode(row),
  };
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "";
}

function safeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) return null;
  return value;
}

// Constant-time string equality via Web Crypto (HMAC under a random one-time key, then a
// length-uniform byte compare). Used for the break-glass bootstrap bearer (L9 discipline).
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const macA = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(a)));
  const macB = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < macA.length; i += 1) diff |= (macA[i] ?? 0) ^ (macB[i] ?? 0);
  return diff === 0;
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const raw = auth.slice("Bearer ".length);
  return raw.length > 0 ? raw : null;
}

// Cross-site rejection for state-changing POSTs: a same-origin app sends Origin == PORTAL_PUBLIC_ORIGIN
// (or Sec-Fetch-Site: same-origin). Anything cross-site is rejected (CSRF defense in depth; the
// session cookie is SameSite=Lax so a cross-site POST would not carry it, but we deny explicitly).
function isCrossSite(request: Request, env: Env): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null) {
    return !(fetchSite === "same-origin" || fetchSite === "none");
  }
  const origin = request.headers.get("origin");
  if (origin === null) return false; // non-browser / no Origin: allow (cookie SameSite still gates).
  const expected = (env.PORTAL_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
  return expected.length === 0 ? true : origin.replace(/\/$/, "") !== expected;
}

async function readJson(request: Request, reqId: string): Promise<Record<string, unknown> | Response> {
  const body = await readTextBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return envelope(reqId, "body_too_large", undefined, 413);
  }
  try {
    const text = body.text;
    const parsed = text === "" ? {} : JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return envelope(reqId, "invalid_json", undefined, 400);
    }
    return parsed as Record<string, unknown>;
  } catch {
    return envelope(reqId, "invalid_json", undefined, 400);
  }
}

async function readTextBody(request: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false }> {
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false };
  }
  if (request.body === null) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The response is already determined; cancel errors do not change the rejection.
      }
      return { ok: false };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

function publicOrigin(env: Env): string {
  return (env.PORTAL_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
}

// Resolve the verified session (the ONLY identity source). Returns the session object or a 401/503
// envelope the caller returns directly.
async function authSession(request: Request, env: Env, reqId: string, now: number): Promise<{ customer_id: string; id: string } | Response> {
  const raw = cookieFromRequest(request);
  if (raw === null) return envelope(reqId, "unauthorized", undefined, 401);
  const resolved = await resolveSession(env, raw, now);
  if (!resolved.ok) {
    if (resolved.code === "config_error") return envelope(reqId, "config_error", undefined, 503);
    return envelope(reqId, "unauthorized", undefined, 401);
  }
  return resolved.session;
}

// -------------------------------------------------------------------------------------------------
// Auth routes
// -------------------------------------------------------------------------------------------------

async function handleAuthRequest(request: Request, env: Env, ctx: ExecutionContextLike | undefined, reqId: string, now: number): Promise<Response> {
  if (isCrossSite(request, env)) return envelope(reqId, "cross_site_forbidden", undefined, 403);
  const body = await readJson(request, reqId);
  if (body instanceof Response) return body;
  const email = typeof body.email === "string" ? body.email : "";
  const result = await requestOtp(env, {
    email,
    clientIp: clientIp(request),
    sendEmailFn: sendEmail,
    waitUntil: ctx?.waitUntil ? ctx.waitUntil.bind(ctx) : undefined,
    magicLinkBase: publicOrigin(env),
    now,
  });
  if (result.code === "config_error") return envelope(reqId, "config_error", undefined, 503);
  if (result.code === "rate_limited") return envelope(reqId, "rate_limited", undefined, 429);
  // Always ok (no enumeration): an unknown email returns the same shape.
  return envelope(reqId, "otp_requested");
}

async function redeemAndMintSession(
  env: Env,
  request: Request,
  reqId: string,
  now: number,
  args: { email?: string; code?: string; secret?: string },
): Promise<Response> {
  const redeemed = await redeemOtp(env, { ...args, clientIp: clientIp(request), now });
  if (redeemed.code === "config_error") return envelope(reqId, "config_error", undefined, 503);
  if (redeemed.code === "rate_limited") return envelope(reqId, "rate_limited", undefined, 429);
  if (!redeemed.ok) return envelope(reqId, "invalid_otp", undefined, 401);
  const minted = await mintSession(env, { customerId: redeemed.customerId, userAgent: request.headers.get("user-agent") ?? "", now });
  if (!minted.ok) return envelope(reqId, "config_error", undefined, 503);
  return envelope(reqId, "signed_in", { customer_id: redeemed.customerId }, 200, { "set-cookie": setSessionCookie(minted.raw) });
}

async function handleAuthVerify(request: Request, env: Env, reqId: string, now: number): Promise<Response> {
  if (isCrossSite(request, env)) return envelope(reqId, "cross_site_forbidden", undefined, 403);
  const body = await readJson(request, reqId);
  if (body instanceof Response) return body;
  return redeemAndMintSession(env, request, reqId, now, {
    email: typeof body.email === "string" ? body.email : "",
    code: typeof body.code === "string" ? body.code : "",
  });
}

// GET /portal/v1/auth/magic — a NON-mutating POST interstitial (invariant 6). The magic-link secret
// arrives in the query string but we NEVER consume it on the GET (which would let a referer/prefetch
// burn the link). We render a tiny self-submitting form that POSTs the secret to /magic-redeem.
function handleMagicInterstitial(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const origin = publicOrigin(env);
  // The token is echoed only into a hidden form field on OUR origin; never logged, never in a redirect.
  const safeToken = token.replace(/[^A-Za-z0-9_-]/g, "");
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
    `<title>Signing in…</title></head><body>` +
    `<form id="f" method="POST" action="${origin}/portal/v1/auth/magic-redeem">` +
    `<input type="hidden" name="token" value="${safeToken}">` +
    `<noscript><button type="submit">Continue sign-in</button></noscript></form>` +
    `<script>document.getElementById('f').submit();</script>` +
    `</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer", "cache-control": "no-store" },
  });
}

async function handleMagicRedeem(request: Request, env: Env, reqId: string, now: number): Promise<Response> {
  if (isCrossSite(request, env)) return envelope(reqId, "cross_site_forbidden", undefined, 403);
  // The interstitial form posts application/x-www-form-urlencoded; also accept JSON.
  let token = "";
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await readJson(request, reqId);
    if (body instanceof Response) return body;
    token = typeof body.token === "string" ? body.token : "";
  } else {
    const form = await request.formData();
    const value = form.get("token");
    token = typeof value === "string" ? value : "";
  }
  return redeemAndMintSession(env, request, reqId, now, { secret: token });
}

async function handleLogout(request: Request, env: Env, reqId: string, now: number): Promise<Response> {
  if (isCrossSite(request, env)) return envelope(reqId, "cross_site_forbidden", undefined, 403);
  const session = await authSession(request, env, reqId, now);
  if (session instanceof Response) {
    // Even an invalid session: clear the cookie idempotently.
    return envelope(reqId, "logged_out", undefined, 200, { "set-cookie": clearSessionCookie() });
  }
  await revokeSession(env, session.id, session.customer_id);
  // Invariant 9: bump the per-customer revocation floor so any in-flight 120s account token dies.
  await env.DB.prepare(
    "INSERT INTO account_token_revocations (customer_id, revocation_seq, updated_at) VALUES (?, 1, ?) " +
      "ON CONFLICT(customer_id) DO UPDATE SET revocation_seq = account_token_revocations.revocation_seq + 1, updated_at = ?",
  ).bind(session.customer_id, now, now).run();
  return envelope(reqId, "logged_out", undefined, 200, { "set-cookie": clearSessionCookie() });
}

// POST /portal/v1/admin/bootstrap-otp — break-glass operator OTP issuance (invariant 10). The ONLY
// path that returns a secret. Gated by: constant-time bearer (unset -> 404, no oracle the route
// exists) + optional Cloudflare Access network gate + always-on RL + append-only audit + 120s TTL.
async function handleBootstrap(request: Request, env: Env, reqId: string, now: number): Promise<Response> {
  const configured = env.PORTAL_BOOTSTRAP_BEARER;
  // Unset in steady state: the route does NOT exist (404, no existence oracle).
  if (configured === undefined || configured === "") {
    return envelope(reqId, "not_found", undefined, 404);
  }
  const presented = bearerToken(request);
  if (presented === null || !(await constantTimeEqual(presented, configured))) {
    return envelope(reqId, "unauthorized", undefined, 401);
  }
  // Network gate: when PORTAL_BOOTSTRAP_REQUIRE_ACCESS=1, require a Cloudflare Access JWT header.
  if ((env.PORTAL_BOOTSTRAP_REQUIRE_ACCESS === "1" || env.PORTAL_BOOTSTRAP_REQUIRE_ACCESS === "true")) {
    const access = request.headers.get("cf-access-jwt-assertion");
    if (access === null || access === "") {
      return envelope(reqId, "access_required", undefined, 403);
    }
  }
  if (isCrossSite(request, env)) return envelope(reqId, "cross_site_forbidden", undefined, 403);
  const body = await readJson(request, reqId);
  if (body instanceof Response) return body;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length === 0) return envelope(reqId, "invalid_request", undefined, 400);

  // Always-on RL on the break-glass path too.
  // (requestOtp itself runs the per-email / per-IP always-on RL before any write.)
  const result = await requestOtp(env, {
    email,
    clientIp: clientIp(request),
    sendEmailFn: undefined, // bootstrap returns the secret directly; never emails.
    magicLinkBase: publicOrigin(env),
    now,
    returnSecret: true,
  });
  if (result.code === "config_error") return envelope(reqId, "config_error", undefined, 503);
  if (result.code === "rate_limited") return envelope(reqId, "rate_limited", undefined, 429);

  // Resolve the customer for the append-only audit row (only when one exists).
  const customer = await env.DB.prepare(
    "SELECT id FROM customers WHERE lower(email) = ? AND status = 'active' LIMIT 1",
  ).bind(email).first<{ id: string }>();
  if (customer !== null && customer.id !== undefined) {
    const actor = bearerLabel(request);
    await env.DB.prepare(
      "INSERT INTO portal_bootstrap_events (id, customer_id, email_lower, actor, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(`pb_${crypto.randomUUID().replace(/-/g, "")}`, customer.id, email, actor, now).run();
  }
  // The secret (when present) is returned to the operator ONCE. For an unknown email, requestOtp
  // returns ok with no secret (no enumeration); we surface the same shape.
  return envelope(reqId, "bootstrap_otp", { secret: result.secret ?? null });
}

function bearerLabel(request: Request): string {
  // A non-secret label for the audit row: the operator's Access email if present, else "operator".
  const email = request.headers.get("cf-access-authenticated-user-email");
  return typeof email === "string" && email.length > 0 ? email.slice(0, 128) : "operator";
}

// -------------------------------------------------------------------------------------------------
// /api/portal/* — session-scoped customer data + actions. EVERY handler binds session.customer_id.
// -------------------------------------------------------------------------------------------------

async function apiMe(session: { customer_id: string }, reqId: string): Promise<Response> {
  return envelope(reqId, "me", { customer_id: session.customer_id });
}

async function apiEntitlements(env: Env, session: { customer_id: string }, reqId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT project, feature, license_fingerprint, status, valid_from, valid_until, pool_size, max_active_devices, max_borrow_sec, heartbeat_grace_sec, is_trial, policy_id " +
      "FROM entitlements WHERE customer_id = ? ORDER BY project, feature, license_fingerprint",
  ).bind(session.customer_id).all<Omit<OwnedEntitlement, "id" | "license_mode">>();
  return envelope(reqId, "entitlements", { items: rows.results.map(withPortalEntitlement) });
}

async function apiDevices(env: Env, session: { customer_id: string }, reqId: string): Promise<Response> {
  // Ownership EXISTS: only devices on entitlements the session customer owns.
  const rows = await env.DB.prepare(
    "SELECT d.project, d.feature, d.license_fingerprint, d.device_key_id, d.created_at " +
      "FROM entitlement_devices d " +
      "WHERE EXISTS (SELECT 1 FROM entitlements e WHERE e.project = d.project AND e.feature = d.feature " +
      "AND e.license_fingerprint = d.license_fingerprint AND e.customer_id = ?) " +
      "ORDER BY d.created_at DESC LIMIT 500",
  ).bind(session.customer_id).all();
  return envelope(reqId, "devices", { items: rows.results });
}

async function apiUsage(env: Env, session: { customer_id: string }, reqId: string): Promise<Response> {
  // usage_events has no customer_id column; gate via the ownership EXISTS on the parent entitlement.
  const rows = await env.DB.prepare(
    "SELECT u.project, u.feature, u.event_type, COUNT(*) AS count " +
      "FROM usage_events u " +
      "WHERE EXISTS (SELECT 1 FROM entitlements e WHERE e.project = u.project AND e.feature = u.feature " +
      "AND e.license_fingerprint = u.license_fingerprint AND e.customer_id = ?) " +
      "GROUP BY u.project, u.feature, u.event_type ORDER BY u.project, u.feature",
  ).bind(session.customer_id).all();
  return envelope(reqId, "usage", { items: rows.results });
}

// Server-resolve the exact entitlement for an action/download (invariant 4). 0 rows -> null (the
// caller returns a generic not_found — no existence oracle). The resolution is bound to customer_id.
async function resolveOwnedEntitlement(
  env: Env,
  customerId: string,
  entitlementIdValue: unknown,
): Promise<OwnedEntitlement | null> {
  if (typeof entitlementIdValue !== "string" || entitlementIdValue.length === 0 || entitlementIdValue.length > 512) return null;
  const key = decodeEntitlementId(entitlementIdValue);
  if (key === null) return null;
  const row = await env.DB.prepare(
    "SELECT project, feature, license_fingerprint, status, valid_from, valid_until, pool_size, max_active_devices, max_borrow_sec, heartbeat_grace_sec, is_trial, policy_id " +
      "FROM entitlements WHERE customer_id = ? AND project = ? AND feature = ? AND license_fingerprint = ? AND status = 'active' LIMIT 1",
  ).bind(customerId, key.project, key.feature, key.license_fingerprint).first<Omit<OwnedEntitlement, "id" | "license_mode">>();
  return row === null ? null : withPortalEntitlement(row);
}

// Action handler (checkout / heartbeat / release): server-resolve the tuple, mint a per-action token
// bound to the SESSION ONLY (invariant 2), proxy to the backend, discard the token.
async function apiAction(
  request: Request,
  env: Env,
  session: { customer_id: string },
  reqId: string,
  now: number,
  operation: "checkout" | "heartbeat" | "release",
): Promise<Response> {
  if (isCrossSite(request, env)) return envelope(reqId, "cross_site_forbidden", undefined, 403);
  const body = await readJson(request, reqId);
  if (body instanceof Response) return body;
  const entitlement = await resolveOwnedEntitlement(env, session.customer_id, body.entitlement_id);
  // Invariant 4: a wrong/foreign/absent tuple is the SAME generic not_found (no oracle). The client
  // body NEVER supplies the fingerprint — it is server-resolved from the session-bound entitlement.
  if (entitlement === null) return envelope(reqId, "not_found", undefined, 404);
  if (operation === "checkout" && (typeof body.client_instance_id !== "string" || typeof body.nonce !== "string")) {
    return envelope(reqId, "invalid_request", undefined, 400);
  }
  if ((operation === "heartbeat" || operation === "release") && (
    typeof body.client_instance_id !== "string" || typeof body.nonce !== "string" || typeof body.seat_id !== "string"
  )) {
    return envelope(reqId, "invalid_request", undefined, 400);
  }

  // Invariant 2: identity is SESSION-ONLY (session.customer_id). The narrow (project,feature,operation)
  // is the already-owner-verified tuple + the server-controlled operation; the mint re-verifies it
  // against the customer's own entitlements and scopes the token to exactly that (audit R2.5 least
  // privilege) — a forged/unowned tuple still mints nothing.
  const minted = await mintSessionToken(env, session, {
    operationClass: "action",
    now,
    narrow: { project: entitlement.project, feature: entitlement.feature, operation },
  });
  if (minted.code === "config_error") return envelope(reqId, "config_error", undefined, 503);
  if (!minted.ok) return envelope(reqId, "not_found", undefined, 404);

  // Build the backend payload from the SERVER-RESOLVED fingerprint + only the safe client fields.
  const proxyBody: Record<string, unknown> = {
    project: entitlement.project,
    feature: entitlement.feature,
    license_fingerprint: entitlement.license_fingerprint,
  };
  for (const k of ["client_instance_id", "nonce", "seat_id", "device_key_id"]) {
    if (typeof body[k] === "string") proxyBody[k] = body[k];
  }
  const upstream = await proxyBackend(env, `/v1/${operation}`, minted.raw, proxyBody);
  let upstreamBody: Record<string, unknown> = {};
  try {
    const parsed = await upstream.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      upstreamBody = parsed as Record<string, unknown>;
    }
  } catch {
    return envelope(reqId, "backend_invalid_response", undefined, 502);
  }
  const code = typeof upstreamBody.code === "string"
    ? upstreamBody.code
    : upstream.ok
      ? `${operation}_ok`
      : `${operation}_failed`;
  return envelope(reqId, code, upstreamBody, upstream.status);
}

// Download the signed .lic: server-resolve the tuple, stream the backend's signed bytes UNCHANGED.
// The portal never parses or signs (invariant 1). Streams Content-Disposition: attachment.
async function apiDownload(
  request: Request,
  env: Env,
  session: { customer_id: string },
  reqId: string,
  now: number,
): Promise<Response> {
  if (isCrossSite(request, env)) return envelope(reqId, "cross_site_forbidden", undefined, 403);
  const body = await readJson(request, reqId);
  if (body instanceof Response) return body;
  const entitlement = await resolveOwnedEntitlement(env, session.customer_id, body.entitlement_id);
  if (entitlement === null) return envelope(reqId, "not_found", undefined, 404);
  const deviceKeyId = typeof body.device_key_id === "string" ? body.device_key_id : "";
  if (deviceKeyId === "") return envelope(reqId, "device_key_required", undefined, 400);

  // Download performs an activate; scope the token to exactly this owned tuple + "activate" (R2.5).
  const minted = await mintSessionToken(env, session, {
    operationClass: "action",
    now,
    narrow: { project: entitlement.project, feature: entitlement.feature, operation: "activate" },
  });
  if (minted.code === "config_error") return envelope(reqId, "config_error", undefined, 503);
  if (!minted.ok) return envelope(reqId, "not_found", undefined, 404);

  const origin = (env.BACKEND_ORIGIN ?? "").replace(/\/$/, "");
  if (origin.length === 0) return envelope(reqId, "backend_unconfigured", undefined, 503);
  let upstream: Response;
  try {
    upstream = await fetch(`${origin}/v1/activate`, {
      method: "POST",
      headers: { authorization: `Bearer ${minted.raw}`, "content-type": "application/json" },
      body: JSON.stringify({
        project: entitlement.project,
        feature: entitlement.feature,
        license_fingerprint: entitlement.license_fingerprint,
        device_key_id: deviceKeyId,
      }),
    });
  } catch {
    return envelope(reqId, "backend_unreachable", undefined, 502);
  }
  let upstreamBody: Record<string, unknown>;
  try {
    const parsed = await upstream.json();
    upstreamBody = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return envelope(reqId, "backend_invalid_response", undefined, 502);
  }
  if (!upstream.ok || upstreamBody.ok !== true || typeof upstreamBody.lic !== "string") {
    const code = typeof upstreamBody.code === "string" ? upstreamBody.code : "activate_failed";
    return envelope(reqId, code, upstreamBody, upstream.status);
  }
  // Convert the backend's JSON lease body into an attachment while STRIPPING upstream Authorization
  // and Set-Cookie so the ephemeral bearer cannot leak back to the browser.
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="${entitlement.project}-${entitlement.feature}.lic"`,
    "cache-control": "no-store",
  });
  return new Response(upstreamBody.lic, { status: 200, headers });
}

async function handleApiPortal(request: Request, env: Env, reqId: string, now: number, pathname: string): Promise<Response> {
  const session = await authSession(request, env, reqId, now);
  if (session instanceof Response) return session;

  if (request.method === "GET" && pathname === "/api/portal/me") return apiMe(session, reqId);
  if (request.method === "GET" && pathname === "/api/portal/entitlements") return apiEntitlements(env, session, reqId);
  if (request.method === "GET" && pathname === "/api/portal/devices") return apiDevices(env, session, reqId);
  if (request.method === "GET" && pathname === "/api/portal/usage") return apiUsage(env, session, reqId);
  if (request.method === "POST" && pathname === "/api/portal/checkout") return apiAction(request, env, session, reqId, now, "checkout");
  if (request.method === "POST" && pathname === "/api/portal/heartbeat") return apiAction(request, env, session, reqId, now, "heartbeat");
  if (request.method === "POST" && pathname === "/api/portal/release") return apiAction(request, env, session, reqId, now, "release");
  if (request.method === "POST" && pathname === "/api/portal/download") return apiDownload(request, env, session, reqId, now);
  return envelope(reqId, "not_found", undefined, 404);
}

function health(env: Env, reqId: string): Response {
  // Invariant 7: the portal is only healthy if the backend enforces full account isolation.
  const required = env.ACCOUNT_TOKEN_MODE === "required";
  return envelope(reqId, required ? "healthy" : "account_token_mode_not_required", { account_token_mode_required: required }, required ? 200 : 503);
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
    const reqId = requestId(request);
    const now = Math.floor(Date.now() / 1000);
    try {
      const url = new URL(request.url);
      const p = url.pathname;

      // Unauthenticated API documentation (added early, before any auth or route dispatch). Does not
      // disturb existing routes. /openapi.json serves the spec; /docs serves a self-contained,
      // dependency-free HTML page that fetches and renders it.
      if (request.method === "GET" && p === "/openapi.json") {
        return json(openApiDocument, 200, { "cache-control": "no-store" });
      }
      if (request.method === "GET" && p === "/docs") {
        return new Response(DOCS_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }

      if (request.method === "GET" && p === "/health") return health(env, reqId);

      if (p === "/portal/v1/auth/request" && request.method === "POST") return await handleAuthRequest(request, env, ctx, reqId, now);
      if (p === "/portal/v1/auth/verify" && request.method === "POST") return await handleAuthVerify(request, env, reqId, now);
      if (p === "/portal/v1/auth/magic" && request.method === "GET") return handleMagicInterstitial(request, env);
      if (p === "/portal/v1/auth/magic-redeem" && request.method === "POST") return await handleMagicRedeem(request, env, reqId, now);
      if (p === "/portal/v1/auth/logout" && request.method === "POST") return await handleLogout(request, env, reqId, now);
      if (p === "/portal/v1/admin/bootstrap-otp" && request.method === "POST") return await handleBootstrap(request, env, reqId, now);

      if (p.startsWith("/api/portal/")) return await handleApiPortal(request, env, reqId, now, p);

      // SPA fallback (assets / client routes).
      if (env.ASSETS !== undefined) return env.ASSETS.fetch(request);
      return new Response("not found", { status: 404 });
    } catch {
      return envelope(reqId, "portal_error", undefined, 500);
    }
  },
};

export const portalInternalsForTests = { isCrossSite, constantTimeEqual, entitlementId, decodeEntitlementId, resolveOwnedEntitlement };
