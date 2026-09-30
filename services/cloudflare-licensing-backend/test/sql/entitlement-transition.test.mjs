// Real-SQLite integration for transitionEntitlement (revoke/disable/reenable), against an
// in-memory SQLite built from the shared migrations. Asserts: a transition flips the
// entitlement's status, bumps revocation_seq, and writes a constraint-safe audit row —
// atomically; revoke is terminal; a same-status call is an idempotent no-op (no seq bump, no
// event); a concurrent revoke fences every other pre-read writer (transitionEntitlement,
// createEntitlement, patchEntitlement, setEntitlementCapacity, syncEntitlement) with zero loser
// writes; and an audit-write failure rolls back the whole guarded batch. Requires node:sqlite
// (Node >= 22). Run via test:sql.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createEntitlement,
  entitlementId,
  patchEntitlement,
  setEntitlementCapacity,
  syncEntitlement,
  transitionEntitlement,
} from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { buildPolicyStampStatement } from "@licensecc/cloudflare-runtime/entitlements/policy_store";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");
const FP = "a".repeat(64);
const NOW = 1_700_000_000;
const KEY = { project: "DEFAULT", feature: "DEFAULT", license_fingerprint: FP };

function normalizeParam(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}
class PreparedStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...values) { const n = new PreparedStatement(this.db, this.sql); n.params = values.map(normalizeParam); return n; }
  async first() { const r = this.db.prepare(this.sql).get(...this.params); return r === undefined ? null : r; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() { this.db.prepare(this.sql).all(...this.params); return { success: true }; }
}
class D1Like {
  constructor(db, { beforeBatch = null } = {}) { this.db = db; this.beforeBatch = beforeBatch; }
  prepare(sql) { return new PreparedStatement(this.db, sql); }
  async batch(statements) {
    if (this.beforeBatch !== null) {
      const hook = this.beforeBatch;
      this.beforeBatch = null;
      await hook();
    }
    const out = [];
    this.db.exec("BEGIN");
    try {
      for (const s of statements) out.push({ results: this.db.prepare(s.sql).all(...s.params), success: true });
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return out;
  }
}

function freshDb({ entitlementStatus = "active", revocationSeq = 0, enforcementMode = "legacy" } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, f), "utf8"));
  }
  db.exec(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, enforcement_mode, created_at, updated_at) " +
      `VALUES ('DEFAULT', 'DEFAULT', '${FP}', '', '${entitlementStatus}', 300, 300, ${revocationSeq}, '${enforcementMode}', ${NOW}, ${NOW})`,
  );
  return db;
}

function ctx(overrides = {}) {
  return {
    actor: { subject: "op", email: "op@x.test", role: "admin", actorType: "access" },
    requestId: "req1",
    ip: "",
    idempotencyKey: null,
    source: "admin",
    // Every scenario here reads a freshly seeded row (customer_id null, revocation_seq 0) before
    // any write, so the mandatory owner/revocation-sequence guard always matches that observed state.
    expectedEntitlement: { customer_id: null, revocation_seq: 0 },
    ...overrides,
  };
}

function entitlementStatus(db) {
  return db.prepare("SELECT status FROM entitlements WHERE license_fingerprint = ?").get(FP).status;
}
function entitlementSeq(db) {
  return db.prepare("SELECT revocation_seq FROM entitlements WHERE license_fingerprint = ?").get(FP).revocation_seq;
}
function eventCount(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM entitlement_events WHERE license_fingerprint = ?").get(FP).c;
}
function idempotencyCount(db, scope, key) {
  return db.prepare("SELECT COUNT(*) AS c FROM mutation_idempotency WHERE scope = ? AND idempotency_key = ?").get(scope, key).c;
}

const TARGET_STATUS = { revoke: "revoked", disable: "disabled", reenable: "active" };
const STATE_MATRIX = [
  { action: "revoke", source: "active", writes: true },
  { action: "revoke", source: "disabled", writes: true },
  { action: "revoke", source: "revoked", writes: false },
  { action: "disable", source: "active", writes: true },
  { action: "disable", source: "disabled", writes: false },
  { action: "disable", source: "revoked", error: "revoked_terminal" },
  { action: "reenable", source: "active", writes: false },
  { action: "reenable", source: "disabled", writes: true },
  { action: "reenable", source: "revoked", error: "revoked_terminal" },
];

