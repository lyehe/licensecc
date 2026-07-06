// Workstream F — usage-analytics reports + the stuck-seat force-release lever
// (real SQLite, end-to-end through worker.fetch). Mirrors policy-admin.test.mjs: the
// REAL compiled worker is driven over an in-memory SQLite built from the shared
// migrations/*.sql wrapped in a D1-like adapter — nothing about the analytics SQL is mocked.
//
// Covers:
//   timeseries  — events land in the right bucket; denial_rate math; fulfillment_events;
//                 an empty window returns zero-filled buckets; from >= to is 400.
//   expiring    — in-window vs out-of-window vs non-active vs no-valid_until; valid_until ASC
//                 ordering; days_left = ceil((valid_until-now)/86400); cursor pagination.
//   force-release — reclaims ONLY live seats (heartbeat_deadline > now); writes one 'reclaim'
//                 usage_events row per seat (reason='force_release'); idempotent 0-release;
//                 reader RBAC is blocked (admin-only); reason is required.
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
import { entitlementId } from "@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation";
import { forceReleaseLiveSeats } from "@licensecc/cloudflare-licensing-backend/lease/seat_reclaim";

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

// --- Seed helpers ------------------------------------------------------------
function insertUsage(db, fp, eventType, ts, { seatId = null, deviceKeyId = null, reason = null } = {}) {
  db.prepare(
    "INSERT INTO usage_events (project, feature, license_fingerprint, event_type, seat_id, device_key_id, reason, ts) VALUES ('DEFAULT','DEFAULT',?,?,?,?,?,?)",
  ).run(fp, eventType, seatId, deviceKeyId, reason, ts);
}

function insertOrderEvent(db, eventId, receivedAt, status = "accepted") {
  db.prepare(
    `INSERT INTO order_events (event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, payload_digest, raw_payload, status, received_at)
     VALUES (?, 'sub_1', 'DEFAULT', 'DEFAULT', 0, 1, 'set', 'k1', 'd', '{}', ?, ?)`,
  ).run(eventId, status, receivedAt);
}

function insertEntitlement(db, fp, { status = "active", validUntil = null, customerId = null, now = 1000 } = {}) {
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, status, valid_until, customer_id, created_at, updated_at) VALUES ('DEFAULT','DEFAULT',?,?,?,?,?,?)",
  ).run(fp, status, validUntil, customerId, now, now);
}

function insertSeat(db, fp, seatId, heartbeatDeadline, { mode = "live", now = 1000 } = {}) {
  db.prepare(
    "INSERT INTO seat_checkouts (project, feature, license_fingerprint, seat_id, client_instance_id, mode, checked_out_at, heartbeat_deadline) VALUES ('DEFAULT','DEFAULT',?,?,?,?,?,?)",
  ).run(fp, seatId, `inst_${seatId}`, mode, now, heartbeatDeadline);
}

// ── Time-series ───────────────────────────────────────────────────────────────

test("timeseries: events land in the right bucket with correct denial_rate math", async () => {
  const db = freshDb();
  const env = devEnv(db);
  // A fixed, deterministic window: 4 buckets of 1000s each over [0, 4000).
  // Bucket 0 [0,1000): 3 checkouts, 1 denial -> denial_rate 1/4 = 0.25
  insertUsage(db, FP_A, "checkout", 10);
  insertUsage(db, FP_A, "checkout", 500);
  insertUsage(db, FP_A, "checkout", 999);
  insertUsage(db, FP_A, "denied", 100);
  // Bucket 1 [1000,2000): 1 release + 1 reclaim -> releases=2, no attempts -> denial_rate 0
  insertUsage(db, FP_A, "release", 1200);
  insertUsage(db, FP_A, "reclaim", 1800);
  // Bucket 2 [2000,3000): 2 denials, 0 checkouts -> denial_rate 2/2 = 1.0
  insertUsage(db, FP_A, "denied", 2100);
  insertUsage(db, FP_A, "denied", 2900);
  // Bucket 3 [3000,4000): empty
  // Fulfillment events: 1 in bucket 0, 2 in bucket 2.
  insertOrderEvent(db, "oe1", 50);
  insertOrderEvent(db, "oe2", 2200);
  insertOrderEvent(db, "oe3", 2800);

  const res = await worker.fetch(devReq("/api/admin/report/timeseries?from=0&to=4000&buckets=4"), env);
  assert.equal(res.status, 200, await res.clone().text());
  const data = (await body(res)).data;
  assert.equal(data.from, 0);
  assert.equal(data.to, 4000);
  assert.equal(data.bucket_seconds, 1000);
  assert.equal(data.buckets.length, 4);

  assert.deepEqual(data.buckets[0], { start: 0, checkouts: 3, releases: 0, denials: 1, denial_rate: 0.25, fulfillment_events: 1 });
  assert.deepEqual(data.buckets[1], { start: 1000, checkouts: 0, releases: 2, denials: 0, denial_rate: 0, fulfillment_events: 0 });
  assert.deepEqual(data.buckets[2], { start: 2000, checkouts: 0, releases: 0, denials: 2, denial_rate: 1, fulfillment_events: 2 });
  assert.deepEqual(data.buckets[3], { start: 3000, checkouts: 0, releases: 0, denials: 0, denial_rate: 0, fulfillment_events: 0 });
});

