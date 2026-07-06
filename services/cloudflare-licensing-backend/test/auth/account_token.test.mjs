// Unit tests for the account-token crypto + resolver (Slice 2). Pure (mock D1) — no SQLite flag.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateAccountToken,
  hashToken,
  resolveAccountToken,
  tokenAllows,
  touchLastUsed,
  _resetRevocationFloorForTests,
} from "../../src/auth/account_token.mjs";

const enc = new TextEncoder();
function pepperBytes() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}
function b64(bytes) {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}

// Mock D1 returning the first stored token whose token_hmac is among the bound candidates and whose
// customer is active. Mirrors the resolver's JOIN customers (active) shape.
function mockDb(tokens, opts = {}) {
  const calls = { run: 0, withSession: 0 };
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (!sql.includes("FROM account_tokens")) return null;
              const candidates = new Set(args);
              const t = tokens.find((x) => candidates.has(x.token_hmac) && x.customer_status !== "inactive");
              if (!t) return null;
              return {
                id: t.id, customer_id: t.customer_id, scopes_json: t.scopes_json ?? "{}",
                status: t.status, expires_at: t.expires_at, pepper_key_id: t.pepper_key_id ?? "p1",
                last_used_at: t.last_used_at ?? null, revocation_seq: t.revocation_seq ?? 0,
              };
            },
            async run() { calls.run += 1; if (opts.throwOnRun) throw new Error("db down"); return {}; },
          };
        },
      };
    },
  };
  if (opts.withSession) db.withSession = () => { calls.withSession += 1; return db; };
  return { db, calls };
}

async function tokenRow(raw, pepper, over = {}) {
  return {
    id: "tok_1", customer_id: "cus_A", status: "active", expires_at: 9_999_999_999,
    token_hmac: await hashToken(pepper, enc.encode(raw)), customer_status: "active", ...over,
  };
}

test("generateAccountToken: lcca_ prefix, url-safe body, distinct, short prefix", () => {
  const a = generateAccountToken(), b = generateAccountToken();
  assert.match(a.raw, /^lcca_[A-Za-z0-9_-]+$/);
  assert.notEqual(a.raw, b.raw);
  assert.equal(a.token_prefix.length, 12);
  assert.ok(a.raw.startsWith(a.token_prefix));
});

test("hashToken: deterministic per pepper, differs across peppers", async () => {
  const p1 = pepperBytes(), p2 = pepperBytes();
  const m = enc.encode("lcca_xyz");
  assert.equal(await hashToken(p1, m), await hashToken(p1, m));
  assert.notEqual(await hashToken(p1, m), await hashToken(p2, m));
});

test("tokenAllows: FAIL-CLOSED — {} denies, allow_all/explicit/wildcard grant", () => {
  assert.equal(tokenAllows("{}", "P", "F", "activate"), false);                 // {} is NOT master
  assert.equal(tokenAllows('{"allow_all":true}', "P", "F", "activate"), true);
  assert.equal(tokenAllows('{"projects":["P"],"features":["F"],"operations":["activate"]}', "P", "F", "activate"), true);
  assert.equal(tokenAllows('{"projects":["P"],"features":"*","operations":["activate"]}', "P", "F", "activate"), true);
  assert.equal(tokenAllows('{"projects":["P"],"features":["F"],"operations":["activate"]}', "P", "F", "renew"), false); // op miss
  assert.equal(tokenAllows('{"projects":["X"],"features":"*","operations":"*"}', "P", "F", "activate"), false);        // project miss
  assert.equal(tokenAllows('{"features":"*","operations":"*"}', "P", "F", "activate"), false);                         // absent axis denies
  assert.equal(tokenAllows("not json", "P", "F", "activate"), false);           // malformed denies
});

test("resolveAccountToken: config_error when peppers unusable", async () => {
  const { db } = mockDb([]);
  assert.equal((await resolveAccountToken({ DB: db, ACCOUNT_TOKEN_PEPPERS: "" }, "lcca_x", 100)).code, "config_error");
  assert.equal((await resolveAccountToken({ DB: db, ACCOUNT_TOKEN_PEPPERS: "{}" }, "lcca_x", 100)).code, "config_error");
});

