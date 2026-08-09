// Real-SQLite integration for per-device revoke/disable/reenable (audit R6.5 / closes R6.1).
// Drives the EXACT transitionEntitlementDevice + listEntitlementDevices the admin worker's
// /api/admin/entitlements/{id}/devices endpoints run, against an in-memory SQLite built from the
// shared migrations. Asserts: a transition flips ONE device's status, bumps the entitlement's
// revocation_seq, and writes a constraint-safe event_type='update' audit row with a device detail —
// all atomically; revoke is terminal; a missing device / entitlement is refused; a same-status call
// is an idempotent no-op (no seq bump, no event). Requires node:sqlite (Node >= 22). Run via test:sql.
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
  transitionEntitlementDevice,
  listEntitlementDevices,
} from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { buildPolicyStampStatement } from "@licensecc/cloudflare-runtime/entitlements/policy_store";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");
const FP = "a".repeat(64);
const DEVICE = `sha256:${"b".repeat(64)}`;
const DEVICE2 = `sha256:${"c".repeat(64)}`;
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

function freshDb({ entitlementStatus = "active", revocationSeq = 0 } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, f), "utf8"));
  }
  db.exec(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, created_at, updated_at) " +
      `VALUES ('DEFAULT', 'DEFAULT', '${FP}', '', '${entitlementStatus}', 300, 300, ${revocationSeq}, ${NOW}, ${NOW})`,
  );
  return db;
}

function addDevice(db, deviceKeyId, status = "active") {
  db.prepare(
    "INSERT INTO entitlement_devices (project, feature, license_fingerprint, device_key_id, public_key_spki_der_base64, status, created_at, updated_at) VALUES ('DEFAULT','DEFAULT',?,?,'pk',?,?,?)",
  ).run(FP, deviceKeyId, status, NOW, NOW);
}

function ctx(overrides = {}) {
  return {
    actor: { subject: "op", email: "op@x.test", role: "admin", actorType: "access" },
    requestId: "req1",
    ip: "",
    idempotencyKey: null,
    source: "admin",
    ...overrides,
  };
}

