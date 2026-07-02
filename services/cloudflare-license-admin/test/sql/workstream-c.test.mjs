// Workstream C BACKEND — bulk transitions, global search, CSV export (real SQLite,
// end-to-end through worker.fetch).
//
// The hermetic unit MockD1 (admin-worker.test.mjs) is hand-specialized to the entitlement SQL and
// THROWS on the customers/licenses/orders/search/entitlement_events SQL these features touch, so
// this suite drives the REAL compiled worker over an in-memory SQLite built from the shared
// migrations/*.sql wrapped in a D1-like adapter — nothing about the new SQL is mocked.
//
// Covers:
//   - BULK TRANSITIONS POST /api/admin/entitlements/batch: per-row results (mixed success / revoked
//     terminal / missing / bad id), the >100 cap, the disable/revoke reason gate, reader RBAC block,
//     and THE PER-ROW IDEMPOTENCY FOOTGUN (re-POST same batch + same Idempotency-Key => each row
//     replays its OWN cached result, NOT row #1's), plus createEntitlement byte-identical (untouched).
//   - GLOBAL SEARCH GET /api/admin/search: fan-out across customers/licenses/entitlements/orders,
//     fingerprint PREFIX match, empty/over-long q => 400, reader allowed.
//   - CSV EXPORT ?format=csv on entitlements/customers/events: content-type + attachment, the SAME
//     filters, field escaping (quote + double-quote), and the row cap comment.
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

import worker, { adminInternalsForTests } from "../../dist-worker/worker/index.js";

const { entitlementId } = adminInternalsForTests;

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
const FP_C = "c".repeat(64);

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
async function createEntitlementFor(env, fingerprint, extra = {}) {
  const res = await worker.fetch(devReq("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint, ...extra }),
  }), env);
  assert.equal(res.status, 200, `seed entitlement ${fingerprint}: ${await res.clone().text()}`);
  return (await body(res)).data;
}

// ── BULK TRANSITIONS ──────────────────────────────────────────────────────────

test("batch: per-row results — mixed success / revoked-terminal / missing / bad id; one bad row never aborts", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const a = await createEntitlementFor(env, FP_A); // will succeed (active -> disabled)
  const b = await createEntitlementFor(env, FP_B); // pre-revoke so disable hits the terminal guard
  await createEntitlementFor(env, FP_C);           // active, will succeed

  // Revoke B up front so a later "disable" on it is rejected as terminal.
  const revokeB = await worker.fetch(devReq(`/api/admin/entitlements/${b.id}/revoke`, {
    method: "POST", body: JSON.stringify({ reason: "pre-revoked" }),
  }), env);
  assert.equal(revokeB.status, 200);

  const missingId = entitlementId("DEFAULT", "DEFAULT", "d".repeat(64));
  const res = await worker.fetch(devReq("/api/admin/entitlements/batch", {
    method: "POST",
    body: JSON.stringify({
      action: "disable",
      reason: "bulk pause",
      ids: [a.id, b.id, missingId, "!!!not-base64!!!", entitlementId("DEFAULT", "DEFAULT", FP_C)],
    }),
  }), env);
  assert.equal(res.status, 200);
  const result = await body(res);
  assert.equal(result.code, "batch_done");
  const byId = new Map(result.data.results.map((r) => [r.id, r]));

  assert.equal(byId.get(a.id).ok, true);
  assert.equal(byId.get(a.id).code, "entitlement_disabled");
  assert.equal(byId.get(b.id).ok, false);
  assert.equal(byId.get(b.id).code, "revoked_entitlement_is_terminal");
  assert.equal(byId.get(missingId).ok, false);
  assert.equal(byId.get(missingId).code, "not_found");
  assert.equal(byId.get("!!!not-base64!!!").ok, false);
  assert.equal(byId.get("!!!not-base64!!!").code, "invalid_entitlement_id");
  const cId = entitlementId("DEFAULT", "DEFAULT", FP_C);
  assert.equal(byId.get(cId).ok, true);

  // The good rows actually flipped; the terminal row stayed revoked.
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE license_fingerprint=?").get(FP_A).status, "disabled");
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE license_fingerprint=?").get(FP_C).status, "disabled");
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE license_fingerprint=?").get(FP_B).status, "revoked");
});

