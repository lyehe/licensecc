// GET /api/admin/events filters, cursor, and CSV export (real SQLite,
// end-to-end through worker.fetch). Mirrors workstream-c.test.mjs / workstream-f.test.mjs: the
// REAL compiled worker is driven over an in-memory SQLite built from the shared migrations/*.sql
// wrapped in a D1-like adapter -- nothing about the events SQL is mocked.
//
// Covers:
//   filters     — project, feature, entitlement_id (decoded to project/feature/license_fingerprint),
//                 event_type, actor, since/until (inclusive range); a malformed entitlement_id or
//                 since/until returns 400 before touching D1.
//   cursor      — keyset pagination on (created_at DESC, id DESC): several rows sharing the same
//                 created_at page forward with no duplicate and no missing row; a malformed cursor
//                 (a plain digit, the old offset shape) returns 400.
//   csv export  — ?format=csv applies the SAME filters as the JSON list.
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

function devEnv(db, extra = {}) {
  return {
    DB: new D1Like(db),
    ENVIRONMENT: "development",
    ADMIN_DEV_BEARER_ENABLED: "1",
    ADMIN_DEV_BEARER: "dev-secret",
    ...extra,
  };
}

function devReq(path, options = {}) {
  return new Request(`https://admin.example${path}`, {
    ...options,
    headers: { authorization: "Bearer dev-secret", "content-type": "application/json", ...(options.headers ?? {}) },
  });
}

async function body(response) {
  return response.json();
}

// --- Seed helper: writes an entitlement_events row directly, id and created_at fully controlled
// so cursor/tie-break behavior can be asserted precisely without driving real mutations. ---
function insertEvent(db, id, {
  project = "DEFAULT", feature = "DEFAULT", fp = FP_A, eventType = "update", status = "active",
  actor = "admin@example.com", actorType = "access", reason = "", createdAt = 1000, revocationSeq = 1,
} = {}) {
  db.prepare(
    `INSERT INTO entitlement_events
       (id, project, feature, license_fingerprint, event_type, status, revocation_seq, actor, actor_type, source, request_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', 'req', ?, ?)`,
  ).run(id, project, feature, fp, eventType, status, revocationSeq, actor, actorType, reason, createdAt);
}

function ids(list) {
  return list.map((item) => item.id);
}

// ── Filters ───────────────────────────────────────────────────────────────────

test("events: filters by project and by feature", async () => {
  const db = freshDb();
  const env = devEnv(db);
  insertEvent(db, 1, { project: "APP_A", createdAt: 100 });
  insertEvent(db, 2, { project: "APP_B", createdAt: 101 });
  insertEvent(db, 3, { project: "APP_A", feature: "pro", createdAt: 102 });

  let res = await worker.fetch(devReq("/api/admin/events?project=APP_A"), env);
  assert.equal(res.status, 200);
  assert.deepEqual(ids((await body(res)).data.items), [3, 1]);

  res = await worker.fetch(devReq("/api/admin/events?project=APP_A&feature=pro"), env);
  assert.deepEqual(ids((await body(res)).data.items), [3]);

  res = await worker.fetch(devReq("/api/admin/events?project=APP_C"), env);
  assert.deepEqual((await body(res)).data.items, []);
});

test("events: filters by entitlement_id, decoded to the exact project/feature/license_fingerprint", async () => {
  const db = freshDb();
  const env = devEnv(db);
  insertEvent(db, 1, { project: "DEFAULT", feature: "pro", fp: FP_A, createdAt: 100 });
  insertEvent(db, 2, { project: "DEFAULT", feature: "pro", fp: FP_B, createdAt: 101 });
  insertEvent(db, 3, { project: "OTHER", feature: "pro", fp: FP_A, createdAt: 102 });
  const targetId = entitlementId("DEFAULT", "pro", FP_A);

  const res = await worker.fetch(devReq(`/api/admin/events?entitlement_id=${encodeURIComponent(targetId)}`), env);
  assert.equal(res.status, 200);
  assert.deepEqual(ids((await body(res)).data.items), [1]);

  const invalid = await worker.fetch(devReq("/api/admin/events?entitlement_id=not-a-real-id"), env);
  assert.equal(invalid.status, 400);
  assert.equal((await body(invalid)).code, "invalid_request");
});

