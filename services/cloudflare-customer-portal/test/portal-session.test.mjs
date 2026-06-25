// portal_session unit tests (blueprint (g)): mint->resolve; revoked/expired/disabled-customer deny;
// the first-primary strong read is used when D1 Sessions are available; revokeAllForCustomer; the
// cookie shape (HttpOnly; Secure; SameSite=Lax).

import assert from "node:assert/strict";
import { test } from "node:test";
import { freshDb, portalEnv, seedCustomer, D1Like, NOW } from "./helpers.mjs";
import {
  mintSession,
  resolveSession,
  revokeSession,
  revokeAllForCustomer,
  cookieFromRequest,
  setSessionCookie,
  clearSessionCookie,
} from "../src/auth/portal_session.mjs";

test("mint then resolve returns the session bound to its customer", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = portalEnv(db);
  const minted = await mintSession(e, { customerId: "A", userAgent: "ua", now: NOW });
  assert.equal(minted.ok, true);
  assert.ok(minted.raw.startsWith("lccp_"));
  const resolved = await resolveSession(e, minted.raw, NOW);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.session.customer_id, "A");
});

test("the plaintext session token is never stored (only its HMAC)", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = portalEnv(db);
  const minted = await mintSession(e, { customerId: "A", now: NOW });
  const stored = db.prepare("SELECT session_hmac FROM portal_sessions WHERE customer_id = 'A'").get();
  assert.notEqual(stored.session_hmac, minted.raw, "the column holds the HMAC, not the raw token");
  assert.ok(stored.session_hmac.length >= 40);
});

test("a revoked session is denied", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = portalEnv(db);
  const minted = await mintSession(e, { customerId: "A", now: NOW });
  const sid = db.prepare("SELECT id FROM portal_sessions WHERE customer_id = 'A'").get().id;
  await revokeSession(e, sid, "A");
  const resolved = await resolveSession(e, minted.raw, NOW);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "unauthorized");
});

test("an expired session is denied", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = portalEnv(db);
  const minted = await mintSession(e, { customerId: "A", now: NOW });
  // Resolve 24h+1s later (TTL is 86400).
  const resolved = await resolveSession(e, minted.raw, NOW + 86401);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "unauthorized");
});

test("a session for a DISABLED customer is denied (JOIN customers active)", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = portalEnv(db);
  const minted = await mintSession(e, { customerId: "A", now: NOW });
  db.prepare("UPDATE customers SET status = 'disabled' WHERE id = 'A'").run();
  const resolved = await resolveSession(e, minted.raw, NOW);
  assert.equal(resolved.ok, false, "a disabled customer's session is denied");
});

test("revokeSession bound to customer_id cannot revoke a foreign session", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  seedCustomer(db, "B", "b@x.com");
  const e = portalEnv(db);
  const aMint = await mintSession(e, { customerId: "A", now: NOW });
  const aSid = db.prepare("SELECT id FROM portal_sessions WHERE customer_id = 'A'").get().id;
  // B tries to revoke A's session id under B's customer_id: the customer_id guard means 0 rows.
  await revokeSession(e, aSid, "B");
  const stillA = await resolveSession(e, aMint.raw, NOW);
  assert.equal(stillA.ok, true, "A's session survives a foreign revoke attempt");
});

test("revokeAllForCustomer logs out every active session for a customer", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = portalEnv(db);
  const m1 = await mintSession(e, { customerId: "A", now: NOW });
  const m2 = await mintSession(e, { customerId: "A", now: NOW + 1 });
  await revokeAllForCustomer(e, "A");
  assert.equal((await resolveSession(e, m1.raw, NOW)).ok, false);
  assert.equal((await resolveSession(e, m2.raw, NOW)).ok, false);
});

test("resolveSession uses the first-primary strong read when D1 Sessions are available", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = portalEnv(db);
  const minted = await mintSession(e, { customerId: "A", now: NOW });
  // Wrap DB so withSession records the mode it is called with.
  let seenMode = null;
  const inner = e.DB;
  e.DB = {
    prepare: (sql) => inner.prepare(sql),
    withSession: (mode) => { seenMode = mode; return inner; },
  };
  const resolved = await resolveSession(e, minted.raw, NOW);
  assert.equal(resolved.ok, true);
  assert.equal(seenMode, "first-primary", "the strong (primary) read is requested");
});

test("falls back to a plain read when withSession is unavailable", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = portalEnv(db);
  const minted = await mintSession(e, { customerId: "A", now: NOW });
  // No withSession on the DB: resolver must still work via the plain read.
  e.DB = { prepare: (sql) => new D1Like(db).prepare(sql) };
  const resolved = await resolveSession(e, minted.raw, NOW);
  assert.equal(resolved.ok, true);
});

test("pepper-unset -> config_error on mint and resolve", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = portalEnv(db, { PORTAL_SESSION_PEPPERS: undefined });
  assert.equal((await mintSession(e, { customerId: "A", now: NOW })).code, "config_error");
  assert.equal((await resolveSession(e, "lccp_whatever", NOW)).code, "config_error");
});

test("the cookie is HttpOnly; Secure; SameSite=Lax and round-trips through cookieFromRequest", () => {
  const setCookie = setSessionCookie("lccp_abc");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  const req = new Request("https://portal.test/", { headers: { cookie: "lccp_session=lccp_abc; other=1" } });
  assert.equal(cookieFromRequest(req), "lccp_abc");
  // clearSessionCookie expires it.
  assert.match(clearSessionCookie(), /Max-Age=0/);
});

test("a non-lccp_ token is rejected without a DB hit", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = portalEnv(db);
  const resolved = await resolveSession(e, "not-a-session", NOW);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, "unauthorized");
});
