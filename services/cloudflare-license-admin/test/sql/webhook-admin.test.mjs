// Webhook endpoint CRUD + delivery status/redrive (real SQLite, end-to-end through worker.fetch).
//
// The hermetic unit MockD1 (admin-worker.test.mjs) only knows the entitlement SQL and throws on
// anything else, so webhook CRUD (webhook_endpoints / webhook_deliveries, migration 0020) cannot run
// there. This suite drives the REAL compiled worker over an in-memory SQLite built from the shared
// migrations/*.sql (which include 0020) wrapped in a D1-like adapter — nothing about the webhook SQL
// is mocked.
//
// Covers: create + the https-only URL gate (a non-https URL is 400 invalid_url, persists nothing);
// event_types csv normalization; list + status filter + cursor; detail (endpoint + recent deliveries)
// + 404; patch (and the not-patchable status rejection); disable/reenable guard + 409 on a stale status;
// the deliveries status view filtered by status/endpoint; redrive resets a 'failed' delivery to pending
// (and is 409 on a non-failed one). RBAC: a reader can read webhooks but cannot run any webhook write.
// Plus a sign/verify roundtrip against the backend's exported verifyWebhookSignature (the SAME verifier
// a receiver imports), proving the signing contract documented for receivers.
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
import { signWebhookBody, verifyWebhookSignature } from "@licensecc/cloudflare-licensing-backend/webhooks/webhook";

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

// Insert a webhook_deliveries row directly (the dispatcher's job; here we seed the outbox so the
// admin status view + redrive have something to read). Returns the autoincrement id.
function seedDelivery(db, { endpoint_id, status = "pending", attempts = 0, last_error = "", event_id = 1, event_source = "entitlement", event_type = "create" }) {
  db.prepare(
    "INSERT INTO webhook_deliveries (endpoint_id, event_source, event_id, event_type, payload_json, status, attempts, last_status, last_error, next_attempt_at, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(endpoint_id, event_source, event_id, event_type, JSON.stringify({ id: event_id }), status, attempts, status === "failed" ? 500 : 0, last_error, 1000, 1000);
  return db.prepare("SELECT last_insert_rowid() AS id").get().id;
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

// Create a webhook endpoint through the worker and return its row.
async function createWebhook(env, payload) {
  const res = await worker.fetch(devReq("/api/admin/webhooks", { method: "POST", body: JSON.stringify(payload) }), env);
  assert.equal(res.status, 200, `create webhook: ${await res.clone().text()}`);
  return (await body(res)).data;
}

// ─────────────────────────────────────────────────────────────────────────────

test("webhook: create writes the endpoint row and normalizes event_types csv", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const created = await createWebhook(env, {
    url: "https://hooks.example.com/lcc",
    event_types: " create , revoke ,, disable ",
    description: "ops channel",
  });
  assert.ok(created.id);
  assert.equal(created.url, "https://hooks.example.com/lcc");
  assert.equal(created.status, "active");
  assert.equal(created.description, "ops channel");
  // event_types is trimmed + empty-entry-dropped, comma-joined.
  assert.equal(created.event_types, "create,revoke,disable");

  const row = db.prepare("SELECT * FROM webhook_endpoints WHERE id = ?").get(created.id);
  assert.equal(row.url, "https://hooks.example.com/lcc");
  assert.equal(row.event_types, "create,revoke,disable");
  assert.equal(row.status, "active");
});

test("webhook: defaults applied for omitted event_types/description", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const created = await createWebhook(env, { url: "https://hooks.example.com/all" });
  assert.equal(created.event_types, ""); // '' = all event types
  assert.equal(created.description, "");
});

