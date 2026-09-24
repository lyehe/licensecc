import { mintSession, setSessionCookie, loadSessionPeppers } from "../../auth/portal_session.mjs";
import { portalRateLimit } from "../../auth/portal_ratelimit.mjs";
import { canonicalHttpsOrigin, emailApiOrigin } from "../../auth/portal_destination.mjs";
import { authSession } from "./auth.js";
import { clientIp, envelope, isCrossSite, readJson, redirect, supportContact } from "../support.js";
import { digest, exchangeIdentity, providerConfig, randomToken, type Provider } from "../oauth/providers.js";
import { identityCustomer } from "../oauth/accounts.js";
import type { Env, TopRoute } from "../env.js";

const COOKIE = "__Host-lccp_oauth";
const TTL = 600;
function cookie(value: string, age = TTL): string {
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${age}`;
}
function browserToken(request: Request): string {
  const values = (request.headers.get("cookie") ?? "").split(/;\s*/).filter((part) => part.startsWith(`${COOKIE}=`));
  return values.length === 1 ? values[0]!.slice(COOKIE.length + 1) : "";
}
function originFor(request: Request, env: Env): string | null {
  const origin = canonicalHttpsOrigin(env.PORTAL_PUBLIC_ORIGIN);
  return origin && new URL(request.url).origin === origin ? origin : null;
}
const callbackPath = (provider: Provider): string => `/portal/v1/auth/${provider}/callback`;
// identityCustomer() failures that reach the browser as their own auth_error. Anything else it
// throws (such as link_failed for an identity another customer owns) stays sign_in_failed.
const CALLBACK_ERRORS = new Set(["account_link_required", "account_suspended"]);
const NO_STORE = { "cache-control": "no-store" };
// The providers envelope publishes these, and unlink counts only them as another usable way in.
const passwordEnabled = (env: Env): boolean => env.PORTAL_PASSWORD_ENABLED === "1";
const emailCodesEnabled = (env: Env): boolean => Boolean(env.PORTAL_EMAIL_API_KEY && env.PORTAL_EMAIL_FROM && emailApiOrigin(env));

async function start(request: Request, env: Env, reqId: string, now: number, provider: Provider): Promise<Response> {
  const origin = originFor(request, env);
  // Start is POST-only and requires the exact Origin, including explicit account-link starts.
  if (!origin || request.headers.get("origin") !== origin) return envelope(reqId, "cross_site_forbidden", undefined, 403);
  const config = providerConfig(env, provider);
  if (!config || loadSessionPeppers(env) === null) return redirect(`${origin}/?auth_error=provider_unavailable#/account`);
  if ((await portalRateLimit(env, `oauth:start:${clientIp(request)}`, 30, 900, now)).limited) return redirect(`${origin}/?auth_error=rate_limited#/account`);
  const mode = new URL(request.url).searchParams.get("mode");
  if (mode !== null && mode !== "link") return envelope(reqId, "invalid_request", undefined, 400);
  let linkSessionId: string | null = null;
  if (mode === "link") {
    const session = await authSession(request, env, reqId, now);
    if (session instanceof Response) return session;
    linkSessionId = session.id;
  }
  const state = randomToken();
  const verifier = randomToken();
  const nonce = randomToken();
  await env.DB.prepare("DELETE FROM portal_oauth_states WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare("INSERT INTO portal_oauth_states (state_hash, provider, browser_hash, nonce, link_session_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await digest(state), provider, await digest(verifier), nonce, linkSessionId, now + TTL).run();
  const url = new URL(provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth" : "https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({ client_id: config.id, redirect_uri: origin + callbackPath(provider), response_type: "code", state,
    scope: provider === "google" ? "openid email profile" : "read:user user:email", code_challenge: await digest(verifier), code_challenge_method: "S256",
    ...(provider === "google" ? { nonce, prompt: "select_account" } : {}),
  }).toString();
  return redirect(url.href, [cookie(verifier)]);
}

async function callback(request: Request, env: Env, reqId: string, now: number, provider: Provider): Promise<Response> {
  const origin = originFor(request, env);
  if (!origin) return envelope(reqId, "config_error", undefined, 503);
  const fail = (code: string): Response => redirect(`${origin}/?auth_error=${code}#/account`, [cookie("", 0)]);
  try {
    if (!providerConfig(env, provider) || loadSessionPeppers(env) === null) return fail("provider_unavailable");
    const params = new URL(request.url).searchParams;
    const state = params.get("state") ?? "";
    const verifier = browserToken(request);
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(verifier) || params.getAll("state").length !== 1) return fail("sign_in_failed");
    if ((await portalRateLimit(env, `oauth:callback:${clientIp(request)}`, 60, 900, now)).limited) return fail("rate_limited");
    const flow = await env.DB.prepare(
      "DELETE FROM portal_oauth_states WHERE state_hash = ? AND provider = ? AND browser_hash = ? AND expires_at > ? RETURNING nonce, link_session_id",
    ).bind(await digest(state), provider, await digest(verifier), now).first<{ nonce: string; link_session_id: string | null }>();
    if (!flow) return fail("sign_in_failed");
    if (params.has("error")) return fail("sign_in_cancelled");
    const code = params.get("code") ?? "";
    if (!code || code.length > 2048 || params.getAll("code").length !== 1) return fail("sign_in_failed");
    if (flow.link_session_id) {
      const current = await authSession(request, env, reqId, now);
      if (current instanceof Response || current.id !== flow.link_session_id) return fail("link_failed");
    }
    const identity = await exchangeIdentity(env, provider, code, verifier, flow.nonce, origin + callbackPath(provider), now);
    const customerId = await identityCustomer(env, identity, flow.link_session_id, now);
    const minted = await mintSession(env, { customerId, authMethod: "oauth", userAgent: request.headers.get("user-agent") ?? "", now });
    if (!minted.ok || !minted.raw) return fail("sign_in_failed");
    return redirect(`${origin}/${flow.link_session_id ? "?auth_result=linked#/account" : "#/apps"}`, [cookie("", 0), setSessionCookie(minted.raw)]);
  } catch (error) {
    return fail(error instanceof Error && CALLBACK_ERRORS.has(error.message) ? error.message : "sign_in_failed");
  }
}

// Disconnect a provider only while another sign-in method is usable now: a password while password
// sign-in is enabled, the other provider's identity while that provider is configured, or a contact
// email while email codes can be sent. The rule and the delete are one conditional statement, so two
// tabs disconnecting both providers cannot both succeed. The same transaction revokes the customer's
// other OAuth sessions, but only when this DELETE removed the row (changes() = 1), so a request that
// lost a race revokes nothing. The current session and non-OAuth sessions are always kept.
async function unlink(request: Request, env: Env, reqId: string, now: number): Promise<Response> {
  if (isCrossSite(request, env)) return envelope(reqId, "cross_site_forbidden", undefined, 403, NO_STORE);
  const session = await authSession(request, env, reqId, now);
  if (session instanceof Response) return session;
  const body = await readJson(request, reqId);
  if (body instanceof Response) return body;
  const provider = (["google", "github"] as const).find((name) => name === body.provider);
  if (provider === undefined) return envelope(reqId, "invalid_request", undefined, 400, NO_STORE);
  const db = env.DB.withSession?.("first-primary") ?? env.DB;
  if (!await db.prepare("SELECT 1 FROM portal_identities WHERE customer_id = ? AND provider = ?").bind(session.customer_id, provider).first()) {
    return envelope(reqId, "not_found", undefined, 404, NO_STORE);
  }
  if (!env.DB.batch) return envelope(reqId, "config_error", undefined, 503, NO_STORE);
  const other: Provider = provider === "google" ? "github" : "google";
  const flag = (usable: boolean): number => (usable ? 1 : 0);
  const [deleted] = await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM portal_identities WHERE customer_id = ? AND provider = ? AND (" +
      "(? = 1 AND EXISTS (SELECT 1 FROM portal_passwords WHERE customer_id = ?)) OR " +
      "(? = 1 AND EXISTS (SELECT 1 FROM portal_identities WHERE customer_id = ? AND provider = ?)) OR " +
      "(? = 1 AND EXISTS (SELECT 1 FROM customers WHERE id = ? AND email <> ''))) RETURNING provider",
    ).bind(session.customer_id, provider, flag(passwordEnabled(env)), session.customer_id,
      flag(providerConfig(env, other) !== null), session.customer_id, other, flag(emailCodesEnabled(env)), session.customer_id),
    env.DB.prepare(
      "UPDATE portal_sessions SET status = 'revoked' WHERE changes() = 1 AND customer_id = ? AND auth_method = 'oauth' AND id <> ? " +
      "AND status = 'active' AND NOT EXISTS (SELECT 1 FROM portal_identities WHERE customer_id = ? AND provider = ?)",
    ).bind(session.customer_id, session.id, session.customer_id, provider),
  ]);
  if (!deleted?.results.length) return envelope(reqId, "last_sign_in_method", undefined, 409, NO_STORE);
  return envelope(reqId, "identity_unlinked", { provider }, 200, NO_STORE);
}

