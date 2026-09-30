// Unit tests for the shared entitlement-mutation core. Imported as raw Node ESM
// (NOT bundled) to prove Worker-safety: the module must use only Web globals
// (btoa/atob/TextEncoder/crypto) and never reach for node:/Buffer. If it did,
// this `node --test` import would fail or behave differently than under wrangler.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEntitlement,
  patchEntitlement,
  transitionEntitlement,
  setEntitlementCapacity,
  withId,
  entitlementId,
} from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";

// Minimal mock-D1 mirroring the prepare/bind/first/run/batch shape used by the
// real binding. It keeps a single entitlements row in `state.entitlement` and
// records audit/idempotency writes so tests can assert atomicity and column-level behavior. UPDATE...RETURNING and
// INSERT...ON CONFLICT...RETURNING are emulated by applying the bound params and
// returning the resulting row in the D1 batch `{ results: [...] }` envelope.
function makeDb(state) {
  state.events = state.events ?? [];
  state.idempotency = state.idempotency ?? {};

  function prepare(sql) {
    return {
      _sql: sql,
      _args: [],
      bind(...args) {
        this._args = args;
        return this;
      },
      async first() {
        if (sql.includes("FROM entitlements")) {
          return state.entitlement ?? null;
        }
        return null;
      },
      async run() {
        if (sql.includes("INSERT INTO entitlement_events")) {
          state.events.push({ sql, args: this._args });
        }
        return {};
      },
    };
  }

  return {
    prepare,
    async batch(statements) {
      // Statement 0 is always the entitlement write (INSERT ... RETURNING or
      // UPDATE ... RETURNING); apply it to the in-memory row and return it.
      const writeStmt = statements[0];
      const writeSql = writeStmt._sql;
      let returnedRow = null;

      if (writeSql.startsWith("INSERT INTO entitlements")) {
        // createEntitlement INSERT...ON CONFLICT param order (see core).
        const a = writeStmt._args;
        state.writeSql = writeSql;
        const row = {
          project: a[0],
          feature: a[1],
          license_fingerprint: a[2],
          status: a[3],
          // a[4..6] are the COALESCE subquery key args; revocation_seq is derived.
          revocation_seq: (state.entitlement?.revocation_seq ?? 0) + 1,
          valid_from: a[7],
          valid_until: a[8],
          notes: a[9],
          customer_id: a[10],
          license_id: a[11],
          policy_id: null,
          is_trial: 0,
          trial_expiration_basis: null,
          trial_duration_sec: 0,
          trial_one_per_device: 0,
          trial_started_at: null,
          trial_device_key_id: null,
          max_active_devices: 1,
          lease_seconds: 86400,
          created_at: a[12],
          updated_at: a[13],
        };
        state.entitlement = row;
        returnedRow = { ...row };
      } else if (writeSql.startsWith("UPDATE entitlements SET")) {
        // setEntitlementCapacity / patch / transition: apply the dynamic SET.
        // The columns updated are encoded positionally; for the capacity path we
        // parse the `col = ?` assignments and zip them with the leading args.
        const row = { ...state.entitlement };
        const setSection = writeSql.slice(writeSql.indexOf("SET ") + 4, writeSql.indexOf(" WHERE "));
        const assignments = setSection.split(", ");
        let argIndex = 0;
        for (const assignment of assignments) {
          const col = assignment.split(" = ")[0];
          if (assignment.includes("max(revocation_seq")) {
            row.revocation_seq = (row.revocation_seq ?? 0) + 1;
            continue;
          }
          if (assignment.endsWith("= ?")) {
            row[col] = writeStmt._args[argIndex];
            argIndex += 1;
          }
        }
        state.entitlement = row;
        returnedRow = { ...row };
      }

      // Remaining statements (audit event, optional idempotency) commit in the
      // same batch; record them once each (do NOT also call run(), which would
      // double-count the audit insert).
      for (let i = 1; i < statements.length; ++i) {
        state.events.push({ sql: statements[i]._sql, args: statements[i]._args });
      }

      return [{ results: returnedRow === null ? [] : [returnedRow] }];
    },
  };
}

function ctx(overrides = {}) {
  return {
    requestId: "req-1",
    actor: { subject: "admin", email: "admin@example.com", role: "admin", actorType: "access" },
    ip: "203.0.113.1",
    idempotencyKey: null,
    source: "admin",
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: "a".repeat(64),
    ...overrides,
  };
}

const KEY = { project: "DEFAULT", feature: "DEFAULT", license_fingerprint: "a".repeat(64) };

test("module imports under raw Node ESM (Worker-safe: no node:/Buffer)", () => {
  // Reaching this line means the static import above resolved without pulling in
  // any node-only dependency. Sanity-check a pure-Web-globals helper too.
  assert.equal(entitlementId("DEFAULT", "DEFAULT", "a".repeat(64)), entitlementId("DEFAULT", "DEFAULT", "a".repeat(64)));
});