test("webhook: a non-https URL is 400 invalid_url and persists nothing", async () => {
  const db = freshDb();
  const env = devEnv(db);
  for (const url of ["http://hooks.example.com/x", "ftp://hooks.example.com/x", "hooks.example.com/x", "https://hooks.example.com/ has space", ""]) {
    const res = await worker.fetch(devReq("/api/admin/webhooks", { method: "POST", body: JSON.stringify({ url }) }), env);
    assert.equal(res.status, 400, `url=${JSON.stringify(url)} should be 400`);
    assert.equal((await body(res)).code, "invalid_url");
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM webhook_endpoints").get().c, 0);
});

test("webhook: list filters by status and paginates with a cursor", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const a = await createWebhook(env, { url: "https://a.example.com/h" });
  const b = await createWebhook(env, { url: "https://b.example.com/h" });
  await createWebhook(env, { url: "https://c.example.com/h" });
  // Disable one so the status filter has something to exclude.
  await worker.fetch(devReq(`/api/admin/webhooks/${a.id}/disable`, { method: "POST", body: "{}" }), env);

  const activeList = await (await worker.fetch(devReq("/api/admin/webhooks?status=active"), env)).json();
  assert.equal(activeList.code, "webhooks_listed");
  assert.equal(activeList.data.items.length, 2);
  assert.ok(activeList.data.items.every((it) => it.status === "active"));

  const disabledList = await (await worker.fetch(devReq("/api/admin/webhooks?status=disabled"), env)).json();
  assert.equal(disabledList.data.items.length, 1);
  assert.equal(disabledList.data.items[0].id, a.id);

  // Cursor: page size 2 over 3 rows -> a next_cursor on page 1, none on page 2.
  const page1 = await (await worker.fetch(devReq("/api/admin/webhooks?limit=2"), env)).json();
  assert.equal(page1.data.items.length, 2);
  assert.equal(page1.data.next_cursor, "2");
  const page2 = await (await worker.fetch(devReq(`/api/admin/webhooks?limit=2&cursor=${page1.data.next_cursor}`), env)).json();
  assert.equal(page2.data.items.length, 1);
  assert.equal(page2.data.next_cursor, null);
  void b;
});

test("webhook: detail returns the endpoint + its recent deliveries; unknown id is 404", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const ep = await createWebhook(env, { url: "https://d.example.com/h" });
  seedDelivery(db, { endpoint_id: ep.id, status: "delivered", event_id: 1 });
  seedDelivery(db, { endpoint_id: ep.id, status: "failed", event_id: 2, last_error: "boom" });

  const detail = await (await worker.fetch(devReq(`/api/admin/webhooks/${ep.id}`), env)).json();
  assert.equal(detail.code, "webhook");
  assert.equal(detail.data.endpoint.id, ep.id);
  assert.equal(detail.data.deliveries.length, 2);
  // newest first (id DESC): the failed one (event_id 2) was inserted last.
  assert.equal(detail.data.deliveries[0].event_id, 2);
  assert.equal(detail.data.deliveries[0].status, "failed");
  // The full payload body is never surfaced — only metadata columns.
  assert.equal(detail.data.deliveries[0].payload_json, undefined);

  const missing = await worker.fetch(devReq("/api/admin/webhooks/does-not-exist"), env);
  assert.equal(missing.status, 404);
  assert.equal((await body(missing)).code, "not_found");
});

test("webhook: patch updates url/event_types/description; status is not patchable; unknown id 404", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const ep = await createWebhook(env, { url: "https://e.example.com/h", event_types: "create" });

  const patched = await (await worker.fetch(devReq(`/api/admin/webhooks/${ep.id}`, {
    method: "PATCH",
    body: JSON.stringify({ url: "https://e.example.com/h2", event_types: "revoke", description: "moved" }),
  }), env)).json();
  assert.equal(patched.code, "webhook_patched");
  assert.equal(patched.data.url, "https://e.example.com/h2");
  assert.equal(patched.data.event_types, "revoke");
  assert.equal(patched.data.description, "moved");

  // status is NOT patchable -> 400 invalid_request (a caller cannot flip status outside disable/reenable).
  const badStatus = await worker.fetch(devReq(`/api/admin/webhooks/${ep.id}`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) }), env);
  assert.equal(badStatus.status, 400);
  assert.equal((await body(badStatus)).code, "invalid_request");

  // a non-https url in a patch -> 400 invalid_url, persists nothing.
  const badUrl = await worker.fetch(devReq(`/api/admin/webhooks/${ep.id}`, { method: "PATCH", body: JSON.stringify({ url: "http://nope" }) }), env);
  assert.equal(badUrl.status, 400);
  assert.equal((await body(badUrl)).code, "invalid_url");
  assert.equal(db.prepare("SELECT url FROM webhook_endpoints WHERE id = ?").get(ep.id).url, "https://e.example.com/h2");

  // unknown id -> 404.
  const missing = await worker.fetch(devReq("/api/admin/webhooks/nope", { method: "PATCH", body: JSON.stringify({ description: "x" }) }), env);
  assert.equal(missing.status, 404);
});

