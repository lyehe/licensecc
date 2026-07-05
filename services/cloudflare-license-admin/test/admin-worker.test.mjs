import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker, { adminInternalsForTests } from "../dist-worker/worker/index.js";

const fingerprint = "a".repeat(64);

// The exact field set the production json_object emits into entitlement_events.next_json
// (eventFromCurrentStatement, now in the shared @licensecc/cloudflare-licensing-backend
// entitlement_mutation core). cache_ttl_seconds is present here even though withId() strips
// it from the API response body; the drift-guard test pins this contract.
const NEXT_JSON_KEYS = [
  "project",
  "feature",
  "license_fingerprint",
  "device_hash",
  "status",
  "assertion_ttl_seconds",
  "cache_ttl_seconds",
  "revocation_seq",
  "valid_from",
  "valid_until",
  "notes",
  "customer_id",
  "license_id",
  "policy_id",
  "is_trial",
  "trial_expiration_basis",
  "trial_duration_sec",
  "trial_one_per_device",
  "trial_require_device_proof",
  "trial_started_at",
  "trial_device_hash",
  "max_active_devices",
  "lease_seconds",
  "rebind_window_sec",
  "pool_size",
  "heartbeat_grace_sec",
  "max_borrow_sec",
  "allow_overdraft",
  "meter_quota",
  "meter_period_sec",
  "license_mode",
  "created_at",
  "updated_at",
  "id",
];

function baseEnv(db = new MockD1()) {
  return {
    DB: db,
    ENVIRONMENT: "development",
    ADMIN_DEV_BEARER_ENABLED: "1",
    ADMIN_DEV_BEARER: "dev-secret",
    PUBLIC_VERIFIER_URL: "https://verifier.example",
  };
}

function syncEnv(db = new MockD1()) {
  return {
    ...baseEnv(db),
    SYNC_API_TOKEN: "sync-secret",
  };
}

