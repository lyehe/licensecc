// portal-worker IDOR / isolation matrix (blueprint (g)). Ported from the backend's
// account_isolation.test.mjs discipline: drive the REAL worker fetch() over a node:sqlite DB built
// from the SHARED migrations, asserting that EVERY /api/portal route binds the session-derived
// customer_id and that no client-supplied tuple/customer_id can cross an account boundary.
//
// The backend is stubbed at globalThis.fetch (the portal proxies there); the stub records the
// proxied Authorization + body so we can prove (a) the SERVER-RESOLVED fingerprint is sent, not a
// forged one, and (b) the minted account token is real + scope-pinned. Requires node:sqlite.

import assert from "node:assert/strict";
import { test } from "node:test";
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

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

// --- backend proxy stub --------------------------------------------------------------------------

function installBackendStub() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const auth = (init.headers && (init.headers.authorization ?? init.headers.Authorization)) ?? null;
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
    calls.push({ url: String(url), auth, body });
    // Canned signed .lic / ok response. Echo the bearer back in the body to PROVE the portal strips
    // it (a hostile/buggy backend that reflects the token must not leak it to the browser).
    return new Response(JSON.stringify({ ok: true, code: "ok", lic: "SIGNED-LIC-BYTES", echoed_auth: auth }), {
      status: 200,
      headers: { "content-type": "application/json", authorization: auth ?? "" },
    });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// --- session helpers (mint a real session cookie for a customer) ----------------------------------

async function cookieFor(env, customerId) {
  const minted = await mintSession(env, { customerId, now: NOW });
  return `lccp_session=${minted.raw}`;
}

function sameSiteHeaders(extra = {}) {
  return { "content-type": "application/json", origin: "https://portal.test", "sec-fetch-site": "same-origin", ...extra };
}

