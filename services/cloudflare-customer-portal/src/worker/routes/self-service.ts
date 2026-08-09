// Session-scoped customer data, device release, seat actions, and signed downloads.

import * as tokenModule from "../../auth/portal_token.mjs";
import * as ratelimitModule from "../../auth/portal_ratelimit.mjs";
import { backendOrigin } from "../../auth/portal_destination.mjs";
import type { Env, SessionRow } from "../env.js";
import {
  clientIp,
  decodeEntitlementId,
  envelope,
  isCrossSite,
  readJson,
  withPortalEntitlement,
  type OwnedEntitlement,
} from "../support.js";

type AnyFn = (...args: any[]) => any;
const mintSessionToken = (tokenModule as { mintSessionToken: AnyFn }).mintSessionToken;
const proxyBackend = (tokenModule as { proxyBackend: AnyFn }).proxyBackend;
const portalRateLimit = (ratelimitModule as { portalRateLimit: AnyFn }).portalRateLimit;

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
  // Ownership EXISTS: only ACTIVE devices on entitlements the session customer owns. A device the
  // customer released (self-serve, below) or an admin revoked/disabled flips out of 'active' and so
  // drops off the customer-facing listing — the Devices tab shows only devices currently holding a slot.
  const rows = await env.DB.prepare(
    "SELECT d.project, d.feature, d.license_fingerprint, d.device_key_id, d.created_at " +
      "FROM entitlement_devices d " +
      "WHERE d.status = 'active' AND EXISTS (SELECT 1 FROM entitlements e WHERE e.project = d.project AND e.feature = d.feature " +
      "AND e.license_fingerprint = d.license_fingerprint AND e.customer_id = ?) " +
      "ORDER BY d.created_at DESC LIMIT 500",
  ).bind(session.customer_id).all();
  return envelope(reqId, "devices", { items: rows.results });
}

