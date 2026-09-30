// Shared, stateless fixtures and builders for bounded-context Worker tests.
import http from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker, { adminInternalsForTests } from "../../dist-worker/worker/index.js";

const fingerprint = "a".repeat(64);

// Every MockD1 seeds one owner a protected grant can name: active customer cus_1 holding licence
// lic_1 for project APP.
const PROTECTED_OWNER = { customer_id: "cus_1", license_id: "lic_1" };
const PROTECTED_PROJECT = "APP";
// The body of a create the admin API accepts: every create is protected and names that owner.
const protectedGrant = { project: PROTECTED_PROJECT, feature: "PRO", license_fingerprint: fingerprint, ...PROTECTED_OWNER };

// The exact field set the production json_object emits into entitlement_events.next_json
// (eventFromCurrentStatement, now in the shared @licensecc/cloudflare-runtime
// entitlement_mutation core); the drift-guard test pins this contract.
const NEXT_JSON_KEYS = [
  "project",
  "feature",
  "license_fingerprint",
  "status",
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
  "trial_started_at",
  "trial_device_key_id",
  "max_active_devices",
  "lease_seconds",
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
  return Number(row.is_trial ?? 0) === 1 ? "trial" : "node_locked";
}

function entitlementDefaults(overrides = {}) {
  const row = {
    policy_id: null,
    is_trial: 0,
    trial_expiration_basis: null,
    trial_duration_sec: 0,
    trial_one_per_device: 0,
    trial_started_at: null,
    trial_device_key_id: null,
    max_active_devices: 1,
    lease_seconds: 86400,
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
    this.customers = new Map([[PROTECTED_OWNER.customer_id, { id: PROTECTED_OWNER.customer_id, status: "active" }]]);
    this.licenses = new Map([[PROTECTED_OWNER.license_id, { id: PROTECTED_OWNER.license_id, customer_id: PROTECTED_OWNER.customer_id, project: PROTECTED_PROJECT }]]);
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
        } else if (statement.sql.startsWith("SELECT response_json FROM mutation_idempotency")
          || statement.sql.startsWith("SELECT project, feature, license_fingerprint")) {
          // The replay-claim read, or (without an idempotency key) the in-batch final snapshot.
          const row = this.first(statement.sql, statement.values);
          results.push({ results: row === null ? [] : [row], meta: { changes: 0 } });
        } else if (statement.sql.startsWith("SELECT CASE WHEN changes()=1 AND EXISTS")) {
          // The protected-create assertion. D1 reports its refusal as malformed JSON, which rolls
          // the whole batch back.
          if (!this.protectedGrantHolds(statement.values)) throw new Error("malformed JSON");
          results.push({ results: [{ ok: 1 }], meta: { changes: 0 } });
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

  // Models the core protected-create rules only; the SQL suite runs the real assertion. The written
  // row is owned by an active seeded customer through that customer's licence for its project.
  protectedGrantHolds([project, feature, licenseFingerprint]) {
    const row = this.entitlements.get(keyOf(project, feature, licenseFingerprint));
    const license = row === undefined ? undefined : this.licenses.get(row.license_id);
    return row !== undefined && this.customers.get(row.customer_id)?.status === "active"
      && license?.customer_id === row.customer_id && license.project === row.project;
  }

  maxEventSeq(project, feature, licenseFingerprint) {
    return this.events
      .filter((event) =>
        event.project === project && event.feature === feature && event.license_fingerprint === licenseFingerprint)
      .reduce((max, event) => Math.max(max, event.revocation_seq), 0);
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
        event_type: values[3],
        status: values[4],
        revocation_seq: values[5],
        detail: values[6],
        actor: values[7],
        actor_type: values[8],
        source: "admin",
        request_id: values[9],
        ip: values[10],
        prev_json: values[11],
        next_json: values[12],
        reason: values[13],
        idempotency_key: values[14],
        created_at: values[15],
      });
      return { meta: { changes: 1 } };
    }
    // The plain replay-cache INSERT lives in idempotency_store
    // (`INSERT ... ON CONFLICT DO NOTHING`). The atomic current-row claim is a
    // strict `INSERT ... SELECT`: a duplicate must
    // fail the batch instead of silently committing a second tuple.
    if (sql.includes("INTO mutation_idempotency")) {
      const key = `${values[0]}\u0000${values[1]}`;
      let responseJson = values[2];
      if (sql.includes(" SELECT ")) {
        const row = this.entitlements.get(keyOf(values[6], values[7], values[8]));
        if (row === undefined) {
          return { meta: { changes: 0 } };
        }
        const data = { ...clone(row), id: values[4] };
        responseJson = JSON.stringify({
          ok: true,
          code: values[2],
          request_id: values[3],
          data,
        });
      }
      if (sql.includes(" SELECT ")) {
        if (this.idempotency.has(key)) {
          throw new Error("UNIQUE constraint failed: mutation_idempotency.scope, mutation_idempotency.idempotency_key");
        }
        this.idempotency.set(key, { response_json: responseJson });
        return { meta: { changes: 1 } };
      }
      if (!this.idempotency.has(key)) this.idempotency.set(key, { response_json: responseJson });
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
      status,
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
      status,
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
  // patchEntitlement: the revocation bump comes first, then the patched body columns.
  if (sql.startsWith("UPDATE entitlements SET revocation_seq")) {
    const key = keyOf(values[6], values[7], values[8]);
    const previous = this.entitlements.get(key);
    if (previous === undefined) return null;
    const row = {
      ...previous,
      revocation_seq: Math.max(previous.revocation_seq, this.maxEventSeq(previous.project, previous.feature, previous.license_fingerprint)) + 1,
      valid_from: values[0],
      valid_until: values[1],
      notes: values[2],
      customer_id: values[3],
      license_id: values[4],
      updated_at: values[5],
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
  if (sql.startsWith("SELECT COUNT(*) AS total,")) {
    const rows = [...this.entitlements.values()];
    return { total: rows.length, active: rows.filter(row => row.status === "active").length,
      revoked: rows.filter(row => row.status === "revoked").length, disabled: rows.filter(row => row.status === "disabled").length };
  }
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
  if (sql.startsWith("WITH e(project, customer_id, license_id)")) {
    // The owner and license rules a PATCH that moves a grant meets, in the create checks' order.
    const [project, customerId, licenseId] = values;
    if (this.customers.get(customerId)?.status !== "active") return { reason: "customer_inactive" };
    if (licenseId === null) return { reason: null };
    const license = this.licenses.get(licenseId);
    if (license === undefined) return { reason: "license_missing" };
    return { reason: license.customer_id === customerId && license.project === project ? null : "license_customer_mismatch" };
  }
  throw new Error(`unexpected first SQL: ${sql}`);
};

// A seeded MockD1 and a request() that POSTs as the dev bearer under a fresh idempotency key.
function protectedCreateFixture() {
  const db = new MockD1();
  const env = baseEnv(db);
  const request = (path, body) => worker.fetch(authed(path, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  }), env);
  return { env, db, request };
}

/**
 * A D1 stand-in that records every statement and finds nothing, so a request that reaches D1 shows.
 * Each prepared statement keeps its SQL and bound values; `first` answers a single-row read and
 * `batchResults` answers a batch, for a test that needs a write to go through.
 */
function recordingDb({ first = null, batchResults = null } = {}) {
  const statements = [];
  const statement = (sql, values = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => first,
    all: async () => ({ results: [] }),
    run: async () => ({}),
    sql,
    values,
  });
  return {
    statements,
    prepare(sql) { statements.push(sql); return statement(sql); },
    async batch(list) {
      statements.push(...list.map((item) => item.sql));
      return batchResults === null ? list.map(() => ({ results: [], meta: { changes: 0 } })) : batchResults(list);
    },
  };
}

export {
  NEXT_JSON_KEYS,
  MockD1,
  accessAuthed,
  accessEnv,
  accessFixture,
  accessToken,
  adminInternalsForTests,
  authed,
  baseEnv,
  clone,
  effectiveLicenseMode,
  entitlementDefaults,
  fingerprint,
  json,
  keyOf,
  protectedCreateFixture,
  protectedGrant,
  recordingDb,
  rotatableAccessFixture,
  syncAuthed,
  syncEnv,
  worker,
};