test("real SQLite entitlement 3x3 transition matrix binds returned identity, status, seq, audit, and idempotency", async () => {
  for (const transition of STATE_MATRIX) {
    const db = freshDb({ entitlementStatus: transition.source });
    const env = { DB: new D1Like(db) };
    const idempotencyKey = `entitlement-${transition.action}-${transition.source}`;
    const idempotency = { scope: "test:entitlement-matrix", responseCode: `entitlement_${transition.action}d` };
    const run = () => transitionEntitlement(
      env,
      KEY,
      TARGET_STATUS[transition.action],
      transition.action,
      "matrix",
      ctx({ idempotencyKey }),
      idempotency,
    );

    if (transition.error !== undefined) {
      await assert.rejects(run, new RegExp(transition.error), `${transition.action} from ${transition.source}`);
      assert.equal(entitlementStatus(db), "revoked");
      assert.equal(entitlementSeq(db), 0);
      assert.equal(eventCount(db), 0);
      assert.equal(idempotencyCount(db, idempotency.scope, idempotencyKey), 0);
      db.close();
      continue;
    }

    const result = await run();
    assert.notEqual(result, null, `${transition.action} from ${transition.source} returns the real entitlement`);
    assert.equal(result.data.id, entitlementId(KEY.project, KEY.feature, KEY.license_fingerprint));
    assert.equal(result.data.project, KEY.project);
    assert.equal(result.data.feature, KEY.feature);
    assert.equal(result.data.license_fingerprint, KEY.license_fingerprint);
    assert.equal(result.data.status, TARGET_STATUS[transition.action]);
    assert.equal(result.data.revocation_seq, transition.writes ? 1 : 0);
    assert.equal(entitlementStatus(db), TARGET_STATUS[transition.action]);
    assert.equal(entitlementSeq(db), transition.writes ? 1 : 0);
    assert.equal(eventCount(db), transition.writes ? 1 : 0);
    assert.equal(result.idempotencyRecorded, transition.writes);
    assert.equal(idempotencyCount(db, idempotency.scope, idempotencyKey), transition.writes ? 1 : 0);
    db.close();
  }
});

test("real SQLite revoke interleaves fence every stale entitlement nonterminal transition with zero loser writes", async () => {
  for (const scenario of [
    { source: "active", loserAction: "disable", loserStatus: "disabled" },
    { source: "disabled", loserAction: "reenable", loserStatus: "active" },
  ]) {
    const db = freshDb({ entitlementStatus: scenario.source });
    const loserKey = `entitlement-loser-${scenario.source}`;
    const loserIdempotency = { scope: "test:entitlement-race", responseCode: `entitlement_${scenario.loserAction}d` };
    const env = {
      DB: new D1Like(db, {
        beforeBatch: async () => {
          await transitionEntitlement(
            { DB: new D1Like(db) },
            KEY,
            "revoked",
            "revoke",
            "race-winner",
            ctx({ requestId: `winner-${scenario.source}` }),
            null,
          );
        },
      }),
    };

    await assert.rejects(
      () => transitionEntitlement(
        env,
        KEY,
        scenario.loserStatus,
        scenario.loserAction,
        "race-loser",
        ctx({ idempotencyKey: loserKey }),
        loserIdempotency,
      ),
      /revoked_terminal/,
      `${scenario.loserAction} from ${scenario.source}`,
    );
    assert.equal(entitlementStatus(db), "revoked");
    assert.equal(entitlementSeq(db), 1, "the stale loser must not bump revocation_seq");
    assert.equal(eventCount(db), 1, "only the revoke winner writes an audit event");
    assert.equal(idempotencyCount(db, loserIdempotency.scope, loserKey), 0, "the stale loser must not publish a replay result");
    db.close();
  }
});

test("real SQLite same-target interleaves return the winner's authoritative state without a second seq/audit write", async () => {
  const db = freshDb();
  const env = {
    DB: new D1Like(db, {
      beforeBatch: async () => {
        await transitionEntitlement({ DB: new D1Like(db) }, KEY, "disabled", "disable", "winner", ctx(), null);
      },
    }),
  };
  const result = await transitionEntitlement(
    env,
    KEY,
    "disabled",
    "disable",
    "loser",
    ctx({ idempotencyKey: "entitlement-same-target" }),
    { scope: "test:same-target", responseCode: "entitlement_disabled" },
  );

  assert.notEqual(result, null);
  assert.equal(result.data.id, entitlementId(KEY.project, KEY.feature, KEY.license_fingerprint));
  assert.equal(result.data.revocation_seq, 1, "returns the winner's authoritative sequence");
  assert.equal(result.idempotencyRecorded, false, "did not publish a second cache row");
  assert.equal(entitlementSeq(db), 1);
  assert.equal(eventCount(db), 1);
  assert.equal(entitlementStatus(db), "disabled");
  assert.equal(idempotencyCount(db, "test:same-target", "entitlement-same-target"), 0);
  db.close();
});

