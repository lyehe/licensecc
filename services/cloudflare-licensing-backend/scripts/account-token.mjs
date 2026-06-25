// Operator CLI for Slice 2 account_token lifecycle (issue / rotate / revoke / revoke-customer /
// repepper / link / merge-customer / list). Mirrors entitlement.mjs: PURE exported SQL/value
// builders (unit-testable) + a thin wrangler-exec wrapper (the exec path is NOT unit-tested).
//
// SECURITY (L1/L10): token auth is `token_hmac` only — token_prefix is display-only and NEVER a
// WHERE selector. The plaintext token is printed ONCE (tty or --out 0600) and is NEVER written into
// the audit log, the SQL, or any idempotency response.
//
// Design: docs/superpowers/plans/2026-06-24-slice2-account-token-blueprint.md (section (d) + Round-2 F7).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateAccountToken, hashToken, loadPepperMap } from "../src/auth/account_token.mjs";
import { bytesFromBase64 } from "../src/fulfillment/order_hmac.mjs";

const DEFAULT_DATABASE = "licensecc-online-verifier";
const NAME = /^[A-Za-z0-9_.:-]+$/;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const textEncoder = new TextEncoder();

function usage() {
  console.error(`usage:
  node scripts/account-token.mjs issue --customer-id <id> --name <name> (--scopes <json> | --scopes-all) --expires-at <epoch> [--pepper-key-id <id>] [--pepper-secret-b64 <b64>] [--actor <op>] [--out <file>] [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]
  node scripts/account-token.mjs rotate --id <token-id> [--overlap-sec <n>] [--compromised] [--pepper-key-id <id>] [--pepper-secret-b64 <b64>] [--actor <op>] [--out <file>] [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]
  node scripts/account-token.mjs revoke --id <token-id> [--reason <text>] [--actor <op>] [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]
  node scripts/account-token.mjs revoke-customer --customer-id <id> --reason <text> [--actor <op>] [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]
  node scripts/account-token.mjs repepper --from <pepperId> --to <pepperId> [--overlap-sec <n>] [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]
  node scripts/account-token.mjs link --project <p> --feature <f> --fingerprint <64-hex> --customer-id <id> [--actor <op>] [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]
  node scripts/account-token.mjs link --list-orphans [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]
  node scripts/account-token.mjs merge-customer --from <id> --into <id> [--actor <op>] [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]
  node scripts/account-token.mjs list --customer-id <id> [--database ${DEFAULT_DATABASE}] [--config wrangler.toml] [--remote]

notes:
  Auth is token_hmac ONLY: token_prefix is display-only and never a lookup selector (L1). The
  plaintext token is printed ONCE (to a tty or --out, written 0600) and is NEVER written to the audit
  log, the SQL, or stdout when piped (L10) — re-run 'rotate'/'issue' if you lose it. rotate is hygiene,
  not revocation (use --compromised for immediate revoke of the old row). revoke / revoke-customer /
  merge bump account_token_revocations.revocation_seq so the resolver's per-customer floor rejects
  stale replicas. The CLI stamps actor_type='cli', source='cli'.`);
  process.exit(2);
}

function parseArgs(argv) {
  const command = argv[2];
  if (!command) {
    usage();
  }
  const options = {};
  for (let i = 3; i < argv.length; ++i) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      usage();
    }
    const key = arg.slice(2);
    if (key === "remote" || key === "local" || key === "scopes-all" || key === "compromised" || key === "list-orphans") {
      options[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) {
      usage();
    }
    options[key] = value;
  }
  return { command, options };
}

// ---------------------------------------------------------------------------
// Validators (mirror entitlement.mjs).
// ---------------------------------------------------------------------------

function validatedName(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !NAME.test(value)) {
    throw new Error(`${label} must be 1-${maxLength} characters using letters, digits, _, ., :, or -`);
  }
  return value;
}

function validatedHex(value, label) {
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new Error(`${label} must be exactly 64 hex characters`);
  }
  return value.toLowerCase();
}

function validatedId(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\0\r\n']/.test(value)) {
    throw new Error(`${label} must be 1-${maxLength} characters without quotes or control line breaks`);
  }
  return value;
}

