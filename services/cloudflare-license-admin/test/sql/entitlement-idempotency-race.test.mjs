// Idempotency races for policy-stamped entitlement creation, exercised through the
// compiled admin Worker on the real migration-backed SQLite schema.  The hooks
// deliberately place a second request after the first request's replay lookup
// but before its D1 batch (and, separately, immediately after commit).  That is
// the smallest deterministic form of the production interleaves this suite
// protects: no SQL or response values are faked by a MockD1.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import worker, { adminInternalsForTests } from "../../dist-worker/worker/index.js";

const { entitlementId } = adminInternalsForTests;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "cloudflare-licensing-backend", "migrations");

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
  constructor(db, { beforeBatch = null, afterBatch = null } = {}) {
    this.db = db;
    this.beforeBatch = beforeBatch;
    this.afterBatch = afterBatch;
  }
  prepare(sql) {
    return new PreparedStatement(this.db, sql);
  }
  async runHook(name) {
    const hook = this[name];
    this[name] = null;
    if (hook !== null) await hook();
  }
  async batch(statements) {
    // The pre-batch hook runs after the outer handler did its replay read but
    // before it begins its transactional batch.  The post-commit hook runs
    // before the caller can read an unprotected final row outside that batch.
    await this.runHook("beforeBatch");
    const out = [];
    this.db.exec("BEGIN");
    try {
      for (const statement of statements) {
        out.push({ results: this.db.prepare(statement.sql).all(...statement.params), success: true });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    await this.runHook("afterBatch");
    return out;
  }
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return db;
}

function devEnv(db, d1 = new D1Like(db)) {
  return {
    DB: d1,
    ENVIRONMENT: "development",
    ADMIN_DEV_BEARER_ENABLED: "1",
    ADMIN_DEV_BEARER: "dev-secret",
    POLICY_STAMP_MODE: "on",
  };
}

function devRequest(path, { body, idempotencyKey, requestId, method = "POST" }) {
  return new Request(`https://admin.example${path}`, {
    method,
    headers: {
      authorization: "Bearer dev-secret",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "cf-ray": requestId,
    },
    body: JSON.stringify(body),
  });
}

const POLICY_ID = "policy-idempotency-race";
const POLICY_SCOPE = "POST:/api/admin/entitlements:dev";
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

function seedPolicy(db) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT INTO entitlement_policies (id, project, name, type, status, assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(POLICY_ID, "DEFAULT", "Idempotency race policy", "floating", "active", 600, 7, 4, 900, now, now);
}

function policyCreate(env, fingerprint, key, requestId, notes = "before-commit") {
  return worker.fetch(devRequest("/api/admin/entitlements", {
    body: {
      project: "DEFAULT",
      feature: "POLICY_RACE",
      license_fingerprint: fingerprint,
      policy_id: POLICY_ID,
      notes,
    },
    idempotencyKey: key,
    requestId,
  }), env);
}

test("policy create: a strict collection idempotency claim rolls back a losing tuple and replays the winner", async () => {
  const db = freshDb();
  seedPolicy(db);
  const key = "same-collection-key";
  const winnerEnv = devEnv(db);
  let winnerRaw = null;

  const outerD1 = new D1Like(db, {
    beforeBatch: async () => {
      // Both requests already missed the same collection-level replay key; the
      // inner request wins its batch before the outer request begins its own.
      const winner = await policyCreate(winnerEnv, FP_B, key, "winner-request");
      assert.equal(winner.status, 200, await winner.clone().text());
      winnerRaw = await winner.text();
    },
  });
  const outer = await policyCreate(devEnv(db, outerD1), FP_A, key, "loser-request");
  const outerRaw = await outer.text();

  assert.equal(outer.status, 200, outerRaw);
  assert.equal(outer.headers.get("x-idempotent-replay"), "1");
  assert.equal(outerRaw, winnerRaw, "the losing tuple must return the winner's exact cached body");

  const replay = await policyCreate(devEnv(db), FP_A, key, "later-replay");
  const replayRaw = await replay.text();
  assert.equal(replay.status, 200, replayRaw);
  assert.equal(replay.headers.get("x-idempotent-replay"), "1");
  assert.equal(replayRaw, winnerRaw);

  // One winning tuple, one policy stamp, one audit, one cache record.  A
  // conflict must roll the whole losing batch back, including the policy extra
  // statement that sits between the entitlement write and audit projection.
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM entitlements").get().count, 1);
  const entitlement = db.prepare("SELECT license_fingerprint, policy_id, pool_size, max_active_devices, max_borrow_sec FROM entitlements").get();
  assert.equal(entitlement.license_fingerprint, FP_B);
  assert.equal(entitlement.policy_id, POLICY_ID);
  assert.equal(entitlement.pool_size, 7);
  assert.equal(entitlement.max_active_devices, 4);
  assert.equal(entitlement.max_borrow_sec, 900);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM entitlement_events").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mutation_idempotency WHERE scope = ? AND idempotency_key = ?").get(POLICY_SCOPE, key).count, 1);
  const audit = db.prepare("SELECT request_id, next_json FROM entitlement_events").get();
  assert.equal(audit.request_id, "winner-request");
  const next = JSON.parse(audit.next_json);
  assert.equal(next.license_fingerprint, FP_B);
  assert.equal(next.status, "active");
  assert.equal(next.revocation_seq, 1);
  assert.equal(next.policy_id, POLICY_ID);
});