test("real SQLite nonterminal guard miss against a concurrent patch is a stable conflict with zero loser writes", async () => {
  const db = freshDb();
  const loserKey = "entitlement-nonterminal-loser";
  const loserIdempotency = { scope: "test:nonterminal-race", responseCode: "entitlement_disabled" };
  const env = {
    DB: new D1Like(db, {
      beforeBatch: async () => {
        await patchEntitlement({ DB: new D1Like(db) }, KEY, { notes: "winner-patch" }, ctx(), null);
      },
    }),
  };

  await assert.rejects(
    () => transitionEntitlement(env, KEY, "disabled", "disable", "loser", ctx({ idempotencyKey: loserKey }), loserIdempotency),
    /stale_transition/,
  );
  assert.equal(entitlementStatus(db), "active");
  assert.equal(entitlementSeq(db), 1);
  assert.equal(db.prepare("SELECT notes FROM entitlements WHERE license_fingerprint = ?").get(FP).notes, "winner-patch");
  assert.equal(eventCount(db), 1);
  assert.equal(idempotencyCount(db, loserIdempotency.scope, loserKey), 0);
  db.close();
});

test("real SQLite guards every other pre-read entitlement writer against a concurrent revoke", async () => {
  const writers = [
    {
      name: "create/update",
      responseCode: "entitlement_saved",
      run: (env, idempotencyKey, idempotency) => createEntitlement(
        env,
        { ...KEY, status: "active", notes: "stale-create" },
        ctx({ idempotencyKey }),
        "",
        undefined,
        idempotency,
        [buildPolicyStampStatement(
          env,
          KEY,
          "stale-policy",
          { pool_size: 9, max_active_devices: 9, max_borrow_sec: 9, meter_quota: 9, meter_period_sec: 3600 },
          { is_trial: 1, trial_expiration_basis: "from_issue", trial_duration_sec: 9, trial_one_per_device: 1, trial_require_device_proof: 1 },
        )],
      ),
    },
    {
      name: "patch",
      responseCode: "entitlement_patched",
      run: (env, idempotencyKey, idempotency) => patchEntitlement(
        env,
        KEY,
        { notes: "stale-patch" },
        ctx({ idempotencyKey }),
        idempotency,
      ),
    },
    {
      name: "capacity",
      responseCode: "entitlement_capacity_saved",
      run: (env, idempotencyKey, idempotency) => setEntitlementCapacity(
        env,
        KEY,
        { max_active_devices: 9 },
        ctx({ idempotencyKey }),
        idempotency,
      ),
    },
    {
      name: "sync",
      responseCode: "entitlement_synced",
      run: (env, idempotencyKey, idempotency) => syncEntitlement(
        env,
        { ...KEY, status: "active", notes: "stale-sync" },
        "",
        ctx({ idempotencyKey, source: "sync" }),
        idempotency,
      ),
    },
  ];

  for (const writer of writers) {
    // createEntitlement writes only protected grants, so the row every writer pre-reads is protected.
    const db = freshDb({ enforcementMode: "device_bound_v1" });
    const idempotencyKey = `writer-loser-${writer.name}`;
    const idempotency = { scope: "test:writer-race", responseCode: writer.responseCode };
    const env = {
      DB: new D1Like(db, {
        beforeBatch: async () => {
          await transitionEntitlement({ DB: new D1Like(db) }, KEY, "revoked", "revoke", "winner", ctx(), null);
        },
      }),
    };

    await assert.rejects(
      () => writer.run(env, idempotencyKey, idempotency),
      /revoked_terminal/,
      `${writer.name} stale loser is terminally fenced`,
    );
    const row = db.prepare("SELECT status, revocation_seq, notes, max_active_devices, policy_id FROM entitlements WHERE license_fingerprint = ?").get(FP);
    assert.equal(row.status, "revoked");
    assert.equal(row.revocation_seq, 1);
    assert.equal(row.notes, "");
    assert.equal(row.max_active_devices, 1);
    assert.equal(row.policy_id, null, `${writer.name} side writes remain inside the failed CAS claim`);
    assert.equal(eventCount(db), 1, `${writer.name} must not append a stale audit event`);
    assert.equal(idempotencyCount(db, idempotency.scope, idempotencyKey), 0, `${writer.name} must not publish a stale replay result`);
    db.close();
  }
});

test("real SQLite audit failure rolls back guarded entitlement state, seq, audit, and idempotency together", async () => {
  const db = freshDb();
  db.exec(
    "CREATE TRIGGER fail_transition_audit BEFORE INSERT ON entitlement_events BEGIN SELECT RAISE(ABORT, 'transition audit failed'); END",
  );
  const idempotencyKey = "entitlement-audit-rollback";
  const idempotency = { scope: "test:audit-rollback", responseCode: "entitlement_disabled" };
  const env = { DB: new D1Like(db) };
  const run = () => transitionEntitlement(env, KEY, "disabled", "disable", "rollback", ctx({ idempotencyKey }), idempotency);

  await assert.rejects(run, /transition audit failed/);
  assert.equal(entitlementStatus(db), "active");
  assert.equal(entitlementSeq(db), 0);
  assert.equal(eventCount(db), 0);
  assert.equal(idempotencyCount(db, idempotency.scope, idempotencyKey), 0);
  db.close();
});