test("createEntitlement returns a MutationResult with an id and writes an audit event", async () => {
  const state = {};
  const env = { DB: makeDb(state) };
  const result = await createEntitlement(env, input({ notes: "hello" }), ctx());
  assert.ok(result, "result is non-null");
  assert.equal(result.data.id, entitlementId("DEFAULT", "DEFAULT", "a".repeat(64)));
  assert.equal(result.data.notes, "hello");
  assert.equal(result.data.status, "active");
  assert.equal(result.data.license_mode, "node_locked");
  // Exactly one audit event was written atomically with the row.
  assert.equal(state.events.length, 1);
  assert.ok(state.events[0].sql.includes("INSERT INTO entitlement_events"));
});

// The INSERT names exactly the grant's own columns; every other column takes its schema default.
// The SQL suites run the real schema.
test("createEntitlement names exactly the grant's own columns", async () => {
  const state = {};
  const env = { DB: makeDb(state) };
  await createEntitlement(env, input(), ctx());
  assert.match(state.writeSql, /^INSERT INTO entitlements \(project, feature, license_fingerprint, status, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, created_at, updated_at\) VALUES/);
});

test("setEntitlementCapacity updates only provided columns and preserves the rest", async () => {
  const state = {};
  const env = { DB: makeDb(state) };
  // Seed an existing entitlement.
  await createEntitlement(env, input({ notes: "keep-me" }), ctx());
  const seededRevSeq = state.entitlement.revocation_seq;
  state.events = []; // reset audit log to isolate the capacity write

  const result = await setEntitlementCapacity(
    env,
    KEY,
    { max_active_devices: 5, lease_seconds: -1, bogus_column: 99 },
    ctx({ expectedEntitlement: { customer_id: state.entitlement.customer_id, revocation_seq: seededRevSeq } }),
  );
  assert.ok(result, "result is non-null for an existing entitlement");
  // Only the valid provided column was written.
  assert.equal(state.entitlement.max_active_devices, 5);
  assert.equal(result.data.max_active_devices, 5);
  // Unknown key is ignored.
  assert.equal("bogus_column" in state.entitlement, false);
  // Negative value is ignored (lease_seconds keeps its default).
  assert.equal(state.entitlement.lease_seconds, 86400);
  // Untouched body columns are preserved.
  assert.equal(state.entitlement.notes, "keep-me");
  assert.equal(state.entitlement.status, "active");
  // revocation_seq bumped exactly once.
  assert.equal(state.entitlement.revocation_seq, seededRevSeq + 1);
  // Audit event written atomically (eventType "update").
  assert.equal(state.events.length, 1);
  assert.ok(state.events[0].sql.includes("INSERT INTO entitlement_events"));
  assert.equal(state.events[0].args[0], "update");
});

test("setEntitlementCapacity is a no-op-safe null on a missing entitlement", async () => {
  const state = {}; // no seeded entitlement
  const env = { DB: makeDb(state) };
  const result = await setEntitlementCapacity(env, KEY, { max_active_devices: 3 }, ctx());
  assert.equal(result, null);
  assert.equal(state.events.length, 0, "no audit event for a missing entitlement");
});

test("setEntitlementCapacity throws revoked_terminal on a revoked entitlement", async () => {
  const state = {};
  const env = { DB: makeDb(state) };
  await createEntitlement(env, input(), ctx());
  state.entitlement.status = "revoked";
  await assert.rejects(
    setEntitlementCapacity(env, KEY, { max_active_devices: 2 }, ctx({ expectedEntitlement: { customer_id: state.entitlement.customer_id, revocation_seq: state.entitlement.revocation_seq } })),
    /revoked_terminal/,
  );
});

// The guard is never a no-op: a caller of any of the three guarded writers that supplies no
// precondition (absent, or explicitly null) fails loudly instead of silently skipping the check.
test("patchEntitlement, transitionEntitlement and setEntitlementCapacity each reject invalid_patch and write nothing without an expectation", async () => {
  for (const missing of [undefined, null]) {
    for (const run of [
      (env) => patchEntitlement(env, KEY, { notes: "no precondition" }, ctx({ expectedEntitlement: missing }), null),
      (env) => transitionEntitlement(env, KEY, "disabled", "disable", "reason", ctx({ expectedEntitlement: missing }), null),
      (env) => setEntitlementCapacity(env, KEY, { max_active_devices: 2 }, ctx({ expectedEntitlement: missing }), null),
    ]) {
      const state = {};
      const env = { DB: makeDb(state) };
      await createEntitlement(env, input(), ctx());
      const before = { ...state.entitlement };
      state.events = [];
      await assert.rejects(run(env), /invalid_patch/, `expectedEntitlement: ${missing}`);
      assert.deepEqual(state.entitlement, before, "a caller with no precondition writes nothing");
      assert.equal(state.events.length, 0, "a caller with no precondition writes no audit event");
    }
  }
});

test("withId derives the id and the license mode", () => {
  const record = withId({
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: "a".repeat(64),
    status: "active",
  });
  assert.equal(record.id, entitlementId("DEFAULT", "DEFAULT", "a".repeat(64)));
  assert.equal(record.license_mode, "node_locked");
});
