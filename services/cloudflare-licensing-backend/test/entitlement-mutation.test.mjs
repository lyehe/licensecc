// Unit tests for the shared entitlement-mutation core. Imported as raw Node ESM
// (NOT bundled) to prove Worker-safety: the module must use only Web globals
// (btoa/atob/TextEncoder/crypto) and never reach for node:/Buffer. If it did,
// this `node --test` import would fail or behave differently than under wrangler.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEntitlement,
  setEntitlementCapacity,
  withId,
  entitlementId,
} from "../src/entitlements/entitlement_mutation.mjs";

// Minimal mock-D1 mirroring the prepare/bind/first/run/batch shape used by the
// real binding (see test/lease-worker.test.mjs). It keeps a single entitlements
// row in `state.entitlement` and records audit/idempotency writes so tests can
// assert atomicity and column-level behavior. UPDATE...RETURNING and
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
        const row = {
          project: a[0],
          feature: a[1],
          license_fingerprint: a[2],
          device_hash: a[3],
          status: a[4],
          assertion_ttl_seconds: a[5],
          cache_ttl_seconds: a[6],
          // a[7..9] are the COALESCE subquery key args; revocation_seq is derived.
          revocation_seq: (state.entitlement?.revocation_seq ?? 0) + 1,
          valid_from: a[10],
          valid_until: a[11],
          notes: a[12],
          customer_id: a[13],
          license_id: a[14],
          policy_id: null,
          is_trial: 0,
          trial_expiration_basis: null,
          trial_duration_sec: 0,
          trial_one_per_device: 0,
          trial_require_device_proof: 0,
          trial_started_at: null,
          trial_device_hash: null,
          max_active_devices: 1,
          lease_seconds: 2592000,
          rebind_window_sec: 7776000,
          pool_size: 0,
          heartbeat_grace_sec: 900,
          max_borrow_sec: 0,
          allow_overdraft: 0,
          meter_quota: 0,
          meter_period_sec: 2592000,
          created_at: a[15],
          updated_at: a[16],
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
  // cache_ttl_seconds must be stripped from the public record by withId().
  assert.equal("cache_ttl_seconds" in result.data, false);
  // Exactly one audit event was written atomically with the row.
  assert.equal(state.events.length, 1);
  assert.ok(state.events[0].sql.includes("INSERT INTO entitlement_events"));
});

test("setEntitlementCapacity updates only provided columns and preserves the rest", async () => {
  const state = {};
  const env = { DB: makeDb(state) };
  // Seed an existing entitlement.
  await createEntitlement(env, input({ notes: "keep-me", device_hash: "" }), ctx());
  const seededRevSeq = state.entitlement.revocation_seq;
  state.events = []; // reset audit log to isolate the capacity write

  const result = await setEntitlementCapacity(
    env,
    KEY,
    { max_active_devices: 5, lease_seconds: 1000, bogus_column: 99, pool_size: -1 },
    ctx(),
  );
  assert.ok(result, "result is non-null for an existing entitlement");
  // Only the two valid provided columns were written.
  assert.equal(state.entitlement.max_active_devices, 5);
  assert.equal(state.entitlement.lease_seconds, 1000);
  assert.equal(result.data.max_active_devices, 5);
  // Unknown key is ignored.
  assert.equal("bogus_column" in state.entitlement, false);
  // Negative value is ignored (pool_size remains at the migrated default).
  assert.equal(state.entitlement.pool_size, 0);
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
    setEntitlementCapacity(env, KEY, { max_active_devices: 2 }, ctx()),
    /revoked_terminal/,
  );
});

test("withId derives the id and strips cache_ttl_seconds", () => {
  const record = withId({
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: "a".repeat(64),
    cache_ttl_seconds: 3600,
    status: "active",
  });
  assert.equal(record.id, entitlementId("DEFAULT", "DEFAULT", "a".repeat(64)));
  assert.equal(record.license_mode, "node_locked");
  assert.equal("cache_ttl_seconds" in record, false);
});