function validatedText(value, label, maxLength, required = false) {
  if (value === undefined || value === "") {
    if (required) {
      throw new Error(`${label} is required`);
    }
    return "";
  }
  if (typeof value !== "string" || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be at most ${maxLength} characters without control line breaks`);
  }
  return value;
}

function validatedEpoch(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER || String(n) !== String(value)) {
    throw new Error(`${label} must be a non-negative integer epoch (canonical form)`);
  }
  return n;
}

function validatedOverlap(value) {
  if (value === undefined || value === "") {
    return 0;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 31_536_000) {
    throw new Error("overlap-sec must be an integer in [0, 31536000]");
  }
  return n;
}

function validatedScopes(options) {
  const all = options["scopes-all"] === true;
  const explicit = options.scopes;
  // F5/I3: scopes is MANDATORY unless --scopes-all. No implicit {} master credential.
  if (!all && (explicit === undefined || explicit === "")) {
    throw new Error("issue requires explicit scopes: pass --scopes <json> or --scopes-all (no implicit master)");
  }
  if (all && explicit !== undefined) {
    throw new Error("pass exactly one of --scopes or --scopes-all");
  }
  if (all) {
    return JSON.stringify({ allow_all: true });
  }
  let parsed;
  try {
    parsed = JSON.parse(explicit);
  } catch {
    throw new Error("--scopes must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--scopes must be a JSON object");
  }
  if (parsed.allow_all !== true) {
    const hasAxis = ["projects", "features", "operations"].some((k) => k in parsed);
    if (!hasAxis) {
      // An object with no allow_all and no axis denies everything (fail-closed) — refuse to mint a dead token.
      throw new Error("--scopes must set allow_all:true or at least one of projects/features/operations");
    }
  }
  // Re-serialize canonically so the stored value is exactly what tokenAllows() will parse.
  return JSON.stringify(parsed);
}

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

function newTokenId() {
  const r = new Uint8Array(16);
  crypto.getRandomValues(r);
  let hex = "";
  for (const b of r) hex += b.toString(16).padStart(2, "0");
  return `acct_${hex}`;
}

// ---------------------------------------------------------------------------
// SQL helpers (mirror entitlement.mjs — single-quote escaping; CLI stamps cli/cli).
// ---------------------------------------------------------------------------

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNullableString(value) {
  return value === null || value === undefined || value === "" ? "NULL" : sqlString(value);
}

// Audit row for account_token_events. NEVER include the raw token (L10): we only ever pass the
// token id, customer id, and operator-supplied reason.
function eventSql({ accountTokenId, customerId, eventType, actor, reason = "" }) {
  return (
    `INSERT INTO account_token_events (account_token_id, customer_id, event_type, actor, actor_type, source, reason, request_id, created_at) ` +
    `VALUES (${sqlString(accountTokenId)}, ${sqlString(customerId)}, ${sqlString(eventType)}, ${sqlString(actor)}, 'cli', 'cli', ${sqlString(reason)}, 'cli-' || lower(hex(randomblob(8))), unixepoch())`
  );
}

// Bump (or create) the per-customer revocation floor. revoke / revoke-customer / merge call this so
// the resolver's process-local floor rejects replica-stale 'active' rows after an emergency revoke.
function bumpRevocationSeqSql(customerId) {
  return (
    `INSERT INTO account_token_revocations (customer_id, revocation_seq, updated_at) ` +
    `VALUES (${sqlString(customerId)}, 1, unixepoch()) ` +
    `ON CONFLICT(customer_id) DO UPDATE SET revocation_seq = account_token_revocations.revocation_seq + 1, updated_at = unixepoch()`
  );
}

// INSERT a fresh account_tokens row. token_hmac is precomputed by the caller (keyed HMAC under the
// named pepper); the raw token is NEVER part of the SQL.
function insertTokenSql({ id, customerId, tokenHmac, pepperKeyId, tokenPrefix, name, scopesJson, expiresAt, actor }) {
  return (
    `INSERT INTO account_tokens (id, customer_id, token_hmac, pepper_key_id, token_prefix, name, scopes_json, status, expires_at, last_used_at, replaced_by, created_by, created_at, updated_at) ` +
    `VALUES (${sqlString(id)}, ${sqlString(customerId)}, ${sqlString(tokenHmac)}, ${sqlString(pepperKeyId)}, ${sqlString(tokenPrefix)}, ${sqlNullableString(name)}, ${sqlString(scopesJson)}, 'active', ${expiresAt}, NULL, NULL, ${sqlString(actor)}, unixepoch(), unixepoch())`
  );
}

// ---------------------------------------------------------------------------
// PURE builders (exported for unit tests). Each returns { sql, ...echo } where echo carries
// non-secret values the wrapper needs (e.g. the plaintext token to print ONCE, the new id).
// ---------------------------------------------------------------------------

// Compute the keyed HMAC for a freshly generated raw token under the named pepper. The pepper bytes
// come from --pepper-secret-b64 (or the env fallback); the CLI asserts --pepper-key-id is named.
async function mintTokenHmac(rawToken, pepperKeyId, pepperBytes) {
  return hashToken(pepperBytes, textEncoder.encode(rawToken));
}

/**
 * issue — require an explicit scope set (F5), a finite future expiry, and a named pepper. Generates
 * a token, hashes it under the pepper, and returns a single batch (token INSERT + 'issue' audit row).
 * The plaintext token is returned in the echo for one-time printing and is NEVER in the SQL.
 */
export async function buildIssue(options, { now = nowEpoch(), pepperBytes, generated } = {}) {
  const customerId = validatedId(options["customer-id"], "customer-id", 128);
  const name = validatedText(options.name, "name", 128, true);
  const scopesJson = validatedScopes(options);
  const expiresAt = validatedEpoch(options["expires-at"], "expires-at");
  if (expiresAt <= now) {
    throw new Error("expires-at must be strictly greater than now");
  }
  const pepperKeyId = validatedName(options["pepper-key-id"] ?? "p1", "pepper-key-id", 128);
  const actor = validatedText(options.actor, "actor", 128) || "cli";
  if (pepperBytes === undefined) {
    throw new Error("issue requires pepper bytes (--pepper-secret-b64 or ACCOUNT_TOKEN_PEPPERS)");
  }

  const token = generated ?? generateAccountToken();
  const id = options._idOverride ?? newTokenId();
  const tokenHmac = await mintTokenHmac(token.raw, pepperKeyId, pepperBytes);
  // The token INSERT is guarded by a WHERE EXISTS on customers(active): "customer must exist+active"
  // is an atomic SQL conjunct (no TOCTOU). A missing/disabled customer changes 0 rows (the wrapper
  // reports the no-op + exit 3); the FK on account_tokens.customer_id is the belt-and-suspenders.
  const sql = [
    insertTokenSqlGuarded({ id, customerId, tokenHmac, pepperKeyId, tokenPrefix: token.token_prefix, name, scopesJson, expiresAt, actor }),
    eventSql({ accountTokenId: id, customerId, eventType: "issue", actor, reason: name }),
  ].join(";\n");

  return { sql, id, tokenHmac, pepperKeyId, plaintext: token.raw, tokenPrefix: token.token_prefix, customerId, scopesJson, expiresAt };
}

// Token INSERT guarded so it inserts ONLY when the customer exists and is active. INSERT...SELECT
// with a WHERE EXISTS makes "customer must exist+active" an atomic SQL conjunct (no TOCTOU): a
// missing/disabled customer changes 0 rows (the wrapper reports the no-op).
function insertTokenSqlGuarded({ id, customerId, tokenHmac, pepperKeyId, tokenPrefix, name, scopesJson, expiresAt, actor }) {
  return (
    `INSERT INTO account_tokens (id, customer_id, token_hmac, pepper_key_id, token_prefix, name, scopes_json, status, expires_at, last_used_at, replaced_by, created_by, created_at, updated_at) ` +
    `SELECT ${sqlString(id)}, ${sqlString(customerId)}, ${sqlString(tokenHmac)}, ${sqlString(pepperKeyId)}, ${sqlString(tokenPrefix)}, ${sqlNullableString(name)}, ${sqlString(scopesJson)}, 'active', ${expiresAt}, NULL, NULL, ${sqlString(actor)}, unixepoch(), unixepoch() ` +
    `WHERE EXISTS (SELECT 1 FROM customers WHERE id = ${sqlString(customerId)} AND status = 'active')`
  );
}

/**
 * rotate — issue a NEW row (new raw, SAME customer/scopes/pepper unless overridden), point the OLD
 * row's replaced_by at it and clamp its expiry to min(expires_at, now+overlap). --compromised forces
 * zero overlap AND immediately revokes the old row (status='revoked' + bump revocation_seq). The new
 * plaintext is returned for one-time printing.
 */
export async function buildRotate(options, { now = nowEpoch(), pepperBytes, generated, oldRow } = {}) {
  const oldId = validatedId(options.id, "id", 128);
  const compromised = options.compromised === true;
  const overlap = compromised ? 0 : validatedOverlap(options["overlap-sec"]);
  const actor = validatedText(options.actor, "actor", 128) || "cli";
  const pepperKeyId = validatedName(options["pepper-key-id"] ?? "p1", "pepper-key-id", 128);
  if (pepperBytes === undefined) {
    throw new Error("rotate requires pepper bytes (--pepper-secret-b64 or ACCOUNT_TOKEN_PEPPERS)");
  }
  // oldRow carries customer_id + scopes_json + expires_at, read by the wrapper before building the
  // batch. The pure builder accepts it so it stays unit-testable without a DB.
  if (oldRow === undefined || oldRow.customer_id === undefined) {
    throw new Error("rotate needs the existing row's customer_id + scopes_json (read it first)");
  }
  const customerId = oldRow.customer_id;
  const scopesJson = oldRow.scopes_json ?? "{}";
  // New row inherits the old expiry (rotation is hygiene; it does not extend a token's lifetime).
  const newExpiresAt = oldRow.expires_at;

  const token = generated ?? generateAccountToken();
  const newId = options._idOverride ?? newTokenId();
  const tokenHmac = await mintTokenHmac(token.raw, pepperKeyId, pepperBytes);

  const statements = [
    insertTokenSql({ id: newId, customerId, tokenHmac, pepperKeyId, tokenPrefix: token.token_prefix, name: oldRow.name ?? "", scopesJson, expiresAt: newExpiresAt, actor }),
    // Old row: link to successor; clamp expiry to the overlap window. Only touch a still-active row.
    `UPDATE account_tokens SET replaced_by = ${sqlString(newId)}, expires_at = min(expires_at, ${now + overlap}), updated_at = unixepoch() WHERE id = ${sqlString(oldId)} AND status != 'revoked'`,
    eventSql({ accountTokenId: newId, customerId, eventType: "rotate", actor, reason: `rotate of ${oldId}` }),
  ];
  if (compromised) {
    // Immediate revocation of the old row + customer-wide seq bump so the resolver floor rejects it.
    statements.push(
      `UPDATE account_tokens SET status = 'revoked', expires_at = ${now}, updated_at = unixepoch() WHERE id = ${sqlString(oldId)} AND status != 'revoked'`,
      bumpRevocationSeqSql(customerId),
      eventSql({ accountTokenId: oldId, customerId, eventType: "revoke", actor, reason: "compromised rotate" }),
    );
  }
  return { sql: statements.join(";\n"), newId, oldId, customerId, plaintext: token.raw, tokenPrefix: token.token_prefix, overlap, compromised, scopesJson, expiresAt: newExpiresAt };
}

/**
 * revoke — set status='revoked' for one token (only when not already revoked) and bump the
 * customer's revocation_seq. A 0-row UPDATE (already revoked / unknown id) is the no-op the wrapper
 * reports as exit 3.
 */
export function buildRevoke(options, { now = nowEpoch() } = {}) {
  const id = validatedId(options.id, "id", 128);
  const reason = validatedText(options.reason, "reason", 1000);
  const actor = validatedText(options.actor, "actor", 128) || "cli";
  const sql = [
    `UPDATE account_tokens SET status = 'revoked', expires_at = min(expires_at, ${now}), updated_at = unixepoch() WHERE id = ${sqlString(id)} AND status != 'revoked'`,
    // Bump the floor for the owning customer (subquery resolves the customer of the revoked row).
    `INSERT INTO account_token_revocations (customer_id, revocation_seq, updated_at) ` +
      `SELECT customer_id, 1, unixepoch() FROM account_tokens WHERE id = ${sqlString(id)} ` +
      `ON CONFLICT(customer_id) DO UPDATE SET revocation_seq = account_token_revocations.revocation_seq + 1, updated_at = unixepoch()`,
    `INSERT INTO account_token_events (account_token_id, customer_id, event_type, actor, actor_type, source, reason, request_id, created_at) ` +
      `SELECT ${sqlString(id)}, customer_id, 'revoke', ${sqlString(actor)}, 'cli', 'cli', ${sqlString(reason)}, 'cli-' || lower(hex(randomblob(8))), unixepoch() ` +
      `FROM account_tokens WHERE id = ${sqlString(id)}`,
  ].join(";\n");
  return { sql, id };
}

/**
 * revoke-customer (EMERGENCY) — revoke ALL of a customer's active tokens, bump the revocation_seq
 * once, and write a single 'revoke-customer' audit row. Immediate (no deploy). Uses a sentinel
 * account_token_id of '*' for the customer-wide audit row.
 */
export function buildRevokeCustomer(options, { now = nowEpoch() } = {}) {
  const customerId = validatedId(options["customer-id"], "customer-id", 128);
  const reason = validatedText(options.reason, "reason", 1000, true);
  const actor = validatedText(options.actor, "actor", 128) || "cli";
  const sql = [
    `UPDATE account_tokens SET status = 'revoked', expires_at = min(expires_at, ${now}), updated_at = unixepoch() WHERE customer_id = ${sqlString(customerId)} AND status = 'active'`,
    bumpRevocationSeqSql(customerId),
    eventSql({ accountTokenId: "*", customerId, eventType: "revoke-customer", actor, reason }),
  ].join(";\n");
  return { sql, customerId };
}

/**
 * repepper — re-issue successors for every active token currently under --from onto --to (a
 * rotate-with-overlap, not a force-expire). The pure builder produces the per-token rotate batch
 * from a list of source rows; the wrapper reads the rows and REFUSES with the count + runbook when
 * any active non-expired row still references --from (so a later pepper drop cannot strand them).
 */
export async function buildRepepper(options, { now = nowEpoch(), toPepperBytes, sourceRows = [], generate } = {}) {
  const from = validatedName(options.from, "from", 128);
  const to = validatedName(options.to, "to", 128);
  if (from === to) {
    throw new Error("--from and --to must differ");
  }
  const overlap = validatedOverlap(options["overlap-sec"]);
  const actor = validatedText(options.actor, "actor", 128) || "cli";
  if (toPepperBytes === undefined) {
    throw new Error("repepper requires --to pepper bytes (--pepper-secret-b64 or ACCOUNT_TOKEN_PEPPERS)");
  }
  const gen = generate ?? (() => generateAccountToken());
  const statements = [];
  const minted = [];
  for (const row of sourceRows) {
    const token = gen(row);
    const newId = newTokenId();
    const tokenHmac = await hashToken(toPepperBytes, textEncoder.encode(token.raw));
    statements.push(
      insertTokenSql({
        id: newId,
        customerId: row.customer_id,
        tokenHmac,
        pepperKeyId: to,
        tokenPrefix: token.token_prefix,
        name: row.name ?? "",
        scopesJson: row.scopes_json ?? "{}",
        expiresAt: row.expires_at,
        actor,
      }),
      `UPDATE account_tokens SET replaced_by = ${sqlString(newId)}, expires_at = min(expires_at, ${now + overlap}), updated_at = unixepoch() WHERE id = ${sqlString(row.id)} AND status != 'revoked'`,
      eventSql({ accountTokenId: newId, customerId: row.customer_id, eventType: "repepper", actor, reason: `repepper ${from}->${to} of ${row.id}` }),
    );
    minted.push({ id: newId, oldId: row.id, plaintext: token.raw });
  }
  return { sql: statements.join(";\n"), from, to, overlap, count: sourceRows.length, minted };
}

/**
 * link — bind a NULL-owner entitlement to a customer (cutover backfill). The ownership predicate
 * `AND customer_id IS NULL` is on the MUTATING UPDATE so it can never overwrite an already-owned row
 * (no cross-account hijack). A 0-row UPDATE (already owned / absent) is the no-op (exit 3).
 */
export function linkEntitlementSql(options, { now = nowEpoch() } = {}) {
  const project = validatedName(options.project, "project", 127);
  const feature = validatedName(options.feature, "feature", 15);
  const fingerprint = validatedHex(options.fingerprint, "fingerprint");
  const customerId = validatedId(options["customer-id"], "customer-id", 128);
  const actor = validatedText(options.actor, "actor", 128) || "cli";
  const where = `project = ${sqlString(project)} AND feature = ${sqlString(feature)} AND license_fingerprint = ${sqlString(fingerprint)}`;
  const sql = [
    `UPDATE entitlements SET customer_id = ${sqlString(customerId)}, updated_at = unixepoch() WHERE ${where} AND customer_id IS NULL`,
    // Audit into entitlement_events (the entitlement's own log), only when the link actually happened.
    `INSERT INTO entitlement_events (project, feature, license_fingerprint, device_hash, event_type, status, revocation_seq, detail, actor, actor_type, source, request_id, reason, created_at) ` +
      `SELECT project, feature, license_fingerprint, device_hash, 'update', status, revocation_seq, ${sqlString(`link customer ${customerId}`)}, ${sqlString(actor)}, 'cli', 'cli', 'cli-' || lower(hex(randomblob(8))), ${sqlString(`link customer ${customerId}`)}, unixepoch() ` +
      `FROM entitlements WHERE ${where} AND customer_id = ${sqlString(customerId)}`,
  ].join(";\n");
  return sql;
}

/**
 * link --list-orphans — the cutover worklist: every NULL-owner entitlement with its best-guess
 * customer (license_id -> licenses.customer_id). Read-only. The off->soft / soft->required gate is
 * "this returns 0 rows".
 */
export function listOrphansSql() {
  return (
    `SELECT e.project, e.feature, e.license_fingerprint, e.status, e.license_id, ` +
    `(SELECT l.customer_id FROM licenses l WHERE l.id = e.license_id) AS best_guess_customer_id ` +
    `FROM entitlements e WHERE e.customer_id IS NULL ORDER BY e.updated_at DESC LIMIT 500`
  );
}

/**
 * merge-customer (F7 — COMPLETENESS) — ONE batch that re-homes EVERY customer-scoped row from
 * --from to --into: entitlements, account_tokens, account_token_revocations (seqs merged), licenses,
 * AND orders. Bumps the revocation_seq for BOTH customers. One 'merge' audit row. Missing any of
 * orders/licenses is the bug this guards against.
 */
export function buildMergeCustomer(options, { now = nowEpoch() } = {}) {
  const from = validatedId(options.from, "from", 128);
  const into = validatedId(options.into, "into", 128);
  if (from === into) {
    throw new Error("--from and --into must differ");
  }
  const actor = validatedText(options.actor, "actor", 128) || "cli";
  const sql = [
    // (1) entitlements — the isolation binding column.
    `UPDATE entitlements SET customer_id = ${sqlString(into)}, updated_at = unixepoch() WHERE customer_id = ${sqlString(from)}`,
    // (2) account_tokens — the credentials follow the customer.
    `UPDATE account_tokens SET customer_id = ${sqlString(into)}, updated_at = unixepoch() WHERE customer_id = ${sqlString(from)}`,
    // (3) account_token_revocations — fold the source floor into the destination (max), then drop the
    //     source row so a future re-create of `from` cannot resurrect a stale low seq.
    `INSERT INTO account_token_revocations (customer_id, revocation_seq, updated_at) ` +
      `VALUES (${sqlString(into)}, (SELECT COALESCE(MAX(revocation_seq), 0) FROM account_token_revocations WHERE customer_id IN (${sqlString(from)}, ${sqlString(into)})), unixepoch()) ` +
      `ON CONFLICT(customer_id) DO UPDATE SET revocation_seq = max(account_token_revocations.revocation_seq, excluded.revocation_seq), updated_at = unixepoch()`,
    `DELETE FROM account_token_revocations WHERE customer_id = ${sqlString(from)}`,
    // (4) licenses — Slice 1 identity (a renewal re-link must land on the new customer).
    `UPDATE licenses SET customer_id = ${sqlString(into)}, updated_at = unixepoch() WHERE customer_id = ${sqlString(from)}`,
    // (5) orders — Slice 1 identity home (a post-merge order-ingest renewal links to `into`).
    `UPDATE orders SET customer_id = ${sqlString(into)}, updated_at = unixepoch() WHERE customer_id = ${sqlString(from)}`,
    // Bump BOTH customers' floors so any token presented under either id re-validates against a higher seq.
    bumpRevocationSeqSql(into),
    eventSql({ accountTokenId: "*", customerId: into, eventType: "merge", actor, reason: `merge from ${from}` }),
  ].join(";\n");
  return { sql, from, into };
}

/**
 * list — read-only inventory for one customer. token_prefix is display-only (NOT a selector — L1).
 */
export function listTokensSql(options) {
  const customerId = validatedId(options["customer-id"], "customer-id", 128);
  return (
    `SELECT id, token_prefix, name, status, expires_at, last_used_at, pepper_key_id, replaced_by, created_at ` +
    `FROM account_tokens WHERE customer_id = ${sqlString(customerId)} ORDER BY created_at DESC LIMIT 200`
  );
}

// ---------------------------------------------------------------------------
// Pepper resolution (CLI side): the operator supplies the pepper bytes that MINT the token. C6: the
// CLI asserts --pepper-key-id is named so it can never silently mint under the wrong pepper.
// ---------------------------------------------------------------------------

function resolvePepperBytes(options, env, pepperKeyId) {
  // Explicit material wins (operator passes the active pepper bytes out-of-band).
  if (typeof options["pepper-secret-b64"] === "string" && options["pepper-secret-b64"].length > 0) {
    const bytes = bytesFromBase64(options["pepper-secret-b64"]);
    if (bytes.length < 32) {
      throw new Error("--pepper-secret-b64 must decode to >= 32 bytes");
    }
    return bytes;
  }
  // Fallback: read from ACCOUNT_TOKEN_PEPPERS in the env and select the named pepper.
  const map = loadPepperMap(env);
  if (map === null) {
    throw new Error("no pepper material: pass --pepper-secret-b64 or set ACCOUNT_TOKEN_PEPPERS");
  }
  const bytes = map[pepperKeyId];
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`pepper-key-id '${pepperKeyId}' is not present in ACCOUNT_TOKEN_PEPPERS`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// One-time plaintext output (L10): tty or --out 0600; warn when piped.
// ---------------------------------------------------------------------------

function emitPlaintextOnce(plaintext, options, label) {
  if (typeof options.out === "string" && options.out.length > 0) {
    writeFileSync(options.out, plaintext + "\n", { mode: 0o600 });
    console.error(`${label}: plaintext token written to ${options.out} (mode 0600). It is shown ONCE — store it now.`);
    return;
  }
  if (!process.stdout.isTTY) {
    // L10: never silently leak the token into a pipe/log. Force --out for non-interactive use.
    console.error(
      `${label}: refusing to print the plaintext token to a non-tty (it would land in a log/pipe). ` +
        `Re-run with --out <file> (written 0600) to capture it.`,
    );
    process.exit(4);
  }
  process.stdout.write(`${plaintext}\n`);
  console.error(`${label}: the token above is shown ONCE and is NOT stored server-side — save it now.`);
}

// ---------------------------------------------------------------------------
// wrangler exec wrapper (mirrors entitlement.mjs; NOT unit-tested).
// ---------------------------------------------------------------------------

const MUTATION_COMMANDS = new Set(["issue", "rotate", "revoke", "revoke-customer", "repepper", "link", "merge-customer"]);

function parseWranglerJson(stdout) {
  if (typeof stdout !== "string") {
    return undefined;
  }
  const start = stdout.search(/[[{]/);
  if (start === -1) {
    return undefined;
  }
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

// "ok" | "noop" | "unavailable" | "ignore" — same contract as entitlement.mjs. A guarded mutation
// that matches zero rows reports rows_written=0 on --remote --file.
export function interpretWranglerResult(parsedJson, command) {
  if (!MUTATION_COMMANDS.has(command)) {
    return "ignore";
  }
  const results = Array.isArray(parsedJson) ? parsedJson : parsedJson === undefined ? [] : [parsedJson];
  let sawCount = false;
  let totalWritten = 0;
  for (const entry of results) {
    if (entry && typeof entry === "object" && entry.meta && typeof entry.meta.rows_written === "number") {
      sawCount = true;
      totalWritten += entry.meta.rows_written;
    }
  }
  if (!sawCount) {
    return "unavailable";
  }
  return totalWritten === 0 ? "noop" : "ok";
}

function runWranglerSql(sql, options, command, { noopCommands } = {}) {
  const require = createRequire(import.meta.url);
  const wranglerBin = require.resolve("wrangler/bin/wrangler.js");
  const database = options.database ?? DEFAULT_DATABASE;
  const useFile = MUTATION_COMMANDS.has(command);
  const args = [wranglerBin, "d1", "execute", database, "--json"];
  let tempDir;
  if (useFile) {
    tempDir = mkdtempSync(join(tmpdir(), "lcc-account-token-"));
    const sqlPath = join(tempDir, "mutation.sql");
    writeFileSync(sqlPath, sql);
    args.push("--file", sqlPath);
  } else {
    args.push("--command", sql);
  }
  if (options.config !== undefined) {
    args.push("--config", options.config);
  }
  args.push(options.remote ? "--remote" : "--local");
  try {
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    if (result.error) {
      console.error(result.error.message);
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
    // Only the no-op-sensitive commands (revoke / link) treat a 0-row result as exit 3. Multi-row
    // batches (issue/rotate/merge) intentionally write several rows; only a true 0 is the no-op there.
    const signal = interpretWranglerResult(parseWranglerJson(result.stdout), command);
    if (signal === "noop" && (noopCommands === undefined || noopCommands.has(command))) {
      console.error(
        `NO-OP: ${command} changed 0 rows and wrote no audit event. The row may already be revoked, ` +
          `already owned, or not exist. Confirm with "list --customer-id <id>".`,
      );
      process.exit(3);
    }
    if (signal === "unavailable" && !options.remote) {
      console.error(
        "note: no-op detection is unavailable on --local (wrangler reports no row counts locally). " +
          "Run against --remote, where a 0-row mutation exits 3.",
      );
    }
  } finally {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// Read a single row via a --command read (used by rotate/repepper to fetch existing rows before the
// batch). Returns the parsed first row or undefined.
function readRows(sql, options) {
  const require = createRequire(import.meta.url);
  const wranglerBin = require.resolve("wrangler/bin/wrangler.js");
  const database = options.database ?? DEFAULT_DATABASE;
  const args = [wranglerBin, "d1", "execute", database, "--json", "--command", sql];
  if (options.config !== undefined) {
    args.push("--config", options.config);
  }
  args.push(options.remote ? "--remote" : "--local");
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  const parsed = parseWranglerJson(result.stdout);
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  return block && Array.isArray(block.results) ? block.results : [];
}

// ---------------------------------------------------------------------------
// Dispatch (the only code that touches the network / process exit).
// ---------------------------------------------------------------------------

async function main() {
  const { command, options } = parseArgs(process.argv);
  const env = process.env;

  if (command === "issue") {
    const pepperKeyId = validatedName(options["pepper-key-id"] ?? "p1", "pepper-key-id", 128);
    const pepperBytes = resolvePepperBytes(options, env, pepperKeyId);
    const built = await buildIssue(options, { pepperBytes });
    runWranglerSql(built.sql, options, command, { noopCommands: new Set(["issue"]) });
    emitPlaintextOnce(built.plaintext, options, "issue");
    return;
  }

  if (command === "rotate") {
    const pepperKeyId = validatedName(options["pepper-key-id"] ?? "p1", "pepper-key-id", 128);
    const pepperBytes = resolvePepperBytes(options, env, pepperKeyId);
    const oldId = validatedId(options.id, "id", 128);
    const rows = readRows(
      `SELECT id, customer_id, scopes_json, expires_at, name, status FROM account_tokens WHERE id = ${sqlString(oldId)} LIMIT 1`,
      options,
    );
    if (rows.length === 0) {
      console.error(`NO-OP: rotate — token id ${oldId} not found.`);
      process.exit(3);
    }
    console.error(
      "ROTATE is HYGIENE, not revocation: the OLD token keeps working until its (clamped) expiry. " +
        "Use --compromised to revoke the old row immediately.",
    );
    const built = await buildRotate(options, { pepperBytes, oldRow: rows[0] });
    runWranglerSql(built.sql, options, command);
    emitPlaintextOnce(built.plaintext, options, "rotate");
    return;
  }

  if (command === "revoke") {
    const built = buildRevoke(options);
    runWranglerSql(built.sql, options, command, { noopCommands: new Set(["revoke"]) });
    return;
  }

  if (command === "revoke-customer") {
    console.error("EMERGENCY revoke-customer: revoking ALL active tokens for the customer (immediate, no deploy).");
    const built = buildRevokeCustomer(options);
    runWranglerSql(built.sql, options, command);
    return;
  }

  if (command === "repepper") {
    const from = validatedName(options.from, "from", 128);
    const to = validatedName(options.to, "to", 128);
    const toBytes = resolvePepperBytes({ "pepper-key-id": to, "pepper-secret-b64": options["pepper-secret-b64"] }, env, to);
    // REFUSE if a future drop of --from would strand active, non-expired rows: surface the count + runbook.
    const now = nowEpoch();
    const sourceRows = readRows(
      `SELECT id, customer_id, scopes_json, expires_at, name FROM account_tokens WHERE pepper_key_id = ${sqlString(from)} AND status = 'active' AND expires_at > ${now}`,
      options,
    );
    if (sourceRows.length === 0) {
      console.error(`repepper: no active non-expired tokens reference pepper '${from}'. Safe to drop '${from}'.`);
      process.exit(3);
    }
    console.error(
      `repepper: ${sourceRows.length} active token(s) still reference '${from}'. Re-issuing successors under ` +
        `'${to}' with overlap; the OLD rows keep validating until their clamped expiry. ` +
        `RUNBOOK: do NOT drop '${from}' from ACCOUNT_TOKEN_PEPPERS until 'repepper --from ${from}' reports 0 ` +
        `(re-run after the overlap window, then remove the pepper).`,
    );
    const built = await buildRepepper(options, { toPepperBytes: toBytes, sourceRows });
    runWranglerSql(built.sql, options, command);
    console.error(`repepper: re-issued ${built.count} successor token(s). Plaintexts are NOT recoverable here — `
      + `clients must re-fetch via their issuance flow.`);
    return;
  }

  if (command === "link") {
    if (options["list-orphans"] === true) {
      runWranglerSql(listOrphansSql(), options, "list");
      return;
    }
    const sql = linkEntitlementSql(options);
    runWranglerSql(sql, options, command, { noopCommands: new Set(["link"]) });
    return;
  }

  if (command === "merge-customer") {
    const built = buildMergeCustomer(options);
    runWranglerSql(built.sql, options, command);
    return;
  }

  if (command === "list") {
    runWranglerSql(listTokensSql(options), options, "list");
    return;
  }

  usage();
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
