// portal-worker IDOR / isolation matrix (blueprint (g)). Ported from the backend's
// account_isolation.test.mjs discipline: drive the REAL worker fetch() over a node:sqlite DB built
// from the SHARED migrations, asserting that EVERY /api/portal route binds the session-derived
// customer_id and that no client-supplied tuple/customer_id can cross an account boundary.
// Requires node:sqlite.

import assert from "node:assert/strict";
import worker from "../dist-worker/worker/index.js";
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

// --- session helpers (mint a real session cookie for a customer) ----------------------------------

export async function cookieFor(env, customerId) {
  const minted = await mintSession(env, { customerId, now: NOW });
  return `lccp_session=${minted.raw}`;
}

export function sameSiteHeaders(extra = {}) {
  return { "content-type": "application/json", origin: "https://portal.test", "sec-fetch-site": "same-origin", ...extra };
}

export async function call(env, method, path, { cookie, body, headers, ctx = CTX } = {}) {
  const h = sameSiteHeaders(headers);
  if (cookie) h.cookie = cookie;
  const req = new Request(`https://portal.test${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await worker.fetch(req, env, ctx);
  let parsed = null;
  const text = await res.clone().text();
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, res };
}

// Two customers, each owning one protected grant: A's and B's rows share project and feature and
// differ only by owner and fingerprint, so every isolation assertion turns on the session customer.
export function baseFixture(extraEnv = {}) {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  seedCustomer(db, "B", "b@x.com");
  seedEntitlement(db, { fingerprint: FP_A, customerId: "A" });
  seedEntitlement(db, { fingerprint: FP_B, customerId: "B" });
  const env = portalEnv(db, extraEnv);
  return { db, env };
}

// Fails fast (rather than hanging) when a promise never settles -- e.g. if a handler starts
// awaiting DB work that a test is deliberately holding open with a gate.
export async function within(promise, milliseconds = 250) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export {
  assert,
  worker,
  mintSession,
  codeFromSecretBytes,
  requestOtp,
  redeemOtp,
  freshDb,
  portalEnv,
  seedCustomer,
  seedEntitlement,
  CTX,
  NOW,
};
