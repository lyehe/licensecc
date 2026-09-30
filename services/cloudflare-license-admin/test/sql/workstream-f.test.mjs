// Workstream F — reports
// (real SQLite, end-to-end through worker.fetch). Mirrors policy-admin.test.mjs: the
// REAL compiled worker is driven over an in-memory SQLite built from the shared
// migrations/*.sql wrapped in a D1-like adapter — nothing about the analytics SQL is mocked.
//
// Covers:
//   timeseries  — only protected refusals and fulfillment events land in each bucket;
//                 an empty window returns zero-filled buckets; from >= to is 400.
//   expiring    — in-window vs out-of-window vs non-active vs no-valid_until; valid_until ASC
//                 ordering; days_left = ceil((valid_until-now)/86400); cursor pagination.
//   RBAC        — a reader can read both reports.
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
import { entitlementId } from "@licensecc/licensing-domain/entitlements/contracts";

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

// The row protected issuance records when it refuses a device because the grant's limit is reached.
function insertRefusal(db, fp, ts) {
  insertUsage(db, fp, "denied", ts, { deviceKeyId: "key", reason: "device_limit_reached" });
}

function insertOrderEvent(db, eventId, receivedAt, status = "accepted") {
  db.prepare(
    `INSERT INTO order_events (event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, payload_digest, raw_payload, status, received_at)
     VALUES (?, 'sub_1', 'DEFAULT', 'DEFAULT', 0, 1, 'set', 'k1', 'd', '{}', ?, ?)`,
  ).run(eventId, status, receivedAt);
}

function insertEntitlement(db, fp, {
  status = "active", validUntil = null, customerId = null, now = 1000,
  isTrial = 0, trialBasis = "from_issue", trialDurationSec = 0, trialStartedAt = null,
} = {}) {
  db.prepare(
    `INSERT INTO entitlements (project, feature, license_fingerprint, status, valid_until, customer_id, is_trial, trial_expiration_basis, trial_duration_sec, trial_started_at, enforcement_mode, created_at, updated_at)
     VALUES ('DEFAULT','DEFAULT',?,?,?,?,?,?,?,?,'device_bound_v1',?,?)`,
  ).run(fp, status, validUntil, customerId, isTrial, trialBasis, trialDurationSec, trialStartedAt, now, now);
}