test("batch: THE PER-ROW IDEMPOTENCY FOOTGUN — re-POST same batch + key replays each row's OWN result", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const a = await createEntitlementFor(env, FP_A);
  const b = await createEntitlementFor(env, FP_B);

  const payload = JSON.stringify({ action: "disable", reason: "footgun probe", ids: [a.id, b.id] });
  const first = await worker.fetch(devReq("/api/admin/entitlements/batch", {
    method: "POST", headers: { "idempotency-key": "batch-key-1" }, body: payload,
  }), env);
  assert.equal(first.status, 200);
  const firstResults = (await body(first)).data.results;
  assert.equal(firstResults.length, 2);
  assert.ok(firstResults.every((r) => r.ok));

  // Each row recorded a DISTINCT mutation_idempotency key (<base>:<id>), not one shared key.
  const keys = db.prepare("SELECT idempotency_key FROM mutation_idempotency ORDER BY idempotency_key").all().map((r) => r.idempotency_key);
  assert.equal(keys.length, 2, "two distinct per-row idempotency keys");
  assert.ok(keys.includes(`batch-key-1:${a.id}`), "row A sub-key");
  assert.ok(keys.includes(`batch-key-1:${b.id}`), "row B sub-key");

  // The per-row cached responses must be DIFFERENT (each carries its own id) — proving the footgun is
  // avoided. If a single shared key had been used, both would carry row #1's (FP_A's) data.
  const respA = JSON.parse(db.prepare("SELECT response_json FROM mutation_idempotency WHERE idempotency_key=?").get(`batch-key-1:${a.id}`).response_json);
  const respB = JSON.parse(db.prepare("SELECT response_json FROM mutation_idempotency WHERE idempotency_key=?").get(`batch-key-1:${b.id}`).response_json);
  assert.equal(respA.data.license_fingerprint, FP_A);
  assert.equal(respB.data.license_fingerprint, FP_B);
  assert.notEqual(respA.data.license_fingerprint, respB.data.license_fingerprint);

  // Count audit events after the first batch (one disable per row).
  const eventsAfterFirst = db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE event_type='disable'").get().c;
  assert.equal(eventsAfterFirst, 2);

  // Re-POST the SAME batch with the SAME key: each row is idempotent (replayed), so NO new disable
  // events are written and both rows still report success — NOT all rows collapsing to row #1.
  const replay = await worker.fetch(devReq("/api/admin/entitlements/batch", {
    method: "POST", headers: { "idempotency-key": "batch-key-1" }, body: payload,
  }), env);
  assert.equal(replay.status, 200);
  const replayResults = (await body(replay)).data.results;
  assert.equal(replayResults.length, 2);
  assert.ok(replayResults.every((r) => r.ok));
  const eventsAfterReplay = db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE event_type='disable'").get().c;
  assert.equal(eventsAfterReplay, 2, "replay wrote no new audit events — each row replayed its own cached result");
});