test("events: filters by event_type and by actor", async () => {
  const db = freshDb();
  const env = devEnv(db);
  insertEvent(db, 1, { eventType: "create", actor: "alice@example.com", createdAt: 100 });
  insertEvent(db, 2, { eventType: "disable", actor: "bob@example.com", createdAt: 101 });
  insertEvent(db, 3, { eventType: "disable", actor: "alice@example.com", createdAt: 102 });

  let res = await worker.fetch(devReq("/api/admin/events?event_type=disable"), env);
  assert.deepEqual(ids((await body(res)).data.items), [3, 2]);

  res = await worker.fetch(devReq("/api/admin/events?actor=alice%40example.com"), env);
  assert.deepEqual(ids((await body(res)).data.items), [3, 1]);

  res = await worker.fetch(devReq("/api/admin/events?event_type=disable&actor=alice%40example.com"), env);
  assert.deepEqual(ids((await body(res)).data.items), [3]);
});

test("events: since/until bound created_at inclusively; a malformed value 400s before touching D1", async () => {
  const db = freshDb();
  const env = devEnv(db);
  insertEvent(db, 1, { createdAt: 1000 });
  insertEvent(db, 2, { createdAt: 2000 });
  insertEvent(db, 3, { createdAt: 3000 });

  let res = await worker.fetch(devReq("/api/admin/events?since=1500"), env);
  assert.deepEqual(ids((await body(res)).data.items), [3, 2]);

  res = await worker.fetch(devReq("/api/admin/events?until=2000"), env);
  assert.deepEqual(ids((await body(res)).data.items), [2, 1]);

  // Both boundaries are inclusive.
  res = await worker.fetch(devReq("/api/admin/events?since=1000&until=3000"), env);
  assert.deepEqual(ids((await body(res)).data.items), [3, 2, 1]);

  res = await worker.fetch(devReq("/api/admin/events?since=2000&until=2000"), env);
  assert.deepEqual(ids((await body(res)).data.items), [2]);

  for (const query of ["since=-1", "since=abc", "until=1.5", "since=Infinity"]) {
    const bad = await worker.fetch(devReq(`/api/admin/events?${query}`), env);
    assert.equal(bad.status, 400, query);
    assert.equal((await body(bad)).code, "invalid_request", query);
  }
});

// ── Keyset cursor ─────────────────────────────────────────────────────────────

test("events: keyset cursor pages forward across equal created_at values with no duplicate and no gap", async () => {
  const db = freshDb();
  const env = devEnv(db);
  // Five events all sharing one created_at second (a burst, e.g. a bulk transition), ids 1..5. The
  // documented order is (created_at DESC, id DESC), so pages must come back 5,4,3,2,1 in strict
  // descending id order with the SAME created_at throughout -- an offset cursor would be vulnerable
  // to skip/repeat if a new row were inserted mid-pagination; the keyset cursor is anchored to the
  // last row's own identity instead.
  for (let id = 1; id <= 5; id += 1) insertEvent(db, id, { createdAt: 5000 });

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const path = cursor === null ? "/api/admin/events?limit=2" : `/api/admin/events?limit=2&cursor=${encodeURIComponent(cursor)}`;
    const res = await worker.fetch(devReq(path), env);
    assert.equal(res.status, 200);
    const data = (await body(res)).data;
    seen.push(...ids(data.items));
    cursor = data.next_cursor;
    if (cursor === null) break;
  }
  assert.deepEqual(seen, [5, 4, 3, 2, 1], "every row exactly once, newest first, no duplicate or gap");
});

test("events: a malformed cursor (the old plain-digit offset shape) returns 400 before touching D1", async () => {
  const db = freshDb();
  const env = devEnv(db);
  insertEvent(db, 1, { createdAt: 1000 });
  for (const cursor of ["1", "-1", "1.5", "abc", "1:", ":2"]) {
    const res = await worker.fetch(devReq(`/api/admin/events?cursor=${encodeURIComponent(cursor)}`), env);
    assert.equal(res.status, 400, cursor);
    assert.equal((await body(res)).code, "invalid_request", cursor);
  }
});

// ── CSV export ────────────────────────────────────────────────────────────────

test("events: CSV export applies the same filters as the JSON list", async () => {
  const db = freshDb();
  const env = devEnv(db);
  insertEvent(db, 1, { project: "APP_A", eventType: "create", createdAt: 100 });
  insertEvent(db, 2, { project: "APP_B", eventType: "disable", reason: "customer request", createdAt: 200 });

  const res = await worker.fetch(devReq("/api/admin/events?project=APP_B&format=csv"), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  const text = await res.text();
  assert.match(text, /disable/);
  assert.match(text, /customer request/);
  assert.doesNotMatch(text, /APP_A/);

  const invalid = await worker.fetch(devReq("/api/admin/events?entitlement_id=not-a-real-id&format=csv"), env);
  assert.equal(invalid.status, 400);
});
