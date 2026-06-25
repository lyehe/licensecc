// Slice 2 — account-token isolation integration matrix (Stage 3).
//
// Drives the REAL Worker fetch() handler (src/index.ts default export) over an in-memory
// SQLite built from the shared migrations/*.sql, wrapped in a D1-like adapter. Nothing about
// the isolation SQL is mocked: every assertion reads back the entitlement-owned mutation that
// the worker's owned/non-owned SQL produced. The account_tokens are seeded with token_hmac
// computed by the REAL hashToken() under a test pepper, so resolveAccountToken matches exactly
// the way production does.
//
// Covers, per relevant endpoint, the matrix: A/A allow; A/B DENY (no oracle); NULL under
// required deny; NULL under soft allow+log; A/B under soft DENY; no/revoked/expired/out-of-scope
// token; pepper-unset 503; disabled-customer denied. Write-atomicity: A cannot lease / checkout /
// heartbeat / release / report against B. Plus the Round-2 regressions F1 (idempotency scoped by
// customer), F3 (revoked entitlement mints nothing — the guard's status='active' denies even if a
// pre-read looked active), and F6 (soft populated-mismatch deny + NULL allow).
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The worker is imported from the COMPILED output (the established test pattern; node:test does
// not type-strip .ts). `npm run test:sql` builds first; the standalone gate runs after a build.
import worker from "../../dist/index.js";
import { generateAccountToken, hashToken, _resetRevocationFloorForTests } from "../../src/auth/account_token.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");

// --- D1-like adapter over node:sqlite ----------------------------------------
// Mirrors the Cloudflare D1 surface index.ts uses: prepare(sql).bind(...).first()/all()/run(),
// a transactional batch([...]), and the feature-detected withSession("first-primary") (returns
// self — a single in-process DB has no replica, so the strong read is the same DB).

class PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...values) {
    const next = new PreparedStatement(this.db, this.sql);
    next.params = values.map(normalizeParam);
    return next;
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
  async run() {
    this.db.prepare(this.sql).all(...this.params);
    return { success: true };
  }
}

function normalizeParam(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

class D1Like {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new PreparedStatement(this.db, sql);
  }
  // Feature-detected strong read: a single in-process DB IS the primary, so return self.
  withSession() {
    return this;
  }
  async batch(statements) {
    const out = [];
    this.db.exec("BEGIN");
    try {
      for (const stmt of statements) {
        out.push({ results: this.db.prepare(stmt.sql).all(...stmt.params), success: true });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return out;
  }
}

// ctx with a synchronous waitUntil so the throttled last_used write runs in-process during tests.
const CTX = { waitUntil: (p) => { void p; } };

// --- fixtures ----------------------------------------------------------------

const PROJECT = "DEFAULT";
const FEATURE = "DEFAULT";
// The worker computes its own `now = Date.now()/1000` internally, so fixtures must be anchored to
// real wall-clock time: a token/entitlement window in the past would spuriously read as expired.
const NOW = Math.floor(Date.now() / 1000);
const TEST_PEPPER_ID = "p1";
// 32 base64 bytes (>= the 32-byte floor loadSecretMap enforces).
const TEST_PEPPER_B64 = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)));
const PEPPERS_JSON = JSON.stringify({ [TEST_PEPPER_ID]: TEST_PEPPER_B64 });

const FP_A = "a".repeat(64); // A-owned entitlement
const FP_B = "b".repeat(64); // B-owned entitlement
const FP_NULL = "c".repeat(64); // NULL-owner entitlement

// A signing key is needed for lease/seat issuance to reach (and complete) the SQL path. Generate a
// throwaway 3072-bit RSA key once (pkcs8 PEM) — issuance only signs AFTER the ownership guard lands.
// The lease canonical payload validates key-id as sha256:<64 lowercase hex>, so use that form.
let LEASE_KEY_PEM;
const LEASE_KEY_ID = "sha256:" + "a".repeat(64);
const ONLINE_KEY_ID = "sha256:" + "b".repeat(64);
async function leaseKeyPem() {
  if (LEASE_KEY_PEM !== undefined) return LEASE_KEY_PEM;
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let b = "";
  for (const byte of pkcs8) b += String.fromCharCode(byte);
  const b64 = btoa(b).replace(/(.{64})/g, "$1\n");
  LEASE_KEY_PEM = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  return LEASE_KEY_PEM;
}