test("batch: validation — bad action, missing reason for disable/revoke, empty/over-100 ids", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const a = await createEntitlementFor(env, FP_A);

  // bad action
  let res = await worker.fetch(devReq("/api/admin/entitlements/batch", {
    method: "POST", body: JSON.stringify({ action: "explode", reason: "x", ids: [a.id] }),
  }), env);
  assert.equal(res.status, 400);
  assert.equal((await body(res)).code, "invalid_request");

  // disable with no reason
  res = await worker.fetch(devReq("/api/admin/entitlements/batch", {
    method: "POST", body: JSON.stringify({ action: "disable", ids: [a.id] }),
  }), env);
  assert.equal(res.status, 400);
  assert.equal((await body(res)).code, "reason_required");

  // revoke with no reason
  res = await worker.fetch(devReq("/api/admin/entitlements/batch", {
    method: "POST", body: JSON.stringify({ action: "revoke", ids: [a.id] }),
  }), env);
  assert.equal(res.status, 400);
  assert.equal((await body(res)).code, "reason_required");

  // empty ids
  res = await worker.fetch(devReq("/api/admin/entitlements/batch", {
    method: "POST", body: JSON.stringify({ action: "reenable", ids: [] }),
  }), env);
  assert.equal(res.status, 400);
  assert.equal((await body(res)).code, "invalid_request");

  // >100 ids -> too_many. The cap is a length check that runs BEFORE any id is decoded, so short
  // placeholder ids suffice (and keep the body under the 8192-byte limit; 101 full encoded ids would
  // legitimately trip the 413 body-size guard first).
  const ids = Array.from({ length: 101 }, (_unused, i) => `id${i}`);
  res = await worker.fetch(devReq("/api/admin/entitlements/batch", {
    method: "POST", body: JSON.stringify({ action: "reenable", ids }),
  }), env);
  assert.equal(res.status, 400);
  assert.equal((await body(res)).code, "too_many");

  // reenable needs no reason -> succeeds (a is active so it's a no-op success).
  res = await worker.fetch(devReq("/api/admin/entitlements/batch", {
    method: "POST", body: JSON.stringify({ action: "reenable", ids: [a.id] }),
  }), env);
  assert.equal(res.status, 200);
  assert.equal((await body(res)).data.results[0].ok, true);
});

test("batch: reader RBAC is blocked; createEntitlement remains byte-identical (untouched)", async (t) => {
  const db = freshDb();
  const fixture = await accessFixture(t);
  const env = accessEnv(db, fixture);
  const admin = await accessToken(fixture, "admin@example.com");
  const reader = await accessToken(fixture, "reader@example.com");

  // Admin seeds two entitlements; capture the create audit count to prove batch never touches create.
  const a = (await body(await worker.fetch(accessReq("/api/admin/entitlements", admin, {
    method: "POST", body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP_A }),
  }), env))).data;
  const b = (await body(await worker.fetch(accessReq("/api/admin/entitlements", admin, {
    method: "POST", body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP_B }),
  }), env))).data;
  const createEvents = db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE event_type='create'").get().c;
  assert.equal(createEvents, 2);

  // Reader cannot batch.
  const denied = await worker.fetch(accessReq("/api/admin/entitlements/batch", reader, {
    method: "POST", body: JSON.stringify({ action: "disable", reason: "nope", ids: [a.id, b.id] }),
  }), env);
  assert.equal(denied.status, 403);
  assert.equal((await body(denied)).code, "admin_role_required");
  // Nothing changed: both still active, no new audit events.
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE license_fingerprint=?").get(FP_A).status, "active");
  assert.equal(db.prepare("SELECT status FROM entitlements WHERE license_fingerprint=?").get(FP_B).status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, 2);

  // Admin CAN, and the disable goes through the SHARED transitionEntitlement (create rows untouched).
  const ok = await worker.fetch(accessReq("/api/admin/entitlements/batch", admin, {
    method: "POST", body: JSON.stringify({ action: "disable", reason: "admin can", ids: [a.id, b.id] }),
  }), env);
  assert.equal(ok.status, 200);
  assert.ok((await body(ok)).data.results.every((r) => r.ok));
  // The create rows are still exactly the two from before — batch added disable events, never re-created.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE event_type='create'").get().c, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE event_type='disable'").get().c, 2);
});

// ── GLOBAL SEARCH ───────────────────────────────────────────────────────────

