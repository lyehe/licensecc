// Unit tests for the PURE builders of scripts/account-token.mjs (the operator CLI). The wrangler
// exec path is intentionally NOT exercised here — only the SQL/value builders, which are the
// security-load-bearing surface (F5 mandatory scopes, F7 merge completeness, revocation-seq bumps,
// the token-hmac round-trip). Pure: no DB, no wrangler, no node:fs writes.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildIssue,
  buildRotate,
  buildRevoke,
  buildRevokeCustomer,
  buildMergeCustomer,
  listTokensSql,
  linkEntitlementSql,
  listOrphansSql,
} from "../../scripts/account-token.mjs";
import { hashToken } from "../../src/auth/account_token.mjs";

const enc = new TextEncoder();
function pepperBytes() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

const NOW = 1_700_000_000;
const FUTURE = NOW + 86_400;

// ---------------------------------------------------------------------------
// issue — scopes are MANDATORY (F5/I3); no implicit {} master.
// ---------------------------------------------------------------------------

test("issue: rejects when neither --scopes nor --scopes-all is given (no implicit master)", async () => {
  const pepper = pepperBytes();
  await assert.rejects(
    buildIssue({ "customer-id": "cus_A", name: "ci", "expires-at": String(FUTURE) }, { now: NOW, pepperBytes: pepper }),
    /issue requires explicit scopes/,
  );
});

test("issue: --scopes-all writes allow_all:true", async () => {
  const pepper = pepperBytes();
  const built = await buildIssue(
    { "customer-id": "cus_A", name: "ci", "scopes-all": true, "expires-at": String(FUTURE) },
    { now: NOW, pepperBytes: pepper },
  );
  assert.equal(built.scopesJson, JSON.stringify({ allow_all: true }));
  assert.match(built.sql, /'\{"allow_all":true\}'/);
});

test("issue: cannot pass both --scopes and --scopes-all", async () => {
  const pepper = pepperBytes();
  await assert.rejects(
    buildIssue(
      { "customer-id": "cus_A", name: "ci", "scopes-all": true, scopes: "{}", "expires-at": String(FUTURE) },
      { now: NOW, pepperBytes: pepper },
    ),
    /exactly one of --scopes or --scopes-all/,
  );
});

test("issue: an explicit {} scope set is refused (would be a dead, fail-closed token)", async () => {
  const pepper = pepperBytes();
  await assert.rejects(
    buildIssue(
      { "customer-id": "cus_A", name: "ci", scopes: "{}", "expires-at": String(FUTURE) },
      { now: NOW, pepperBytes: pepper },
    ),
    /allow_all:true or at least one of/,
  );
});

test("issue: explicit axis scopes are accepted and re-serialized canonically", async () => {
  const pepper = pepperBytes();
  const built = await buildIssue(
    {
      "customer-id": "cus_A",
      name: "ci",
      scopes: '{"projects":["P"],"features":["F"],"operations":["activate"]}',
      "expires-at": String(FUTURE),
    },
    { now: NOW, pepperBytes: pepper },
  );
  assert.deepEqual(JSON.parse(built.scopesJson), { projects: ["P"], features: ["F"], operations: ["activate"] });
});

// ---------------------------------------------------------------------------
// issue — finite future expiry (expires_at <= now rejected).
// ---------------------------------------------------------------------------

test("issue: expires-at <= now is rejected", async () => {
  const pepper = pepperBytes();
  await assert.rejects(
    buildIssue(
      { "customer-id": "cus_A", name: "ci", "scopes-all": true, "expires-at": String(NOW) },
      { now: NOW, pepperBytes: pepper },
    ),
    /expires-at must be strictly greater than now/,
  );
  await assert.rejects(
    buildIssue(
      { "customer-id": "cus_A", name: "ci", "scopes-all": true, "expires-at": String(NOW - 1) },
      { now: NOW, pepperBytes: pepper },
    ),
    /expires-at must be strictly greater than now/,
  );
});

test("issue: requires pepper bytes (no silent unkeyed hash)", async () => {
  await assert.rejects(
    buildIssue({ "customer-id": "cus_A", name: "ci", "scopes-all": true, "expires-at": String(FUTURE) }, { now: NOW }),
    /requires pepper bytes/,
  );
});

// ---------------------------------------------------------------------------
// issue — the token-hmac round-trip: the stored token_hmac equals hashToken(pepper, raw), so the
// resolver (which computes the same keyed HMAC) would resolve it. We assert the builder's stored
// HMAC matches an independent hashToken(pepper, raw) of the SAME generated plaintext.
// ---------------------------------------------------------------------------