function authed(path, options = {}) {
  return new Request(`https://admin.example${path}`, {
    ...options,
    headers: {
      authorization: "Bearer dev-secret",
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
}

function accessEnv(db, fixture) {
  return {
    DB: db,
    ENVIRONMENT: "staging",
    ADMIN_DEV_BEARER_ENABLED: "0",
    ADMIN_ACCESS_ISSUER: fixture.issuer,
    ADMIN_ACCESS_AUDIENCE: fixture.audience,
    ADMIN_ACCESS_JWKS_URL: fixture.jwksUrl,
    ADMIN_ACCESS_ADMIN_EMAILS: "admin@example.com",
    ADMIN_ACCESS_READER_EMAILS: "reader@example.com",
    PUBLIC_VERIFIER_URL: "https://verifier.example",
  };
}

function accessAuthed(path, token, options = {}) {
  return new Request(`https://admin.example${path}`, {
    ...options,
    headers: {
      "cf-access-jwt-assertion": token,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
}

function syncAuthed(body, options = {}) {
  return new Request("https://admin.example/api/sync/entitlements", {
    method: "POST",
    ...options,
    headers: {
      authorization: "Bearer sync-secret",
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

async function json(response) {
  return response.json();
}

function keyOf(project, feature, licenseFingerprint) {
  return `${project}\u0000${feature}\u0000${licenseFingerprint}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function effectiveLicenseMode(row) {
  if (Number(row.is_trial ?? 0) === 1) return "trial";
  if (Number(row.pool_size ?? 0) > 0) return "floating";
  return "node_locked";
}

function entitlementDefaults(overrides = {}) {
  const row = {
    policy_id: null,
    is_trial: 0,
    trial_expiration_basis: null,
    trial_duration_sec: 0,
    trial_one_per_device: 0,
    trial_require_device_proof: 0,
    trial_started_at: null,
    trial_device_hash: null,
    max_active_devices: 1,
    lease_seconds: 2592000,
    rebind_window_sec: 7776000,
    pool_size: 0,
    heartbeat_grace_sec: 900,
    max_borrow_sec: 0,
    allow_overdraft: 0,
    meter_quota: 0,
    meter_period_sec: 2592000,
    ...overrides,
  };
  return { ...row, license_mode: effectiveLicenseMode(row) };
}

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

async function accessToken(fixture, email, overrides = {}) {
  let token = new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(fixture.issuer)
    .setAudience(overrides.audience ?? fixture.audience)
    .setSubject(overrides.subject ?? email)
    .setIssuedAt();
  token = overrides.expired
    ? token.setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    : token.setExpirationTime("5m");
  return token.sign(fixture.privateKey);
}

// Like accessFixture, but exposes a request counter so tests can assert JWKS cache reuse and the
// fail-closed unknown-kid path. Each fixture binds an ephemeral port (unique jwksUrl), so the worker's
// module-level jwksCache never bleeds between tests.
async function rotatableAccessFixture(t) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const state = { keys: [jwk], requests: 0 };
  const server = http.createServer((_request, response) => {
    state.requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: state.keys }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return {
    issuer: "https://licensecc-test.cloudflareaccess.com",
    audience: "test-audience",
    jwksUrl: `http://127.0.0.1:${port}/cdn-cgi/access/certs`,
    privateKey,
    state,
  };
}

class MockStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.db.first(this.sql, this.values);
  }

  async all() {
    return { results: this.db.all(this.sql, this.values) };
  }

  async run() {
    this.db.run(this.sql, this.values);
    return {};
  }
}

class MockD1 {
  constructor() {
    this.entitlements = new Map();
    this.events = [];
    this.idempotency = new Map();
    this.failEvents = false;
    this.lastBatchSize = 0;
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  async batch(statements) {
    this.lastBatchSize = statements.length;
    const entitlementSnapshot = new Map([...this.entitlements.entries()].map(([key, value]) => [key, clone(value)]));
    const eventSnapshot = this.events.map(clone);
    const idempotencySnapshot = new Map([...this.idempotency.entries()].map(([key, value]) => [key, clone(value)]));
    try {
      const results = [];
      for (const statement of statements) {
        if (statement.sql.startsWith("INSERT INTO entitlements") || statement.sql.startsWith("UPDATE entitlements SET")) {
          const row = this.first(statement.sql, statement.values);
          results.push({ results: row === null ? [] : [row], meta: { changes: row === null ? 0 : 1 } });
        } else {
          results.push(this.run(statement.sql, statement.values));
        }
      }
      return results;
    } catch (error) {
      this.entitlements = entitlementSnapshot;
      this.events = eventSnapshot;
      this.idempotency = idempotencySnapshot;
      throw error;
    }
  }

  maxEventSeq(project, feature, licenseFingerprint) {
    return this.events
      .filter((event) =>
        event.project === project && event.feature === feature && event.license_fingerprint === licenseFingerprint)
      .reduce((max, event) => Math.max(max, event.revocation_seq), 0);
  }

  first(sql, values) {
    if (sql.startsWith("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'active'")) {
      return { count: [...this.entitlements.values()].filter((row) => row.status === "active").length };
    }
    if (sql.startsWith("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'revoked'")) {
      return { count: [...this.entitlements.values()].filter((row) => row.status === "revoked").length };
    }
    if (sql.startsWith("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'disabled'")) {
      return { count: [...this.entitlements.values()].filter((row) => row.status === "disabled").length };
    }
    if (sql.startsWith("SELECT COUNT(*) AS count FROM entitlements")) {
      return { count: this.entitlements.size };
    }
    if (sql.startsWith("SELECT response_json FROM mutation_idempotency")) {
      return this.idempotency.get(`${values[0]}\u0000${values[1]}`) ?? null;
    }
    if (sql.startsWith("SELECT project, feature, license_fingerprint")) {
      const row = this.entitlements.get(keyOf(values[0], values[1], values[2]));
      return row === undefined ? null : clone(row);
    }
    throw new Error(`unexpected first SQL: ${sql}`);
  }

  all(sql, values) {
    if (sql.includes("FROM entitlement_events")) {
      return this.events.slice().reverse().slice(0, values[0] ?? 50).map(clone);
    }
    if (sql.startsWith("SELECT project, feature, license_fingerprint")) {
      let rows = [...this.entitlements.values()];
      if (sql.includes("WHERE project = ?")) {
        rows = rows.filter((row) => row.project === values[0]);
      }
      return rows.map(clone);
    }
    throw new Error(`unexpected all SQL: ${sql}`);
  }

  run(sql, values) {
    if (sql.startsWith("INSERT INTO entitlement_events")) {
      if (this.failEvents) {
        throw new Error("event_failed");
      }
      if (sql.includes(" SELECT ")) {
        const row = this.entitlements.get(keyOf(values[11], values[12], values[13]));
        if (row === undefined) {
          return { meta: { changes: 0 } };
        }
        const source = sql.includes("'sync'") ? "sync" : "admin";
        this.events.push({
          id: this.events.length + 1,
          project: row.project,
          feature: row.feature,
          license_fingerprint: row.license_fingerprint,
          device_hash: row.device_hash,
          event_type: values[0],
          status: row.status,
          revocation_seq: row.revocation_seq,
          detail: values[1],
          actor: values[2],
          actor_type: values[3],
          source,
          request_id: values[4],
          ip: values[5],
          prev_json: values[6],
          next_json: JSON.stringify({ ...clone(row), id: values[7] }),
          reason: values[8],
          idempotency_key: values[9],
          created_at: values[10],
        });
        return { meta: { changes: 1 } };
      }
      this.events.push({
        id: this.events.length + 1,
        project: values[0],
        feature: values[1],
        license_fingerprint: values[2],
        device_hash: values[3],
        event_type: values[4],
        status: values[5],
        revocation_seq: values[6],
        detail: values[7],
        actor: values[8],
        actor_type: values[9],
        source: "admin",
        request_id: values[10],
        ip: values[11],
        prev_json: values[12],
        next_json: values[13],
        reason: values[14],
        idempotency_key: values[15],
        created_at: values[16],
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT OR IGNORE INTO mutation_idempotency")) {
      const key = `${values[0]}\u0000${values[1]}`;
      let responseJson = values[2];
      if (sql.includes(" SELECT ")) {
        const row = this.entitlements.get(keyOf(values[6], values[7], values[8]));
        if (row === undefined) {
          return { meta: { changes: 0 } };
        }
        const data = { ...clone(row), id: values[4] };
        delete data.cache_ttl_seconds;
        responseJson = JSON.stringify({
          ok: true,
          code: values[2],
          request_id: values[3],
          data,
        });
      }
      if (!this.idempotency.has(key)) {
        this.idempotency.set(key, { response_json: responseJson });
      }
      return { meta: { changes: 1 } };
    }
    throw new Error(`unexpected run SQL: ${sql}`);
  }
}

MockD1.prototype.first = function first(sql, values) {
  if (sql.startsWith("INSERT INTO entitlements")) {
    const [
      project,
      feature,
      licenseFingerprint,
      deviceHash,
      status,
      assertionTtl,
      cacheTtl,
      _historyProject,
      _historyFeature,
      _historyFingerprint,
      validFrom,
      validUntil,
      notes,
      customerId,
      licenseId,
      createdAt,
      updatedAt,
    ] = values;
    const key = keyOf(project, feature, licenseFingerprint);
    const previous = this.entitlements.get(key);
    const row = {
      ...entitlementDefaults(previous ?? {}),
      project,
      feature,
      license_fingerprint: licenseFingerprint,
      device_hash: deviceHash,
      status,
      assertion_ttl_seconds: assertionTtl,
      cache_ttl_seconds: cacheTtl,
      revocation_seq: Math.max(previous?.revocation_seq ?? 0, this.maxEventSeq(project, feature, licenseFingerprint)) + 1,
      valid_from: validFrom,
      valid_until: validUntil,
      notes,
      customer_id: customerId,
      license_id: licenseId,
      created_at: previous?.created_at ?? createdAt,
      updated_at: updatedAt,
    };
    this.entitlements.set(key, row);
    return clone(row);
  }
  if (sql.startsWith("UPDATE entitlements SET device_hash")) {
    const key = keyOf(values[9], values[10], values[11]);
    const previous = this.entitlements.get(key);
    if (previous === undefined) return null;
    const row = {
      ...previous,
      device_hash: values[0],
      assertion_ttl_seconds: values[1],
      cache_ttl_seconds: values[2],
      revocation_seq: Math.max(previous.revocation_seq, this.maxEventSeq(previous.project, previous.feature, previous.license_fingerprint)) + 1,
      valid_from: values[3],
      valid_until: values[4],
      notes: values[5],
      customer_id: values[6],
      license_id: values[7],
      updated_at: values[8],
    };
    this.entitlements.set(key, row);
    return clone(row);
  }
  if (sql.startsWith("UPDATE entitlements SET status")) {
    const key = keyOf(values[2], values[3], values[4]);
    const previous = this.entitlements.get(key);
    if (previous === undefined) return null;
    const row = {
      ...previous,
      status: values[0],
      revocation_seq: Math.max(previous.revocation_seq, this.maxEventSeq(previous.project, previous.feature, previous.license_fingerprint)) + 1,
      updated_at: values[1],
    };
    this.entitlements.set(key, row);
    return clone(row);
  }
  return Object.getPrototypeOf(MockD1.prototype).first?.call(this, sql, values) ?? MockD1.prototype.__lookupFirst.call(this, sql, values);
};

MockD1.prototype.__lookupFirst = function lookupFirst(sql, values) {
  if (sql.startsWith("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'active'")) {
    return { count: [...this.entitlements.values()].filter((row) => row.status === "active").length };
  }
  if (sql.startsWith("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'revoked'")) {
    return { count: [...this.entitlements.values()].filter((row) => row.status === "revoked").length };
  }
  if (sql.startsWith("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'disabled'")) {
    return { count: [...this.entitlements.values()].filter((row) => row.status === "disabled").length };
  }
  if (sql.startsWith("SELECT COUNT(*) AS count FROM entitlements")) {
    return { count: this.entitlements.size };
  }
  if (sql.startsWith("SELECT response_json FROM mutation_idempotency")) {
    return this.idempotency.get(`${values[0]}\u0000${values[1]}`) ?? null;
  }
  if (sql.startsWith("SELECT project, feature, license_fingerprint")) {
    const row = this.entitlements.get(keyOf(values[0], values[1], values[2]));
    return row === undefined ? null : clone(row);
  }
  throw new Error(`unexpected first SQL: ${sql}`);
};

test("admin summary requires authentication", async () => {
  const response = await worker.fetch(new Request("https://admin.example/api/admin/summary"), baseEnv());
  assert.equal(response.status, 401);
  assert.equal((await json(response)).code, "admin_auth_not_configured");
});

test("dev bearer cannot be enabled in production", async () => {
  const env = baseEnv();
  env.ENVIRONMENT = "production";
  const response = await worker.fetch(authed("/api/admin/summary"), env);
  assert.equal(response.status, 500);
  assert.equal((await json(response)).code, "dev_bearer_forbidden_in_environment");
});

test("dev bearer is accepted only in development", async () => {
  const env = baseEnv();
  env.ENVIRONMENT = "staging";
  const response = await worker.fetch(authed("/api/admin/summary"), env);
  assert.equal(response.status, 500);
  assert.equal((await json(response)).code, "dev_bearer_forbidden_in_environment");
});

test("admin worker rejects oversized JSON bodies without relying on Content-Length", async () => {
  const response = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: "x".repeat(8193),
  }), baseEnv());
  assert.equal(response.status, 413);
  assert.equal((await json(response)).code, "body_too_large");
});

test("cloudflare access jwt admin can read admin summary", async (t) => {
  const fixture = await accessFixture(t);
  const token = await accessToken(fixture, "admin@example.com");
  const response = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 200);
  assert.equal((await json(response)).code, "summary");
});

test("cloudflare access reader can read but cannot mutate", async (t) => {
  const fixture = await accessFixture(t);
  const db = new MockD1();
  const env = accessEnv(db, fixture);
  const token = await accessToken(fixture, "reader@example.com");
  const read = await worker.fetch(accessAuthed("/api/admin/summary", token), env);
  assert.equal(read.status, 200);

  const mutate = await worker.fetch(accessAuthed("/api/admin/entitlements", token, {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  assert.equal(mutate.status, 403);
  assert.equal((await json(mutate)).code, "admin_role_required");
});

test("cloudflare access admin can mutate entitlements", async (t) => {
  const fixture = await accessFixture(t);
  const db = new MockD1();
  const env = accessEnv(db, fixture);
  const token = await accessToken(fixture, "admin@example.com");
  const response = await worker.fetch(accessAuthed("/api/admin/entitlements", token, {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.code, "entitlement_saved");
  assert.equal(body.data.revocation_seq, 1);
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].actor, "admin@example.com");
  assert.equal(db.events[0].actor_type, "access");
});

test("cloudflare access jwt rejects invalid audience", async (t) => {
  const fixture = await accessFixture(t);
  const token = await accessToken(fixture, "admin@example.com", { audience: "wrong-audience" });
  const response = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 403);
  assert.equal((await json(response)).code, "invalid_access_jwt");
});

test("cloudflare access jwt rejects expired token", async (t) => {
  const fixture = await accessFixture(t);
  const token = await accessToken(fixture, "admin@example.com", { expired: true });
  const response = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 403);
  assert.equal((await json(response)).code, "invalid_access_jwt");
});

test("cloudflare access jwt rejects unknown role", async (t) => {
  const fixture = await accessFixture(t);
  const token = await accessToken(fixture, "unknown@example.com");
  const response = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 403);
  assert.equal((await json(response)).code, "admin_role_denied");
});

test("cloudflare access jwt rejects malformed token", async (t) => {
  const fixture = await accessFixture(t);
  const response = await worker.fetch(accessAuthed("/api/admin/summary", "not-a-jwt"), accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 403);
  assert.equal((await json(response)).code, "invalid_access_jwt");
});

test("cloudflare access identity header without jwt is rejected", async (t) => {
  const fixture = await accessFixture(t);
  const request = new Request("https://admin.example/api/admin/summary", {
    headers: { "cf-access-authenticated-user-email": "admin@example.com" },
  });
  const response = await worker.fetch(request, accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 401);
  assert.equal((await json(response)).code, "missing_access_jwt");
});

test("sync endpoint requires its dedicated bearer secret", async () => {
  const payload = { project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint };
  const missing = await worker.fetch(syncAuthed(payload), baseEnv(new MockD1()));
  assert.equal(missing.status, 401);
  assert.equal((await json(missing)).code, "sync_auth_not_configured");

  const invalid = await worker.fetch(new Request("https://admin.example/api/sync/entitlements", {
    method: "POST",
    headers: { authorization: "Bearer wrong", "content-type": "application/json" },
    body: JSON.stringify(payload),
  }), syncEnv(new MockD1()));
  assert.equal(invalid.status, 403);
  assert.equal((await json(invalid)).code, "invalid_sync_token");
});

test("sync endpoint upserts user database projection and no-ops identical state", async () => {
  const db = new MockD1();
  const env = syncEnv(db);
  const payload = {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    status: "active",
    assertion_ttl_seconds: 300,
    customer_id: "cus_123",
    license_id: "lic_123",
    notes: "paid account",
  };

  const first = await worker.fetch(syncAuthed(payload, { headers: { "idempotency-key": "sync-1" } }), env);
  assert.equal(first.status, 200);
  const firstBody = await json(first);
  assert.equal(firstBody.code, "entitlement_synced");
  assert.equal(firstBody.data.customer_id, "cus_123");
  assert.equal(firstBody.data.license_id, "lic_123");
  assert.equal(firstBody.data.revocation_seq, 1);
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].source, "sync");
  assert.equal(db.events[0].actor_type, "sync");

  const identical = await worker.fetch(syncAuthed(payload), env);
  assert.equal(identical.status, 200);
  assert.equal((await json(identical)).data.revocation_seq, 1);
  assert.equal(db.events.length, 1);
});

test("sync endpoint revokes with reason and keeps revoked terminal", async () => {
  const db = new MockD1();
  const env = syncEnv(db);
  const active = {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    status: "active",
    customer_id: "cus_456",
    license_id: "lic_456",
  };
  assert.equal((await worker.fetch(syncAuthed(active), env)).status, 200);

  const missingReason = await worker.fetch(syncAuthed({ ...active, status: "revoked" }), env);
  assert.equal(missingReason.status, 400);
  assert.equal((await json(missingReason)).code, "reason_required");

  const revoked = await worker.fetch(syncAuthed({ ...active, status: "revoked", reason: "chargeback" }), env);
  assert.equal(revoked.status, 200);
  const revokedBody = await json(revoked);
  assert.equal(revokedBody.data.status, "revoked");
  assert.equal(revokedBody.data.customer_id, "cus_456");
  assert.equal(revokedBody.data.license_id, "lic_456");
  assert.equal(revokedBody.data.revocation_seq, 2);
  assert.equal(db.events.at(-1).event_type, "revoke");
  assert.equal(db.events.at(-1).source, "sync");
  assert.equal(db.events.at(-1).reason, "chargeback");

  const reactivate = await worker.fetch(syncAuthed(active), env);
  assert.equal(reactivate.status, 409);
  assert.equal((await json(reactivate)).code, "revoked_entitlement_is_terminal");
});

test("sync endpoint records status transition event types while updating projection", async () => {
  const db = new MockD1();
  const env = syncEnv(db);
  const base = {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    customer_id: "cus_789",
    license_id: "lic_789",
  };

  const disabled = await worker.fetch(syncAuthed({
    ...base,
    status: "disabled",
    notes: "paused",
    reason: "subscription paused",
  }), env);
  assert.equal(disabled.status, 200);
  const disabledBody = await json(disabled);
  assert.equal(disabledBody.data.status, "disabled");
  assert.equal(disabledBody.data.notes, "paused");
  assert.equal(db.events.at(-1).event_type, "disable");
  assert.equal(db.events.at(-1).reason, "subscription paused");

  const reenabled = await worker.fetch(syncAuthed({
    ...base,
    status: "active",
    notes: "paid again",
  }), env);
  assert.equal(reenabled.status, 200);
  const reenabledBody = await json(reenabled);
  assert.equal(reenabledBody.data.status, "active");
  assert.equal(reenabledBody.data.notes, "paid again");
  assert.equal(reenabledBody.data.revocation_seq, 2);
  assert.equal(db.events.at(-1).event_type, "reenable");
});

test("admin create is audited and idempotent", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const body = {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    assertion_ttl_seconds: 300,
    cache_ttl_seconds: 3600,
    notes: "first",
  };
  const request = authed("/api/admin/entitlements", {
    method: "POST",
    headers: { "idempotency-key": "create-1" },
    body: JSON.stringify(body),
  });
  const first = await worker.fetch(request, env);
  assert.equal(first.status, 200);
  const firstBody = await json(first);
  assert.equal(firstBody.data.revocation_seq, 1);
  assert.equal(firstBody.data.cache_ttl_seconds, undefined);
  assert.equal(db.entitlements.get(keyOf("DEFAULT", "DEFAULT", fingerprint)).cache_ttl_seconds, 300);
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].event_type, "create");
  assert.equal(JSON.parse(db.events[0].next_json).id, firstBody.data.id);
  assert.equal(db.lastBatchSize, 3);
  assert.equal(db.idempotency.size, 1);

  const replay = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    headers: { "idempotency-key": "create-1" },
    body: JSON.stringify(body),
  }), env);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("x-idempotent-replay"), "1");
  assert.equal((await json(replay)).data.revocation_seq, 1);
  assert.equal(db.events.length, 1);
});

