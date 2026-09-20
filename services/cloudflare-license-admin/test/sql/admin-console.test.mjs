// Slice 4 — operator-console integration suite (real SQLite, end-to-end through worker.fetch).
//
// The hermetic unit MockD1 (admin-worker.test.mjs) is hand-specialized to the entitlement SQL and
// THROWS on any other statement, so the console's customers/licenses/orders/report/kill-switch SQL
// cannot run there. This suite drives the REAL compiled worker over an in-memory SQLite built from
// the shared migrations/*.sql wrapped in a D1-like adapter — nothing about the console SQL is mocked.
//
// Covers: every read endpoint returns the seeded rows + filters; customer detail NEVER leaks
// token_hmac/pepper_key_id; the report aggregates; the customer kill-switch is atomic + audited and
// its 404/409/reason gates; and reader RBAC blocks the only write (disable/reenable) while allowing
// every read. The kill-switch is what severs a customer's account-token auth downstream (the backend
// resolveAccountToken JOINs customers c ON c.status='active') — proven here at the status+audit layer.
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.

import assert from "node:assert/strict";
import http from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { scryptSync } from "node:crypto";
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

const NOW = Math.floor(Date.now() / 1000);
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
const TOKEN_HMAC_SECRET = "super-secret-token-hmac-value-must-never-leak";

