import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../dist-worker/worker/index.js";

const fingerprint = "a".repeat(64);

function baseEnv(db = new MockD1()) {
  return {
    DB: db,
    ENVIRONMENT: "development",
    ADMIN_DEV_BEARER_ENABLED: "1",
    ADMIN_DEV_BEARER: "dev-secret",
    PUBLIC_VERIFIER_URL: "https://verifier.example",
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

async function json(response) {
  return response.json();
}

function keyOf(project, feature, licenseFingerprint) {
  return `${project}\u0000${feature}\u0000${licenseFingerprint}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  async batch(statements) {
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
          source: "admin",
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
      if (!this.idempotency.has(key)) {
        this.idempotency.set(key, { response_json: values[2] });
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
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].event_type, "create");
  assert.equal(JSON.parse(db.events[0].next_json).id, firstBody.data.id);

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
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  assert.equal(response.status, 500);
  assert.equal((await json(response)).code, "mutation_failed");
  assert.equal(db.entitlements.size, 0);
  assert.equal(db.events.length, 0);
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