function insertCustomer(db, id, name, now = 1000) {
  db.prepare("INSERT INTO customers (id, name, email, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, name, "", now, now);
}

// ── Time-series ───────────────────────────────────────────────────────────────

test("timeseries: each bucket counts only protected refusals and fulfillment events", async () => {
  const db = freshDb();
  const env = devEnv(db);
  // A fixed, deterministic window: 4 buckets of 1000s each over [0, 4000).
  // Bucket 0 [0,1000): one protected refusal among seat checkouts and a seat-pool denial.
  insertUsage(db, FP_A, "checkout", 10);
  insertUsage(db, FP_A, "checkout", 500);
  insertUsage(db, FP_A, "denied", 600, { reason: "pool_exhausted" });
  insertRefusal(db, FP_A, 100);
  // Bucket 1 [1000,2000): seat releases only, so no refusal.
  insertUsage(db, FP_A, "release", 1200);
  insertUsage(db, FP_A, "reclaim", 1800);
  // Bucket 2 [2000,3000): two protected refusals.
  insertRefusal(db, FP_A, 2100);
  insertRefusal(db, FP_B, 2900);
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
  assert.deepEqual(data.buckets, [
    { start: 0, denials: 1, fulfillment_events: 1 },
    { start: 1000, denials: 0, fulfillment_events: 0 },
    { start: 2000, denials: 2, fulfillment_events: 2 },
    { start: 3000, denials: 0, fulfillment_events: 0 },
  ]);
});

test("timeseries: a row exactly at the upper edge is excluded; one just inside lands in the last bucket", async () => {
  const db = freshDb();
  const env = devEnv(db);
  // `to` is the exclusive upper edge: ts == to must NOT count.
  insertRefusal(db, FP_A, 4000); // == to -> excluded
  insertRefusal(db, FP_B, 3999); // last bucket
  const res = await worker.fetch(devReq("/api/admin/report/timeseries?from=0&to=4000&buckets=4"), env);
  const data = (await body(res)).data;
  // Only the 3999 refusal is in-window, and it must clamp into bucket 3 (never a phantom bucket 4).
  assert.equal(data.buckets.reduce((sum, b) => sum + b.denials, 0), 1);
  assert.equal(data.buckets[3].denials, 1);
});

test("timeseries: an empty window returns zero-filled buckets (default 24)", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const res = await worker.fetch(devReq("/api/admin/report/timeseries?from=0&to=2400"), env);
  assert.equal(res.status, 200);
  const data = (await body(res)).data;
  assert.equal(data.buckets.length, 24, "default bucket count");
  assert.equal(data.bucket_seconds, 100);
  for (const [index, bucket] of data.buckets.entries()) {
    assert.deepEqual(bucket, { start: index * 100, denials: 0, fulfillment_events: 0 });
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

test("expiring: each row carries the entitlement's canonical id and, when a customer is set, its name", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  insertCustomer(db, "cus_a", "Acme Co", now);
  insertEntitlement(db, FP_A, { validUntil: now + 5 * DAY, customerId: "cus_a", now });
  insertEntitlement(db, FP_B, { validUntil: now + 6 * DAY, customerId: null, now });

  const data = (await body(await worker.fetch(devReq("/api/admin/report/expiring"), env))).data;
  assert.equal(data.items.length, 2);
  const withCustomer = data.items.find((item) => item.license_fingerprint === FP_A);
  const withoutCustomer = data.items.find((item) => item.license_fingerprint === FP_B);
  assert.equal(withCustomer.id, entitlementId("DEFAULT", "DEFAULT", FP_A));
  assert.equal(withCustomer.customer_name, "Acme Co");
  assert.equal(withoutCustomer.id, entitlementId("DEFAULT", "DEFAULT", FP_B));
  assert.equal(withoutCustomer.customer_id, null);
  assert.equal(withoutCustomer.customer_name, null);
});

test("expiring: an activated activation-basis trial is included via its trial deadline; one not yet activated is excluded", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  // Activated: trial_started_at + trial_duration_sec falls inside the horizon even though
  // valid_until was never stamped (the clock started at first activation, not at issue).
  insertEntitlement(db, FP_A, {
    validUntil: null, now,
    isTrial: 1, trialBasis: "from_first_activation", trialDurationSec: 5 * DAY, trialStartedAt: now,
  });
  // Not yet activated: no known deadline yet, so it cannot be "expiring soon".
  insertEntitlement(db, FP_B, {
    validUntil: null, now,
    isTrial: 1, trialBasis: "from_first_activation", trialDurationSec: 5 * DAY, trialStartedAt: null,
  });
  // from_issue trial: unchanged behavior, still keyed off the stamped valid_until.
  insertEntitlement(db, FP_C, {
    validUntil: now + 2 * DAY, now,
    isTrial: 1, trialBasis: "from_issue", trialDurationSec: 2 * DAY,
  });

  const data = (await body(await worker.fetch(devReq("/api/admin/report/expiring"), env))).data;
  assert.deepEqual(data.items.map((item) => item.license_fingerprint).sort(), [FP_A, FP_C].sort());
  const activated = data.items.find((item) => item.license_fingerprint === FP_A);
  assert.equal(activated.days_left, 5);
  assert.equal(activated.valid_until, now + 5 * DAY);
});

// A policy may stamp an explicit valid_until on an activation-basis trial before its clock has
// started. The grant still stops at valid_until whatever the trial clock later does, so the report
// must list it by that date; an unknown trial deadline must never hide the known one.
test("expiring: an unstarted activation-basis trial is listed by its stamped valid_until", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  // No first activation yet, but the license itself ends in 2 days.
  insertEntitlement(db, FP_A, {
    validUntil: now + 2 * DAY, now,
    isTrial: 1, trialBasis: "from_first_activation", trialDurationSec: 20 * DAY, trialStartedAt: null,
  });
  // The same shape for a first-use trial.
  insertEntitlement(db, FP_B, {
    validUntil: now + 3 * DAY, now,
    isTrial: 1, trialBasis: "from_first_use", trialDurationSec: 20 * DAY, trialStartedAt: null,
  });
  // Unstarted and without any valid_until: still no known deadline, so still not expiring soon.
  insertEntitlement(db, FP_C, {
    validUntil: null, now,
    isTrial: 1, trialBasis: "from_first_activation", trialDurationSec: 2 * DAY, trialStartedAt: null,
  });

  const data = (await body(await worker.fetch(devReq("/api/admin/report/expiring"), env))).data;
  assert.deepEqual(data.items.map((item) => item.license_fingerprint), [FP_A, FP_B]);
  const activation = data.items.find((item) => item.license_fingerprint === FP_A);
  assert.equal(activation.valid_until, now + 2 * DAY);
  assert.equal(activation.days_left, 2);
  const firstUse = data.items.find((item) => item.license_fingerprint === FP_B);
  assert.equal(firstUse.valid_until, now + 3 * DAY);
  assert.equal(firstUse.days_left, 3);
});