test("admin mutation rolls back entitlement write when audit insert fails", async () => {
  const db = new MockD1();
  db.failEvents = true;
  const env = baseEnv(db);
  const response = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    headers: { "idempotency-key": "rollback-1" },
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  assert.equal(response.status, 500);
  assert.equal((await json(response)).code, "mutation_failed");
  assert.equal(db.lastBatchSize, 3);
  assert.equal(db.entitlements.size, 0);
  assert.equal(db.events.length, 0);
  assert.equal(db.idempotency.size, 0);
});

test("admin mutation fails closed when D1 batch is unavailable", async () => {
  const db = new MockD1();
  db.batch = undefined;
  const env = baseEnv(db);
  const response = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  assert.equal(response.status, 500);
  assert.equal((await json(response)).code, "mutation_failed");
  assert.equal(db.entitlements.size, 0);
  assert.equal(db.events.length, 0);
});

test("admin upsert increments the stored revocation sequence", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const key = keyOf("DEFAULT", "DEFAULT", fingerprint);
  db.entitlements.set(key, {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    device_hash: "",
    status: "active",
    assertion_ttl_seconds: 300,
    cache_ttl_seconds: 3600,
    revocation_seq: 7,
    valid_from: null,
    valid_until: null,
    notes: "existing",
    customer_id: null,
    license_id: null,
    created_at: 100,
    updated_at: 100,
  });

  const response = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint, notes: "changed" }),
  }), env);

  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.data.revocation_seq, 8);
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].event_type, "update");
  assert.equal(db.events[0].revocation_seq, 8);
});