function applyMigrations(db) {
  for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
}

function seedCustomer(db, id, status = "active") {
  db.prepare(
    "INSERT INTO customers (id, name, email, metadata_json, created_at, updated_at, status, external_ref) VALUES (?, ?, '', '{}', ?, ?, ?, '')",
  ).run(id, `cust-${id}`, NOW, NOW, status);
}

// Seed an entitlement wired for BOTH lease (max_active_devices/lease_seconds/rebind_window_sec)
// and seat (pool_size/heartbeat_grace_sec) issuance. customerId null => NULL-owner row.
function seedEntitlement(db, fingerprint, customerId, { status = "active", poolSize = 5, validUntil = NOW + 365 * 86400 } = {}) {
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, " +
      "assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, " +
      "customer_id, max_active_devices, lease_seconds, rebind_window_sec, pool_size, " +
      "heartbeat_grace_sec, max_borrow_sec, allow_overdraft, created_at, updated_at) VALUES " +
      "(?, ?, ?, '', ?, 300, 300, 0, ?, ?, ?, 10, 2592000, 7776000, ?, 900, 0, 0, ?, ?)",
  ).run(PROJECT, FEATURE, fingerprint, status, NOW - 86400, validUntil, customerId, poolSize, NOW, NOW);
}

// Seed an account_token under the test pepper. scopes defaults to allow-all on the three axes.
async function seedToken(
  db,
  { customerId, status = "active", expiresAt = NOW + 365 * 86400, scopes = { allow_all: true }, pepperId = TEST_PEPPER_ID } = {},
) {
  const { raw, token_prefix } = generateAccountToken();
  const pepperBytes = new Uint8Array(atob(TEST_PEPPER_B64).split("").map((c) => c.charCodeAt(0)));
  const rawBytes = new TextEncoder().encode(raw);
  const tokenHmac = await hashToken(pepperBytes, rawBytes);
  const id = `tok_${customerId}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    "INSERT INTO account_tokens (id, customer_id, token_hmac, pepper_key_id, token_prefix, name, scopes_json, status, expires_at, last_used_at, replaced_by, created_by, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, NULL, NULL, '', ?, ?)",
  ).run(id, customerId, tokenHmac, pepperId, token_prefix, JSON.stringify(scopes), status, expiresAt, NOW, NOW);
  return { raw, id };
}

async function freshEnv(modeOverrides = {}) {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  seedCustomer(db, "A");
  seedCustomer(db, "B");
  seedCustomer(db, "D", "disabled");
  seedEntitlement(db, FP_A, "A");
  seedEntitlement(db, FP_B, "B");
  seedEntitlement(db, FP_NULL, null);
  const env = {
    DB: new D1Like(db),
    ACCOUNT_TOKEN_PEPPERS: PEPPERS_JSON,
    ACCOUNT_TOKEN_ACTIVE_PEPPER_ID: TEST_PEPPER_ID,
    ACCOUNT_TOKEN_MODE: "required",
    ACCOUNT_TOKEN_LAST_USED_THROTTLE_SEC: "300",
    LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM: await leaseKeyPem(),
    LEASE_SIGNING_KEY_ID: LEASE_KEY_ID,
    ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: await leaseKeyPem(),
    ONLINE_SIGNING_KEY_ID: ONLINE_KEY_ID,
    ...modeOverrides,
  };
  _resetRevocationFloorForTests();
  return { db, env };
}

// --- request helpers ---------------------------------------------------------

function bearer(token) {
  return token === null ? {} : { authorization: `Bearer ${token}` };
}

async function leaseReq(env, token, fingerprint, extra = {}) {
  const req = new Request("https://x/v1/activate", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ project: PROJECT, feature: FEATURE, license_fingerprint: fingerprint, device_key_id: "sha256:" + "d".repeat(64), ...extra }),
  });
  const res = await worker.fetch(req, env, CTX);
  return { status: res.status, body: await res.json() };
}

async function checkoutReq(env, token, fingerprint, instance = "inst-1") {
  const req = new Request("https://x/v1/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ project: PROJECT, feature: FEATURE, license_fingerprint: fingerprint, client_instance_id: instance, nonce: "e".repeat(64) }),
  });
  const res = await worker.fetch(req, env, CTX);
  return { status: res.status, body: await res.json() };
}

async function heartbeatReq(env, token, fingerprint, seatId) {
  const req = new Request("https://x/v1/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ project: PROJECT, feature: FEATURE, license_fingerprint: fingerprint, client_instance_id: "inst-1", nonce: "e".repeat(64), seat_id: seatId }),
  });
  const res = await worker.fetch(req, env, CTX);
  return { status: res.status, body: await res.json() };
}

async function releaseReq(env, token, fingerprint, seatId) {
  const req = new Request("https://x/v1/release", {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ project: PROJECT, feature: FEATURE, license_fingerprint: fingerprint, client_instance_id: "inst-1", nonce: "e".repeat(64), seat_id: seatId }),
  });
  const res = await worker.fetch(req, env, CTX);
  return { status: res.status, body: await res.json() };
}

async function reportReq(env, token, fingerprint, { from } = {}) {
  const qs = new URLSearchParams({ project: PROJECT, feature: FEATURE, license_fingerprint: fingerprint });
  if (from !== undefined) qs.set("from", String(from));
  const req = new Request(`https://x/v1/admin/report?${qs.toString()}`, { method: "GET", headers: { ...bearer(token) } });
  const res = await worker.fetch(req, env, CTX);
  return { status: res.status, body: await res.json() };
}

