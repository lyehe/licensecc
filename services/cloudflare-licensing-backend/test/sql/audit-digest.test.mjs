// Real-SQLite integration for the tamper-evident audit digest (audit R6.4). Drives the EXACT
// appendAuditDigest the Worker's scheduled() runs + verifyAuditChain, against an in-memory SQLite
// built from the shared migrations. Asserts: the chain verifies clean; ALTERING a covered event is
// detected (digest_mismatch); DELETING one is detected (event_count_mismatch); append is a no-op with
// no new events. Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { appendAuditDigest, verifyAuditChain } from "../../src/audit/audit_digest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");

class PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...values) {
    const next = new PreparedStatement(this.db, this.sql);
    next.params = values.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
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
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return db;
}

function addEvent(db, detail, createdAt, seq) {
  db.prepare(
    "INSERT INTO entitlement_events (project, feature, license_fingerprint, event_type, status, revocation_seq, detail, created_at) " +
      "VALUES ('P','F',?,?,?,?,?,?)",
  ).run("a".repeat(64), "create", "active", seq, detail, createdAt);
}

test("audit digest chain verifies clean across multiple segments (R6.4)", async () => {
  const db = freshDb();
  const env = { DB: new D1Like(db) };
  addEvent(db, "e1", 100, 1);
  addEvent(db, "e2", 101, 2);
  addEvent(db, "e3", 102, 3);

  const seg1 = await appendAuditDigest(env, 200);
  assert.equal(seg1.event_count, 3);
  assert.deepEqual(await verifyAuditChain(env), { ok: true, checked: 1 });

  // A second cron tick over new events extends the chain.
  addEvent(db, "e4", 103, 4);
  addEvent(db, "e5", 104, 5);
  const seg2 = await appendAuditDigest(env, 201);
  assert.equal(seg2.event_count, 2);
  assert.deepEqual(await verifyAuditChain(env), { ok: true, checked: 2 });

  // No new events -> append is a no-op.
  assert.equal(await appendAuditDigest(env, 202), null);
  db.close();
});

test("altering a covered event breaks the chain (R6.4)", async () => {
  const db = freshDb();
  const env = { DB: new D1Like(db) };
  addEvent(db, "original", 100, 1);
  addEvent(db, "second", 101, 2);
  await appendAuditDigest(env, 200);
  assert.equal((await verifyAuditChain(env)).ok, true);

  // Tamper: alter the first covered event's detail.
  db.prepare("UPDATE entitlement_events SET detail = 'tampered' WHERE id = 1").run();
  const result = await verifyAuditChain(env);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "digest_mismatch");
  assert.equal(result.brokenAt, 1);
  db.close();
});

test("deleting a covered event breaks the chain (R6.4)", async () => {
  const db = freshDb();
  const env = { DB: new D1Like(db) };
  addEvent(db, "a", 100, 1);
  addEvent(db, "b", 101, 2);
  addEvent(db, "c", 102, 3);
  await appendAuditDigest(env, 200);
  assert.equal((await verifyAuditChain(env)).ok, true);

  db.prepare("DELETE FROM entitlement_events WHERE id = 2").run();
  const result = await verifyAuditChain(env);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "event_count_mismatch");
  db.close();
});
