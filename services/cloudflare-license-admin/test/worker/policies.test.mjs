import assert from "node:assert/strict";
import test from "node:test";
import {
  NEXT_JSON_KEYS,
  MockD1,
  accessAuthed,
  accessEnv,
  accessFixture,
  accessToken,
  adminInternalsForTests,
  authed,
  baseEnv,
  clone,
  effectiveLicenseMode,
  entitlementDefaults,
  fingerprint,
  json,
  keyOf,
  rotatableAccessFixture,
  syncAuthed,
  syncEnv,
  worker,
} from "./fixtures.mjs";
import { assertRouteGroup, assertRouteGroupRejectsUnauthenticated } from "./route-group-assertions.mjs";
test("policy routes have direct owners and reject anonymous access", async () => {
  assertRouteGroup("policies", 6);
  await assertRouteGroupRejectsUnauthenticated("policies");
});

const { validatePolicyInput, validatePolicyPatch } = adminInternalsForTests;

test("validatePolicyInput accepts a minimal body and applies defaults", () => {
  // A policy carries its identity, validity, device limit and trial rules, and nothing else.
  assert.deepEqual(validatePolicyInput({ project: "DEFAULT", name: "Trial", type: "trial" }), {
    project: "DEFAULT",
    name: "Trial",
    type: "trial",
    notes: "",
    valid_from_offset_sec: null,
    duration_sec: null,
    max_active_devices: 1,
    expiry_strategy: "fixed_window",
    trial_expiration_basis: "from_issue",
    trial_duration_sec: 0,
    trial_one_per_device: 0,
  });
});

test("validatePolicyInput honors explicit values and rejects malformed bodies", () => {
  const full = validatePolicyInput({
    project: "P", name: "Pro", type: "subscription", valid_from_offset_sec: 0, duration_sec: 31536000,
    max_active_devices: 5, expiry_strategy: "non_expiring", trial_expiration_basis: "from_first_activation",
    trial_duration_sec: 1209600, trial_one_per_device: 1, notes: "ok",
  });
  assert.ok(full);
  assert.equal(full.duration_sec, 31536000);
  assert.equal(full.max_active_devices, 5);
  assert.equal(full.expiry_strategy, "non_expiring");
  assert.equal(full.trial_one_per_device, 1);
  for (const type of ["trial", "node_locked", "subscription"]) {
    assert.equal(validatePolicyInput({ project: "P", name: "x", type })?.type, type);
  }

  for (const bad of [
    null,
    "string",
    {},
    { project: "P", name: "x" }, // missing type
    { project: "P", name: "x", type: "bogus" },
    { project: "", name: "x", type: "trial" },
    { project: "P", name: "x\ninjection", type: "trial" },
    { project: "P", name: "x", type: "trial", expiry_strategy: "nope" },
    { project: "P", name: "x", type: "trial", trial_expiration_basis: "nope" },
    { project: "P", name: "x", type: "trial", trial_one_per_device: 2 },
    { project: "P", name: "x", type: "trial", max_active_devices: -1 },
    { project: "P", name: "x", type: "trial", duration_sec: -5 },
    { project: "P", name: "x", type: "floating" },
    { project: "P", name: "x", type: "floating", pool_size: 2 },
    { project: "P", name: "x", type: "node_locked", pool_size: 0 },
    { project: "P", name: "x", type: "trial", max_borrow_sec: 0 },
    { project: "P", name: "x", type: "trial", meter_quota: 0 },
    { project: "P", name: "x", type: "trial", meter_period_sec: 2592000 },
    { project: "P", name: "x", type: "trial", assertion_ttl_seconds: 300 },
    { project: "P", name: "x", type: "trial", trial_require_device_proof: 0 },
    { project: "P", name: "x", type: "trial", status: "active" },
  ]) {
    assert.equal(validatePolicyInput(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("validatePolicyPatch updates mutable fields and rejects identity fields", () => {
  assert.deepEqual(validatePolicyPatch({ max_active_devices: 8, notes: "x" }), { max_active_devices: 8, notes: "x" });
  assert.deepEqual(validatePolicyPatch({ valid_from_offset_sec: null, duration_sec: 100 }), { valid_from_offset_sec: null, duration_sec: 100 });
  assert.deepEqual(validatePolicyPatch({}), {});

  // Identity / status fields are not patchable.
  for (const bad of [{ project: "X" }, { name: "Renamed" }, { type: "trial" }, { status: "disabled" }]) {
    assert.equal(validatePolicyPatch(bad), null, `identity field ${JSON.stringify(bad)} must be rejected`);
  }
  // Out-of-range / bad-enum values, and fields a policy does not have, are rejected.
  for (const bad of [
    { max_active_devices: -1 },
    { trial_one_per_device: 5 },
    { pool_size: 8 },
    { assertion_ttl_seconds: 300 },
    { trial_require_device_proof: 0 },
    { expiry_strategy: "weird" },
    { trial_expiration_basis: "weird" },
    { notes: "a".repeat(2000) },
  ]) {
    assert.equal(validatePolicyPatch(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// A D1 stand-in that records every statement and finds nothing, so a request that reaches D1 shows.
function recordingDb() {
  const statements = [];
  const statement = (sql) => ({
    bind: () => statement(sql),
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({}),
    sql,
  });
  return {
    statements,
    prepare(sql) { statements.push(sql); return statement(sql); },
    async batch(list) { statements.push(...list.map((item) => item.sql)); return list.map(() => ({ results: [], meta: { changes: 0 } })); },
  };
}

test("a floating policy is refused", async () => {
  for (const body of [
    { project: "APP", name: "Float", type: "floating", pool_size: 2 },
    { project: "APP", name: "Float", type: "floating" },
  ]) {
    const db = recordingDb();
    const response = await worker.fetch(authed("/api/admin/policies", { method: "POST", body: JSON.stringify(body) }), baseEnv(db));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await json(response)).code, "invalid_request");
    assert.deepEqual(db.statements, [], "a refused policy never reaches D1");
  }
});

test("policy create and PATCH refuse seat, borrow, meter, TTL and device-proof fields", async () => {
  for (const field of [
    { pool_size: 0 },
    { max_borrow_sec: 0 },
    { meter_quota: 0 },
    { meter_period_sec: 2592000 },
    { assertion_ttl_seconds: 300 },
    { trial_require_device_proof: 0 },
  ]) {
    const db = recordingDb();
    const created = await worker.fetch(authed("/api/admin/policies", {
      method: "POST",
      body: JSON.stringify({ project: "APP", name: "Locked", type: "node_locked", ...field }),
    }), baseEnv(db));
    assert.equal(created.status, 400, `create ${JSON.stringify(field)}`);
    assert.equal((await json(created)).code, "invalid_request");
    const patched = await worker.fetch(authed("/api/admin/policies/pol_1", { method: "PATCH", body: JSON.stringify(field) }), baseEnv(db));
    assert.equal(patched.status, 400, `patch ${JSON.stringify(field)}`);
    assert.equal((await json(patched)).code, "invalid_request");
    assert.deepEqual(db.statements, [], `${JSON.stringify(field)} never reaches D1`);
  }
});