test("admin upsert preserves historical revocation floor when row is recreated", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  db.events.push({
    id: 1,
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    device_hash: "",
    event_type: "revoke",
    status: "revoked",
    revocation_seq: 10,
    detail: "",
    actor: "previous",
    actor_type: "cli",
    source: "cli",
    request_id: "previous",
    ip: "",
    prev_json: "",
    next_json: "",
    reason: "previous revoke",
    idempotency_key: null,
    created_at: 100,
  });

  const response = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);

  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.data.revocation_seq, 11);
  assert.equal(db.events.at(-1).revocation_seq, 11);
});

test("admin patch and transitions increment from stored row state", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const create = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  const id = (await json(create)).data.id;
  const key = keyOf("DEFAULT", "DEFAULT", fingerprint);
  db.entitlements.get(key).revocation_seq = 11;

  const patched = await worker.fetch(authed(`/api/admin/entitlements/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ notes: "patched" }),
  }), env);
  assert.equal((await json(patched)).data.revocation_seq, 12);

  db.entitlements.get(key).revocation_seq = 21;
  const disabled = await worker.fetch(authed(`/api/admin/entitlements/${id}/disable`, {
    method: "POST",
    body: JSON.stringify({ reason: "stored sequence regression" }),
  }), env);
  assert.equal((await json(disabled)).data.revocation_seq, 22);
});

test("admin create and patch accept explicit empty notes from UI payloads", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const create = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({
      project: "DEFAULT",
      feature: "DEFAULT",
      license_fingerprint: fingerprint,
      notes: "",
      customer_id: null,
      license_id: null,
    }),
  }), env);
  assert.equal(create.status, 200);
  const created = await json(create);
  assert.equal(created.data.notes, "");
  assert.equal(created.data.customer_id, null);
  assert.equal(created.data.license_id, null);

  const patched = await worker.fetch(authed(`/api/admin/entitlements/${created.data.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      notes: "",
      customer_id: "",
      license_id: "",
    }),
  }), env);
  assert.equal(patched.status, 200);
  const patchedBody = await json(patched);
  assert.equal(patchedBody.data.notes, "");
  assert.equal(patchedBody.data.customer_id, null);
  assert.equal(patchedBody.data.license_id, null);
});