// POST /api/portal/devices/release — SELF-SERVE device deactivation (finding 11). Frees the slot a
// node-locked/proof-carrying device holds so a customer can swap hardware without escalating. Fully
// SESSION-SCOPED: the device is resolved through the SAME ownership EXISTS as apiDevices, so a foreign
// or absent device is the SAME generic not_found (invariant 4 — no existence oracle). The write is an
// atomic guarded transition mirroring the admin device-revoke: it (1) bumps the entitlement
// revocation_seq (so the released device is refused by online-verify on its next check), (2) flips
// the device out of 'active', and (3) appends the 'portal_device_release' audit event — ALL in one
// guarded D1 batch. A statement failure rolls the full sequence back; a lost race matches 0 rows and
// yields 409, with neither a torn slot change nor a phantom audit.
async function apiDeviceRelease(
  request: Request,
  env: Env,
  session: { customer_id: string },
  reqId: string,
  now: number,
): Promise<Response> {
  if (isCrossSite(request, env)) return envelope(reqId, "cross_site_forbidden", undefined, 403);
  // Always-on per-session throttle (invariant 5 discipline) so the release surface cannot be hammered.
  const rl = await portalRateLimit(env, `device_release:cust:${session.customer_id}`, 30, 900, now);
  if (rl.limited) return envelope(reqId, "rate_limited", undefined, 429);
  const body = await readJson(request, reqId);
  if (body instanceof Response) return body;
  const deviceKeyId = typeof body.device_key_id === "string" ? body.device_key_id : "";
  if (deviceKeyId === "" || deviceKeyId.length > 512) return envelope(reqId, "invalid_request", undefined, 400);

  // Ownership-scoped pre-read: 0 rows -> generic not_found (foreign/absent are indistinguishable).
  const device = await env.DB.prepare(
    "SELECT d.project AS project, d.feature AS feature, d.license_fingerprint AS license_fingerprint, d.status AS status " +
      "FROM entitlement_devices d " +
      "WHERE d.device_key_id = ? AND EXISTS (SELECT 1 FROM entitlements e WHERE e.project = d.project AND e.feature = d.feature " +
      "AND e.license_fingerprint = d.license_fingerprint AND e.customer_id = ?) LIMIT 1",
  ).bind(deviceKeyId, session.customer_id).first<{ project: string; feature: string; license_fingerprint: string; status: string }>();
  if (device === null) return envelope(reqId, "not_found", undefined, 404);
  // Already released/revoked/disabled: nothing to free (guarded-transition convention).
  if (device.status !== "active") return envelope(reqId, "device_status_conflict", undefined, 409);

  // The guarded state change MUST be one transaction: bumping revocation_seq without flipping the
  // device (or vice versa) would be a torn slot change. Real D1 always exposes batch(); a missing
  // batch() is a degraded/mocked binding — fail closed rather than write un-transactioned.
  if (env.DB.batch === undefined) return envelope(reqId, "portal_error", undefined, 500);
  const detail = `portal-device-release ${deviceKeyId}`;
  // (1) Guarded revocation_seq bump — the WHERE re-asserts the device is STILL active + owner-matched,
  // so a release/removal landing between the pre-read and here yields 0 rows (RETURNING empty -> 409).
  const bump = env.DB.prepare(
    "UPDATE entitlements SET revocation_seq = max(revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events " +
      "WHERE project = entitlements.project AND feature = entitlements.feature AND license_fingerprint = entitlements.license_fingerprint), revocation_seq)) + 1, " +
      "updated_at = ? WHERE project = ? AND feature = ? AND license_fingerprint = ? AND customer_id = ? " +
      "AND EXISTS (SELECT 1 FROM entitlement_devices d WHERE d.project = entitlements.project AND d.feature = entitlements.feature " +
      "AND d.license_fingerprint = entitlements.license_fingerprint AND d.device_key_id = ? AND d.status = 'active') RETURNING revocation_seq",
  ).bind(now, device.project, device.feature, device.license_fingerprint, session.customer_id, deviceKeyId);
  // (2) Flip the device out of 'active', repeating the entitlement ownership guard. This closes the
  // ownership-transfer TOCTOU: if the entitlement changed hands after the pre-read, BOTH statements
  // return zero rows in the atomic batch, so the new owner's device remains active.
  const flip = env.DB.prepare(
    "UPDATE entitlement_devices SET status = 'revoked', updated_at = ? WHERE project = ? AND feature = ? AND license_fingerprint = ? " +
      "AND device_key_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM entitlements e WHERE e.project = entitlement_devices.project " +
      "AND e.feature = entitlement_devices.feature AND e.license_fingerprint = entitlement_devices.license_fingerprint AND e.customer_id = ?) " +
      "RETURNING device_key_id",
  ).bind(now, device.project, device.feature, device.license_fingerprint, deviceKeyId, session.customer_id);

  // (3) Append the audit within the SAME transaction. `changes() = 1` is transaction-visible SQLite
  // state from the preceding guarded flip, while the entitlement's current `revocation_seq` is the
  // freshly bumped value. Together with the fresh timestamps and ownership predicates, this cannot
  // produce an audit row for a lost pre-read race.
  const audit = env.DB.prepare(
    "INSERT INTO entitlement_events (project, feature, license_fingerprint, device_hash, event_type, status, revocation_seq, detail, actor, actor_type, source, request_id, ip, reason, created_at) " +
      "SELECT e.project, e.feature, e.license_fingerprint, '', 'revoke', e.status, e.revocation_seq, ?, ?, 'system', 'portal', ?, ?, 'portal_device_release', ? " +
      "FROM entitlements e WHERE changes() = 1 AND e.project = ? AND e.feature = ? AND e.license_fingerprint = ? " +
      "AND e.customer_id = ? AND e.updated_at = ? AND EXISTS (SELECT 1 FROM entitlement_devices d WHERE d.project = e.project " +
      "AND d.feature = e.feature AND d.license_fingerprint = e.license_fingerprint AND d.device_key_id = ? " +
      "AND d.status = 'revoked' AND d.updated_at = ?) RETURNING revocation_seq",
  ).bind(
    detail,
    session.customer_id,
    reqId,
    clientIp(request),
    now,
    device.project,
    device.feature,
    device.license_fingerprint,
    session.customer_id,
    now,
    deviceKeyId,
    now,
  );

  const results = await env.DB.batch([bump, flip, audit]);
  const bumpRows = results[0]?.results;
  const flipRows = results[1]?.results;
  const auditRows = results[2]?.results;
  if ([bumpRows, flipRows, auditRows].every((rows) => Array.isArray(rows) && rows.length === 0)) {
    // A lost release/removal/ownership transfer matches zero rows for every guarded statement under
    // D1's atomic batch, so no state or audit side effect is emitted.
    return envelope(reqId, "device_status_conflict", undefined, 409);
  }
  if (!Array.isArray(bumpRows) || bumpRows.length !== 1 || !Array.isArray(flipRows) || flipRows.length !== 1 || !Array.isArray(auditRows) || auditRows.length !== 1) {
    return envelope(reqId, "portal_error", undefined, 500);
  }
  // The audit must carry the freshly bumped sequence from the same transaction. A mismatch signals a
  // broken/mock D1 contract, so fail closed instead of claiming a successful release.
  const bumped = bumpRows[0];
  const audited = auditRows[0];
  const bumpedSeq = bumped !== null && typeof bumped === "object" && "revocation_seq" in bumped && typeof bumped.revocation_seq === "number"
    ? bumped.revocation_seq
    : null;
  const auditedSeq = audited !== null && typeof audited === "object" && "revocation_seq" in audited && typeof audited.revocation_seq === "number"
    ? audited.revocation_seq
    : null;
  if (bumpedSeq === null || auditedSeq === null || bumpedSeq !== auditedSeq) return envelope(reqId, "portal_error", undefined, 500);
  return envelope(reqId, "device_released", { device_key_id: deviceKeyId });
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
export async function resolveOwnedEntitlement(
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

  // Resolve the credential destination before minting an account token. A bad configuration cannot
  // cause a bearer to be created or sent anywhere.
  const origin = backendOrigin(env);
  if (origin === null) return envelope(reqId, "backend_unconfigured", undefined, 503);

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
  const proxied = await proxyBackend(origin, `/v1/${operation}`, minted.raw, proxyBody, operation);
  if (!proxied.ok) return envelope(reqId, proxied.code, undefined, proxied.status);
  // proxyBackend has already consumed the entire bounded upstream body while its abort timeout was
  // live, checked an exact 200 route-specific success envelope, and copied only approved fields.
  // Do not call Response.json() here: an unread response would reintroduce an unbounded path after
  // the credentialed fetch timer had been cleared.
  const code = typeof proxied.code === "string" ? proxied.code : `${operation}_ok`;
  return envelope(reqId, code, proxied.data, 200);
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

  // As with actions, destination validation precedes account-token minting and bearer construction.
  const origin = backendOrigin(env);
  if (origin === null) return envelope(reqId, "backend_unconfigured", undefined, 503);

  // Download performs an activate; scope the token to exactly this owned tuple + "activate" (R2.5).
  const minted = await mintSessionToken(env, session, {
    operationClass: "action",
    now,
    narrow: { project: entitlement.project, feature: entitlement.feature, operation: "activate" },
  });
  if (minted.code === "config_error") return envelope(reqId, "config_error", undefined, 503);
  if (!minted.ok) return envelope(reqId, "not_found", undefined, 404);

  const proxied = await proxyBackend(origin, "/v1/activate", minted.raw, {
    project: entitlement.project,
    feature: entitlement.feature,
    license_fingerprint: entitlement.license_fingerprint,
    device_key_id: deviceKeyId,
  }, "download");
  if (!proxied.ok) return envelope(reqId, proxied.code, undefined, proxied.status);
  const lic = typeof proxied.data?.lic === "string" ? proxied.data.lic : null;
  // Defence in depth for the attachment boundary. A successful proxy result is already required to
  // include a string `lic`; this fallback cannot reflect any upstream body if that invariant drifts.
  if (lic === null) return envelope(reqId, "backend_invalid_response", undefined, 502);
  // Convert the backend's JSON lease body into an attachment while STRIPPING upstream Authorization
  // and Set-Cookie so the ephemeral bearer cannot leak back to the browser.
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="${entitlement.project}-${entitlement.feature}.lic"`,
    "cache-control": "no-store",
  });
  return new Response(lic, { status: 200, headers });
}

export const SESSION_DISPATCH = {
  "GET /api/portal/me": (_request: Request, _env: Env, session: SessionRow, reqId: string, _now: number) => apiMe(session, reqId),
  "GET /api/portal/entitlements": (_request: Request, env: Env, session: SessionRow, reqId: string, _now: number) => apiEntitlements(env, session, reqId),
  "GET /api/portal/devices": (_request: Request, env: Env, session: SessionRow, reqId: string, _now: number) => apiDevices(env, session, reqId),
  "POST /api/portal/devices/release": (request: Request, env: Env, session: SessionRow, reqId: string, now: number) => apiDeviceRelease(request, env, session, reqId, now),
  "GET /api/portal/usage": (_request: Request, env: Env, session: SessionRow, reqId: string, _now: number) => apiUsage(env, session, reqId),
  "POST /api/portal/checkout": (request: Request, env: Env, session: SessionRow, reqId: string, now: number) => apiAction(request, env, session, reqId, now, "checkout"),
  "POST /api/portal/heartbeat": (request: Request, env: Env, session: SessionRow, reqId: string, now: number) => apiAction(request, env, session, reqId, now, "heartbeat"),
  "POST /api/portal/release": (request: Request, env: Env, session: SessionRow, reqId: string, now: number) => apiAction(request, env, session, reqId, now, "release"),
  "POST /api/portal/download": (request: Request, env: Env, session: SessionRow, reqId: string, now: number) => apiDownload(request, env, session, reqId, now),
};