test("webhook: disable/reenable guard + 409 on a stale status", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const ep = await createWebhook(env, { url: "https://f.example.com/h" });

  const disabled = await (await worker.fetch(devReq(`/api/admin/webhooks/${ep.id}/disable`, { method: "POST", body: "{}" }), env)).json();
  assert.equal(disabled.code, "webhook_disabled");
  assert.equal(disabled.data.status, "disabled");

  // Disabling an already-disabled endpoint is a 409 (the guarded UPDATE requires status=active).
  const again = await worker.fetch(devReq(`/api/admin/webhooks/${ep.id}/disable`, { method: "POST", body: "{}" }), env);
  assert.equal(again.status, 409);
  assert.equal((await body(again)).code, "webhook_status_conflict");

  const reenabled = await (await worker.fetch(devReq(`/api/admin/webhooks/${ep.id}/reenable`, { method: "POST", body: "{}" }), env)).json();
  assert.equal(reenabled.code, "webhook_reenabled");
  assert.equal(reenabled.data.status, "active");
});

test("webhook deliveries: status view filters by status + endpoint", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const ep1 = await createWebhook(env, { url: "https://g1.example.com/h" });
  const ep2 = await createWebhook(env, { url: "https://g2.example.com/h" });
  seedDelivery(db, { endpoint_id: ep1.id, status: "pending", event_id: 1 });
  seedDelivery(db, { endpoint_id: ep1.id, status: "failed", event_id: 2 });
  seedDelivery(db, { endpoint_id: ep2.id, status: "delivered", event_id: 3 });

  const allFailed = await (await worker.fetch(devReq("/api/admin/webhooks/deliveries?status=failed"), env)).json();
  assert.equal(allFailed.code, "webhook_deliveries_listed");
  assert.equal(allFailed.data.items.length, 1);
  assert.equal(allFailed.data.items[0].event_id, 2);

  const ep1Only = await (await worker.fetch(devReq(`/api/admin/webhooks/deliveries?endpoint_id=${ep1.id}`), env)).json();
  assert.equal(ep1Only.data.items.length, 2);
  assert.ok(ep1Only.data.items.every((it) => it.endpoint_id === ep1.id));

  // An invalid status filter is a 400.
  const bad = await worker.fetch(devReq("/api/admin/webhooks/deliveries?status=bogus"), env);
  assert.equal(bad.status, 400);
  assert.equal((await body(bad)).code, "invalid_request");
});

test("webhook deliveries: redrive resets a failed delivery to pending; non-failed is 409", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const ep = await createWebhook(env, { url: "https://h.example.com/h" });
  const failedId = seedDelivery(db, { endpoint_id: ep.id, status: "failed", attempts: 6, last_error: "gateway down", event_id: 1 });
  const deliveredId = seedDelivery(db, { endpoint_id: ep.id, status: "delivered", event_id: 2 });

  const redrive = await (await worker.fetch(devReq(`/api/admin/webhooks/deliveries/${failedId}/redrive`, { method: "POST", body: "{}" }), env)).json();
  assert.equal(redrive.code, "webhook_delivery_redriven");
  assert.equal(redrive.data.status, "pending");
  assert.equal(redrive.data.attempts, 0);
  assert.equal(redrive.data.last_error, "");

  const row = db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(failedId);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);

  // Redriving a non-failed (delivered) delivery is a 409.
  const conflict = await worker.fetch(devReq(`/api/admin/webhooks/deliveries/${deliveredId}/redrive`, { method: "POST", body: "{}" }), env);
  assert.equal(conflict.status, 409);
  assert.equal((await body(conflict)).code, "webhook_delivery_not_failed");

  // Redriving an unknown delivery id is a 404.
  const missing = await worker.fetch(devReq("/api/admin/webhooks/deliveries/999999/redrive", { method: "POST", body: "{}" }), env);
  assert.equal(missing.status, 404);
});