test("admin transitions require reason and revoked is terminal", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const create = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    headers: { "idempotency-key": "create-2" },
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  const id = (await json(create)).data.id;

  const missingReason = await worker.fetch(authed(`/api/admin/entitlements/${id}/disable`, {
    method: "POST",
    body: JSON.stringify({}),
  }), env);
  assert.equal(missingReason.status, 400);
  assert.equal((await json(missingReason)).code, "reason_required");

  const disabled = await worker.fetch(authed(`/api/admin/entitlements/${id}/disable`, {
    method: "POST",
    headers: { "idempotency-key": "disable-1" },
    body: JSON.stringify({ reason: "support request" }),
  }), env);
  assert.equal((await json(disabled)).data.status, "disabled");

  const reenabled = await worker.fetch(authed(`/api/admin/entitlements/${id}/reenable`, {
    method: "POST",
    headers: { "idempotency-key": "reenable-1" },
    body: JSON.stringify({}),
  }), env);
  assert.equal((await json(reenabled)).data.status, "active");

  const revoked = await worker.fetch(authed(`/api/admin/entitlements/${id}/revoke`, {
    method: "POST",
    headers: { "idempotency-key": "revoke-1" },
    body: JSON.stringify({ reason: "chargeback" }),
  }), env);
  const revokedBody = await json(revoked);
  assert.equal(revokedBody.data.status, "revoked");
  assert.equal(revokedBody.data.revocation_seq, 4);

  const terminal = await worker.fetch(authed(`/api/admin/entitlements/${id}/reenable`, {
    method: "POST",
    body: JSON.stringify({}),
  }), env);
  assert.equal(terminal.status, 409);
  assert.equal((await json(terminal)).code, "revoked_entitlement_is_terminal");
});