function entitlementStatus(db) {
  return db.prepare("SELECT status FROM entitlements WHERE license_fingerprint = ?").get(FP).status;
}
function deviceStatus(db, deviceKeyId) {
  return db.prepare("SELECT status FROM entitlement_devices WHERE license_fingerprint = ? AND device_key_id = ?").get(FP, deviceKeyId)?.status;
}
function entitlementSeq(db) {
  return db.prepare("SELECT revocation_seq FROM entitlements WHERE license_fingerprint = ?").get(FP).revocation_seq;
}
function latestEvent(db) {
  return db.prepare("SELECT event_type, detail FROM entitlement_events WHERE license_fingerprint = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(FP);
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

test("real SQLite device 3x3 transition matrix binds returned parent identity/seq and child state", async () => {
  for (const transition of STATE_MATRIX) {
    const db = freshDb();
    addDevice(db, DEVICE, transition.source);
    const env = { DB: new D1Like(db) };
    const idempotencyKey = `device-${transition.action}-${transition.source}`;
    const idempotency = { scope: "test:device-matrix", responseCode: `device_${transition.action}d` };
    const expectedError = transition.error === "revoked_terminal" ? "device_revoked_terminal" : transition.error;
    const run = () => transitionEntitlementDevice(
      env,
      KEY,
      DEVICE,
      TARGET_STATUS[transition.action],
      "matrix",
      ctx({ idempotencyKey }),
      idempotency,
    );

    if (expectedError !== undefined) {
      await assert.rejects(run, new RegExp(expectedError), `${transition.action} from ${transition.source}`);
      assert.equal(deviceStatus(db, DEVICE), "revoked");
      assert.equal(entitlementStatus(db), "active");
      assert.equal(entitlementSeq(db), 0);
      assert.equal(eventCount(db), 0);
      assert.equal(idempotencyCount(db, idempotency.scope, idempotencyKey), 0);
      db.close();
      continue;
    }

    const result = await run();
    assert.notEqual(result, null, `${transition.action} from ${transition.source} returns the parent entitlement`);
    assert.equal(result.data.id, entitlementId(KEY.project, KEY.feature, KEY.license_fingerprint));
    assert.equal(result.data.project, KEY.project);
    assert.equal(result.data.feature, KEY.feature);
    assert.equal(result.data.license_fingerprint, KEY.license_fingerprint);
    assert.equal(result.data.status, "active");
    assert.equal(result.data.revocation_seq, transition.writes ? 1 : 0);
    assert.equal(deviceStatus(db, DEVICE), TARGET_STATUS[transition.action]);
    assert.equal(entitlementSeq(db), transition.writes ? 1 : 0);
    assert.equal(eventCount(db), transition.writes ? 1 : 0);
    assert.equal(result.idempotencyRecorded, transition.writes);
    assert.equal(idempotencyCount(db, idempotency.scope, idempotencyKey), transition.writes ? 1 : 0);
    db.close();
  }
});

test("revoke a device flips status, bumps revocation_seq, writes a constraint-safe audit event (R6.5)", async () => {
  const db = freshDb();
  addDevice(db, DEVICE);
  const env = { DB: new D1Like(db) };

  const result = await transitionEntitlementDevice(env, KEY, DEVICE, "revoked", "chargeback", ctx(), null);
  assert.notEqual(result, null);
  assert.equal(deviceStatus(db, DEVICE), "revoked");
  assert.equal(entitlementSeq(db), 1, "revocation_seq bumped so caches invalidate on next check");
  const ev = latestEvent(db);
  assert.equal(ev.event_type, "update", "device events reuse the constraint-safe 'update' type");
  assert.match(ev.detail, /^device-revoke sha256:bbbbbbbb\.\.\.: chargeback$/);
  db.close();
});

test("disable then reenable a device round-trips status and bumps seq each time (R6.5)", async () => {
  const db = freshDb();
  addDevice(db, DEVICE);
  const env = { DB: new D1Like(db) };

  await transitionEntitlementDevice(env, KEY, DEVICE, "disabled", "audit", ctx(), null);
  assert.equal(deviceStatus(db, DEVICE), "disabled");
  assert.equal(entitlementSeq(db), 1);

  await transitionEntitlementDevice(env, KEY, DEVICE, "active", "", ctx(), null);
  assert.equal(deviceStatus(db, DEVICE), "active");
  assert.equal(entitlementSeq(db), 2, "reenable also bumps the seq");
  assert.match(latestEvent(db).detail, /^device-reenable /);
  db.close();
});

test("revoke is terminal: a revoked device cannot be disabled or reenabled (R6.5)", async () => {
  const db = freshDb();
  addDevice(db, DEVICE, "revoked");
  const env = { DB: new D1Like(db) };
  await assert.rejects(() => transitionEntitlementDevice(env, KEY, DEVICE, "disabled", "x", ctx(), null), /device_revoked_terminal/);
  await assert.rejects(() => transitionEntitlementDevice(env, KEY, DEVICE, "active", "x", ctx(), null), /device_revoked_terminal/);
  db.close();
});

test("a same-status transition is an idempotent no-op — no seq bump, no event (R6.5)", async () => {
  const db = freshDb();
  addDevice(db, DEVICE, "disabled");
  const env = { DB: new D1Like(db) };
  const before = eventCount(db);
  const result = await transitionEntitlementDevice(env, KEY, DEVICE, "disabled", "x", ctx(), null);
  assert.notEqual(result, null);
  assert.equal(entitlementSeq(db), 0, "no status change -> no revocation_seq bump");
  assert.equal(eventCount(db), before, "no audit event for a no-op");
  db.close();
});

test("a missing device throws device_not_found; a missing entitlement returns null (R6.5)", async () => {
  const db = freshDb();
  addDevice(db, DEVICE);
  const env = { DB: new D1Like(db) };
  await assert.rejects(() => transitionEntitlementDevice(env, KEY, DEVICE2, "revoked", "x", ctx(), null), /device_not_found/);
  const missingEnt = await transitionEntitlementDevice(env, { ...KEY, feature: "NOPE" }, DEVICE, "revoked", "x", ctx(), null);
  assert.equal(missingEnt, null);
  db.close();
});

test("listEntitlementDevices returns the entitlement's devices (R6.5)", async () => {
  const db = freshDb();
  addDevice(db, DEVICE);
  addDevice(db, DEVICE2, "revoked");
  const env = { DB: new D1Like(db) };
  const devices = await listEntitlementDevices(env, KEY);
  assert.equal(devices.length, 2);
  const byId = Object.fromEntries(devices.map((d) => [d.device_key_id, d.status]));
  assert.equal(byId[DEVICE], "active");
  assert.equal(byId[DEVICE2], "revoked");
  db.close();
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

test("real SQLite revoke interleaves fence every stale device nonterminal transition with zero loser writes", async () => {
  for (const scenario of [
    { source: "active", loserStatus: "disabled" },
    { source: "disabled", loserStatus: "active" },
  ]) {
    const db = freshDb();
    addDevice(db, DEVICE, scenario.source);
    const loserKey = `device-loser-${scenario.source}`;
    const loserIdempotency = { scope: "test:device-race", responseCode: "device_transition" };
    const env = {
      DB: new D1Like(db, {
        beforeBatch: async () => {
          await transitionEntitlementDevice(
            { DB: new D1Like(db) },
            KEY,
            DEVICE,
            "revoked",
            "race-winner",
            ctx({ requestId: `winner-${scenario.source}` }),
            null,
          );
        },
      }),
    };

    await assert.rejects(
      () => transitionEntitlementDevice(
        env,
        KEY,
        DEVICE,
        scenario.loserStatus,
        "race-loser",
        ctx({ idempotencyKey: loserKey }),
        loserIdempotency,
      ),
      /device_revoked_terminal/,
      `device ${scenario.source} -> ${scenario.loserStatus}`,
    );
    assert.equal(deviceStatus(db, DEVICE), "revoked");
    assert.equal(entitlementSeq(db), 1, "the stale loser must not bump the parent sequence");
    assert.equal(eventCount(db), 1, "only the revoke winner writes an audit event");
    assert.equal(idempotencyCount(db, loserIdempotency.scope, loserKey), 0, "the stale loser must not publish a replay result");
    db.close();
  }
});

test("real SQLite same-target interleaves return the winner's authoritative state without a second seq/audit write", async () => {
  for (const kind of ["entitlement", "device"]) {
    const db = freshDb();
    if (kind === "device") addDevice(db, DEVICE, "active");
    const env = {
      DB: new D1Like(db, {
        beforeBatch: async () => {
          if (kind === "entitlement") {
            await transitionEntitlement({ DB: new D1Like(db) }, KEY, "disabled", "disable", "winner", ctx(), null);
          } else {
            await transitionEntitlementDevice({ DB: new D1Like(db) }, KEY, DEVICE, "disabled", "winner", ctx(), null);
          }
        },
      }),
    };
    const result = kind === "entitlement"
      ? await transitionEntitlement(env, KEY, "disabled", "disable", "loser", ctx({ idempotencyKey: `${kind}-same-target` }), { scope: "test:same-target", responseCode: "entitlement_disabled" })
      : await transitionEntitlementDevice(env, KEY, DEVICE, "disabled", "loser", ctx({ idempotencyKey: `${kind}-same-target` }), { scope: "test:same-target", responseCode: "device_disabled" });

    assert.notEqual(result, null);
    assert.equal(result.data.id, entitlementId(KEY.project, KEY.feature, KEY.license_fingerprint));
    assert.equal(result.data.revocation_seq, 1, `${kind} returns the winner's authoritative sequence`);
    assert.equal(result.idempotencyRecorded, false, `${kind} did not publish a second cache row`);
    assert.equal(entitlementSeq(db), 1);
    assert.equal(eventCount(db), 1);
    if (kind === "entitlement") {
      assert.equal(entitlementStatus(db), "disabled");
    } else {
      assert.equal(deviceStatus(db, DEVICE), "disabled");
    }
    assert.equal(idempotencyCount(db, "test:same-target", `${kind}-same-target`), 0);
    db.close();
  }
});

test("real SQLite nonterminal and deleted-source guard misses are stable conflicts with zero loser writes", async () => {
  {
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
  }

  {
    const db = freshDb();
    addDevice(db, DEVICE, "active");
    addDevice(db, DEVICE2, "active");
    const loserKey = "device-nonterminal-loser";
    const loserIdempotency = { scope: "test:nonterminal-race", responseCode: "device_disabled" };
    const env = {
      DB: new D1Like(db, {
        beforeBatch: async () => {
          await transitionEntitlementDevice({ DB: new D1Like(db) }, KEY, DEVICE2, "disabled", "winner", ctx(), null);
        },
      }),
    };

    await assert.rejects(
      () => transitionEntitlementDevice(env, KEY, DEVICE, "disabled", "loser", ctx({ idempotencyKey: loserKey }), loserIdempotency),
      /stale_transition/,
    );
    assert.equal(deviceStatus(db, DEVICE), "active");
    assert.equal(deviceStatus(db, DEVICE2), "disabled");
    assert.equal(entitlementSeq(db), 1);
    assert.equal(eventCount(db), 1);
    assert.equal(idempotencyCount(db, loserIdempotency.scope, loserKey), 0);
    db.close();
  }

  {
    const db = freshDb();
    addDevice(db, DEVICE, "active");
    const loserKey = "device-deleted-loser";
    const loserIdempotency = { scope: "test:deleted-source-race", responseCode: "device_disabled" };
    const env = {
      DB: new D1Like(db, {
        beforeBatch: async () => {
          db.prepare("DELETE FROM entitlement_devices WHERE license_fingerprint = ? AND device_key_id = ?").run(FP, DEVICE);
        },
      }),
    };

    await assert.rejects(
      () => transitionEntitlementDevice(env, KEY, DEVICE, "disabled", "loser", ctx({ idempotencyKey: loserKey }), loserIdempotency),
      /stale_transition/,
    );
    assert.equal(deviceStatus(db, DEVICE), undefined);
    assert.equal(entitlementSeq(db), 0);
    assert.equal(eventCount(db), 0);
    assert.equal(idempotencyCount(db, loserIdempotency.scope, loserKey), 0);
    db.close();
  }
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
    const db = freshDb();
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

test("real SQLite audit failure rolls back guarded entitlement/device state, seq, audit, and idempotency together", async () => {
  for (const kind of ["entitlement", "device"]) {
    const db = freshDb();
    if (kind === "device") addDevice(db, DEVICE, "active");
    db.exec(
      "CREATE TRIGGER fail_transition_audit BEFORE INSERT ON entitlement_events BEGIN SELECT RAISE(ABORT, 'transition audit failed'); END",
    );
    const idempotencyKey = `${kind}-audit-rollback`;
    const idempotency = { scope: "test:audit-rollback", responseCode: `${kind}_disabled` };
    const env = { DB: new D1Like(db) };
    const run = kind === "entitlement"
      ? () => transitionEntitlement(env, KEY, "disabled", "disable", "rollback", ctx({ idempotencyKey }), idempotency)
      : () => transitionEntitlementDevice(env, KEY, DEVICE, "disabled", "rollback", ctx({ idempotencyKey }), idempotency);

    await assert.rejects(run, /transition audit failed/);
    assert.equal(entitlementStatus(db), "active");
    assert.equal(entitlementSeq(db), 0);
    assert.equal(eventCount(db), 0);
    assert.equal(idempotencyCount(db, idempotency.scope, idempotencyKey), 0);
    if (kind === "device") assert.equal(deviceStatus(db, DEVICE), "active");
    db.close();
  }
});