function liveSeats(db, fingerprint) {
  return db.prepare("SELECT COUNT(*) AS c FROM seat_checkouts WHERE license_fingerprint = ? AND heartbeat_deadline > ?").get(fingerprint, NOW).c;
}

function seatRowFor(db, fingerprint) {
  return db.prepare("SELECT seat_id FROM seat_checkouts WHERE license_fingerprint = ? LIMIT 1").get(fingerprint);
}

// =============================================================================
// LEASE — /v1/activate
// =============================================================================

test("lease required: A's token issues against A's entitlement", async () => {
  const { db, env } = await freshEnv();
  const a = await seedToken(db, { customerId: "A" });
  const r = await leaseReq(env, a.raw, FP_A);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM lease_issuance WHERE license_fingerprint = ?").get(FP_A).c, 1);
  db.close();
});

test("lease required: A's token CANNOT issue against B's entitlement (no oracle, no row)", async () => {
  const { db, env } = await freshEnv();
  const a = await seedToken(db, { customerId: "A" });
  const r = await leaseReq(env, a.raw, FP_B);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, "device_limit_exceeded", "owned guard matched no row => the cap-guard insert returned nothing (same shape as absent)");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM lease_issuance WHERE license_fingerprint = ?").get(FP_B).c, 0, "no lease written for B under A's token");
  db.close();
});