function seedSearch(db) {
  const exec = (sql, params) => db.prepare(sql).run(...params);
  exec("INSERT INTO customers (id, name, email, created_at, updated_at, status, external_ref) VALUES (?,?,?,?,?,?,?)",
    ["cus_acme", "Acme Co", "ops@acme.example", NOW - 1000, NOW - 1000, "active", "crm-7788"]);
  exec("INSERT INTO customers (id, name, email, created_at, updated_at, status, external_ref) VALUES (?,?,?,?,?,?,?)",
    ["cus_beta", "Beta LLC", "beta@beta.example", NOW - 900, NOW - 900, "active", "crm-0001"]);
  exec("INSERT INTO licenses (id, customer_id, project, label, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ["lic_acme_primary", "cus_acme", "DEFAULT", "Acme primary seat", NOW - 800, NOW - 800]);
  exec("INSERT INTO orders (subscription_id, project, feature, license_fingerprint, customer_id, last_seq, order_epoch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ["sub_acme_2024", "DEFAULT", "DEFAULT", FP_A, "cus_acme", 1, 1, NOW - 500, NOW - 100]);
}

test("search: fans out across customers / licenses / entitlements / orders", async () => {
  const db = freshDb();
  seedSearch(db);
  const env = devEnv(db);
  // Entitlement whose fingerprint shares a prefix with the search term below.
  await createEntitlementFor(env, FP_A);

  // "acme" hits the customer (name/id), the license (id/label), and the order (subscription_id).
  const res = await worker.fetch(devReq("/api/admin/search?q=acme"), env);
  assert.equal(res.status, 200);
  const results = (await body(res)).data.results;
  const types = new Set(results.map((r) => r.type));
  assert.ok(types.has("customer"), "customer match");
  assert.ok(types.has("license"), "license match");
  assert.ok(types.has("order"), "order match");
  const customer = results.find((r) => r.type === "customer");
  assert.equal(customer.id, "cus_acme");
  assert.equal(customer.label, "Acme Co");
  const license = results.find((r) => r.type === "license");
  assert.equal(license.id, "lic_acme_primary");
  const order = results.find((r) => r.type === "order");
  assert.equal(order.id, "sub_acme_2024");

  // external_ref ("crm-7788") is searchable on customers.
  const byRef = await worker.fetch(devReq("/api/admin/search?q=crm-7788"), env);
  const refResults = (await body(byRef)).data.results;
  assert.equal(refResults.filter((r) => r.type === "customer").length, 1);
  assert.equal(refResults.find((r) => r.type === "customer").id, "cus_acme");
});

test("search: entitlement license_fingerprint is a PREFIX match with a deep-linkable encoded id", async () => {
  const db = freshDb();
  seedSearch(db);
  const env = devEnv(db);
  await createEntitlementFor(env, FP_A); // "aaaa..."
  await createEntitlementFor(env, FP_B); // "bbbb..."

  // A prefix of FP_A matches only FP_A's entitlement (prefix, not contains).
  const res = await worker.fetch(devReq(`/api/admin/search?q=${"a".repeat(10)}`), env);
  assert.equal(res.status, 200);
  const ents = (await body(res)).data.results.filter((r) => r.type === "entitlement");
  assert.equal(ents.length, 1);
  assert.equal(ents[0].id, entitlementId("DEFAULT", "DEFAULT", FP_A));
  assert.equal(ents[0].label, FP_A);

  // A middle substring of the fingerprint does NOT prefix-match.
  const mid = await worker.fetch(devReq("/api/admin/search?q=bbbbbb"), env);
  const midEnts = (await body(mid)).data.results.filter((r) => r.type === "entitlement");
  assert.equal(midEnts.length, 1, "bbbbbb is a prefix of FP_B");
  // But a term that is only an interior fragment of every fingerprint matches none by prefix.
  const interior = await worker.fetch(devReq(`/api/admin/search?q=${"a".repeat(64)}z`), env);
  assert.equal((await body(interior)).data.results.filter((r) => r.type === "entitlement").length, 0);
});

test("search: empty or over-long q is 400 invalid_request; reader is allowed", async (t) => {
  const db = freshDb();
  seedSearch(db);

  const env = devEnv(db);
  assert.equal((await worker.fetch(devReq("/api/admin/search?q="), env)).status, 400);
  assert.equal((await worker.fetch(devReq("/api/admin/search"), env)).status, 400);
  const tooLong = await worker.fetch(devReq(`/api/admin/search?q=${"x".repeat(129)}`), env);
  assert.equal(tooLong.status, 400);
  assert.equal((await body(tooLong)).code, "invalid_request");

  // Reader (read-only role) CAN search.
  const fixture = await accessFixture(t);
  const accEnv = accessEnv(db, fixture);
  const reader = await accessToken(fixture, "reader@example.com");
  const res = await worker.fetch(accessReq("/api/admin/search?q=acme", reader), accEnv);
  assert.equal(res.status, 200);
  assert.equal((await body(res)).code, "search_results");
});

// ── CSV EXPORT ──────────────────────────────────────────────────────────────

function parseCsv(text) {
  // Minimal RFC-4180-ish parser sufficient for the quoted fields this worker emits.
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\r") {
      // skip; handled by \n
    } else if (ch === "\n") {
      row.push(field); field = ""; rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

test("csv: entitlements ?format=csv streams a text/csv attachment with the SAME filters", async () => {
  const db = freshDb();
  const env = devEnv(db);
  await createEntitlementFor(env, FP_A, { project: "DEFAULT" });
  await createEntitlementFor(env, FP_B, { project: "DEFAULT" });

  const res = await worker.fetch(devReq("/api/admin/entitlements?format=csv"), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="entitlements\.csv"/);
  const rows = parseCsv(await res.text());
  assert.deepEqual(rows[0], ["id", "project", "feature", "license_fingerprint", "device_hash", "status", "assertion_ttl_seconds", "revocation_seq", "valid_from", "valid_until", "notes", "customer_id", "license_id", "created_at", "updated_at"]);
  const fpCol = rows[0].indexOf("license_fingerprint");
  const fps = rows.slice(1).map((r) => r[fpCol]);
  assert.ok(fps.includes(FP_A) && fps.includes(FP_B));

  // The SAME status filter applies: disable FP_A, then csv with status=disabled returns only it.
  const aId = entitlementId("DEFAULT", "DEFAULT", FP_A);
  await worker.fetch(devReq(`/api/admin/entitlements/${aId}/disable`, { method: "POST", body: JSON.stringify({ reason: "x" }) }), env);
  const filtered = await worker.fetch(devReq("/api/admin/entitlements?format=csv&status=disabled"), env);
  const filteredRows = parseCsv(await filtered.text());
  const filteredFps = filteredRows.slice(1).map((r) => r[fpCol]);
  assert.deepEqual(filteredFps, [FP_A]);
});

test("csv: fields are escaped (quote + double-quote) so commas/quotes/newlines stay inert", async () => {
  const db = freshDb();
  const env = devEnv(db);
  // notes carries a comma and an embedded double-quote; both must survive a round trip.
  await createEntitlementFor(env, FP_A, { notes: 'a "tricky", note' });

  const res = await worker.fetch(devReq("/api/admin/entitlements?format=csv"), env);
  const text = await res.text();
  // The raw CSV must contain the doubled-quote escaping for the embedded quote.
  assert.ok(text.includes('"a ""tricky"", note"'), `expected escaped notes in raw CSV, got: ${text}`);
  const rows = parseCsv(text);
  const notesCol = rows[0].indexOf("notes");
  const dataRow = rows.slice(1).find((r) => r[rows[0].indexOf("license_fingerprint")] === FP_A);
  assert.equal(dataRow[notesCol], 'a "tricky", note', "escaped notes round-trips intact");
});

test("csv: customers and events also export; events cap-comment shape", async () => {
  const db = freshDb();
  seedSearch(db);
  const env = devEnv(db);
  await createEntitlementFor(env, FP_A);

  const customers = await worker.fetch(devReq("/api/admin/customers?format=csv"), env);
  assert.equal(customers.status, 200);
  assert.match(customers.headers.get("content-disposition") ?? "", /filename="customers\.csv"/);
  const custRows = parseCsv(await customers.text());
  assert.deepEqual(custRows[0], ["id", "name", "email", "status", "external_ref", "entitlement_count", "active_entitlement_count", "created_at", "updated_at"]);
  assert.ok(custRows.slice(1).some((r) => r[0] === "cus_acme"));

  const events = await worker.fetch(devReq("/api/admin/events?format=csv"), env);
  assert.equal(events.status, 200);
  assert.match(events.headers.get("content-type") ?? "", /text\/csv/);
  const evRows = parseCsv(await events.text());
  assert.deepEqual(evRows[0], ["id", "project", "feature", "license_fingerprint", "event_type", "status", "revocation_seq", "actor", "actor_type", "source", "request_id", "reason", "detail", "created_at"]);
  // The single create event from the seeded entitlement is present.
  assert.ok(evRows.slice(1).some((r) => r[evRows[0].indexOf("event_type")] === "create"));
});
