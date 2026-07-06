// Stage 3 — license-policy CRUD + create-from-policy stamp (real SQLite, end-to-end through worker.fetch).
//
// The hermetic unit MockD1 (admin-worker.test.mjs) only knows the entitlement SQL and throws on anything
// else, so policy CRUD (entitlement_policies / policy_events) + the atomic policy-stamp side-write cannot
// run there. This suite drives the REAL compiled worker over an in-memory SQLite built from the shared
// migrations/*.sql (which include 0018 entitlement_policies + 0019 policy_events) wrapped in a D1-like
// adapter — nothing about the policy SQL is mocked.
//
// Covers: create + audit row; UNIQUE(project, lower(name)) -> 409 policy_name_conflict; patch
// (and the not-patchable project/name/type/status rejection); disable/reenable guard + audit + the
// reason gate; list filters + cursor; detail 404. create-from-policy: POLICY_STAMP_MODE off rejects
// (400 policy_stamping_disabled); on stamps the policy window/ttl + capacity/trial columns onto the row;
// an unknown/disabled policy -> 404 policy_not_found. RBAC: a reader can read policies but cannot run any
// policy write nor the policy-stamp create.
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.

import assert from "node:assert/strict";
import http from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import worker from "../../dist-worker/worker/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "cloudflare-licensing-backend", "migrations");

// --- D1-like adapter over node:sqlite (mirrors the surface the worker uses) ---
function normalizeParam(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

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

class D1Like {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new PreparedStatement(this.db, sql);
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

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return db;
}

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

// --- Cloudflare Access fixture (reader vs admin RBAC) ------------------------
async function accessFixture(t) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return {
    issuer: "https://licensecc-test.cloudflareaccess.com",
    audience: "test-audience",
    jwksUrl: `http://127.0.0.1:${port}/cdn-cgi/access/certs`,
    privateKey,
  };
}

function accessToken(fixture, email) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(fixture.issuer)
    .setAudience(fixture.audience)
    .setSubject(email)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(fixture.privateKey);
}

function devEnv(db, extra = {}) {
  return {
    DB: new D1Like(db),
    ENVIRONMENT: "development",
    ADMIN_DEV_BEARER_ENABLED: "1",
    ADMIN_DEV_BEARER: "dev-secret",
    ...extra,
  };
}

function accessEnv(db, fixture, extra = {}) {
  return {
    DB: new D1Like(db),
    ENVIRONMENT: "staging",
    ADMIN_DEV_BEARER_ENABLED: "0",
    ADMIN_ACCESS_ISSUER: fixture.issuer,
    ADMIN_ACCESS_AUDIENCE: fixture.audience,
    ADMIN_ACCESS_JWKS_URL: fixture.jwksUrl,
    ADMIN_ACCESS_ADMIN_EMAILS: "admin@example.com",
    ADMIN_ACCESS_READER_EMAILS: "reader@example.com",
    ...extra,
  };
}

function devReq(path, options = {}) {
  return new Request(`https://admin.example${path}`, {
    ...options,
    headers: { authorization: "Bearer dev-secret", "content-type": "application/json", ...(options.headers ?? {}) },
  });
}

function accessReq(path, token, options = {}) {
  return new Request(`https://admin.example${path}`, {
    ...options,
    headers: { "cf-access-jwt-assertion": token, "content-type": "application/json", ...(options.headers ?? {}) },
  });
}

async function body(response) {
  return response.json();
}

// Create a policy through the worker and return its row.
async function createPolicy(env, payload) {
  const res = await worker.fetch(devReq("/api/admin/policies", { method: "POST", body: JSON.stringify(payload) }), env);
  assert.equal(res.status, 200, `create policy: ${await res.clone().text()}`);
  return (await body(res)).data;
}