test("webhook: reader can read but cannot run any webhook write", async (t) => {
  const db = freshDb();
  const fixture = await accessFixture(t);
  const env = accessEnv(db, fixture);
  const admin = await accessToken(fixture, "admin@example.com");
  const reader = await accessToken(fixture, "reader@example.com");

  // Admin seeds an endpoint + a failed delivery.
  const createRes = await worker.fetch(accessReq("/api/admin/webhooks", admin, {
    method: "POST",
    body: JSON.stringify({ url: "https://rbac.example.com/h" }),
  }), env);
  assert.equal(createRes.status, 200);
  const epId = (await body(createRes)).data.id;
  const failedId = seedDelivery(db, { endpoint_id: epId, status: "failed", event_id: 1 });

  // Reader CAN read list + detail + deliveries view.
  assert.equal((await worker.fetch(accessReq("/api/admin/webhooks", reader), env)).status, 200);
  assert.equal((await worker.fetch(accessReq(`/api/admin/webhooks/${epId}`, reader), env)).status, 200);
  assert.equal((await worker.fetch(accessReq("/api/admin/webhooks/deliveries", reader), env)).status, 200);

  // Reader CANNOT create / patch / disable / reenable / redrive.
  const denied = [
    accessReq("/api/admin/webhooks", reader, { method: "POST", body: JSON.stringify({ url: "https://nope.example.com/h" }) }),
    accessReq(`/api/admin/webhooks/${epId}`, reader, { method: "PATCH", body: JSON.stringify({ description: "x" }) }),
    accessReq(`/api/admin/webhooks/${epId}/disable`, reader, { method: "POST", body: "{}" }),
    accessReq(`/api/admin/webhooks/${epId}/reenable`, reader, { method: "POST", body: "{}" }),
    accessReq(`/api/admin/webhooks/deliveries/${failedId}/redrive`, reader, { method: "POST", body: "{}" }),
  ];
  for (const req of denied) {
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 403, `reader ${req.method} ${new URL(req.url).pathname}`);
    assert.equal((await body(res)).code, "admin_role_required");
  }
  // Denied reader writes changed nothing: still exactly one endpoint (active), the failed delivery untouched.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM webhook_endpoints").get().c, 1);
  assert.equal(db.prepare("SELECT status FROM webhook_endpoints WHERE id = ?").get(epId).status, "active");
  assert.equal(db.prepare("SELECT status FROM webhook_deliveries WHERE id = ?").get(failedId).status, "failed");
});

test("webhook: idempotency-key replays the create response without a second row", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const key = "idem-create-1";
  const first = await (await worker.fetch(devReq("/api/admin/webhooks", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify({ url: "https://i.example.com/h" }) }), env)).json();
  assert.equal(first.code, "webhook_created");
  const second = await (await worker.fetch(devReq("/api/admin/webhooks", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify({ url: "https://i.example.com/h" }) }), env)).json();
  assert.equal(second.data.id, first.data.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM webhook_endpoints").get().c, 1);
});

test("webhook signature: sign/verify roundtrip against the backend's exported verifier", async () => {
  // The SAME verifier a receiver imports. Build a null-prototype secrets map (a 32-byte secret)
  // exactly as loadSecretMap would, sign "<t>.<body>", and prove verify accepts the fresh signature
  // but rejects a tampered body and a stale timestamp (the documented 5-minute replay window).
  const secret = new Uint8Array(32).fill(9);
  const secretsMap = Object.create(null);
  secretsMap["k1"] = secret;
  const now = 1_700_000_000;
  const payload = JSON.stringify({ id: 7, type: "create", source: "entitlement" });

  const header = await signWebhookBody(secretsMap, "k1", payload, now);
  assert.match(header, /^t=1700000000,keyid=k1,v1=[0-9a-f]{64}$/);

  assert.equal(await verifyWebhookSignature(payload, header, secretsMap, now), true, "fresh signature verifies");
  assert.equal(await verifyWebhookSignature(payload + "!", header, secretsMap, now), false, "tampered body rejected");
  assert.equal(await verifyWebhookSignature(payload, header, secretsMap, now + 301), false, "stale (>5min) timestamp rejected");
});
