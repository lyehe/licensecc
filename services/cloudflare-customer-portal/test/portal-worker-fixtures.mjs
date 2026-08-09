// portal-worker IDOR / isolation matrix (blueprint (g)). Ported from the backend's
// account_isolation.test.mjs discipline: drive the REAL worker fetch() over a node:sqlite DB built
// from the SHARED migrations, asserting that EVERY /api/portal route binds the session-derived
// customer_id and that no client-supplied tuple/customer_id can cross an account boundary.
//
// The backend is stubbed at globalThis.fetch (the portal proxies there); the stub records the
// proxied Authorization + body so we can prove (a) the SERVER-RESOLVED fingerprint is sent, not a
// forged one, and (b) the minted account token is real + scope-pinned. Requires node:sqlite.

import assert from "node:assert/strict";
import worker from "../dist-worker/worker/index.js";
import { policyCapacityViolation } from "@licensecc/licensing-domain/entitlements/policy";
import {
  freshDb,
  portalEnv,
  seedCustomer,
  seedEntitlement,
  CTX,
  NOW,
} from "./helpers.mjs";
import { mintSession } from "../src/auth/portal_session.mjs";
import { codeFromSecretBytes, requestOtp, redeemOtp } from "../src/auth/portal_otp.mjs";

export const FP_A = "a".repeat(64);
export const FP_B = "b".repeat(64);

// --- backend proxy stub --------------------------------------------------------------------------

export function installBackendStub() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const auth = (init.headers && (init.headers.authorization ?? init.headers.Authorization)) ?? null;
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
    calls.push({ url: String(url), auth, body });
    // Canned canonical 200 response. Echo the bearer back in an otherwise-valid body to PROVE the
    // portal's success sanitizer strips it (a hostile/buggy backend must not leak it to the browser).
    const target = new URL(String(url)).pathname;
    const response = target.endsWith("/v1/checkout")
      ? { ok: true, assertion: "lccoa1-checkout-assertion", seat_id: "seat-1", mode: "live", server_time: NOW, expires_at: NOW + 3600, heartbeat_in: 60, echoed_auth: auth }
      : target.endsWith("/v1/heartbeat")
        ? { ok: true, assertion: "lccoa1-heartbeat-assertion", server_time: NOW, expires_at: NOW + 3600, heartbeat_in: 60, echoed_auth: auth }
        : target.endsWith("/v1/release")
          ? { ok: true, server_time: NOW, echoed_auth: auth }
          : { ok: true, lic: "SIGNED-LIC-BYTES", server_time: NOW, renew_by: NOW + 1800, valid_to_epoch: NOW + 86400, echoed_auth: auth };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json", authorization: auth ?? "" },
    });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// --- session helpers (mint a real session cookie for a customer) ----------------------------------

export async function cookieFor(env, customerId) {
  const minted = await mintSession(env, { customerId, now: NOW });
  return `lccp_session=${minted.raw}`;
}

export function sameSiteHeaders(extra = {}) {
  return { "content-type": "application/json", origin: "https://portal.test", "sec-fetch-site": "same-origin", ...extra };
}

export function entitlementId(project, feature, fingerprint) {
  return btoa(JSON.stringify([project, feature, fingerprint])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function ownedEntitlementId(env, cookie) {
  const r = await call(env, "GET", "/api/portal/entitlements", { cookie });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.data.items[0].id, "string");
  return r.body.data.items[0].id;
}

export async function call(env, method, path, { cookie, body, headers } = {}) {
  const h = sameSiteHeaders(headers);
  if (cookie) h.cookie = cookie;
  const req = new Request(`https://portal.test${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await worker.fetch(req, env, CTX);
  let parsed = null;
  const text = await res.clone().text();
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, res };
}

export function baseFixture(extraEnv = {}) {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  seedCustomer(db, "B", "b@x.com");
  seedEntitlement(db, { fingerprint: FP_A, customerId: "A" });
  seedEntitlement(db, { fingerprint: FP_B, customerId: "B" });
  const env = portalEnv(db, extraEnv);
  return { db, env };
}

// =================================================================================================
// READS — A sees only A
// =================================================================================================

// DEVICE RELEASE — self-serve deactivation (ownership-scoped, guarded, audited)
// =================================================================================================

export function seedDevice(db, { project = "DEFAULT", feature = "DEFAULT", fingerprint, deviceKeyId, status = "active" }) {
  db.prepare(
    "INSERT INTO entitlement_devices (project, feature, license_fingerprint, device_key_id, public_key_spki_der_base64, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', ?, ?, ?)",
  ).run(project, feature, fingerprint, deviceKeyId, status, NOW, NOW);
}
export {
  assert,
  worker,
  mintSession,
  codeFromSecretBytes,
  requestOtp,
  redeemOtp,
  policyCapacityViolation,
  freshDb,
  portalEnv,
  seedCustomer,
  seedEntitlement,
  CTX,
  NOW,
};