export const OAUTH_DISPATCH: Record<string, TopRoute> = {
  "GET /portal/v1/auth/providers": (_request, env, _ctx, reqId) => envelope(reqId, "auth_providers", {
    google: providerConfig(env, "google") !== null, github: providerConfig(env, "github") !== null,
    password: passwordEnabled(env),
    email: emailCodesEnabled(env),
    support: supportContact(env),
  }, 200, NO_STORE),
  "POST /portal/v1/auth/google/start": (request, env, _ctx, reqId, now) => start(request, env, reqId, now, "google"),
  "POST /portal/v1/auth/github/start": (request, env, _ctx, reqId, now) => start(request, env, reqId, now, "github"),
  "GET /portal/v1/auth/google/callback": (request, env, _ctx, reqId, now) => callback(request, env, reqId, now, "google"),
  "GET /portal/v1/auth/github/callback": (request, env, _ctx, reqId, now) => callback(request, env, reqId, now, "github"),
  "GET /portal/v1/auth/identities": async (request, env, _ctx, reqId, now) => {
    const session = await authSession(request, env, reqId, now);
    if (session instanceof Response) return session;
    const db = env.DB.withSession?.("first-primary") ?? env.DB;
    const rows = await db.prepare("SELECT provider, email, created_at FROM portal_identities WHERE customer_id = ? ORDER BY provider").bind(session.customer_id).all();
    return envelope(reqId, "identities", { items: rows.results }, 200, NO_STORE);
  },
  "POST /portal/v1/auth/identities/unlink": (request, env, _ctx, reqId, now) => unlink(request, env, reqId, now),
};
