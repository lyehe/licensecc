// Worker-safe PURE issue SQL builders for account_tokens, extracted from scripts/account-token.mjs
// so the customer portal (and any Worker) can mint per-customer account tokens without pulling in
// the Node CLI (no node:/Buffer here — only Web Crypto + standard globals).
//
// SECURITY (L1/L10): token auth is `token_hmac` only — token_prefix is display-only and NEVER a
// WHERE selector. The plaintext token is returned in the echo for one-time use and is NEVER part
// of the SQL. The INSERT is GUARDED by a WHERE EXISTS on customers(active): "customer must
// exist+active" is an atomic SQL conjunct (no TOCTOU); a missing/disabled customer changes 0 rows.
//
// These builders are byte-for-byte the same SQL the CLI emitted before the extraction; the CLI now
// imports them from here. Design: docs/superpowers/plans/2026-06-24-slice2-account-token-blueprint.md
// (+ 2026-06-24-slice3-customer-portal-blueprint.md, invariant 1: the portal imports only this, the
// account-token resolver, and types — never the entitlement MUTATORS).

import { generateAccountToken, hashToken } from "./account_token.mjs";

const NAME = /^[A-Za-z0-9_.:-]+$/;
const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Validators (mirror entitlement.mjs / account-token.mjs — kept identical so the CLI tests stay
// green after the extraction).
// ---------------------------------------------------------------------------

export function validatedName(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !NAME.test(value)) {
    throw new Error(`${label} must be 1-${maxLength} characters using letters, digits, _, ., :, or -`);
  }
  return value;
}

export function validatedId(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\0\r\n']/.test(value)) {
    throw new Error(`${label} must be 1-${maxLength} characters without quotes or control line breaks`);
  }
  return value;
}

export function validatedText(value, label, maxLength, required = false) {
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

export function validatedEpoch(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER || String(n) !== String(value)) {
    throw new Error(`${label} must be a non-negative integer epoch (canonical form)`);
  }
  return n;
}

// F5/I3: scopes is MANDATORY unless --scopes-all. No implicit {} master credential.
export function validatedScopes(options) {
  const all = options["scopes-all"] === true;
  const explicit = options.scopes;
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

export function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

export function newTokenId() {
  const r = new Uint8Array(16);
  crypto.getRandomValues(r);
  let hex = "";
  for (const b of r) hex += b.toString(16).padStart(2, "0");
  return `acct_${hex}`;
}

// ---------------------------------------------------------------------------
// SQL helpers (single-quote escaping; the issuer stamps the caller-supplied actor).
// ---------------------------------------------------------------------------

export function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function sqlNullableString(value) {
  return value === null || value === undefined || value === "" ? "NULL" : sqlString(value);
}

// Audit row for account_token_events. NEVER include the raw token (L10): we only ever pass the
// token id, customer id, and operator-supplied reason.
export function eventSql({ accountTokenId, customerId, eventType, actor, reason = "" }) {
  return (
    `INSERT INTO account_token_events (account_token_id, customer_id, event_type, actor, actor_type, source, reason, request_id, created_at) ` +
    `VALUES (${sqlString(accountTokenId)}, ${sqlString(customerId)}, ${sqlString(eventType)}, ${sqlString(actor)}, 'cli', 'cli', ${sqlString(reason)}, 'cli-' || lower(hex(randomblob(8))), unixepoch())`
  );
}

// Token INSERT guarded so it inserts ONLY when the customer exists and is active. INSERT...SELECT
// with a WHERE EXISTS makes "customer must exist+active" an atomic SQL conjunct (no TOCTOU): a
// missing/disabled customer changes 0 rows (the caller reports the no-op).
export function insertTokenSqlGuarded({ id, customerId, tokenHmac, pepperKeyId, tokenPrefix, name, scopesJson, expiresAt, actor }) {
  return (
    `INSERT INTO account_tokens (id, customer_id, token_hmac, pepper_key_id, token_prefix, name, scopes_json, status, expires_at, last_used_at, replaced_by, created_by, created_at, updated_at) ` +
    `SELECT ${sqlString(id)}, ${sqlString(customerId)}, ${sqlString(tokenHmac)}, ${sqlString(pepperKeyId)}, ${sqlString(tokenPrefix)}, ${sqlNullableString(name)}, ${sqlString(scopesJson)}, 'active', ${expiresAt}, NULL, NULL, ${sqlString(actor)}, unixepoch(), unixepoch() ` +
    `WHERE EXISTS (SELECT 1 FROM customers WHERE id = ${sqlString(customerId)} AND status = 'active')`
  );
}

// Compute the keyed HMAC for a freshly generated raw token under the named pepper.
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
  const statements = [
    insertTokenSqlGuarded({ id, customerId, tokenHmac, pepperKeyId, tokenPrefix: token.token_prefix, name, scopesJson, expiresAt, actor }),
    eventSql({ accountTokenId: id, customerId, eventType: "issue", actor, reason: name }),
  ];
  const sql = statements.join(";\n");

  return { sql, statements, id, tokenHmac, pepperKeyId, plaintext: token.raw, tokenPrefix: token.token_prefix, customerId, scopesJson, expiresAt };
}