test("issue: stored token_hmac == hashToken(pepper, raw) for the generated plaintext (resolver round-trip)", async () => {
  const pepper = pepperBytes();
  const built = await buildIssue(
    { "customer-id": "cus_A", name: "ci", "scopes-all": true, "expires-at": String(FUTURE), "pepper-key-id": "p1" },
    { now: NOW, pepperBytes: pepper },
  );
  // Independent recomputation of what resolveAccountToken would compute under the same pepper.
  const expected = await hashToken(pepper, enc.encode(built.plaintext));
  assert.equal(built.tokenHmac, expected);
  // The SQL stores exactly that HMAC, and never the plaintext.
  assert.match(built.sql, new RegExp(expected.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
  assert.ok(!built.sql.includes(built.plaintext), "the raw token must NEVER appear in the SQL");
  assert.equal(built.pepperKeyId, "p1");
});

test("issue: SQL is a guarded INSERT...SELECT requiring an active customer + writes an issue audit row", async () => {
  const pepper = pepperBytes();
  const built = await buildIssue(
    { "customer-id": "cus_A", name: "ci", "scopes-all": true, "expires-at": String(FUTURE) },
    { now: NOW, pepperBytes: pepper },
  );
  assert.match(built.sql, /INSERT INTO account_tokens[\s\S]*WHERE EXISTS \(SELECT 1 FROM customers WHERE id = 'cus_A' AND status = 'active'\)/);
  assert.match(built.sql, /INSERT INTO account_token_events[\s\S]*'issue'/);
});

// ---------------------------------------------------------------------------
// F7 — merge-customer touches ALL of entitlements, account_tokens, licenses, orders (+ revocations).
// ---------------------------------------------------------------------------

test("merge-customer: ONE batch re-homes entitlements + account_tokens + licenses + orders (F7)", () => {
  const built = buildMergeCustomer({ from: "cus_old", into: "cus_new" }, { now: NOW });
  const sql = built.sql;
  assert.match(sql, /UPDATE entitlements SET customer_id = 'cus_new'[\s\S]*WHERE customer_id = 'cus_old'/);
  assert.match(sql, /UPDATE account_tokens SET customer_id = 'cus_new'[\s\S]*WHERE customer_id = 'cus_old'/);
  assert.match(sql, /UPDATE licenses SET customer_id = 'cus_new'[\s\S]*WHERE customer_id = 'cus_old'/);
  assert.match(sql, /UPDATE orders SET customer_id = 'cus_new'[\s\S]*WHERE customer_id = 'cus_old'/);
  // account_token_revocations are folded (max) and the source floor is dropped.
  assert.match(sql, /INTO account_token_revocations/);
  assert.match(sql, /DELETE FROM account_token_revocations WHERE customer_id = 'cus_old'/);
  // A 'merge' audit row is written.
  assert.match(sql, /INSERT INTO account_token_events[\s\S]*'merge'/);
});

test("merge-customer: explicit table-completeness set is {entitlements, account_tokens, licenses, orders} (F7 guard)", () => {
  const built = buildMergeCustomer({ from: "cus_old", into: "cus_new" }, { now: NOW });
  // The bug F7 guards against is a missing table. Assert each required table is re-homed exactly.
  for (const table of ["entitlements", "account_tokens", "licenses", "orders"]) {
    assert.ok(
      new RegExp(`UPDATE ${table} SET customer_id = 'cus_new'`).test(built.sql),
      `merge-customer must move ${table}.customer_id (F7 completeness)`,
    );
  }
});

test("merge-customer: --from must differ from --into", () => {
  assert.throws(() => buildMergeCustomer({ from: "cus_x", into: "cus_x" }), /must differ/);
});

// ---------------------------------------------------------------------------
// revoke / revoke-customer — bump revocation_seq.
// ---------------------------------------------------------------------------

test("revoke: revokes only a non-revoked row AND bumps the owning customer's revocation_seq", () => {
  const built = buildRevoke({ id: "acct_1", reason: "lost laptop" }, { now: NOW });
  assert.match(built.sql, /UPDATE account_tokens SET status = 'revoked'[\s\S]*WHERE id = 'acct_1' AND status != 'revoked'/);
  // The seq bump is keyed on the token's owning customer (resolved from the row), incremented by 1.
  assert.match(built.sql, /INTO account_token_revocations[\s\S]*revocation_seq = account_token_revocations\.revocation_seq \+ 1/);
  assert.match(built.sql, /INSERT INTO account_token_events[\s\S]*'revoke'/);
  assert.ok(built.sql.includes("lost laptop"), "the operator-supplied reason is recorded in the audit row");
});

test("revoke-customer: revokes ALL active tokens for a customer + ONE seq bump + a revoke-customer audit row", () => {
  const built = buildRevokeCustomer({ "customer-id": "cus_A", reason: "breach" }, { now: NOW });
  assert.match(built.sql, /UPDATE account_tokens SET status = 'revoked'[\s\S]*WHERE customer_id = 'cus_A' AND status = 'active'/);
  assert.match(built.sql, /INTO account_token_revocations \(customer_id, revocation_seq, updated_at\) VALUES \('cus_A'/);
  assert.match(built.sql, /INSERT INTO account_token_events[\s\S]*'revoke-customer'/);
});

test("revoke-customer: requires a reason", () => {
  assert.throws(() => buildRevokeCustomer({ "customer-id": "cus_A" }), /reason is required/);
});

// ---------------------------------------------------------------------------
// rotate — new row, old row clamped/linked; --compromised => zero overlap + immediate revoke.
// ---------------------------------------------------------------------------

test("rotate: issues a new row, links replaced_by, and clamps the old expiry to now+overlap", async () => {
  const pepper = pepperBytes();
  const oldRow = { customer_id: "cus_A", scopes_json: '{"allow_all":true}', expires_at: FUTURE + 100, name: "ci" };
  const built = await buildRotate({ id: "acct_old", "overlap-sec": "3600" }, { now: NOW, pepperBytes: pepper, oldRow });
  assert.match(built.sql, /INSERT INTO account_tokens/);
  assert.match(built.sql, new RegExp(`replaced_by = '${built.newId}', expires_at = min\\(expires_at, ${NOW + 3600}\\)`));
  assert.equal(built.compromised, false);
  // New row inherits the same customer + scopes; the plaintext is fresh and not in the SQL.
  assert.equal(built.customerId, "cus_A");
  assert.equal(built.scopesJson, '{"allow_all":true}');
  assert.ok(!built.sql.includes(built.plaintext));
});

test("rotate --compromised: zero overlap, immediate revoke of the old row, and a seq bump", async () => {
  const pepper = pepperBytes();
  const oldRow = { customer_id: "cus_A", scopes_json: '{"allow_all":true}', expires_at: FUTURE, name: "ci" };
  const built = await buildRotate({ id: "acct_old", compromised: true, "overlap-sec": "9999" }, { now: NOW, pepperBytes: pepper, oldRow });
  assert.equal(built.overlap, 0);
  assert.equal(built.compromised, true);
  assert.match(built.sql, /UPDATE account_tokens SET status = 'revoked'[\s\S]*WHERE id = 'acct_old' AND status != 'revoked'/);
  assert.match(built.sql, /INTO account_token_revocations[\s\S]*revocation_seq = account_token_revocations\.revocation_seq \+ 1/);
});

// ---------------------------------------------------------------------------
// link / list — ownership predicate on the mutation, display-only token_prefix (L1).
// ---------------------------------------------------------------------------

test("link: binds NULL-owner entitlement only (AND customer_id IS NULL — no cross-account overwrite)", () => {
  const sql = linkEntitlementSql(
    { project: "DEFAULT", feature: "DEFAULT", fingerprint: "a".repeat(64), "customer-id": "cus_A" },
    { now: NOW },
  );
  assert.match(sql, /UPDATE entitlements SET customer_id = 'cus_A'[\s\S]*AND customer_id IS NULL/);
});

test("link --list-orphans: read-only worklist joining license_id -> licenses.customer_id", () => {
  const sql = listOrphansSql();
  assert.match(sql, /FROM entitlements e WHERE e\.customer_id IS NULL/);
  assert.match(sql, /licenses l WHERE l\.id = e\.license_id/);
});

test("list: read-only SELECT exposes token_prefix as DISPLAY ONLY (never a WHERE selector — L1)", () => {
  const sql = listTokensSql({ "customer-id": "cus_A" });
  assert.match(sql, /SELECT id, token_prefix, name, status, expires_at, last_used_at/);
  assert.match(sql, /WHERE customer_id = 'cus_A'/);
  // token_prefix must appear only in the projection, never as a comparison operand.
  assert.ok(!/token_prefix\s*(?:=|IN\b|LIKE\b)/.test(sql), "token_prefix is display-only, never a selector");
});
