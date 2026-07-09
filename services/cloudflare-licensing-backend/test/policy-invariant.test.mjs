import test from "node:test";
import assert from "node:assert/strict";
import { POLICY_TYPES, policyCapacityViolation } from "../src/entitlements/policy.mjs";

test("policy type enum and capacity invariant", () => {
  assert.deepEqual([...POLICY_TYPES], ["trial", "node_locked", "floating", "subscription"]);
  assert.equal(policyCapacityViolation("node_locked", 0), null);
  assert.equal(policyCapacityViolation("node_locked", 3), "node_locked_requires_zero_pool");
  assert.equal(policyCapacityViolation("floating", 5), null);
  assert.equal(policyCapacityViolation("floating", 0), "floating_requires_pool");
  assert.equal(policyCapacityViolation("trial", 0), null);
  assert.equal(policyCapacityViolation("subscription", 42), null);
});
