import test from "node:test";
import assert from "node:assert/strict";
import { POLICY_TYPES, stampFromPolicy } from "@licensecc/licensing-domain/entitlements/policy";

test("policy types are trial, node-locked or subscription, and a stamp carries only a device limit", () => {
  assert.deepEqual([...POLICY_TYPES], ["trial", "node_locked", "subscription"]);
  // A policy stamps a protected grant: it yields only its device limit and its trial state.
  const stamp = stampFromPolicy({
    type: "node_locked", expiry_strategy: "non_expiring", trial_expiration_basis: "from_issue",
    valid_from_offset_sec: null, duration_sec: null, max_active_devices: 3,
    trial_duration_sec: 0, trial_one_per_device: 0,
  }, { project: "APP", feature: "PRO", license_fingerprint: "a".repeat(64) }, 0);
  assert.deepEqual(stamp.capacity, { max_active_devices: 3 });
  assert.deepEqual(stamp.trial, { is_trial: 0, trial_expiration_basis: null, trial_duration_sec: 0, trial_one_per_device: 0 });
});