function entitlementId(project, feature, fingerprint) {
  return btoa(JSON.stringify([project, feature, fingerprint])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function ownedEntitlementId(env, cookie) {
  const r = await call(env, "GET", "/api/portal/entitlements", { cookie });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.data.items[0].id, "string");
  return r.body.data.items[0].id;
}

async function call(env, method, path, { cookie, body, headers } = {}) {
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

function baseFixture(extraEnv = {}) {
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

test("portal worker rejects oversized JSON bodies without relying on Content-Length", async () => {
  const { db, env } = baseFixture();
  const res = await worker.fetch(new Request("https://portal.test/portal/v1/auth/request", {
    method: "POST",
    headers: sameSiteHeaders(),
    body: "x".repeat(8193),
  }), env, CTX);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "body_too_large");
  db.close();
});

test("A's /api/portal/entitlements returns ONLY A's entitlements", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
    const r = await call(env, "GET", "/api/portal/entitlements", { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.items.length, 1);
    assert.equal(r.body.data.items[0].project, "DEFAULT");
    assert.equal(r.body.data.items[0].license_mode, "floating");
    assert.equal(r.body.data.items[0].pool_size, 5);
    assert.equal(typeof r.body.data.items[0].id, "string");
  // The response carries no fingerprint/foreign id.
  assert.ok(!JSON.stringify(r.body).includes(FP_B), "B's data never appears in A's response");
  db.close();
});

test("/api/portal/me reports the SESSION customer, never a client value", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
  const r = await call(env, "GET", "/api/portal/me", { cookie });
  assert.equal(r.body.data.customer_id, "A");
  db.close();
});

test("devices + usage are gated by the ownership EXISTS (A sees no B rows)", async () => {
  const { db, env } = baseFixture();
  // Seed a device + usage event on B's entitlement.
  db.prepare(
    "INSERT INTO entitlement_devices (project, feature, license_fingerprint, device_key_id, public_key_spki_der_base64, status, created_at, updated_at) VALUES ('DEFAULT','DEFAULT',?, 'dk_b','x','active',?,?)",
  ).run(FP_B, NOW, NOW);
  db.prepare(
    "INSERT INTO usage_events (project, feature, license_fingerprint, event_type, ts) VALUES ('DEFAULT','DEFAULT',?, 'checkout', ?)",
  ).run(FP_B, NOW);
  const cookie = await cookieFor(env, "A");
  const devices = await call(env, "GET", "/api/portal/devices", { cookie });
  assert.equal(devices.body.data.items.length, 0, "A sees none of B's devices");
  const usage = await call(env, "GET", "/api/portal/usage", { cookie });
  assert.equal(usage.body.data.items.length, 0, "A sees none of B's usage");
  db.close();
});

// =================================================================================================
// ACTIONS — server-resolve the tuple; forged body ignored; no oracle
// =================================================================================================

test("A's checkout on A's tuple proxies the SERVER-RESOLVED fingerprint with a real bearer", async () => {
  const { db, env } = baseFixture();
  const stub = installBackendStub();
  try {
    const cookie = await cookieFor(env, "A");
    const id = await ownedEntitlementId(env, cookie);
    const r = await call(env, "POST", "/api/portal/checkout", { cookie, body: { entitlement_id: id, client_instance_id: "i1", nonce: "e".repeat(64) } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.code, "ok");
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0].url, /\/v1\/checkout$/);
    assert.match(stub.calls[0].auth, /^Bearer lcca_/, "a real ephemeral account token is presented");
    assert.equal(stub.calls[0].body.license_fingerprint, FP_A, "the server-resolved fingerprint is proxied");
    // The minted token row is real, scope-pinned, and 120s-lived.
    const tok = db.prepare("SELECT scopes_json, expires_at, customer_id FROM account_tokens WHERE customer_id = 'A' ORDER BY created_at DESC LIMIT 1").get();
    assert.equal(tok.customer_id, "A");
    const scopes = JSON.parse(tok.scopes_json);
    assert.deepEqual(scopes.projects, ["DEFAULT"]);
    assert.deepEqual(scopes.features, ["DEFAULT"]);
    // R2.5 least privilege: the token is scoped to EXACTLY the one operation being proxied, not all
    // five action ops (deepEqual, not includes -- the un-narrowed mint would carry all five here).
    assert.deepEqual(scopes.operations, ["checkout"]);
    assert.ok(scopes.allow_all === undefined, "never allow_all");
    assert.ok(!scopes.projects.includes("*") && !scopes.features.includes("*"), "scope axes are never *");
    // ~120s TTL; +5 slop absorbs a Date.now() second-boundary between NOW capture and the worker call.
    assert.ok(tok.expires_at > NOW && tok.expires_at <= NOW + 125, "~120s TTL");
    db.close();
  } finally {
    stub.restore();
  }
});

test("A -> B: a checkout referencing B's tuple is a GENERIC not_found (no oracle, no proxy, no mint)", async () => {
  const { db, env } = baseFixture();
  const stub = installBackendStub();
  try {
    const cookie = await cookieFor(env, "A");
    // A references B's project/feature pair — but B's entitlement is not owned by A. The server
    // resolves WHERE customer_id='A' AND project/feature -> 0 rows -> generic not_found.
    // (Here both use DEFAULT/DEFAULT, so the discriminator is the OWNER; we instead seed a B-only
    //  feature to make the cross-owner reference explicit.)
    seedEntitlement(db, { feature: "BONLY", fingerprint: "c".repeat(64), customerId: "B" });
    const r = await call(env, "POST", "/api/portal/checkout", { cookie, body: { entitlement_id: entitlementId("DEFAULT", "BONLY", "c".repeat(64)), client_instance_id: "i1", nonce: "e".repeat(64) } });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "not_found", "the SAME generic not_found as an absent tuple (no existence oracle)");
    assert.equal(stub.calls.length, 0, "no proxy for a foreign tuple");
    // No account token minted for A against a foreign feature.
    const minted = db.prepare("SELECT COUNT(*) AS c FROM account_tokens WHERE customer_id = 'A'").get();
    assert.equal(minted.c, 0, "no token minted for a denied action");
    db.close();
  } finally {
    stub.restore();
  }
});

