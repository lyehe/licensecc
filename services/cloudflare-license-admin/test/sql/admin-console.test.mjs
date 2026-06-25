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

  for (const path of ["/api/admin/customers", "/api/admin/customers/cus_a", "/api/admin/licenses", "/api/admin/orders", "/api/admin/report"]) {
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
