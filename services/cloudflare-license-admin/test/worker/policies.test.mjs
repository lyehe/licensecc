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
  const v = validatePolicyInput({ project: "DEFAULT", name: "Trial", type: "trial" });
  assert.ok(v);
  assert.equal(v.project, "DEFAULT");
  assert.equal(v.name, "Trial");
  assert.equal(v.type, "trial");
  assert.equal(v.assertion_ttl_seconds, 300);
  assert.equal(v.pool_size, 0);
  assert.equal(v.max_active_devices, 1);
  assert.equal(v.max_borrow_sec, 0);
  assert.equal(v.expiry_strategy, "fixed_window");
  assert.equal(v.trial_expiration_basis, "from_issue");
  assert.equal(v.trial_duration_sec, 0);
  assert.equal(v.trial_one_per_device, 0);
  assert.equal(v.trial_require_device_proof, 0);
  assert.equal(v.valid_from_offset_sec, null);
  assert.equal(v.duration_sec, null);
  assert.equal(v.notes, "");
});

test("validatePolicyInput honors explicit values and rejects malformed bodies", () => {
  const full = validatePolicyInput({
    project: "P", name: "Pro", type: "subscription", valid_from_offset_sec: 0, duration_sec: 31536000,
    assertion_ttl_seconds: 600, pool_size: 10, max_active_devices: 5, max_borrow_sec: 3600,
    expiry_strategy: "non_expiring", trial_expiration_basis: "from_first_activation",
    trial_duration_sec: 1209600, trial_one_per_device: 1, trial_require_device_proof: 1, notes: "ok",
  });
  assert.ok(full);
  assert.equal(full.duration_sec, 31536000);
  assert.equal(full.expiry_strategy, "non_expiring");
  assert.equal(full.trial_one_per_device, 1);

  for (const bad of [
    null,
    "string",
    {},
    { project: "P", name: "x" }, // missing type
    { project: "P", name: "x", type: "bogus" },
    { project: "", name: "x", type: "trial" },
    { project: "P", name: "x\ninjection", type: "trial" },
    { project: "P", name: "x", type: "trial", assertion_ttl_seconds: 0 },
    { project: "P", name: "x", type: "trial", assertion_ttl_seconds: 9999 },
    { project: "P", name: "x", type: "trial", expiry_strategy: "nope" },
    { project: "P", name: "x", type: "trial", trial_expiration_basis: "nope" },
    { project: "P", name: "x", type: "trial", trial_one_per_device: 2 },
    { project: "P", name: "x", type: "trial", pool_size: -1 },
    { project: "P", name: "x", type: "trial", duration_sec: -5 },
    { project: "P", name: "x", type: "node_locked", pool_size: 1 },
    { project: "P", name: "x", type: "floating" },
    { project: "P", name: "x", type: "floating", pool_size: 0 },
  ]) {
    assert.equal(validatePolicyInput(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("validatePolicyPatch updates mutable fields and rejects identity fields", () => {
  assert.deepEqual(validatePolicyPatch({ pool_size: 8, notes: "x" }), { pool_size: 8, notes: "x" });
  assert.deepEqual(validatePolicyPatch({ valid_from_offset_sec: null, duration_sec: 100 }), { valid_from_offset_sec: null, duration_sec: 100 });
  assert.deepEqual(validatePolicyPatch({}), {});

  // Identity / status fields are not patchable.
  for (const bad of [{ project: "X" }, { name: "Renamed" }, { type: "trial" }, { status: "disabled" }]) {
    assert.equal(validatePolicyPatch(bad), null, `identity field ${JSON.stringify(bad)} must be rejected`);
  }
  // Out-of-range / bad-enum values are rejected.
  for (const bad of [
    { assertion_ttl_seconds: 0 },
    { trial_require_device_proof: 5 },
    { expiry_strategy: "weird" },
    { trial_expiration_basis: "weird" },
    { notes: "a".repeat(2000) },
  ]) {
    assert.equal(validatePolicyPatch(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});