// An operator can set valid_until on a trial grant; every enforcing path (the protected-device store,
// the portal's self-service list) then clamps the trial clock to it, since a trial never outlives its
// license. The report must use the same min(valid_until, trial deadline)
// clamp, not the trial deadline alone, or it shows the wrong date (or a wrong inclusion/exclusion).
test("expiring: an activated trial clamps to an EARLIER valid_until, exactly like the enforcing rules", async () => {
  const db = freshDb();
  const env = devEnv(db);
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  // Trial clock would end in 20 days, but the operator's valid_until is only 2 days out: the earlier
  // date must win, and the row must appear at day 2 (not day 20).
  insertEntitlement(db, FP_A, {
    validUntil: now + 2 * DAY, now,
    isTrial: 1, trialBasis: "from_first_activation", trialDurationSec: 20 * DAY, trialStartedAt: now,
  });
  // Same shape, but the operator's valid_until is already in the past: the row is fully expired by
  // the license itself and must be excluded even though the trial clock alone still has 20 days left.
  insertEntitlement(db, FP_B, {
    validUntil: now - DAY, now,
    isTrial: 1, trialBasis: "from_first_activation", trialDurationSec: 20 * DAY, trialStartedAt: now,
  });
  // A trial clock that ends BEFORE valid_until: the earlier trial deadline wins instead.
  insertEntitlement(db, FP_C, {
    validUntil: now + 20 * DAY, now,
    isTrial: 1, trialBasis: "from_first_use", trialDurationSec: 3 * DAY, trialStartedAt: now,
  });

  const data = (await body(await worker.fetch(devReq("/api/admin/report/expiring"), env))).data;
  assert.deepEqual(data.items.map((item) => item.license_fingerprint).sort(), [FP_A, FP_C].sort());
  const validUntilClamped = data.items.find((item) => item.license_fingerprint === FP_A);
  assert.equal(validUntilClamped.valid_until, now + 2 * DAY, "the earlier valid_until wins over the later trial clock");
  assert.equal(validUntilClamped.days_left, 2);
  const trialClamped = data.items.find((item) => item.license_fingerprint === FP_C);
  assert.equal(trialClamped.valid_until, now + 3 * DAY, "the earlier trial clock wins over the later valid_until");
  assert.equal(trialClamped.days_left, 3);
});

// ── Reader access ─────────────────────────────────────────────────────────────

test("reports: a reader can read the timeseries and expiring reports", async (t) => {
  const db = freshDb();
  const fixture = await accessFixture(t);
  const env = accessEnv(db, fixture);
  const reader = await accessToken(fixture, "reader@example.com");
  const now = Math.floor(Date.now() / 1000);
  insertEntitlement(db, FP_A, { validUntil: now + 5 * 86400, now });

  assert.equal((await worker.fetch(accessReq("/api/admin/report/timeseries", reader), env)).status, 200);
  const expiring = await worker.fetch(accessReq("/api/admin/report/expiring", reader), env);
  assert.equal(expiring.status, 200);
  assert.deepEqual((await body(expiring)).data.items.map((item) => item.license_fingerprint), [FP_A]);
});