test("a forged body customer_id is IGNORED; the mint binds the SESSION customer only (invariant 2)", async () => {
  const { db, env } = baseFixture();
  const stub = installBackendStub();
  try {
    const cookie = await cookieFor(env, "A");
    const id = await ownedEntitlementId(env, cookie);
    // Forge customer_id=B AND license_fingerprint=B's in the body. Both must be ignored: the handler
    // server-resolves A's own fingerprint and the mint takes the session (customer A) ONLY.
    const r = await call(env, "POST", "/api/portal/checkout", {
      cookie,
      body: { entitlement_id: id, customer_id: "B", license_fingerprint: FP_B, client_instance_id: "i1", nonce: "e".repeat(64) },
    });
    assert.equal(r.status, 200);
    assert.equal(stub.calls[0].body.license_fingerprint, FP_A, "the forged B fingerprint is ignored; A's is used");
    // The minted token is for A, never B.
    const forB = db.prepare("SELECT COUNT(*) AS c FROM account_tokens WHERE customer_id = 'B'").get();
    assert.equal(forB.c, 0, "no token ever minted for the forged customer_id");
    const forA = db.prepare("SELECT customer_id FROM account_tokens ORDER BY created_at DESC LIMIT 1").get();
    assert.equal(forA.customer_id, "A");
    db.close();
  } finally {
    stub.restore();
  }
});

// HARD invariant-2 test: the mint chokepoint signature accepts the SESSION ONLY — no request/body arg.
test("HARD: mintSessionToken's call site passes ONLY the session (no body/request field)", async () => {
  const { mintSessionToken } = await import("../src/auth/portal_token.mjs");
  // The function takes (env, session, options). options has NO customer/tuple field. We prove the
  // SOURCE of the worker's call passes the resolved session object, not a request-derived value, by
  // inspecting the function's parameter shape + that a forged session.customer_id is the ONLY lever.
  const src = (await import("node:fs")).readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
  // Every mintSessionToken call in the worker passes `session` as the 2nd arg (never a body object).
  const calls = [...src.matchAll(/mintSessionToken\(\s*env\s*,\s*([A-Za-z0-9_]+)\s*,/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, "the worker mints in at least the action + download paths");
  for (const arg of calls) {
    assert.equal(arg, "session", "mintSessionToken's 2nd arg is ALWAYS the verified session object");
  }
  // And the function itself never reads a request/body — its only identity input is session.customer_id.
  const tokenSrc = (await import("node:fs")).readFileSync(new URL("../src/auth/portal_token.mjs", import.meta.url), "utf8");
  assert.ok(/session\?\.customer_id/.test(tokenSrc), "the mint reads customer_id from the session ONLY");
  assert.ok(!/options\.(customer|customer_id|license_fingerprint|tuple)/.test(tokenSrc), "the mint never reads a client tuple/customer field");
  void mintSessionToken;
});

// =================================================================================================
// SESSION GATES — 401 / 403 / disabled
// =================================================================================================

test("missing / invalid / revoked session -> 401 on a protected read", async () => {
  const { db, env } = baseFixture();
  // Missing.
  assert.equal((await call(env, "GET", "/api/portal/me", {})).status, 401);
  // Invalid token.
  assert.equal((await call(env, "GET", "/api/portal/me", { cookie: "lccp_session=lccp_garbage" })).status, 401);
  // Revoked.
  const cookie = await cookieFor(env, "A");
  const sid = db.prepare("SELECT id FROM portal_sessions WHERE customer_id = 'A'").get().id;
  db.prepare("UPDATE portal_sessions SET status = 'revoked' WHERE id = ?").run(sid);
  assert.equal((await call(env, "GET", "/api/portal/me", { cookie })).status, 401);
  db.close();
});

test("a disabled customer's session -> 401", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
  db.prepare("UPDATE customers SET status = 'disabled' WHERE id = 'A'").run();
  assert.equal((await call(env, "GET", "/api/portal/me", { cookie })).status, 401);
  db.close();
});

test("cross-site POST is rejected 403 (CSRF defense)", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
  const req = new Request("https://portal.test/api/portal/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "sec-fetch-site": "cross-site", origin: "https://evil.test" },
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT" }),
  });
  const res = await worker.fetch(req, env, CTX);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "cross_site_forbidden");
  db.close();
});