test("resolveAccountToken: unauthorized for non-lcca / no match", async () => {
  _resetRevocationFloorForTests();
  const pepper = pepperBytes();
  const env = { ACCOUNT_TOKEN_PEPPERS: JSON.stringify({ p1: b64(pepper) }) };
  const { db } = mockDb([]);
  assert.equal((await resolveAccountToken({ ...env, DB: db }, "not-a-token", 100)).code, "unauthorized");
  assert.equal((await resolveAccountToken({ ...env, DB: db }, "lcca_nomatch", 100)).code, "unauthorized");
});

test("resolveAccountToken: active resolves; revoked/expired/disabled-customer denied", async () => {
  _resetRevocationFloorForTests();
  const pepper = pepperBytes();
  const env = { ACCOUNT_TOKEN_PEPPERS: JSON.stringify({ p1: b64(pepper) }) };
  const raw = "lcca_active";
  const ok = mockDb([await tokenRow(raw, pepper)]);
  const r = await resolveAccountToken({ ...env, DB: ok.db }, raw, 100);
  assert.equal(r.ok, true); assert.equal(r.token.customer_id, "cus_A");

  const rev = mockDb([await tokenRow(raw, pepper, { status: "revoked" })]);
  assert.equal((await resolveAccountToken({ ...env, DB: rev.db }, raw, 100)).code, "token_revoked");

  const exp = mockDb([await tokenRow(raw, pepper, { expires_at: 50 })]);
  assert.equal((await resolveAccountToken({ ...env, DB: exp.db }, raw, 100)).code, "token_expired");

  const dis = mockDb([await tokenRow(raw, pepper, { customer_status: "inactive" })]);
  assert.equal((await resolveAccountToken({ ...env, DB: dis.db }, raw, 100)).code, "unauthorized"); // JOIN drops it
});

test("resolveAccountToken: F4 seq-floor rejects a replica-stale lower seq", async () => {
  _resetRevocationFloorForTests();
  const pepper = pepperBytes();
  const env = { ACCOUNT_TOKEN_PEPPERS: JSON.stringify({ p1: b64(pepper) }) };
  const raw = "lcca_seq";
  // First sees seq 5 (post-revoke-bump) -> floor advances to 5.
  const hi = mockDb([await tokenRow(raw, pepper, { revocation_seq: 5 })]);
  assert.equal((await resolveAccountToken({ ...env, DB: hi.db }, raw, 100)).ok, true);
  // A later read hits a stale replica showing seq 3 -> rejected by the floor.
  const lo = mockDb([await tokenRow(raw, pepper, { revocation_seq: 3 })]);
  assert.equal((await resolveAccountToken({ ...env, DB: lo.db }, raw, 100)).code, "token_revoked");
});

test("resolveAccountToken: uses the strong (first-primary) read when D1 Sessions exist", async () => {
  _resetRevocationFloorForTests();
  const pepper = pepperBytes();
  const env = { ACCOUNT_TOKEN_PEPPERS: JSON.stringify({ p1: b64(pepper) }) };
  const raw = "lcca_strong";
  const m = mockDb([await tokenRow(raw, pepper)], { withSession: true });
  const r = await resolveAccountToken({ ...env, DB: m.db }, raw, 100);
  assert.equal(r.ok, true);
  assert.ok(m.calls.withSession >= 1, "withSession('first-primary') was used");
});

test("touchLastUsed: throttled, waitUntil-deferred, never throws", async () => {
  const fresh = mockDb([], { throwOnRun: true });
  const tasks = [];
  // within throttle -> no write
  touchLastUsed({ DB: fresh.db }, { id: "t", last_used_at: 100 }, 120, 300, (p) => tasks.push(p));
  assert.equal(fresh.calls.run, 0);
  // stale -> deferred write via waitUntil; a DB error must not throw
  touchLastUsed({ DB: fresh.db }, { id: "t", last_used_at: 0 }, 1000, 300, (p) => tasks.push(p));
  await Promise.all(tasks); // resolves despite throwOnRun (swallowed)
  assert.equal(fresh.calls.run, 1);
});