// ATOM-2: pin the audit next_json contract (the only existing assertion checks a single field, .id).
test("audit next_json carries the full production json_object field set", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const res = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({
      project: "DEFAULT",
      feature: "DEFAULT",
      license_fingerprint: fingerprint,
      device_hash: "d".repeat(64),
      assertion_ttl_seconds: 321,
      valid_from: 1000,
      valid_until: 2000,
      notes: "shape probe",
      customer_id: "cus-1",
      license_id: "lic-1",
      status: "active",
    }),
  }), env);
  assert.equal(res.status, 200);
  const saved = (await json(res)).data;
  const next = JSON.parse(db.events[0].next_json);
  assert.deepEqual(Object.keys(next).sort(), [...NEXT_JSON_KEYS].sort());
  // Intentional shape divergence: next_json includes cache_ttl_seconds; the API response (withId) does not.
  assert.ok("cache_ttl_seconds" in next);
  assert.equal(saved.cache_ttl_seconds, undefined);
  assert.equal(next.id, saved.id);
  assert.equal(next.customer_id, "cus-1");
  assert.equal(next.license_id, "lic-1");
  assert.equal(db.events[0].prev_json, ""); // prev was null on create
});

test("production json_object next_json key set matches the audit contract (drift guard)", () => {
  // eventFromCurrentStatement moved into the shared entitlement_mutation core; read it there.
  const moduleUrl = import.meta.resolve("@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation");
  const src = readFileSync(new URL(moduleUrl), "utf8");
  const match = /function eventFromCurrentStatement\([\s\S]*?json_object\(([\s\S]*?)\),\s*\n/.exec(src);
  assert.ok(match, "eventFromCurrentStatement json_object block not found");
  const keys = [...match[1].matchAll(/'([a-z_]+)'\s*,/g)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), [...NEXT_JSON_KEYS].sort());
});