test("policy: create writes the row + a policy_events audit row", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const created = await createPolicy(env, {
    project: "DEFAULT",
    name: "Pro Annual",
    type: "subscription",
    duration_sec: 31536000,
    assertion_ttl_seconds: 600,
    max_active_devices: 5,
    pool_size: 10,
    notes: "annual seat plan",
  });
  assert.ok(created.id);
  assert.equal(created.project, "DEFAULT");
  assert.equal(created.name, "Pro Annual");
  assert.equal(created.type, "subscription");
  assert.equal(created.status, "active");
  assert.equal(created.duration_sec, 31536000);
  assert.equal(created.assertion_ttl_seconds, 600);
  assert.equal(created.max_active_devices, 5);
  assert.equal(created.pool_size, 10);

  const row = db.prepare("SELECT * FROM entitlement_policies WHERE id = ?").get(created.id);
  assert.equal(row.name, "Pro Annual");
  const event = db.prepare("SELECT * FROM policy_events WHERE policy_id = ? ORDER BY id DESC LIMIT 1").get(created.id);
  assert.equal(event.event_type, "create");
  assert.equal(event.actor, "dev.local");
  assert.equal(event.project, "DEFAULT");
  // next_json carries the persisted row snapshot.
  const next = JSON.parse(event.next_json);
  assert.equal(next.name, "Pro Annual");
  assert.equal(next.id, created.id);
});

test("policy: defaults are applied for omitted columns", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const created = await createPolicy(env, { project: "DEFAULT", name: "Bare", type: "node_locked" });
  assert.equal(created.assertion_ttl_seconds, 300);
  assert.equal(created.pool_size, 0);
  assert.equal(created.max_active_devices, 1);
  assert.equal(created.max_borrow_sec, 0);
  assert.equal(created.expiry_strategy, "fixed_window");
  assert.equal(created.trial_expiration_basis, "from_issue");
  assert.equal(created.valid_from_offset_sec, null);
  assert.equal(created.duration_sec, null);
  assert.equal(created.notes, "");
});

test("policy: duplicate name within a project (case-insensitive) is 409 policy_name_conflict", async () => {
  const db = freshDb();
  const env = devEnv(db);
  await createPolicy(env, { project: "DEFAULT", name: "Trial 30d", type: "trial" });

  const dup = await worker.fetch(devReq("/api/admin/policies", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", name: "TRIAL 30D", type: "trial" }),
  }), env);
  assert.equal(dup.status, 409);
  assert.equal((await body(dup)).code, "policy_name_conflict");
  // Only the first policy persisted; no audit row for the rejected create.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_policies").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM policy_events").get().c, 1);

  // The same name in a DIFFERENT project is allowed.
  const other = await worker.fetch(devReq("/api/admin/policies", {
    method: "POST",
    body: JSON.stringify({ project: "OTHER", name: "Trial 30d", type: "trial" }),
  }), env);
  assert.equal(other.status, 200);
});

test("policy: invalid create bodies are 400 invalid_request", async () => {
  const db = freshDb();
  const env = devEnv(db);
  for (const bad of [
    {},
    { project: "DEFAULT", name: "x" }, // missing type
    { project: "DEFAULT", name: "x", type: "bogus" }, // bad enum
    { project: "DEFAULT", name: "x", type: "trial", assertion_ttl_seconds: 0 }, // out of range
    { project: "DEFAULT", name: "x", type: "trial", expiry_strategy: "nope" },
    { project: "DEFAULT", name: "x", type: "trial", trial_one_per_device: 2 },
    { project: "DEFAULT", name: "x\ninjection", type: "trial" }, // newline rejected
  ]) {
    const res = await worker.fetch(devReq("/api/admin/policies", { method: "POST", body: JSON.stringify(bad) }), env);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal((await body(res)).code, "invalid_request");
  }
});