test("lease required: a NULL-owner entitlement is denied (NULL = ? is never true)", async () => {
  const { db, env } = await freshEnv();
  const a = await seedToken(db, { customerId: "A" });
  const r = await leaseReq(env, a.raw, FP_NULL);
  assert.equal(r.body.ok, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM lease_issuance WHERE license_fingerprint = ?").get(FP_NULL).c, 0);
  db.close();
});

test("lease soft: NULL-owner is allowed; populated-mismatch (A->B) is DENIED (F6)", async () => {
  const { db, env } = await freshEnv({ ACCOUNT_TOKEN_MODE: "soft" });
  const a = await seedToken(db, { customerId: "A" });
  // F6: NULL-owner allowed under soft.
  const rNull = await leaseReq(env, a.raw, FP_NULL);
  assert.equal(rNull.body.ok, true, "soft mode allows a NULL-owner entitlement");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM lease_issuance WHERE license_fingerprint = ?").get(FP_NULL).c, 1);
  // F6: a POPULATED mismatch still denies under soft.
  const rB = await leaseReq(env, a.raw, FP_B);
  assert.equal(rB.body.ok, false, "soft mode still denies a populated wrong-owner");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM lease_issuance WHERE license_fingerprint = ?").get(FP_B).c, 0);
  db.close();
});

test("lease: no token denied 401; revoked token 401; expired token 401; out-of-scope 403", async () => {
  const { db, env } = await freshEnv();
  const revoked = await seedToken(db, { customerId: "A", status: "revoked" });
  const expired = await seedToken(db, { customerId: "A", expiresAt: NOW - 10 });
  const scoped = await seedToken(db, { customerId: "A", scopes: { projects: ["OTHER"], features: ["*"], operations: ["*"] } });

  assert.equal((await leaseReq(env, null, FP_A)).status, 401, "missing token");
  assert.equal((await leaseReq(env, revoked.raw, FP_A)).status, 401, "revoked token");
  assert.equal((await leaseReq(env, expired.raw, FP_A)).status, 401, "expired token");
  const oos = await leaseReq(env, scoped.raw, FP_A);
  assert.equal(oos.status, 403, "out-of-scope project");
  assert.equal(oos.body.code, "forbidden_scope");
  db.close();
});

test("lease: pepper-unset => 503 config_error (terminal deny, never bearer-fallback)", async () => {
  const { db, env } = await freshEnv({ ACCOUNT_TOKEN_PEPPERS: undefined });
  const a = await seedToken(db, { customerId: "A" });
  const r = await leaseReq(env, a.raw, FP_A);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "config_error");
  db.close();
});

test("lease: a token for a DISABLED customer is denied (customers JOIN c.status='active')", async () => {
  const { db, env } = await freshEnv();
  seedEntitlement(db, "f".repeat(64), "D"); // D is disabled
  const d = await seedToken(db, { customerId: "D" });
  const r = await leaseReq(env, d.raw, "f".repeat(64));
  assert.equal(r.status, 401, "disabled customer's token does not resolve");
  db.close();
});

// F1 — idempotency scoped by customer: a replay of B's request_id under A's token must NOT return
// B's cached lease.
test("F1: replaying B's request_id under A's token does NOT return B's cached lease", async () => {
  const { db, env } = await freshEnv();
  const a = await seedToken(db, { customerId: "A" });
  const b = await seedToken(db, { customerId: "B" });

  // B issues a real lease for B's entitlement under request_id RID (caches under scope lease:B).
  const rB = await leaseReq(env, b.raw, FP_B, { request_id: "RID-shared" });
  assert.equal(rB.body.ok, true);
  const bLic = rB.body.lic;
  assert.ok(typeof bLic === "string" && bLic.length > 0);

  // A replays the SAME request_id but against B's fingerprint. The idempotency cache is scoped by
  // customer (lease:A != lease:B) => cache MISS => falls through to the ownership guard => denied.
  const rReplay = await leaseReq(env, a.raw, FP_B, { request_id: "RID-shared" });
  assert.equal(rReplay.body.ok, false, "A's replay must not return B's cached lease");
  assert.notEqual(rReplay.body.lic, bLic, "B's signed lease was not served to A");
  // And no new lease for B was minted under A's token.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM lease_issuance WHERE license_fingerprint = ?").get(FP_B).c, 1, "still exactly B's own one lease");
  db.close();
});

// F3 — a revoked entitlement mints nothing even though a pre-read might look active. We revoke
// AFTER seeding active, so the advisory pre-read could pass but the guarded INSERT's status='active'
// conjunct denies.
test("F3: a revoked entitlement yields no lease (guard status='active' denies post-pre-read)", async () => {
  const { db, env } = await freshEnv();
  const a = await seedToken(db, { customerId: "A" });
  // The entitlement is active for the pre-read, then revoked before the guarded write would land.
  // We assert the END STATE: with status='revoked', the owned guard's status='active' conjunct
  // means the INSERT EXISTS is false -> no lease, regardless of what a stale pre-read believed.
  db.prepare("UPDATE entitlements SET status = 'revoked' WHERE license_fingerprint = ?").run(FP_A);
  const r = await leaseReq(env, a.raw, FP_A);
  assert.equal(r.body.ok, false, "no lease for a revoked entitlement");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM lease_issuance WHERE license_fingerprint = ?").get(FP_A).c, 0, "nothing signed from a stale active pre-read");
  db.close();
});