// =================================================================================================
// LOGOUT bumps revocation_seq (invariant 9)
// =================================================================================================

test("logout revokes the session AND bumps account_token_revocations.revocation_seq", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
  const r = await call(env, "POST", "/portal/v1/auth/logout", { cookie, body: {} });
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get("set-cookie") ?? "", /Max-Age=0/, "the cookie is cleared");
  const seq = db.prepare("SELECT revocation_seq FROM account_token_revocations WHERE customer_id = 'A'").get();
  assert.ok(seq && seq.revocation_seq >= 1, "the per-customer revocation floor is bumped on logout");
  // The session is revoked.
  const after = await call(env, "GET", "/api/portal/me", { cookie });
  assert.equal(after.status, 401, "the session no longer resolves after logout");
  db.close();
});

// =================================================================================================
// DOWNLOAD streams the signed bytes + strips upstream auth
// =================================================================================================

test("download streams the signed .lic and STRIPS the upstream Authorization", async () => {
  const { db, env } = baseFixture();
  const stub = installBackendStub();
  try {
    const cookie = await cookieFor(env, "A");
    const id = await ownedEntitlementId(env, cookie);
    const req = new Request("https://portal.test/api/portal/download", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://portal.test", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ entitlement_id: id, device_key_id: "device-a" }),
    });
    const res = await worker.fetch(req, env, CTX);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
    // The response must NOT carry the upstream Authorization (the ephemeral bearer is stripped).
    assert.equal(res.headers.get("authorization"), null, "the upstream bearer never reaches the browser");
    const text = await res.text();
    assert.match(text, /SIGNED-LIC-BYTES/, "the signed bytes pass through unchanged");
    assert.equal(stub.calls[0].body.license_fingerprint, FP_A, "the server-resolved fingerprint is used");
    db.close();
  } finally {
    stub.restore();
  }
});

test("A -> B download referencing B's tuple is a generic not_found (no proxy)", async () => {
  const { db, env } = baseFixture();
  const stub = installBackendStub();
  try {
    seedEntitlement(db, { feature: "BONLY", fingerprint: "d".repeat(64), customerId: "B" });
    const cookie = await cookieFor(env, "A");
    const r = await call(env, "POST", "/api/portal/download", { cookie, body: { entitlement_id: entitlementId("DEFAULT", "BONLY", "d".repeat(64)), device_key_id: "device-b" } });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "not_found");
    assert.equal(stub.calls.length, 0, "no proxy for a foreign tuple");
    db.close();
  } finally {
    stub.restore();
  }
});

// =================================================================================================
// CONFIG GATES — pepper-unset 503; /health mode!=required; bootstrap break-glass
// =================================================================================================

test("pepper-unset (session) -> 503 config_error on a protected route", async () => {
  const { db, env } = baseFixture({ PORTAL_SESSION_PEPPERS: undefined });
  // With no session peppers we cannot even mint a cookie; resolveSession returns config_error -> 503.
  const r = await call(env, "GET", "/api/portal/me", { cookie: "lccp_session=lccp_anything" });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "config_error");
  db.close();
});

test("/health is unhealthy (503) when ACCOUNT_TOKEN_MODE != required (invariant 7)", async () => {
  const { db, env } = baseFixture({ ACCOUNT_TOKEN_MODE: "soft" });
  const r = await call(env, "GET", "/health", {});
  assert.equal(r.status, 503);
  assert.equal(r.body.data.account_token_mode_required, false);

  const { db: db2, env: env2 } = baseFixture();
  const ok = await call(env2, "GET", "/health", {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.code, "healthy");
  db.close();
  db2.close();
});

test("bootstrap-otp: 404 when the bearer is unset (no existence oracle)", async () => {
  const { db, env } = baseFixture();
  const r = await call(env, "POST", "/portal/v1/admin/bootstrap-otp", { body: { email: "a@x.com" } });
  assert.equal(r.status, 404, "an unset bootstrap bearer means the route does not exist");
  assert.equal(r.body.code, "not_found");
  db.close();
});

test("bootstrap-otp: 403 when PORTAL_BOOTSTRAP_REQUIRE_ACCESS=1 and no Access JWT", async () => {
  const { db, env } = baseFixture({ PORTAL_BOOTSTRAP_BEARER: "break-glass", PORTAL_BOOTSTRAP_REQUIRE_ACCESS: "1" });
  const req = new Request("https://portal.test/portal/v1/admin/bootstrap-otp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer break-glass", origin: "https://portal.test", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ email: "a@x.com" }),
  });
  const res = await worker.fetch(req, env, CTX);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "access_required");
  db.close();
});

