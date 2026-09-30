import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createEntitlement, findEntitlement, patchEntitlement, syncEntitlement, setEntitlementCapacity } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { buildPolicyStampStatement } from "@licensecc/cloudflare-runtime/entitlements/policy_store";
import { observedExpectation } from "@licensecc/cloudflare-runtime/d1/entitlement_guards";

function fixture(t, state) {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  sql.exec(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));
  sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('owner','Owner',1,1),('other','Other',1,1);
    INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,max_active_devices,created_at,updated_at)
      VALUES('APP','PRO','fingerprint','active','owner',1,1,1);
    INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,created_at,last_proof_at)
      VALUES('device','owner','APP','key','synthetic-public',1,1);
    INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,state,generation,revision,hold_until,created_at,updated_at)
      VALUES('binding','APP','PRO','fingerprint','device','${state}',2,3,4102444800,1,1);`);
  const prepare = (query, args = []) => ({ query, args,
    bind(...values) { return prepare(query, values.map(value => value === undefined ? null : value)); },
    async first(column) { const row = sql.prepare(query).get(...args); return column ? row?.[column] ?? null : row ?? null; },
    async all() { return { results: sql.prepare(query).all(...args), success: true }; },
    async run() { return this.all(); },
  });
  const env = { DB: { prepare, async batch(statements) {
    sql.exec("BEGIN");
    try {
      const result = statements.map(statement => ({ success: true, results: sql.prepare(statement.query).all(...statement.args) }));
      sql.exec("COMMIT"); return result;
    } catch (error) { sql.exec("ROLLBACK"); throw error; }
  } } };
  const snapshot = () => ["entitlements", "device_bound_bindings", "entitlement_events", "mutation_idempotency"]
    .map(table => sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { sql, env, snapshot };
}
const key = { project: "APP", feature: "PRO", license_fingerprint: "fingerprint" };
const input = { ...key, customer_id: "owner", status: "active" };
const ctx = { actor: { subject: "operator", email: "", actorType: "access" }, requestId: "request", ip: "", idempotencyKey: "operation", source: "admin" };
const idempotency = { scope: "writer-test", responseCode: "updated" };

// The owner/revocation-sequence precondition patchEntitlement and setEntitlementCapacity now
// require, read fresh off the row so it always matches whatever this test's preceding calls left.
function observed(f) {
  return observedExpectation(f.sql.prepare("SELECT customer_id, revocation_seq FROM entitlements WHERE project=? AND feature=? AND license_fingerprint=?")
    .get(key.project, key.feature, key.license_fingerprint));
}

for (const state of ["active", "retiring"]) {
  test(`admin and sync batches cannot overwrite occupied protected ${state} authority`, async t => {
    const f = fixture(t, state), before = f.snapshot();
    for (const action of [
      () => createEntitlement(f.env, { ...input, customer_id: "other" }, ctx, "", undefined, idempotency),
      () => patchEntitlement(f.env, key, { customer_id: "other" }, { ...ctx, expectedEntitlement: observed(f) }, idempotency),
      () => syncEntitlement(f.env, { ...input, customer_id: "other" }, "sync", { ...ctx, source: "sync" }, idempotency),
      () => setEntitlementCapacity(f.env, key, { max_active_devices: 0 }, { ...ctx, expectedEntitlement: observed(f) }, idempotency),
    ]) {
      await assert.rejects(action(), /capacity_in_use/);
      assert.deepEqual(f.snapshot(), before);
    }
    const stamp = buildPolicyStampStatement(f.env, key, null, { max_active_devices: 0 },
      { is_trial: 0, trial_expiration_basis: null, trial_duration_sec: 0, trial_one_per_device: 0 });
    await assert.rejects(createEntitlement(f.env, input, ctx, "", undefined, idempotency, [stamp]), /capacity_in_use/);
    assert.deepEqual(f.snapshot(), before, "failed policy stamp rolls back the preceding upsert and all evidence");
    const result = await patchEntitlement(f.env, key, { valid_until: 4102445000 }, { ...ctx, expectedEntitlement: observed(f) }, idempotency);
    assert.ok(result);
    // The record, its audit event and its replay all carry the patched window.
    assert.equal(result.data.valid_until, 4102445000);
    assert.equal((await findEntitlement(f.env, key)).valid_until, 4102445000);
    assert.equal(JSON.parse(f.sql.prepare("SELECT next_json FROM entitlement_events").get().next_json).valid_until, 4102445000);
    assert.equal(JSON.parse(f.sql.prepare("SELECT response_json FROM mutation_idempotency").get().response_json).data.valid_until, 4102445000);
    const row = f.sql.prepare("SELECT customer_id,authority_revision,max_active_devices,valid_until FROM entitlements").get();
    assert.deepEqual({ ...row }, { customer_id: "owner", authority_revision: 1, max_active_devices: 1, valid_until: 4102445000 });
    assert.deepEqual(f.snapshot()[1], before[1]);
    assert.equal(f.snapshot()[2].length, 1);
    assert.equal(f.snapshot()[3].length, 1);
    await syncEntitlement(f.env, { ...input, valid_until: 4102445100 }, "extend",
      { ...ctx, source: "sync", idempotencyKey: "sync-operation" }, idempotency);
    await setEntitlementCapacity(f.env, key, { max_active_devices: 2 },
      { ...ctx, idempotencyKey: "capacity-operation", expectedEntitlement: observed(f) }, idempotency);
    const updated = f.sql.prepare("SELECT customer_id,authority_revision,max_active_devices,valid_until FROM entitlements").get();
    assert.deepEqual({ ...updated }, { customer_id: "owner", authority_revision: 3,
      max_active_devices: 2, valid_until: 4102445100 });
    assert.deepEqual(f.snapshot()[1], before[1]);
    assert.equal(f.snapshot()[2].length, 3);
    assert.equal(f.snapshot()[3].length, 3);
    // A sync identical to a grant inserted directly with only its required columns is a no-op.
    f.sql.exec("INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,created_at,updated_at) VALUES('APP','OLD','fingerprint','active','owner',1,1)");
    const defaulted = f.snapshot();
    const unchanged = await syncEntitlement(f.env, { ...key, feature: "OLD", customer_id: "owner", status: "active" }, "",
      { ...ctx, source: "sync", idempotencyKey: "defaulted-operation" }, idempotency);
    assert.equal(unchanged.idempotencyRecorded, false);
    assert.equal(unchanged.data.customer_id, "owner");
    assert.deepEqual(f.snapshot(), defaulted);
    assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
  });
}
