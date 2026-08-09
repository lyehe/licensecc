// Cookie-less authentication and break-glass operator routes.

import * as otpModule from "../../auth/portal_otp.mjs";
import * as sessionModule from "../../auth/portal_session.mjs";
import * as emailModule from "../../auth/portal_email.mjs";
import type { Env, ExecutionContextLike } from "../env.js";
import {
  bearerToken,
  clientIp,
  constantTimeEqual,
  envelope,
  isCrossSite,
  publicOrigin,
  readJson,
} from "../support.js";

type AnyFn = (...args: any[]) => any;
const requestOtp = (otpModule as { requestOtp: AnyFn }).requestOtp;
const redeemOtp = (otpModule as { redeemOtp: AnyFn }).redeemOtp;
const mintSession = (sessionModule as { mintSession: AnyFn }).mintSession;
const resolveSession = (sessionModule as { resolveSession: AnyFn }).resolveSession;
const revokeSession = (sessionModule as { revokeSession: AnyFn }).revokeSession;
const cookieFromRequest = (sessionModule as { cookieFromRequest: (r: Request) => string | null }).cookieFromRequest;
const setSessionCookie = (sessionModule as { setSessionCookie: (raw: string) => string }).setSessionCookie;
const clearSessionCookie = (sessionModule as { clearSessionCookie: () => string }).clearSessionCookie;
const sendEmail = (emailModule as { sendEmail: AnyFn }).sendEmail;

const MAGIC_REDEEM_MAX_BODY_BYTES = 8192;
const HEX = /^[0-9A-Fa-f]{2}$/;
const formTextEncoder = new TextEncoder();

type BoundedBody =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: "body_too_large" | "read_error" };

function cancelBody(request: Request): void {
  if (request.body === null) return;
  try {
    void Promise.resolve(request.body.cancel()).catch(() => {
      // Cancellation is best effort; the bounded response must not wait for the source to settle.
    });
  } catch {
    // A synchronous cancellation failure does not change the bounded response.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => {
      // Cancellation is best effort; the bounded response must not wait for the source to settle.
    });
  } catch {
    // A synchronous cancellation failure does not change the bounded response.
  }
}

async function readBoundedBody(request: Request): Promise<BoundedBody> {
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAGIC_REDEEM_MAX_BODY_BYTES) {
    cancelBody(request);
    return { ok: false, code: "body_too_large" };
  }
  if (request.body === null) return { ok: true, bytes: new Uint8Array(0) };

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    cancelBody(request);
    return { ok: false, code: "read_error" };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        cancelReader(reader);
        return { ok: false, code: "read_error" };
      }
      if (result.done) break;
      const value = result.value;
      if (value === undefined) continue;
      if (size + value.byteLength > MAGIC_REDEEM_MAX_BODY_BYTES) {
        cancelReader(reader);
        return { ok: false, code: "body_too_large" };
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader is no longer used; a release failure must not change the response.
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

function decodeFormComponent(value: string): string | null {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "%") {
      const escape = value.slice(index + 1, index + 3);
      if (!HEX.test(escape)) return null;
      bytes.push(Number.parseInt(escape, 16));
      index += 2;
      continue;
    }
    const source = character === "+" ? " " : character;
    const encoded = formTextEncoder.encode(source);
    for (const byte of encoded) bytes.push(byte);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

function parseFormToken(bytes: Uint8Array): { ok: true; token: string } | { ok: false } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false };
  }

  let token = "";
  let foundToken = false;
  for (const field of text.split("&")) {
    if (field === "") continue;
    const separator = field.indexOf("=");
    const key = decodeFormComponent(separator < 0 ? field : field.slice(0, separator));
    const value = decodeFormComponent(separator < 0 ? "" : field.slice(separator + 1));
    if (key === null || value === null) return { ok: false };
    if (key === "token" && !foundToken) {
      token = value;
      foundToken = true;
    }
  }
  return { ok: true, token };
}

// Resolve the verified session (the ONLY identity source). Returns the session object or a 401/503
// envelope the caller returns directly.
export async function authSession(request: Request, env: Env, reqId: string, now: number): Promise<{ customer_id: string; id: string } | Response> {
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
  const mediaType = (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType === "application/json") {
    const body = await readJson(request, reqId);
    if (body instanceof Response) return body;
    return redeemAndMintSession(env, request, reqId, now, {
      secret: typeof body.token === "string" ? body.token : "",
    });
  }
  if (mediaType !== "application/x-www-form-urlencoded") {
    return envelope(reqId, "unsupported_media_type", undefined, 415);
  }

  const body = await readBoundedBody(request);
  if (!body.ok) {
    return body.code === "body_too_large"
      ? envelope(reqId, "body_too_large", undefined, 413)
      : envelope(reqId, "invalid_request", undefined, 400);
  }
  const parsed = parseFormToken(body.bytes);
  if (!parsed.ok) return envelope(reqId, "invalid_request", undefined, 400);
  return redeemAndMintSession(env, request, reqId, now, { secret: parsed.token });
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

// The public dispatch map is intentionally separate from the session map. The app composes it only
// after the meta routes, preserving authentication-before-session-route lookup at the boundary.
export const AUTH_DISPATCH = {
  "POST /portal/v1/auth/request": (request: Request, env: Env, ctx: ExecutionContextLike | undefined, reqId: string, now: number) => handleAuthRequest(request, env, ctx, reqId, now),
  "POST /portal/v1/auth/verify": (request: Request, env: Env, _ctx: ExecutionContextLike | undefined, reqId: string, now: number) => handleAuthVerify(request, env, reqId, now),
  "GET /portal/v1/auth/magic": (request: Request, env: Env, _ctx: ExecutionContextLike | undefined, _reqId: string, _now: number) => handleMagicInterstitial(request, env),
  "POST /portal/v1/auth/magic-redeem": (request: Request, env: Env, _ctx: ExecutionContextLike | undefined, reqId: string, now: number) => handleMagicRedeem(request, env, reqId, now),
  "POST /portal/v1/auth/logout": (request: Request, env: Env, _ctx: ExecutionContextLike | undefined, reqId: string, now: number) => handleLogout(request, env, reqId, now),
  "POST /portal/v1/admin/bootstrap-otp": (request: Request, env: Env, _ctx: ExecutionContextLike | undefined, reqId: string, now: number) => handleBootstrap(request, env, reqId, now),
};
