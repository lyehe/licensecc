// portal_token.mjs — the per-action ephemeral account-token mint + backend proxy (blueprint (a)).
//
// THE MINT CHOKEPOINT (invariant 2): mintSessionToken(env, session) takes the SESSION OBJECT ONLY.
// There is NO request / no body / no client-supplied customer_id or tuple parameter — the customer
// identity is ALWAYS session.customer_id (server-derived from the verified opaque cookie). A forged
// body field can never reach this function.
//
// Scopes are PINNED (invariant 2): projects/features come from the customer's OWN entitlements
// (SELECT DISTINCT project,feature FROM entitlements WHERE customer_id=?), and operations are the
// minimal set for the operation class (read -> ["report"]; action -> the five lease ops). NEVER "*"
// and NEVER allow_all — a portal-minted token cannot act outside the customer's entitlements.
//
// The minted token is ephemeral: TTL now+120, the plaintext is used ONCE to proxy and is NEVER
// persisted client-side and NEVER returned to the browser (invariant 3). Only its HMAC lands in the
// account_tokens row (via buildIssue), exactly like the CLI mint.
//
// Worker-safe: no node:/Buffer; imports only the Worker-safe issue builders + the pepper loader.

import { buildIssue } from "@licensecc/cloudflare-licensing-backend/auth/account_token_issue";
import { loadPepperMap } from "@licensecc/cloudflare-licensing-backend/auth/account_token";

const TOKEN_TTL_SEC = 120;
const READ_OPERATIONS = ["report"];
const ACTION_OPERATIONS = ["activate", "checkout", "heartbeat", "release", "renew"];

function activePepper(env, peppers) {
  const configured = env?.ACCOUNT_TOKEN_ACTIVE_PEPPER_ID;
  if (typeof configured === "string" && configured.length > 0 && peppers[configured] instanceof Uint8Array) {
    return { id: configured, bytes: peppers[configured] };
  }
  const keys = Object.keys(peppers);
  return keys.length > 0 ? { id: keys[0], bytes: peppers[keys[0]] } : null;
}

/**
 * mintSessionToken(env, session, { operationClass?, now? }) -> { ok, raw?, code }
 *
 * session: { customer_id } from resolveSession — the ONLY identity source (invariant 2).
 * operationClass: "read" (default) or "action" — selects the pinned operations axis.
 *
 *   { ok:false, code:"config_error" }    ACCOUNT_TOKEN_PEPPERS unset (worker -> 503).
 *   { ok:false, code:"no_entitlements" } the customer owns no entitlements (nothing to scope to).
 *   { ok:true,  raw, code:"ok" }         the ephemeral plaintext token (used ONCE, then discarded;
 *                                        never returned to the browser, never persisted client-side).
 */
export async function mintSessionToken(env, session, { operationClass = "read", now = Math.floor(Date.now() / 1000) } = {}) {
  const customerId = session?.customer_id;
  if (typeof customerId !== "string" || customerId.length === 0) {
    return { ok: false, code: "config_error" };
  }
  const peppers = loadPepperMap(env);
  if (peppers === null) return { ok: false, code: "config_error" };
  const active = activePepper(env, peppers);
  if (active === null) return { ok: false, code: "config_error" };

  // Pin projects/features to the customer's OWN entitlements (never "*"). Bound by customer_id.
  const rows = await env.DB.prepare(
    "SELECT DISTINCT project, feature FROM entitlements WHERE customer_id = ?",
  ).bind(customerId).all();
  const list = rows?.results ?? [];
  const projects = [...new Set(list.map((r) => r.project))];
  const features = [...new Set(list.map((r) => r.feature))];
  if (projects.length === 0 || features.length === 0) {
    return { ok: false, code: "no_entitlements" };
  }

  const operations = operationClass === "action" ? ACTION_OPERATIONS : READ_OPERATIONS;
  const scopes = JSON.stringify({ projects, features, operations });

  // buildIssue mints an opaque lcca_ token, hashes it under the active pepper, and returns the INSERT
  // (guarded on customers active) + audit row, plus the plaintext for one-time use. We run the SQL as
  // a batch so the token row + audit land atomically, then proxy with the plaintext and discard it.
  const built = await buildIssue(
    {
      "customer-id": customerId,
      name: `portal-${operationClass}`,
      scopes,
      "expires-at": String(now + TOKEN_TTL_SEC),
      actor: "portal",
    },
    { now, pepperBytes: active.bytes, _idOverride: undefined, "pepper-key-id": active.id },
  );

  // Execute the two statements. buildIssue's sql is "INSERT...;\nINSERT..." — split and batch so the
  // guarded token INSERT + its audit row commit together. The token INSERT is guarded (customer must
  // be active), so a disabled customer mints nothing.
  const statements = built.sql.split(";\n").map((s) => env.DB.prepare(s));
  if (typeof env.DB.batch === "function") {
    await env.DB.batch(statements);
  } else {
    for (const stmt of statements) await stmt.run();
  }

  return { ok: true, raw: built.plaintext, code: "ok" };
}

/**
 * proxyBackend(env, path, token, body) -> Response
 *
 * Forwards an /api/portal action to ${BACKEND_ORIGIN}/v1/* with Authorization: Bearer <ephemeral
 * account token>. The backend (ACCOUNT_TOKEN_MODE=required) is the authoritative isolation boundary.
 *
 * On a non-2xx upstream we pass the JSON body through but STRIP the upstream Authorization (and any
 * Set-Cookie / sensitive headers) so a backend echo can never leak the bearer back to the browser.
 */
export async function proxyBackend(env, path, token, body) {
  const origin = (env?.BACKEND_ORIGIN ?? "").replace(/\/$/, "");
  if (origin.length === 0) {
    return new Response(JSON.stringify({ ok: false, code: "backend_unconfigured" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  let upstream;
  try {
    upstream = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    return new Response(JSON.stringify({ ok: false, code: "backend_unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  // Re-emit ONLY the body + content-type. Never forward upstream Authorization / Set-Cookie / other
  // headers (the ephemeral bearer must not round-trip to the browser).
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export const _internals = { TOKEN_TTL_SEC, READ_OPERATIONS, ACTION_OPERATIONS };