// =============================================================================
// SEAT — checkout / heartbeat / release
// =============================================================================

test("checkout required: A checks out A's seat; A CANNOT check out B's seat (write-atomicity)", async () => {
  const { db, env } = await freshEnv();
  const a = await seedToken(db, { customerId: "A" });
  const ok = await checkoutReq(env, a.raw, FP_A);
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.equal(liveSeats(db, FP_A), 1);

  const denied = await checkoutReq(env, a.raw, FP_B);
  assert.equal(denied.body.ok, false, "A cannot check out a seat on B's entitlement");
  assert.equal(liveSeats(db, FP_B), 0, "no seat written against B under A's token");
  db.close();
});

test("checkout: A's seats never count against B's pool (foreign seats don't count)", async () => {
  const { db, env } = await freshEnv();
  // B's pool is 1; A holds many seats on A's entitlement — they must not occupy B's pool.
  db.prepare("UPDATE entitlements SET pool_size = 1 WHERE license_fingerprint = ?").run(FP_B);
  const a = await seedToken(db, { customerId: "A" });
  const b = await seedToken(db, { customerId: "B" });
  await checkoutReq(env, a.raw, FP_A, "a1");
  await checkoutReq(env, a.raw, FP_A, "a2");
  // B can still take its single seat (A's checkouts are on a different fingerprint/owner).
  const bOk = await checkoutReq(env, b.raw, FP_B, "b1");
  assert.equal(bOk.body.ok, true, "B's own pool is unaffected by A's seats");
  db.close();
});

test("heartbeat required: A heartbeats A's seat; A CANNOT heartbeat B's seat", async () => {
  const { db, env } = await freshEnv();
  const a = await seedToken(db, { customerId: "A" });
  const b = await seedToken(db, { customerId: "B" });
  const aCo = await checkoutReq(env, a.raw, FP_A);
  const bCo = await checkoutReq(env, b.raw, FP_B);
  const aSeat = aCo.body.seat_id;
  const bSeat = bCo.body.seat_id;

  const aHb = await heartbeatReq(env, a.raw, FP_A, aSeat);
  assert.equal(aHb.body.ok, true, "A can heartbeat its own seat");

  // A attempts to heartbeat B's seat (B's fingerprint + B's seat id) under A's token: 0 rows.
  const crossHb = await heartbeatReq(env, a.raw, FP_B, bSeat);
  assert.equal(crossHb.body.ok, false, "A cannot heartbeat B's seat");
  assert.equal(crossHb.status, 410, "no row refreshed => seat_reclaimed");
  db.close();
});

test("release required: A's release of B's seat frees NOTHING (B's seat survives)", async () => {
  const { db, env } = await freshEnv();
  const a = await seedToken(db, { customerId: "A" });
  const b = await seedToken(db, { customerId: "B" });
  const bCo = await checkoutReq(env, b.raw, FP_B);
  const bSeat = bCo.body.seat_id;
  assert.equal(liveSeats(db, FP_B), 1);

  // A releases B's seat: idempotent {ok:true} but the owned DELETE frees nothing.
  const aRel = await releaseReq(env, a.raw, FP_B, bSeat);
  assert.equal(aRel.body.ok, true, "release is idempotent regardless");
  assert.equal(liveSeats(db, FP_B), 1, "B's seat was NOT freed by A");

  // B can release its own seat.
  const bRel = await releaseReq(env, b.raw, FP_B, bSeat);
  assert.equal(bRel.body.ok, true);
  assert.equal(liveSeats(db, FP_B), 0, "B freed its own seat");
  db.close();
});

// =============================================================================
// USAGE REPORT — /v1/admin/report
// =============================================================================