test("timeseries: a row exactly at the upper edge is excluded; one just inside lands in the last bucket", async () => {
  const db = freshDb();
  const env = devEnv(db);
  // `to` is the exclusive upper edge: ts == to must NOT count.
  insertUsage(db, FP_A, "checkout", 4000); // == to -> excluded
  insertUsage(db, FP_A, "checkout", 3999); // last bucket
  const res = await worker.fetch(devReq("/api/admin/report/timeseries?from=0&to=4000&buckets=4"), env);
  const data = (await body(res)).data;
  // Only the 3999 checkout is in-window, and it must clamp into bucket 3 (never a phantom bucket 4).
  assert.equal(data.buckets.reduce((sum, b) => sum + b.checkouts, 0), 1);
  assert.equal(data.buckets[3].checkouts, 1);
});

test("timeseries: an empty window returns zero-filled buckets (default 24)", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const res = await worker.fetch(devReq("/api/admin/report/timeseries?from=0&to=2400"), env);
  assert.equal(res.status, 200);
  const data = (await body(res)).data;
  assert.equal(data.buckets.length, 24, "default bucket count");
  assert.equal(data.bucket_seconds, 100);
  for (const bucket of data.buckets) {
    assert.deepEqual(
      { checkouts: bucket.checkouts, releases: bucket.releases, denials: bucket.denials, denial_rate: bucket.denial_rate, fulfillment_events: bucket.fulfillment_events },
      { checkouts: 0, releases: 0, denials: 0, denial_rate: 0, fulfillment_events: 0 },
    );
  }
});

test("timeseries: a non-positive window (from >= to) is 400 invalid_request", async () => {
  const db = freshDb();
  const env = devEnv(db);
  for (const qs of ["from=4000&to=4000", "from=5000&to=4000"]) {
    const res = await worker.fetch(devReq(`/api/admin/report/timeseries?${qs}`), env);
    assert.equal(res.status, 400, qs);
    assert.equal((await body(res)).code, "invalid_request");
  }
});

test("timeseries: buckets is clamped to [1,200]; a falsy/unparseable value falls back to the default", async () => {
  const db = freshDb();
  const env = devEnv(db);
  // Over the ceiling clamps to 200.
  assert.equal((await body(await worker.fetch(devReq("/api/admin/report/timeseries?from=0&to=4000&buckets=9999"), env))).data.buckets.length, 200);
  // A negative value clamps up to the floor of 1.
  assert.equal((await body(await worker.fetch(devReq("/api/admin/report/timeseries?from=0&to=4000&buckets=-5"), env))).data.buckets.length, 1);
  // buckets=1 is the explicit single-bucket case.
  assert.equal((await body(await worker.fetch(devReq("/api/admin/report/timeseries?from=0&to=4000&buckets=1"), env))).data.buckets.length, 1);
  // A falsy/unparseable value (0, blank, NaN) falls back to the default 24 — the repo's
  // `Number(x) || default` idiom (matches limit/cursor/within_days handling).
  assert.equal((await body(await worker.fetch(devReq("/api/admin/report/timeseries?from=0&to=4000&buckets=0"), env))).data.buckets.length, 24);
  assert.equal((await body(await worker.fetch(devReq("/api/admin/report/timeseries?from=0&to=4000&buckets=abc"), env))).data.buckets.length, 24);
});

