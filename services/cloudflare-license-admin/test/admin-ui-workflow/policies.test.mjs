import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

test("admin UI workflow builds filtered policy API paths", async () => {
  const workflow = await loadWorkflowModule("features/policies/workflow.ts");
  assert.equal(workflow.policiesPath({ project: "", type: "", status: "" }), "/api/admin/policies");
  assert.equal(
    workflow.policiesPath({ project: "DEFAULT", type: "trial", status: "active" }),
    "/api/admin/policies?project=DEFAULT&type=trial&status=active",
  );
  assert.equal(workflow.policiesPath({ project: "", type: "", status: "active" }), "/api/admin/policies?status=active");
});

test("admin UI workflow builds policy detail and transition paths with encoding", async () => {
  const workflow = await loadWorkflowModule("features/policies/workflow.ts");
  assert.equal(workflow.policyPath("pol_123"), "/api/admin/policies/pol_123");
  assert.equal(workflow.policyPath("pol/with space"), "/api/admin/policies/pol%2Fwith%20space");
  assert.equal(workflow.policyTransitionPath("pol_123", "disable"), "/api/admin/policies/pol_123/disable");
  assert.equal(workflow.policyTransitionPath("pol_123", "reenable"), "/api/admin/policies/pol_123/reenable");
  assert.equal(workflow.policyTransitionPath("pol/x", "disable"), "/api/admin/policies/pol%2Fx/disable");
});

test("admin UI workflow policy action rules match kill-switch invariants", async () => {
  const workflow = await loadWorkflowModule("features/policies/workflow.ts");
  assert.equal(workflow.canRunPolicyAction("active", "disable"), true);
  assert.equal(workflow.canRunPolicyAction("active", "reenable"), false);
  assert.equal(workflow.canRunPolicyAction("disabled", "disable"), false);
  assert.equal(workflow.canRunPolicyAction("disabled", "reenable"), true);
  assert.equal(workflow.canRunPolicyAction("unknown", "disable"), false);
  assert.equal(workflow.canRunPolicyAction("unknown", "reenable"), false);
});

test("admin UI workflow normalizes the policy editor form", async () => {
  const workflow = await loadWorkflowModule("features/policies/workflow.ts");
  const minimal = workflow.normalizePolicyForm({ ...workflow.emptyPolicyForm, name: "Trial 14d" });
  assert.deepEqual(minimal, {
    project: "DEFAULT",
    name: "Trial 14d",
    type: "trial",
    valid_from_offset_sec: null,
    duration_sec: null,
    assertion_ttl_seconds: 300,
    pool_size: 0,
    max_active_devices: 1,
    max_borrow_sec: 0,
    meter_quota: 0,
    meter_period_sec: 2592000,
    expiry_strategy: "fixed_window",
    trial_expiration_basis: "from_issue",
    trial_duration_sec: 0,
    trial_one_per_device: 0,
    trial_require_device_proof: 0,
    notes: "",
  });

  const full = workflow.normalizePolicyForm({
    ...workflow.emptyPolicyForm,
    project: "P",
    name: "Floating",
    type: "floating",
    valid_from_offset_sec: "0",
    duration_sec: "2592000",
    pool_size: 25,
    max_active_devices: 5,
    max_borrow_sec: 86400,
    meter_quota: 1000,
    meter_period_sec: 3600,
    expiry_strategy: "non_expiring",
    trial_expiration_basis: "from_first_activation",
    trial_duration_sec: 1209600,
    trial_one_per_device: true,
    trial_require_device_proof: true,
    notes: "team plan",
  });
  assert.equal(full.duration_sec, 2592000);
  assert.equal(full.pool_size, 25);
  assert.equal(full.meter_quota, 1000);
  assert.equal(full.meter_period_sec, 3600);
  assert.equal(full.expiry_strategy, "non_expiring");
  assert.equal(full.trial_one_per_device, 1);
  assert.equal(full.trial_require_device_proof, 1);

  assert.throws(() => workflow.normalizePolicyForm({ ...workflow.emptyPolicyForm, name: "x", assertion_ttl_seconds: 0 }), /assertion_ttl_seconds_must_be_between_1_and_3600/);
  assert.throws(() => workflow.normalizePolicyForm({ ...workflow.emptyPolicyForm, name: "x", pool_size: -1 }), /pool_size_must_be_between_0_and_1000000/);
  assert.throws(() => workflow.normalizePolicyForm({ ...workflow.emptyPolicyForm, name: "x", duration_sec: "-5" }), /duration_sec_must_be_between_0_and_/);
  assert.throws(() => workflow.normalizePolicyForm({ ...workflow.emptyPolicyForm, name: "x", type: "floating", pool_size: 0 }), /floating_pool_size_must_be_at_least_1/);
  assert.throws(() => workflow.normalizePolicyForm({ ...workflow.emptyPolicyForm, name: "x", type: "node_locked", pool_size: 2 }), /node_locked_pool_size_must_be_0/);
});

test("disable-policy confirm copy echoes the policy and clarifies frozen entitlements", async () => {
  const workflow = await loadWorkflowModule("features/policies/workflow.ts");
  const copy = workflow.disablePolicyConfirm({ name: "Trial 14d", type: "trial" });
  assert.match(copy, /Disable policy "Trial 14d" \(trial\)/);
  assert.match(copy, /already-stamped entitlements are frozen and unaffected/);
});