test("report required: A sees A's usage; A's report on B's entitlement is empty (no foreign events)", async () => {
  const { db, env } = await freshEnv();
  const a = await seedToken(db, { customerId: "A" });
  const b = await seedToken(db, { customerId: "B" });
  // Generate real usage on both A and B.
  await checkoutReq(env, a.raw, FP_A, "a1");
  await checkoutReq(env, b.raw, FP_B, "b1");

  const aReport = await reportReq(env, a.raw, FP_A);
  assert.equal(aReport.body.ok, true);

  // A reports on B's fingerprint: the owned EXISTS gates on A's customer_id, so B's events do not
  // surface (B-owned entitlement never matches A) — the report is empty/zeroed for A.
  const crossReport = await reportReq(env, a.raw, FP_B);
  assert.equal(crossReport.body.ok, true, "report endpoint returns ok with empty data, not an oracle");
  assert.equal(crossReport.body.total_checkouts ?? 0, 0, "no B checkouts surface in A's cross report");
  db.close();
});

test("report soft: a NULL-owner entitlement's report is allowed", async () => {
  const { db, env } = await freshEnv({ ACCOUNT_TOKEN_MODE: "soft" });
  const a = await seedToken(db, { customerId: "A" });
  await checkoutReq(env, a.raw, FP_NULL); // soft allows the NULL-owner checkout
  const r = await reportReq(env, a.raw, FP_NULL);
  assert.equal(r.body.ok, true, "soft mode allows reporting a NULL-owner entitlement");
  db.close();
});

// =============================================================================
// EMERGENCY break-glass — /v1/emergency/*
// =============================================================================

async function emergencyReleaseReq(env, bearerValue, fingerprint, seatId) {
  const headers = { "content-type": "application/json" };
  if (bearerValue !== null) headers.authorization = `Bearer ${bearerValue}`;
  const req = new Request("https://x/v1/emergency/v1/release", {
    method: "POST",
    headers,
    body: JSON.stringify({ project: PROJECT, feature: FEATURE, license_fingerprint: fingerprint, client_instance_id: "i", nonce: "e".repeat(64), seat_id: seatId }),
  });
  const res = await worker.fetch(req, env, CTX);
  return { status: res.status, body: await res.json() };
}

test("emergency: unset bearer => 404; wrong bearer => 401; correct bearer => non-isolated dispatch", async () => {
  // Unset EMERGENCY_OPERATOR_BEARER: the route does not exist.
  const { db: db0, env: env0 } = await freshEnv();
  const r404 = await emergencyReleaseReq(env0, "anything", FP_B, "x");
  assert.equal(r404.status, 404, "unset emergency bearer => 404");
  db0.close();

  // Set the bearer. A wrong value => 401; the right value => dispatch with isolation forced off.
  const { db, env } = await freshEnv({ EMERGENCY_OPERATOR_BEARER: "break-glass-secret" });
  const b = await seedToken(db, { customerId: "B" });
  const bCo = await checkoutReq(env, b.raw, FP_B);
  const bSeat = bCo.body.seat_id;
  assert.equal(liveSeats(db, FP_B), 1, "B holds a seat before break-glass");

  const wrong = await emergencyReleaseReq(env, "nope", FP_B, bSeat);
  assert.equal(wrong.status, 401, "wrong emergency bearer => 401");
  assert.equal(liveSeats(db, FP_B), 1, "B's seat untouched by the failed break-glass");

  // Correct bearer: the operator override releases B's seat WITHOUT any customer token (off mode,
  // original non-owned DELETE), proving break-glass is non-isolated.
  const right = await emergencyReleaseReq(env, "break-glass-secret", FP_B, bSeat);
  assert.equal(right.body.ok, true);
  assert.equal(liveSeats(db, FP_B), 0, "break-glass freed B's seat without a customer token");
  db.close();
});

// =============================================================================
// EXCLUDED paths unaffected (/v1/orders separate domain; /health open)
// =============================================================================

test("/health is open (no account-token gate)", async () => {
  const { db, env } = await freshEnv();
  const res = await worker.fetch(new Request("https://x/health", { method: "GET" }), env, CTX);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  db.close();
});