test("timeseries: the default window is the last 7 days ending now", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const res = await worker.fetch(devReq("/api/admin/report/timeseries"), env);
  const data = (await body(res)).data;
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(data.to - now) <= 5, "to ~ now");
  assert.equal(data.to - data.from, 604800, "7-day default window");
});

// ── Expiring ──────────────────────────────────────────────────────────────────

test("expiring: in-window vs out-of-window vs non-active vs no-valid_until; ordering + days_left", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  // In-window (within 30d): expires in ~5d and ~20d.
  insertEntitlement(db, FP_A, { validUntil: now + 5 * DAY, customerId: "cus_a", now });
  insertEntitlement(db, FP_B, { validUntil: now + 20 * DAY, customerId: "cus_b", now });
  // Out-of-window: expires in ~100d (beyond 30d horizon).
  insertEntitlement(db, FP_C, { validUntil: now + 100 * DAY, now });
  // Already expired (valid_until in the past) — excluded (valid_until > now is required).
  insertEntitlement(db, "d".repeat(64), { validUntil: now - DAY, now });
  // Non-active (disabled) but in-window — excluded.
  insertEntitlement(db, "e".repeat(64), { status: "disabled", validUntil: now + 3 * DAY, now });
  // Active in-window but NULL valid_until (non-expiring) — excluded.
  insertEntitlement(db, "f".repeat(64), { validUntil: null, now });

  const res = await worker.fetch(devReq("/api/admin/report/expiring"), env);
  assert.equal(res.status, 200);
  const data = (await body(res)).data;
  assert.equal(data.items.length, 2, "only the two active, in-window, finite-expiry rows");
  // Ordered valid_until ASC: FP_A (5d) before FP_B (20d).
  assert.equal(data.items[0].license_fingerprint, FP_A);
  assert.equal(data.items[1].license_fingerprint, FP_B);
  assert.equal(data.items[0].customer_id, "cus_a");
  // days_left = ceil((valid_until - now)/86400). The +5*DAY row reports exactly 5.
  assert.equal(data.items[0].days_left, 5);
  assert.equal(data.items[1].days_left, 20);
  assert.equal(data.items[0].valid_until, now + 5 * DAY);
});

test("expiring: within_days narrows the horizon and is clamped to [1,365]", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  insertEntitlement(db, FP_A, { validUntil: now + 3 * DAY, now });
  insertEntitlement(db, FP_B, { validUntil: now + 50 * DAY, now });

  // within_days=7 includes only FP_A.
  assert.equal((await body(await worker.fetch(devReq("/api/admin/report/expiring?within_days=7"), env))).data.items.length, 1);
  // within_days=60 includes both.
  assert.equal((await body(await worker.fetch(devReq("/api/admin/report/expiring?within_days=60"), env))).data.items.length, 2);
  // within_days=99999 clamps to 365 (still both, since 50d < 365d).
  assert.equal((await body(await worker.fetch(devReq("/api/admin/report/expiring?within_days=99999"), env))).data.items.length, 2);
});

test("expiring: days_left rounds UP so a sub-day expiry never reports 0", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const now = Math.floor(Date.now() / 1000);
  insertEntitlement(db, FP_A, { validUntil: now + 3600, now }); // 1 hour out
  const data = (await body(await worker.fetch(devReq("/api/admin/report/expiring"), env))).data;
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].days_left, 1, "ceil of <1 day is 1, never 0");
});

test("expiring: cursor pagination over valid_until ASC", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  for (let i = 0; i < 3; ++i) {
    insertEntitlement(db, String(i).repeat(64), { validUntil: now + (i + 1) * DAY, now });
  }
  const page1 = (await body(await worker.fetch(devReq("/api/admin/report/expiring?limit=2"), env))).data;
  assert.equal(page1.items.length, 2);
  assert.equal(page1.next_cursor, "2");
  assert.equal(page1.items[0].days_left, 1);
  assert.equal(page1.items[1].days_left, 2);
  const page2 = (await body(await worker.fetch(devReq("/api/admin/report/expiring?limit=2&cursor=2"), env))).data;
  assert.equal(page2.items.length, 1);
  assert.equal(page2.next_cursor, null);
  assert.equal(page2.items[0].days_left, 3);
});

// ── Force-release ───────────────────────────────────────────────────────────────