test("policy: patch updates mutable fields + audits; identity fields are rejected", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const created = await createPolicy(env, { project: "DEFAULT", name: "Editable", type: "floating", pool_size: 3 });

  const patched = await worker.fetch(devReq(`/api/admin/policies/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ pool_size: 8, max_borrow_sec: 3600, notes: "bumped" }),
  }), env);
  assert.equal(patched.status, 200);
  const data = (await body(patched)).data;
  assert.equal(data.pool_size, 8);
  assert.equal(data.max_borrow_sec, 3600);
  assert.equal(data.notes, "bumped");
  assert.ok(data.updated_at >= created.updated_at);
  assert.equal(db.prepare("SELECT event_type FROM policy_events WHERE policy_id=? ORDER BY id DESC LIMIT 1").get(created.id).event_type, "update");

  // project/name/type/status are not patchable.
  for (const bad of [{ project: "X" }, { name: "Renamed" }, { type: "trial" }, { status: "disabled" }]) {
    const res = await worker.fetch(devReq(`/api/admin/policies/${created.id}`, { method: "PATCH", body: JSON.stringify(bad) }), env);
    assert.equal(res.status, 400, `identity field ${JSON.stringify(bad)} must be rejected`);
    assert.equal((await body(res)).code, "invalid_request");
  }
  // Patch on a missing policy is 404.
  const missing = await worker.fetch(devReq("/api/admin/policies/nope", { method: "PATCH", body: JSON.stringify({ pool_size: 1 }) }), env);
  assert.equal(missing.status, 404);
});

test("policy: disable/reenable is guarded + audited with the reason gate", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const created = await createPolicy(env, { project: "DEFAULT", name: "Switchable", type: "trial" });

  // disable requires a reason
  const noReason = await worker.fetch(devReq(`/api/admin/policies/${created.id}/disable`, { method: "POST", body: "{}" }), env);
  assert.equal(noReason.status, 400);
  assert.equal((await body(noReason)).code, "reason_required");

  // disable -> 200, status flips, audit row written with the reason
  const disabled = await worker.fetch(devReq(`/api/admin/policies/${created.id}/disable`, { method: "POST", body: JSON.stringify({ reason: "deprecated" }) }), env);
  assert.equal(disabled.status, 200);
  assert.equal((await body(disabled)).data.status, "disabled");
  assert.equal(db.prepare("SELECT status FROM entitlement_policies WHERE id=?").get(created.id).status, "disabled");
  const ev = db.prepare("SELECT * FROM policy_events WHERE policy_id=? ORDER BY id DESC LIMIT 1").get(created.id);
  assert.equal(ev.event_type, "disable");
  assert.equal(ev.reason, "deprecated");

  // already disabled -> 409
  const again = await worker.fetch(devReq(`/api/admin/policies/${created.id}/disable`, { method: "POST", body: JSON.stringify({ reason: "y" }) }), env);
  assert.equal(again.status, 409);
  assert.equal((await body(again)).code, "policy_status_conflict");

  // reenable -> 200 active (reason optional)
  const reenabled = await worker.fetch(devReq(`/api/admin/policies/${created.id}/reenable`, { method: "POST", body: "{}" }), env);
  assert.equal(reenabled.status, 200);
  assert.equal((await body(reenabled)).data.status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM policy_events WHERE policy_id=?").get(created.id).c, 3);

  // disable on a missing policy -> 404
  const missing = await worker.fetch(devReq("/api/admin/policies/nope/disable", { method: "POST", body: JSON.stringify({ reason: "x" }) }), env);
  assert.equal(missing.status, 404);
});

test("policy: list filters by project/type/status with cursor pagination; detail 404", async () => {
  const db = freshDb();
  const env = devEnv(db);
  await createPolicy(env, { project: "DEFAULT", name: "P1", type: "trial" });
  await createPolicy(env, { project: "DEFAULT", name: "P2", type: "subscription" });
  await createPolicy(env, { project: "OTHER", name: "P3", type: "trial" });

  assert.equal((await body(await worker.fetch(devReq("/api/admin/policies"), env))).data.items.length, 3);
  assert.equal((await body(await worker.fetch(devReq("/api/admin/policies?project=OTHER"), env))).data.items.length, 1);
  assert.equal((await body(await worker.fetch(devReq("/api/admin/policies?type=trial"), env))).data.items.length, 2);
  assert.equal((await body(await worker.fetch(devReq("/api/admin/policies?type=subscription"), env))).data.items[0].name, "P2");

  // cursor pagination
  const page1 = await body(await worker.fetch(devReq("/api/admin/policies?limit=2"), env));
  assert.equal(page1.data.items.length, 2);
  assert.equal(page1.data.next_cursor, "2");
  const page2 = await body(await worker.fetch(devReq("/api/admin/policies?limit=2&cursor=2"), env));
  assert.equal(page2.data.items.length, 1);
  assert.equal(page2.data.next_cursor, null);

  // detail
  const id = page1.data.items[0].id;
  assert.equal((await worker.fetch(devReq(`/api/admin/policies/${id}`), env)).status, 200);
  assert.equal((await worker.fetch(devReq("/api/admin/policies/nope"), env)).status, 404);
});

test("stamp: POLICY_STAMP_MODE off rejects a policy_id create (400 policy_stamping_disabled)", async () => {
  const db = freshDb();
  const env = devEnv(db); // no POLICY_STAMP_MODE -> off
  const policy = await createPolicy(env, { project: "DEFAULT", name: "TrialOff", type: "trial", trial_duration_sec: 1209600 });

  const res = await worker.fetch(devReq("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP_A, policy_id: policy.id }),
  }), env);
  assert.equal(res.status, 400);
  assert.equal((await body(res)).code, "policy_stamping_disabled");
  // No entitlement was created.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);

  // Without a policy_id, the exact current behavior still works even in off mode.
  const plain = await worker.fetch(devReq("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP_B }),
  }), env);
  assert.equal(plain.status, 200);
});

test("stamp: POLICY_STAMP_MODE on stamps the policy window/ttl + capacity/trial columns", async () => {
  const db = freshDb();
  const env = devEnv(db, { POLICY_STAMP_MODE: "on" });
  const policy = await createPolicy(env, {
    project: "DEFAULT",
    name: "Trial14",
    type: "trial",
    assertion_ttl_seconds: 900,
    trial_duration_sec: 1209600, // 14 days
    trial_one_per_device: 1,
    trial_require_device_proof: 1,
    pool_size: 4,
    max_active_devices: 2,
    max_borrow_sec: 7200,
  });

  const res = await worker.fetch(devReq("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP_A, policy_id: policy.id, customer_id: "cus_x" }),
  }), env);
  assert.equal(res.status, 200, await res.clone().text());
  const data = (await body(res)).data;
  assert.equal(data.assertion_ttl_seconds, 900, "ttl came from the policy");
  assert.equal(data.customer_id, "cus_x", "override flowed through");
  // from_issue trial, no valid_from_offset_sec -> open start (null), valid_until = now + trial_duration.
  assert.equal(data.valid_from, null);
  const stampNow = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(data.valid_until - (stampNow + 1209600)) <= 5, `valid_until ~ now+trial_duration, got ${data.valid_until}`);

  // The capacity + frozen-trial side-state landed on the SAME row (atomic with the INSERT).
  const row = db.prepare("SELECT policy_id, is_trial, trial_expiration_basis, trial_duration_sec, trial_one_per_device, trial_require_device_proof, pool_size, max_active_devices, max_borrow_sec, assertion_ttl_seconds FROM entitlements WHERE project='DEFAULT' AND feature='DEFAULT' AND license_fingerprint=?").get(FP_A);
  assert.equal(row.policy_id, policy.id);
  assert.equal(row.is_trial, 1);
  assert.equal(row.trial_expiration_basis, "from_issue");
  assert.equal(row.trial_duration_sec, 1209600);
  assert.equal(row.trial_one_per_device, 1);
  assert.equal(row.trial_require_device_proof, 1);
  assert.equal(row.pool_size, 4);
  assert.equal(row.max_active_devices, 2);
  assert.equal(row.max_borrow_sec, 7200);
  assert.equal(row.assertion_ttl_seconds, 900);

  // The stamp produced exactly one entitlement audit event (create), proving the side-write rode the same batch.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE license_fingerprint=?").get(FP_A).c, 1);
});

test("stamp: a non-trial policy freezes is_trial=0 and applies its duration window", async () => {
  const db = freshDb();
  const env = devEnv(db, { POLICY_STAMP_MODE: "on" });
  const policy = await createPolicy(env, {
    project: "DEFAULT",
    name: "Sub1y",
    type: "subscription",
    duration_sec: 31536000,
    max_active_devices: 3,
  });
  const res = await worker.fetch(devReq("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP_A, policy_id: policy.id }),
  }), env);
  assert.equal(res.status, 200);
  const data = (await body(res)).data;
  // No valid_from_offset_sec on the policy -> open start (null) and valid_until = now + duration.
  assert.equal(data.valid_from, null);
  const nowSec = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(data.valid_until - (nowSec + 31536000)) <= 5, `valid_until ~ now+duration, got ${data.valid_until}`);
  const row = db.prepare("SELECT is_trial, trial_duration_sec, max_active_devices, policy_id FROM entitlements WHERE license_fingerprint=?").get(FP_A);
  assert.equal(row.is_trial, 0);
  assert.equal(row.trial_duration_sec, 0);
  assert.equal(row.max_active_devices, 3);
  assert.equal(row.policy_id, policy.id);
});

test("stamp: unknown or disabled policy_id is 404 policy_not_found", async () => {
  const db = freshDb();
  const env = devEnv(db, { POLICY_STAMP_MODE: "on" });

  const unknown = await worker.fetch(devReq("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP_A, policy_id: "does-not-exist" }),
  }), env);
  assert.equal(unknown.status, 404);
  assert.equal((await body(unknown)).code, "policy_not_found");

  // A disabled policy cannot be stamped (frozen templates: disabling blocks NEW stamps).
  const policy = await createPolicy(env, { project: "DEFAULT", name: "Retired", type: "trial" });
  await worker.fetch(devReq(`/api/admin/policies/${policy.id}/disable`, { method: "POST", body: JSON.stringify({ reason: "eol" }) }), env);
  const disabled = await worker.fetch(devReq("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP_A, policy_id: policy.id }),
  }), env);
  assert.equal(disabled.status, 404);
  assert.equal((await body(disabled)).code, "policy_not_found");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
});

test("policy: reader can read policies but cannot run any policy write or stamp", async (t) => {
  const db = freshDb();
  const fixture = await accessFixture(t);
  const env = accessEnv(db, fixture, { POLICY_STAMP_MODE: "on" });
  const admin = await accessToken(fixture, "admin@example.com");
  const reader = await accessToken(fixture, "reader@example.com");

  // Admin seeds a policy.
  const createRes = await worker.fetch(accessReq("/api/admin/policies", admin, {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", name: "RBAC", type: "trial" }),
  }), env);
  assert.equal(createRes.status, 200);
  const policyId = (await body(createRes)).data.id;

  // Reader CAN read list + detail.
  assert.equal((await worker.fetch(accessReq("/api/admin/policies", reader), env)).status, 200);
  assert.equal((await worker.fetch(accessReq(`/api/admin/policies/${policyId}`, reader), env)).status, 200);

  // Reader CANNOT create / patch / disable / reenable / stamp.
  const denied = [
    accessReq("/api/admin/policies", reader, { method: "POST", body: JSON.stringify({ project: "DEFAULT", name: "Nope", type: "trial" }) }),
    accessReq(`/api/admin/policies/${policyId}`, reader, { method: "PATCH", body: JSON.stringify({ pool_size: 9 }) }),
    accessReq(`/api/admin/policies/${policyId}/disable`, reader, { method: "POST", body: JSON.stringify({ reason: "x" }) }),
    accessReq(`/api/admin/policies/${policyId}/reenable`, reader, { method: "POST", body: "{}" }),
    accessReq("/api/admin/entitlements", reader, { method: "POST", body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP_A, policy_id: policyId }) }),
  ];
  for (const req of denied) {
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 403, `reader ${req.method} ${new URL(req.url).pathname}`);
    assert.equal((await body(res)).code, "admin_role_required");
  }
  // Denied reader writes changed nothing: still exactly one policy, no extra audit rows, no entitlement.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_policies").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM policy_events").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlements").get().c, 0);
});