test("audit prev_json is the prior API record on update", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const base = { project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint, notes: "v1" };
  const first = await worker.fetch(authed("/api/admin/entitlements", { method: "POST", body: JSON.stringify(base) }), env);
  const firstData = (await json(first)).data;
  const second = await worker.fetch(
    authed("/api/admin/entitlements", { method: "POST", body: JSON.stringify({ ...base, notes: "v2" }) }),
    env,
  );
  assert.equal(second.status, 200);
  const updateEvent = db.events.at(-1);
  assert.equal(updateEvent.event_type, "update");
  const prev = JSON.parse(updateEvent.prev_json);
  assert.equal(prev.id, firstData.id);
  assert.equal(prev.notes, "v1");
  assert.equal(prev.status, firstData.status);
});

// TEST-1: PATCH and the transitions were only exercised via the dev bearer; prove the Access-JWT path too.
test("cloudflare access admin can patch and transition entitlements end to end", async (t) => {
  const fixture = await accessFixture(t);
  const db = new MockD1();
  const env = accessEnv(db, fixture);
  const token = await accessToken(fixture, "admin@example.com");
  const create = await worker.fetch(accessAuthed("/api/admin/entitlements", token, {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  const id = (await json(create)).data.id;

  const patched = await worker.fetch(accessAuthed(`/api/admin/entitlements/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify({ notes: "access-patched" }),
  }), env);
  assert.equal(patched.status, 200);
  assert.equal((await json(patched)).code, "entitlement_patched");

  const disabled = await worker.fetch(accessAuthed(`/api/admin/entitlements/${id}/disable`, token, {
    method: "POST",
    body: JSON.stringify({ reason: "support request" }),
  }), env);
  assert.equal((await json(disabled)).data.status, "disabled");

  const reenabled = await worker.fetch(accessAuthed(`/api/admin/entitlements/${id}/reenable`, token, {
    method: "POST",
    body: JSON.stringify({}),
  }), env);
  assert.equal((await json(reenabled)).data.status, "active");

  const revoked = await worker.fetch(accessAuthed(`/api/admin/entitlements/${id}/revoke`, token, {
    method: "POST",
    body: JSON.stringify({ reason: "chargeback" }),
  }), env);
  assert.equal((await json(revoked)).data.status, "revoked");

  const terminal = await worker.fetch(accessAuthed(`/api/admin/entitlements/${id}/reenable`, token, {
    method: "POST",
    body: JSON.stringify({}),
  }), env);
  assert.equal(terminal.status, 409);
  assert.equal((await json(terminal)).code, "revoked_entitlement_is_terminal");

  // Every audit event must carry the Access identity (actor propagation through eventFromCurrentStatement).
  assert.ok(db.events.length >= 4);
  for (const event of db.events) {
    assert.equal(event.actor_type, "access");
    assert.equal(event.actor, "admin@example.com");
  }
});

test("cloudflare access reader cannot patch or transition", async (t) => {
  const fixture = await accessFixture(t);
  const db = new MockD1();
  const env = accessEnv(db, fixture);
  const create = await worker.fetch(accessAuthed("/api/admin/entitlements", await accessToken(fixture, "admin@example.com"), {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  const id = (await json(create)).data.id;
  const eventsAfterCreate = db.events.length;
  const reader = await accessToken(fixture, "reader@example.com");
  for (const request of [
    accessAuthed(`/api/admin/entitlements/${id}`, reader, { method: "PATCH", body: JSON.stringify({ notes: "x" }) }),
    accessAuthed(`/api/admin/entitlements/${id}/disable`, reader, { method: "POST", body: JSON.stringify({ reason: "x" }) }),
    accessAuthed(`/api/admin/entitlements/${id}/reenable`, reader, { method: "POST", body: JSON.stringify({}) }),
    accessAuthed(`/api/admin/entitlements/${id}/revoke`, reader, { method: "POST", body: JSON.stringify({ reason: "x" }) }),
  ]) {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 403);
    assert.equal((await json(response)).code, "admin_role_required");
  }
  assert.equal(db.events.length, eventsAfterCreate); // denied reader mutations write nothing
});

// TEST-2: JWKS cache reuse + fail-closed unknown-kid (the only review-listed auth path with zero coverage).
test("access auth fails closed for a token signed with an unknown kid", async (t) => {
  const fixture = await rotatableAccessFixture(t);
  const token = await new SignJWT({ email: "admin@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "never-published" })
    .setIssuer(fixture.issuer)
    .setAudience(fixture.audience)
    .setSubject("admin@example.com")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(fixture.privateKey);
  const response = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(response.status, 403);
  assert.equal((await json(response)).code, "invalid_access_jwt");
  // jose fetches the JWKS once, cannot match the kid, then the cooldown blocks a refetch -> fail closed.
  assert.equal(fixture.state.requests, 1);
});

test("access auth reuses the cached JWKS across repeated valid tokens", async (t) => {
  const fixture = await rotatableAccessFixture(t);
  const token = await accessToken(fixture, "admin@example.com");
  const first = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(first.status, 200);
  const afterFirst = fixture.state.requests;
  const second = await worker.fetch(accessAuthed("/api/admin/summary", token), accessEnv(new MockD1(), fixture));
  assert.equal(second.status, 200);
  assert.equal(fixture.state.requests, afterFirst); // served from the memoized key set, no second fetch
});

// ── Stage 3: policy validators (hermetic unit — no DB) ───────────────────────
const { validatePolicyInput, validatePolicyPatch } = adminInternalsForTests;

test("validatePolicyInput accepts a minimal body and applies defaults", () => {
  const v = validatePolicyInput({ project: "DEFAULT", name: "Trial", type: "trial" });
  assert.ok(v);
  assert.equal(v.project, "DEFAULT");
  assert.equal(v.name, "Trial");
  assert.equal(v.type, "trial");
  assert.equal(v.assertion_ttl_seconds, 300);
  assert.equal(v.pool_size, 0);
  assert.equal(v.max_active_devices, 1);
  assert.equal(v.max_borrow_sec, 0);
  assert.equal(v.expiry_strategy, "fixed_window");
  assert.equal(v.trial_expiration_basis, "from_issue");
  assert.equal(v.trial_duration_sec, 0);
  assert.equal(v.trial_one_per_device, 0);
  assert.equal(v.trial_require_device_proof, 0);
  assert.equal(v.valid_from_offset_sec, null);
  assert.equal(v.duration_sec, null);
  assert.equal(v.notes, "");
});

test("validatePolicyInput honors explicit values and rejects malformed bodies", () => {
  const full = validatePolicyInput({
    project: "P", name: "Pro", type: "subscription", valid_from_offset_sec: 0, duration_sec: 31536000,
    assertion_ttl_seconds: 600, pool_size: 10, max_active_devices: 5, max_borrow_sec: 3600,
    expiry_strategy: "non_expiring", trial_expiration_basis: "from_first_activation",
    trial_duration_sec: 1209600, trial_one_per_device: 1, trial_require_device_proof: 1, notes: "ok",
  });
  assert.ok(full);
  assert.equal(full.duration_sec, 31536000);
  assert.equal(full.expiry_strategy, "non_expiring");
  assert.equal(full.trial_one_per_device, 1);

  for (const bad of [
    null,
    "string",
    {},
    { project: "P", name: "x" }, // missing type
    { project: "P", name: "x", type: "bogus" },
    { project: "", name: "x", type: "trial" },
    { project: "P", name: "x\ninjection", type: "trial" },
    { project: "P", name: "x", type: "trial", assertion_ttl_seconds: 0 },
    { project: "P", name: "x", type: "trial", assertion_ttl_seconds: 9999 },
    { project: "P", name: "x", type: "trial", expiry_strategy: "nope" },
    { project: "P", name: "x", type: "trial", trial_expiration_basis: "nope" },
    { project: "P", name: "x", type: "trial", trial_one_per_device: 2 },
    { project: "P", name: "x", type: "trial", pool_size: -1 },
    { project: "P", name: "x", type: "trial", duration_sec: -5 },
  ]) {
    assert.equal(validatePolicyInput(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("validatePolicyPatch updates mutable fields and rejects identity fields", () => {
  assert.deepEqual(validatePolicyPatch({ pool_size: 8, notes: "x" }), { pool_size: 8, notes: "x" });
  assert.deepEqual(validatePolicyPatch({ valid_from_offset_sec: null, duration_sec: 100 }), { valid_from_offset_sec: null, duration_sec: 100 });
  assert.deepEqual(validatePolicyPatch({}), {});

  // Identity / status fields are not patchable.
  for (const bad of [{ project: "X" }, { name: "Renamed" }, { type: "trial" }, { status: "disabled" }]) {
    assert.equal(validatePolicyPatch(bad), null, `identity field ${JSON.stringify(bad)} must be rejected`);
  }
  // Out-of-range / bad-enum values are rejected.
  for (const bad of [
    { assertion_ttl_seconds: 0 },
    { trial_require_device_proof: 5 },
    { expiry_strategy: "weird" },
    { trial_expiration_basis: "weird" },
    { notes: "a".repeat(2000) },
  ]) {
    assert.equal(validatePolicyPatch(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});