test("force-release helper: reclaims live seats and emits balanced reclaim events", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const now = Math.floor(Date.now() / 1000);
  insertEntitlement(db, FP_A, { now });
  insertSeat(db, FP_A, "seat_live_2", now + 1200, { now });
  insertSeat(db, FP_A, "seat_live_1", now + 600, { now });
  insertSeat(db, FP_A, "seat_dead", now - 60, { now });

  const result = await forceReleaseLiveSeats(
    env,
    { project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP_A },
    now,
  );
  assert.deepEqual(result, { released: 2, seat_ids: ["seat_live_1", "seat_live_2"] });
  assert.deepEqual(
    db.prepare("SELECT seat_id FROM seat_checkouts WHERE license_fingerprint=? ORDER BY seat_id").all(FP_A).map((row) => row.seat_id),
    ["seat_dead"],
  );
  assert.deepEqual(
    db.prepare("SELECT seat_id, event_type, reason FROM usage_events WHERE license_fingerprint=? ORDER BY seat_id")
      .all(FP_A)
      .map((row) => ({ seat_id: row.seat_id, event_type: row.event_type, reason: row.reason })),
    [
      { seat_id: "seat_live_1", event_type: "reclaim", reason: "force_release" },
      { seat_id: "seat_live_2", event_type: "reclaim", reason: "force_release" },
    ],
  );
});

test("force-release: reclaims ONLY live seats and writes a 'reclaim' usage_events row per seat", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const now = Math.floor(Date.now() / 1000);
  insertEntitlement(db, FP_A, { now });
  // Two LIVE seats (deadline in the future) + one DEAD seat (deadline in the past).
  insertSeat(db, FP_A, "seat_live_1", now + 600, { now });
  insertSeat(db, FP_A, "seat_live_2", now + 1200, { now });
  insertSeat(db, FP_A, "seat_dead", now - 60, { now });
  // A seat on a DIFFERENT entitlement must be untouched.
  insertEntitlement(db, FP_B, { now });
  insertSeat(db, FP_B, "other_live", now + 600, { now });

  const id = entitlementId("DEFAULT", "DEFAULT", FP_A);
  const res = await worker.fetch(devReq(`/api/admin/entitlements/${id}/release-seats`, {
    method: "POST",
    body: JSON.stringify({ reason: "dead machine" }),
  }), env);
  assert.equal(res.status, 200, await res.clone().text());
  const data = (await body(res)).data;
  assert.equal(data.released, 2);
  assert.deepEqual(data.seat_ids, ["seat_live_1", "seat_live_2"]);

  // The two live seats were deleted; the dead seat row remains (only LIVE seats are swept).
  const remaining = db.prepare("SELECT seat_id FROM seat_checkouts WHERE license_fingerprint=? ORDER BY seat_id").all(FP_A);
  assert.deepEqual(remaining.map((r) => r.seat_id), ["seat_dead"]);
  // The other entitlement's seat is untouched.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM seat_checkouts WHERE license_fingerprint=?").get(FP_B).c, 1);

  // One 'reclaim' usage_events row per reclaimed seat, reason='force_release', device_key_id NULL.
  const reclaims = db.prepare(
    "SELECT seat_id, event_type, reason, device_key_id FROM usage_events WHERE license_fingerprint=? ORDER BY seat_id",
  ).all(FP_A);
  assert.equal(reclaims.length, 2);
  for (const row of reclaims) {
    assert.equal(row.event_type, "reclaim");
    assert.equal(row.reason, "force_release");
    assert.equal(row.device_key_id, null);
  }
  assert.deepEqual(reclaims.map((r) => r.seat_id), ["seat_live_1", "seat_live_2"]);
});

test("force-release: 0 released is a valid idempotent {ok:true}", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const now = Math.floor(Date.now() / 1000);
  insertEntitlement(db, FP_A, { now });
  // Only a DEAD seat exists -> nothing live to reclaim.
  insertSeat(db, FP_A, "seat_dead", now - 60, { now });

  const id = entitlementId("DEFAULT", "DEFAULT", FP_A);
  const res = await worker.fetch(devReq(`/api/admin/entitlements/${id}/release-seats`, {
    method: "POST",
    body: JSON.stringify({ reason: "sweep" }),
  }), env);
  assert.equal(res.status, 200);
  const data = (await body(res)).data;
  assert.equal(data.released, 0);
  assert.deepEqual(data.seat_ids, []);
  // No reclaim rows written when nothing was live.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM usage_events WHERE license_fingerprint=?").get(FP_A).c, 0);
});