test("policy create: the initial body is the committed snapshot even when a post-commit patch interleaves", async () => {
  const db = freshDb();
  seedPolicy(db);
  const key = "after-commit-snapshot";
  const id = entitlementId("DEFAULT", "POLICY_RACE", FP_A);
  const patchEnv = devEnv(db);
  const outerD1 = new D1Like(db, {
    afterBatch: async () => {
      const patched = await worker.fetch(devRequest(`/api/admin/entitlements/${id}`, {
        method: "PATCH",
        body: { notes: "after-commit" },
        idempotencyKey: "after-commit-patch",
        requestId: "after-commit-patch-request",
      }), patchEnv);
      assert.equal(patched.status, 200, await patched.clone().text());
    },
  });

  const initial = await policyCreate(devEnv(db, outerD1), FP_A, key, "snapshot-request");
  const initialRaw = await initial.text();
  assert.equal(initial.status, 200, initialRaw);

  const cached = db.prepare("SELECT response_json FROM mutation_idempotency WHERE scope = ? AND idempotency_key = ?").get(POLICY_SCOPE, key);
  assert.notEqual(cached, undefined);
  assert.equal(initialRaw, cached.response_json, "initial success must be the exact transactional cached result");

  const replay = await policyCreate(devEnv(db), FP_A, key, "snapshot-replay-request");
  const replayRaw = await replay.text();
  assert.equal(replay.status, 200, replayRaw);
  assert.equal(replay.headers.get("x-idempotent-replay"), "1");
  assert.equal(replayRaw, initialRaw, "initial and replay bodies must be byte-identical");

  const initialBody = JSON.parse(initialRaw);
  assert.equal(initialBody.data.notes, "before-commit");
  assert.equal(initialBody.data.revocation_seq, 1);
  assert.equal(initialBody.data.policy_id, POLICY_ID);
  const current = db.prepare("SELECT notes, revocation_seq FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ?").get("DEFAULT", "POLICY_RACE", FP_A);
  assert.equal(current.notes, "after-commit");
  assert.equal(current.revocation_seq, 2);
  const createAudit = db.prepare("SELECT next_json FROM entitlement_events WHERE request_id = ?").get("snapshot-request");
  const next = JSON.parse(createAudit.next_json);
  assert.equal(next.notes, "before-commit");
  assert.equal(next.revocation_seq, 1);
  assert.equal(next.policy_id, POLICY_ID);
});