function seed(db) {
  const exec = (sql, params) => db.prepare(sql).run(...params);
  // Two customers; B is the foil for isolation/no-leak assertions.
  exec("INSERT INTO customers (id, name, email, created_at, updated_at, status, external_ref) VALUES (?,?,?,?,?,?,?)",
    ["cus_a", "Acme Co", "ops@acme.example", NOW - 1000, NOW - 1000, "active", "ext-a"]);
  exec("INSERT INTO customers (id, name, email, created_at, updated_at, status, external_ref) VALUES (?,?,?,?,?,?,?)",
    ["cus_b", "Beta LLC", "beta@beta.example", NOW - 900, NOW - 900, "active", "ext-b"]);
  // Licenses.
  exec("INSERT INTO licenses (id, customer_id, project, label, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ["lic_a1", "cus_a", "DEFAULT", "Acme primary", NOW - 800, NOW - 800]);
  exec("INSERT INTO licenses (id, customer_id, project, label, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ["lic_b1", "cus_b", "OTHER", "Beta primary", NOW - 700, NOW - 700]);
  // account_tokens — token_hmac is the secret that must NEVER appear in any response.
  exec(`INSERT INTO account_tokens (id, customer_id, token_hmac, pepper_key_id, token_prefix, name, scopes_json, status, expires_at, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ["atk_a1", "cus_a", TOKEN_HMAC_SECRET, "p1", "lcca_abc123", "ci-token", '{"projects":["DEFAULT"]}', "active", NOW + 86400, NOW - 600, NOW - 600]);
  // orders + order_events (fulfillment monitor). One processed, one stale-accepted.
  exec("INSERT INTO orders (subscription_id, project, feature, license_fingerprint, customer_id, last_seq, order_epoch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ["sub_a", "DEFAULT", "DEFAULT", FP_A, "cus_a", 2, 1, NOW - 500, NOW - 100]);
  exec(`INSERT INTO order_events (event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, payload_digest, raw_payload, status, received_at, processed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ["evt_done", "sub_a", "DEFAULT", "DEFAULT", 1, 2, "provision", "k1", "d1", "{}", "processed", NOW - 100, NOW - 99]);
  exec(`INSERT INTO order_events (event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, payload_digest, raw_payload, status, received_at, processed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ["evt_stuck", "sub_a", "DEFAULT", "DEFAULT", 1, 3, "provision", "k1", "d2", "{}", "accepted", NOW - 4000, null]);
}

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

function devEnv(db) {
  return {
    DB: new D1Like(db),
    ENVIRONMENT: "development",
    ADMIN_DEV_BEARER_ENABLED: "1",
    ADMIN_DEV_BEARER: "dev-secret",
  };
}

function accessEnv(db, fixture) {
  return {
    DB: new D1Like(db),
    ENVIRONMENT: "staging",
    ADMIN_DEV_BEARER_ENABLED: "0",
    ADMIN_ACCESS_ISSUER: fixture.issuer,
    ADMIN_ACCESS_AUDIENCE: fixture.audience,
    ADMIN_ACCESS_JWKS_URL: fixture.jwksUrl,
    ADMIN_ACCESS_ADMIN_EMAILS: "admin@example.com",
    ADMIN_ACCESS_READER_EMAILS: "reader@example.com",
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

// Seed an entitlement through the worker so createEntitlement owns the full column set (no drift).
async function createEntitlementFor(env, customerId, fingerprint) {
  const res = await worker.fetch(devReq("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint, customer_id: customerId }),
  }), env);
  assert.equal(res.status, 200, "seed entitlement");
}

test("console: admin creates an isolated password user atomically with safe same-key replay", async () => {
  const db = freshDb(); seed(db); db.exec("PRAGMA foreign_keys=ON"); const env = devEnv(db);
  const password = "A long initial passphrase 123!";
  const create = (email, key = "new-user-1", name = "New user") => worker.fetch(devReq("/api/admin/customers", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify({ name, email, password }) }), env);
  assert.equal((await worker.fetch(devReq("/api/admin/customers", { method: "POST", body: "{}" }), env)).status, 400);
  assert.equal((await create("OPS@ACME.EXAMPLE")).status, 409, "never claim existing customer");
  const responses = await Promise.all([create(" New@Example.test "), create(" New@Example.test ")]);
  for (const response of responses) assert.equal(response.status, 200);
  const first = await responses[0].json(); const second = await responses[1].json();
  assert.deepEqual(first, second); assert.equal(first.code, "customer_created");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customers").get().n, 3);
  const credential = db.prepare("SELECT * FROM portal_passwords").get();
  assert.equal(credential.email_lower, "new@example.test");
  const [, salt, digest] = credential.password_hash.split("$");
  assert.equal(digest, scryptSync(password, Buffer.from(salt, "hex"), 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString("hex"));
  assert.equal(db.prepare("SELECT email FROM customers WHERE id=?").get(credential.customer_id).email, "");
  assert.equal((await create("new@example.test", "different-key")).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entitlements WHERE customer_id=?").get(credential.customer_id).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM portal_sessions").get().n, 0);
  const cache = db.prepare("SELECT response_json FROM mutation_idempotency WHERE idempotency_key='new-user-1'").get().response_json;
  for (const secret of [password, credential.password_hash]) assert.ok(!JSON.stringify(first).includes(secret) && !cache.includes(secret));
  const search = await body(await worker.fetch(devReq("/api/admin/customers?q=new%40example.test"), env));
  assert.equal(search.data.items[0].login_email, "new@example.test");
  const before = db.prepare("SELECT COUNT(*) AS n FROM customers").get().n;
  db.exec("CREATE TRIGGER fail_password_insert BEFORE INSERT ON portal_passwords BEGIN SELECT RAISE(ABORT,'forced'); END");
  assert.equal((await create("rollback@example.test", "rollback-key")).status, 500);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customers").get().n, before, "credential failure rolls back customer creation");
});

test("console: customer access pagination exceeds legacy detail cap and cannot change customer scope", async () => {
  const db = freshDb(); seed(db); const env = devEnv(db);
  for (let i = 1; i <= 205; i++) await createEntitlementFor(env, "cus_a", i.toString(16).padStart(64, "0"));
  await createEntitlementFor(env, "cus_b", FP_B);
  const ids = new Set(); let cursor = "0";
  do {
    const response = await worker.fetch(devReq(`/api/admin/customers/cus_a/access?limit=100&cursor=${cursor}&customer_id=cus_b`), env);
    assert.equal(response.status, 200);
    const page = (await response.json()).data;
    for (const item of page.items) { assert.equal(item.customer_id, "cus_a"); assert.ok(!ids.has(item.id)); ids.add(item.id); }
    cursor = page.next_cursor;
  } while (cursor !== null);
  assert.equal(ids.size, 205);
  const missing = await worker.fetch(devReq("/api/admin/customers/missing/access"), env);
  assert.equal(missing.status, 404);
  const empty = await worker.fetch(devReq("/api/admin/customers/cus_a/access?project=OTHER"), env);
  assert.deepEqual((await empty.json()).data, { items: [], next_cursor: null });
  const invalid = await worker.fetch(devReq("/api/admin/customers/cus_a/access?limit=101"), env);
  assert.equal(invalid.status, 400);
  const id = [...ids][0];
  const exact = await worker.fetch(devReq(`/api/admin/entitlements/${encodeURIComponent(id)}`), env);
  assert.equal(exact.status, 200);
  assert.equal((await exact.json()).data.customer_id, "cus_a");
});

test("console: complete app summaries and paginated resources stay within customer ownership", async () => {
  const db = freshDb(); seed(db); const env = devEnv(db);
  for (let i = 1; i <= 105; i++) await createEntitlementFor(env, "cus_a", i.toString(16).padStart(64, "0"));
  await createEntitlementFor(env, "cus_b", FP_B);
  const fp = (1).toString(16).padStart(64, "0");
  db.prepare("INSERT INTO entitlements (project,feature,license_fingerprint,status,customer_id,created_at,updated_at) VALUES ('Z_EXTRA','base',?,'active','cus_a',?,?)").run(FP_A, NOW, NOW);
  db.exec("UPDATE customers SET status='disabled' WHERE id='cus_a'");
  db.prepare("UPDATE entitlements SET valid_until=? WHERE license_fingerprint=?").run(NOW - 10, fp);
  const node = db.prepare("INSERT INTO entitlement_devices (project,feature,license_fingerprint,device_key_id,public_key_spki_der_base64,status,created_at,updated_at) VALUES ('DEFAULT','DEFAULT',?,?,'private-fixture-material','active',?,?)");
  const seat = db.prepare("INSERT INTO seat_checkouts (project,feature,license_fingerprint,seat_id,client_instance_id,mode,checked_out_at,heartbeat_deadline) VALUES ('DEFAULT','DEFAULT',?,?,?,'live',?,?)");
  for (const fingerprint of [fp, FP_B]) for (let i = 0; i < 3; i++) {
    node.run(fingerprint, `node-${i}`, NOW, NOW);
    seat.run(fingerprint, `seat-${i}`, `client-${i}`, NOW, NOW + (i - 1) * 60);
  }
  const apps = (await body(await worker.fetch(devReq("/api/admin/customers/cus_a/apps?limit=1"), env))).data;
  assert.equal(apps.items[0].grant_count, 105, "aggregation must precede pagination");
  assert.equal(apps.items[0].in_date_count, 104);
  assert.equal(apps.items[0].no_expiry_count, 104);
  assert.equal(apps.customer.status, "disabled", "enabled/in-date grant counts do not override customer suspension");
  assert.equal(apps.next_cursor, "1");
  const secondApp = (await body(await worker.fetch(devReq("/api/admin/customers/cus_a/apps?limit=1&cursor=1"), env))).data;
  assert.equal(secondApp.items[0].project, "Z_EXTRA"); assert.equal(secondApp.items[0].grant_count, 1); assert.equal(secondApp.next_cursor, null);
  for (const kind of ["nodes", "sessions"]) {
    const records = []; let cursor = "0";
    do {
      const response = await worker.fetch(devReq(`/api/admin/customers/cus_a/resources?kind=${kind}&project=DEFAULT&limit=2&cursor=${cursor}&customer_id=cus_b`), env);
      assert.equal(response.status, 200);
      const raw = await response.clone().text(); assert.ok(!raw.includes("private-fixture-material"));
      const page = (await body(response)).data;
      records.push(...page.items); cursor = page.next_cursor;
    } while (cursor !== null);
    assert.equal(records.length, 3);
    assert.ok(records.every(row => row.license_fingerprint === fp));
    assert.equal(new Set(records.map(row => row.device_key_id ?? row.seat_id)).size, 3);
  }
  assert.equal((await worker.fetch(devReq("/api/admin/customers/cus_a/resources?kind=invalid"), env)).status, 400);
  for (const view of ["apps", "resources"]) assert.equal((await worker.fetch(devReq(`/api/admin/customers/missing/${view}`), env)).status, 404);
});

test("console: exact grant selection and optional owner/revision preconditions reject stale writes", async () => {
  const db = freshDb(); seed(db); const env = devEnv(db);
  await createEntitlementFor(env, "cus_a", FP_A); await createEntitlementFor(env, "cus_b", FP_B);
  const observed = (await body(await worker.fetch(devReq("/api/admin/customers/cus_a/access"), env))).data.items[0];
  const query = new URLSearchParams({ id: observed.id, customer_id: "cus_a" });
  assert.equal((await body(await worker.fetch(devReq(`/api/admin/entitlements?${query}`), env))).data.items.length, 1);
  query.set("customer_id", "cus_b");
  assert.equal((await body(await worker.fetch(devReq(`/api/admin/entitlements?${query}`), env))).data.items.length, 0);
  const path = `/api/admin/entitlements/${encodeURIComponent(observed.id)}`;
  const expected = { expected_customer_id: "cus_a", expected_revocation_seq: observed.revocation_seq };
  const patch = (fields, key) => worker.fetch(devReq(path, { method: "PATCH", headers: key ? { "idempotency-key": key } : {}, body: JSON.stringify({ notes: "edited", ...fields }) }), env);
  assert.equal((await patch({ expected_customer_id: "cus_a" })).status, 400);
  assert.equal((await patch({ ...expected, expected_customer_id: "cus_b" })).status, 409);
  assert.equal((await patch({ ...expected, expected_revocation_seq: observed.revocation_seq + 1 })).status, 409);
  assert.equal((await patch(expected, "observed-edit")).status, 200);
  const replay = await patch(expected, "observed-edit");
  assert.equal(replay.status, 200); assert.equal(replay.headers.get("x-idempotent-replay"), "1");
  assert.equal((await patch(expected)).status, 409);
  const staleDisable = await worker.fetch(devReq(`${path}/disable`, { method: "POST", body: JSON.stringify({ ...expected, reason: "old view" }) }), env);
  assert.equal(staleDisable.status, 409);
  assert.equal((await patch({})).status, 200, "legacy callers remain supported");
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE license_fingerprint=?").get(FP_A).status, "active");
});

test("console: workspace query plans and bounded responses at 20000 grants", async t => {
  const db = freshDb(); seed(db); const env = devEnv(db);
  const insert = db.prepare("INSERT INTO entitlements (project,feature,license_fingerprint,status,customer_id,created_at,updated_at) VALUES (?,'base',?,'active','cus_a',?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 20000; i++) insert.run(`APP_${String(i % 250).padStart(3, "0")}`, i.toString(16).padStart(64, "0"), NOW, NOW);
  db.exec("COMMIT");
  db.exec("INSERT INTO entitlement_devices (project,feature,license_fingerprint,device_key_id,public_key_spki_der_base64,status,created_at,updated_at) SELECT project,feature,license_fingerprint,'node','fixture','active',created_at,updated_at FROM entitlements LIMIT 1000");
  db.exec("INSERT INTO seat_checkouts (project,feature,license_fingerprint,seat_id,client_instance_id,mode,checked_out_at,heartbeat_deadline) SELECT project,feature,license_fingerprint,'seat','client','live',created_at,updated_at+600 FROM entitlements LIMIT 1000");
  const captured = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    const statement = prepare(sql); const bind = statement.bind.bind(statement);
    statement.bind = (...values) => { captured.push({ sql, values }); return bind(...values); };
    return statement;
  };
  for (const suffix of ["apps?limit=100", "apps?limit=100&cursor=200", "access?limit=100", "access?limit=100&cursor=19000", "resources?kind=nodes&limit=100", "resources?kind=sessions&limit=100"]) {
    captured.length = 0; const started = performance.now();
    const response = await worker.fetch(devReq(`/api/admin/customers/cus_a/${suffix}`), env);
    const raw = await response.text(); const data = JSON.parse(raw).data;
    assert.equal(response.status, 200); assert.ok(data.items.length <= 100); assert.equal(captured.length, 2, "no per-record query fan-out");
    if (suffix.startsWith("apps")) assert.ok(data.items.every(item => item.grant_count === 80));
    const elapsed = performance.now() - started;
    const query = captured[1];
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.values).map(row => row.detail);
    t.diagnostic(JSON.stringify({ suffix, rows: data.items.length, bytes: Buffer.byteLength(raw), queries: captured.length, local_ms: Number(elapsed.toFixed(2)), plan }));
  }
});

test("console: summary and report share stored-state counts using one entitlement query", async () => {
  const db = freshDb(); seed(db); const env = devEnv(db);
  await createEntitlementFor(env, "cus_a", FP_A);
  db.prepare("UPDATE entitlements SET valid_until = ? WHERE customer_id = 'cus_a'").run(NOW - 1);
  const queries = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => { queries.push(sql); return prepare(sql); };
  const summary = await (await worker.fetch(devReq("/api/admin/summary"), env)).json();
  assert.equal(queries.length, 1, "four sequential count statements become one aggregate");
  assert.deepEqual(summary.data.entitlements, { total: 1, active: 1, revoked: 0, disabled: 0 });
  queries.length = 0;
  const report = await (await worker.fetch(devReq("/api/admin/report"), env)).json();
  assert.deepEqual(report.data.entitlements, summary.data.entitlements);
  assert.equal(queries.filter(sql => sql.includes("FROM entitlements")).length, 1);
});

test("console: project inventory includes empty configured apps and legacy records with stable pages", async () => {
  const db = freshDb(); seed(db); const env = devEnv(db);
  db.prepare("INSERT INTO catalog_features (id,project,feature_key,name,status,created_at,updated_at) VALUES ('empty','EMPTY','base','Empty','disabled',?,?)").run(NOW,NOW);
  db.prepare("INSERT INTO entitlement_policies (id,project,name,type,created_at,updated_at) VALUES ('policy-only','POLICY_ONLY','No grants','node_locked',?,?)").run(NOW,NOW);
  const projects = []; let cursor = "0";
  do {
    const response = await worker.fetch(devReq(`/api/admin/catalog/projects?limit=1&cursor=${cursor}`), env);
    assert.equal(response.status, 200);
    const page = (await response.json()).data;
    projects.push(...page.items.map(item => item.project)); cursor = page.next_cursor;
  } while (cursor !== null);
  assert.deepEqual(projects, ["DEFAULT", "EMPTY", "OTHER", "POLICY_ONLY"]);
  assert.equal((await worker.fetch(devReq("/api/admin/catalog/projects?cursor=-1"), env)).status, 400);
});

test("console: customers list returns seeded rows with entitlement counts + filters", async () => {
  const db = freshDb();
  seed(db);
  const env = devEnv(db);
  await createEntitlementFor(env, "cus_a", FP_A);

  const all = await worker.fetch(devReq("/api/admin/customers"), env);
  assert.equal(all.status, 200);
  const data = (await body(all)).data;
  assert.equal(data.items.length, 2);
  const acme = data.items.find((c) => c.id === "cus_a");
  assert.equal(acme.entitlement_count, 1);
  assert.equal(acme.active_entitlement_count, 1);

  const filtered = await worker.fetch(devReq("/api/admin/customers?q=acme"), env);
  const list = (await body(filtered)).data.items;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "cus_a");

  const disabledOnly = await worker.fetch(devReq("/api/admin/customers?status=disabled"), env);
  assert.equal((await body(disabledOnly)).data.items.length, 0);
});

test("console: customer detail aggregates and NEVER leaks token_hmac", async () => {
  const db = freshDb();
  seed(db);
  const env = devEnv(db);
  await createEntitlementFor(env, "cus_a", FP_A);

  const res = await worker.fetch(devReq("/api/admin/customers/cus_a"), env);
  assert.equal(res.status, 200);
  const raw = await res.clone().text();
  const data = (await body(res)).data;
  assert.equal(data.customer.id, "cus_a");
  assert.equal(data.entitlements.length, 1);
  assert.equal(data.account_tokens.length, 1);
  assert.equal(data.account_tokens[0].token_prefix, "lcca_abc123");
  assert.equal(data.licenses.length, 1);
  assert.equal(data.orders.length, 1);
  // The keyed secret and pepper id must never cross the wire.
  assert.ok(!raw.includes(TOKEN_HMAC_SECRET), "token_hmac leaked in customer detail");
  assert.ok(!("token_hmac" in data.account_tokens[0]), "token_hmac field present");
  assert.ok(!("pepper_key_id" in data.account_tokens[0]), "pepper_key_id field present");

  const missing = await worker.fetch(devReq("/api/admin/customers/cus_nope"), env);
  assert.equal(missing.status, 404);
});

test("console: licenses list filters by project / customer / q", async () => {
  const db = freshDb();
  seed(db);
  const env = devEnv(db);

  assert.equal((await body(await worker.fetch(devReq("/api/admin/licenses"), env))).data.items.length, 2);
  assert.equal((await body(await worker.fetch(devReq("/api/admin/licenses?project=OTHER"), env))).data.items.length, 1);
  assert.equal((await body(await worker.fetch(devReq("/api/admin/licenses?customer_id=cus_a"), env))).data.items[0].id, "lic_a1");
  assert.equal((await body(await worker.fetch(devReq("/api/admin/licenses?q=beta"), env))).data.items[0].id, "lic_b1");
});

test("console: fulfillment monitor surfaces status summary + stale-accepted flag", async () => {
  const db = freshDb();
  seed(db);
  const env = devEnv(db);

  const res = await worker.fetch(devReq("/api/admin/orders"), env);
  assert.equal(res.status, 200);
  const data = (await body(res)).data;
  assert.equal(data.summary.processed, 1);
  assert.equal(data.summary.accepted, 1);
  assert.equal(data.summary.stale_accepted, 1);
  const stuck = data.items.find((e) => e.event_id === "evt_stuck");
  assert.equal(stuck.stale, true);
  const done = data.items.find((e) => e.event_id === "evt_done");
  assert.equal(done.stale, false);

  const onlyAccepted = await worker.fetch(devReq("/api/admin/orders?status=accepted"), env);
  const accepted = (await body(onlyAccepted)).data.items;
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].event_id, "evt_stuck");
});

test("console: report aggregates entitlements / customers / tokens / fulfillment", async () => {
  const db = freshDb();
  seed(db);
  const env = devEnv(db);
  await createEntitlementFor(env, "cus_a", FP_A);
  await createEntitlementFor(env, "cus_b", FP_B);

  const res = await worker.fetch(devReq("/api/admin/report"), env);
  assert.equal(res.status, 200);
  const data = (await body(res)).data;
  assert.equal(data.entitlements.total, 2);
  assert.equal(data.entitlements.active, 2);
  assert.equal(data.customers.total, 2);
  assert.equal(data.customers.active, 2);
  assert.equal(data.account_tokens.active, 1);
  assert.equal(data.licenses.total, 2);
  assert.equal(data.fulfillment.processed, 1);
  assert.equal(data.fulfillment.stale_accepted, 1);
});

test("console: customer kill-switch is atomic + audited with gates", async () => {
  const db = freshDb();
  seed(db);
  const env = devEnv(db);

  // disable requires a reason
  const noReason = await worker.fetch(devReq("/api/admin/customers/cus_a/disable", { method: "POST", body: "{}" }), env);
  assert.equal(noReason.status, 400);
  assert.equal((await body(noReason)).code, "reason_required");

  // missing customer -> 404
  const missing = await worker.fetch(devReq("/api/admin/customers/cus_nope/disable", { method: "POST", body: JSON.stringify({ reason: "x" }) }), env);
  assert.equal(missing.status, 404);

  // disable -> 200, status flips, audit row written
  const disabled = await worker.fetch(devReq("/api/admin/customers/cus_a/disable", { method: "POST", body: JSON.stringify({ reason: "chargeback" }) }), env);
  assert.equal(disabled.status, 200);
  assert.equal((await body(disabled)).data.status, "disabled");
  assert.equal(db.prepare("SELECT status FROM customers WHERE id='cus_a'").get().status, "disabled");
  const event = db.prepare("SELECT * FROM customer_events WHERE customer_id='cus_a' ORDER BY id DESC LIMIT 1").get();
  assert.equal(event.event_type, "disable");
  assert.equal(event.prev_status, "active");
  assert.equal(event.next_status, "disabled");
  assert.equal(event.reason, "chargeback");
  assert.equal(event.actor, "dev.local");

  // already disabled -> 409
  const again = await worker.fetch(devReq("/api/admin/customers/cus_a/disable", { method: "POST", body: JSON.stringify({ reason: "y" }) }), env);
  assert.equal(again.status, 409);
  assert.equal((await body(again)).code, "customer_status_conflict");

  // reenable -> 200 active (reason optional)
  const reenabled = await worker.fetch(devReq("/api/admin/customers/cus_a/reenable", { method: "POST", body: "{}" }), env);
  assert.equal(reenabled.status, 200);
  assert.equal((await body(reenabled)).data.status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM customer_events WHERE customer_id='cus_a'").get().c, 2);
});

test("console: kill-switch is idempotent under a repeated idempotency-key", async () => {
  const db = freshDb();
  seed(db);
  const env = devEnv(db);
  const req = () => devReq("/api/admin/customers/cus_a/disable", {
    method: "POST",
    headers: { "idempotency-key": "kill-1" },
    body: JSON.stringify({ reason: "dup" }),
  });
  const first = await worker.fetch(req(), env);
  assert.equal(first.status, 200);
  const replay = await worker.fetch(req(), env);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("x-idempotent-replay"), "1");
  // Exactly one audit row despite two POSTs.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM customer_events WHERE customer_id='cus_a'").get().c, 1);
});

test("console: reader can read every endpoint but cannot run the kill-switch", async (t) => {
  const db = freshDb();
  seed(db);
  const fixture = await accessFixture(t);
  const env = accessEnv(db, fixture);
  const reader = await accessToken(fixture, "reader@example.com");
  assert.equal((await worker.fetch(accessReq("/api/admin/customers", reader, { method: "POST", body: "{}" }), env)).status, 403);

  for (const path of ["/api/admin/customers/cus_a/apps", "/api/admin/customers/cus_a/resources", "/api/admin/customers/cus_a/resources?kind=sessions", "/api/admin/customers/cus_a/access", "/api/admin/catalog/projects", "/api/admin/customers", "/api/admin/customers/cus_a", "/api/admin/licenses", "/api/admin/orders", "/api/admin/report"]) {
    const res = await worker.fetch(accessReq(path, reader), env);
    assert.equal(res.status, 200, `reader GET ${path}`);
  }

  for (const action of ["disable", "reenable"]) {
    const res = await worker.fetch(accessReq(`/api/admin/customers/cus_a/${action}`, reader, {
      method: "POST",
      body: JSON.stringify({ reason: "reader should not" }),
    }), env);
    assert.equal(res.status, 403, `reader ${action}`);
    assert.equal((await body(res)).code, "admin_role_required");
  }
  // Denied reader writes changed nothing.
  assert.equal(db.prepare("SELECT status FROM customers WHERE id='cus_a'").get().status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM customer_events").get().c, 0);

  // And an admin via the same Access path CAN.
  const admin = await accessToken(fixture, "admin@example.com");
  const ok = await worker.fetch(accessReq("/api/admin/customers/cus_a/disable", admin, {
    method: "POST",
    body: JSON.stringify({ reason: "admin can" }),
  }), env);
  assert.equal(ok.status, 200);
  assert.equal(db.prepare("SELECT actor_type FROM customer_events WHERE customer_id='cus_a'").get().actor_type, "access");
});