test("force-release: replaying the same Idempotency-Key returns the cached result, no double reclaim", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const now = Math.floor(Date.now() / 1000);
  insertEntitlement(db, FP_A, { now });
  insertSeat(db, FP_A, "seat_live_1", now + 600, { now });

  const id = entitlementId("DEFAULT", "DEFAULT", FP_A);
  const headers = { "idempotency-key": "force-1" };
  const first = await worker.fetch(devReq(`/api/admin/entitlements/${id}/release-seats`, { method: "POST", headers, body: JSON.stringify({ reason: "x" }) }), env);
  assert.equal((await body(first)).data.released, 1);

  const second = await worker.fetch(devReq(`/api/admin/entitlements/${id}/release-seats`, { method: "POST", headers, body: JSON.stringify({ reason: "x" }) }), env);
  assert.equal(second.headers.get("x-idempotent-replay"), "1");
  assert.equal((await body(second)).data.released, 1, "replayed cached result, not a fresh 0-release");
  // Exactly one reclaim row — the replay never re-ran the mutation.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM usage_events WHERE license_fingerprint=?").get(FP_A).c, 1);
});

test("force-release: reason is required (400 reason_required)", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const now = Math.floor(Date.now() / 1000);
  insertEntitlement(db, FP_A, { now });
  insertSeat(db, FP_A, "seat_live_1", now + 600, { now });
  const id = entitlementId("DEFAULT", "DEFAULT", FP_A);
  for (const payload of ["{}", JSON.stringify({ reason: "" })]) {
    const res = await worker.fetch(devReq(`/api/admin/entitlements/${id}/release-seats`, { method: "POST", body: payload }), env);
    assert.equal(res.status, 400, payload);
    assert.equal((await body(res)).code, "reason_required");
  }
  // No seat was reclaimed by a rejected request.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM seat_checkouts WHERE license_fingerprint=?").get(FP_A).c, 1);
});

test("force-release: a malformed entitlement id is 400 invalid_entitlement_id", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const res = await worker.fetch(devReq("/api/admin/entitlements/!!!notbase64!!!/release-seats", { method: "POST", body: JSON.stringify({ reason: "x" }) }), env);
  assert.equal(res.status, 400);
  assert.equal((await body(res)).code, "invalid_entitlement_id");
});

test("force-release: reader RBAC is blocked; reports + reads stay reader+admin", async (t) => {
  const db = freshDb();
  const fixture = await accessFixture(t);
  const env = accessEnv(db, fixture);
  const admin = await accessToken(fixture, "admin@example.com");
  const reader = await accessToken(fixture, "reader@example.com");
  const now = Math.floor(Date.now() / 1000);
  insertEntitlement(db, FP_A, { validUntil: now + 5 * 86400, now });
  insertSeat(db, FP_A, "seat_live_1", now + 600, { now });
  const id = entitlementId("DEFAULT", "DEFAULT", FP_A);

  // Reader CAN read both reports.
  assert.equal((await worker.fetch(accessReq("/api/admin/report/timeseries", reader), env)).status, 200);
  assert.equal((await worker.fetch(accessReq("/api/admin/report/expiring", reader), env)).status, 200);

  // Reader CANNOT force-release (admin-only WRITE).
  const denied = await worker.fetch(accessReq(`/api/admin/entitlements/${id}/release-seats`, reader, { method: "POST", body: JSON.stringify({ reason: "x" }) }), env);
  assert.equal(denied.status, 403);
  assert.equal((await body(denied)).code, "admin_role_required");
  // The reader's denied write changed nothing.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM seat_checkouts WHERE license_fingerprint=?").get(FP_A).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM usage_events WHERE license_fingerprint=?").get(FP_A).c, 0);

  // Admin CAN force-release.
  const allowed = await worker.fetch(accessReq(`/api/admin/entitlements/${id}/release-seats`, admin, { method: "POST", body: JSON.stringify({ reason: "ok" }) }), env);
  assert.equal(allowed.status, 200);
  assert.equal((await body(allowed)).data.released, 1);
});