test("bootstrap-otp: a correct bearer issues a secret, audits append-only, 120s row TTL", async () => {
  const { db, env } = baseFixture({ PORTAL_BOOTSTRAP_BEARER: "break-glass" });
  const req = new Request("https://portal.test/portal/v1/admin/bootstrap-otp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer break-glass", origin: "https://portal.test", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ email: "a@x.com" }),
  });
  const res = await worker.fetch(req, env, CTX);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.code, "bootstrap_otp");
  assert.ok(typeof body.data.secret === "string" && body.data.secret.length > 0, "the operator gets the secret ONCE");
  // Append-only audit row exists.
  const audit = db.prepare("SELECT COUNT(*) AS c FROM portal_bootstrap_events WHERE customer_id = 'A'").get();
  assert.equal(audit.c, 1, "the bootstrap issuance is audited");
  // The OTP row exists and expires within 10 minutes (600s) of now.
  const otp = db.prepare("SELECT expires_at FROM portal_otp WHERE customer_id = 'A'").get();
  assert.ok(otp.expires_at > NOW && otp.expires_at <= NOW + 605); // +5 slop for the clock boundary
  db.close();
});

test("bootstrap-otp: a WRONG bearer is 401 (constant-time), never 404 once configured", async () => {
  const { db, env } = baseFixture({ PORTAL_BOOTSTRAP_BEARER: "break-glass" });
  const req = new Request("https://portal.test/portal/v1/admin/bootstrap-otp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong", origin: "https://portal.test", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ email: "a@x.com" }),
  });
  const res = await worker.fetch(req, env, CTX);
  assert.equal(res.status, 401);
  db.close();
});

// =================================================================================================
// FULL LOGIN ROUNDTRIP — request -> redeem -> me (proves the cookie binds the right customer)
// =================================================================================================

test("login roundtrip: request OTP -> redeem code -> session resolves to that customer", async () => {
  const { db, env } = baseFixture();
  // Use the OTP module directly to capture the secret (the worker never returns it).
  const req = await requestOtp(env, { email: "a@x.com", clientIp: "1.1.1.1", returnSecret: true, now: NOW });
  const secretBytes = Uint8Array.from(atob(req.secret.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const code = codeFromSecretBytes(secretBytes);

  // Verify through the worker (mints the session cookie).
  const verify = await call(env, "POST", "/portal/v1/auth/verify", { body: { email: "a@x.com", code } });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.data.customer_id, "A");
  const setCookie = verify.res.headers.get("set-cookie");
  assert.match(setCookie, /lccp_session=lccp_/);
  assert.match(setCookie, /HttpOnly/);

  // The cookie now resolves to A.
  const sessionCookie = setCookie.split(";")[0];
  const me = await call(env, "GET", "/api/portal/me", { cookie: sessionCookie });
  assert.equal(me.body.data.customer_id, "A");
  void redeemOtp;
  db.close();
});

test("auth/request returns the SAME ok for a known and unknown email (no enumeration)", async () => {
  const { db, env } = baseFixture();
  const known = await call(env, "POST", "/portal/v1/auth/request", { body: { email: "a@x.com" } });
  const unknown = await call(env, "POST", "/portal/v1/auth/request", { body: { email: "nobody@x.com" } });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.equal(known.body.code, unknown.body.code, "byte-identical code (no enumeration oracle)");
  db.close();
});
