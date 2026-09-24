import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

// B2: the device limit is visible and settable, policies say what they grant, and a policy's
// patchable fields are editable.
const failure = (code, data, requestId = "req-3") => ({ kind: "failure", code, requestId, ...(data === undefined ? {} : { data }) });

test("a create without a policy sends its own device limit; a policy create leaves it to the policy", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const { MAX_DEVICE_LIMIT } = await loadWorkflowModule("../shared/api.ts");
  assert.equal(MAX_DEVICE_LIMIT, 1_000_000);
  assert.equal(workflow.emptyEntitlementForm.max_active_devices, 1);
  const form = { ...workflow.emptyEntitlementForm, license_fingerprint: "a".repeat(64), max_active_devices: 3 };
  assert.equal(workflow.normalizeEntitlementForm(form).max_active_devices, 3);
  assert.equal("max_active_devices" in workflow.normalizeCreateFromPolicy({ ...form, policy_id: "pol_1" }), false);
  assert.deepEqual(workflow.entitlementFormErrors(form), {});
  for (const value of [0, 1_000_001, 2.5, Number.NaN]) {
    assert.throws(() => workflow.normalizeEntitlementForm({ ...form, max_active_devices: value }), /max_active_devices_must_be_between_1_and_1000000/);
    assert.match(workflow.entitlementFormErrors({ ...form, max_active_devices: value }).max_active_devices, /1 to 1,000,000/);
    // With a policy the field is read-only: the policy's own limit is stamped.
    assert.equal(workflow.entitlementFormErrors({ ...form, policy_id: "pol_1", max_active_devices: value }).max_active_devices, undefined);
  }
});

test("policy options name what they grant and the project, and list only the draft's project", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const policy = (id, project, extra = {}) => ({ id, name: `Policy ${id}`, project, pool_size: 0, max_active_devices: 3, ...extra });
  assert.equal(workflow.policyOptionLabel(policy("pro", "APP")), "Policy pro · 3 devices · APP");
  assert.equal(workflow.policyOptionLabel(policy("solo", "APP", { max_active_devices: 1 })), "Policy solo · 1 device · APP");
  // A floating policy grants a seat pool, not a device limit.
  assert.equal(workflow.policyOptionLabel(policy("team", "APP", { pool_size: 5 })), "Policy team · 5 seats · APP");
  const policies = [policy("a", "APP"), policy("b", "OTHER"), policy("c", "APP")];
  assert.deepEqual(workflow.policiesForProject(policies, "APP").map((item) => item.id), ["a", "c"]);
  assert.deepEqual(workflow.policiesForProject(policies, "NONE"), []);
});

test("a refused device limit names the connected devices in words, never its code", async () => {
  const limits = await loadWorkflowModule("features/entitlements/deviceLimit.ts");
  assert.equal(limits.deviceLimitFailureMessage(failure("capacity_in_use", { devices_in_use: 3 }), 2), "3 devices are connected; disconnect one first. Reference req-3.");
  // Saying "one" would send the operator back for a second refusal.
  assert.equal(limits.deviceLimitFailureMessage(failure("capacity_in_use", { devices_in_use: 5 }), 2), "5 devices are connected; disconnect 3 first. Reference req-3.");
  for (const data of [undefined, null, {}, { devices_in_use: -1 }, { devices_in_use: 2.5 }, { devices_in_use: "3" }]) {
    const message = limits.deviceLimitFailureMessage(failure("capacity_in_use", data), 2);
    assert.match(message, /; disconnect one first\. Reference req-3\.$/, JSON.stringify(data));
    assert.doesNotMatch(message, /capacity_in_use|undefined|NaN|null/);
  }
  assert.equal(limits.deviceLimitFailureMessage(failure("stale_transition"), 2), null);
});

test("the device limit PATCH carries only the limit and the observed state, and admits the capacity refusal", async () => {
  const limits = await loadWorkflowModule("features/entitlements/deviceLimit.ts");
  const item = { id: "ent-1", customer_id: "cus_1", revocation_seq: 4 };
  assert.deepEqual(JSON.parse(limits.deviceLimitRequestBody(item, 5)), { max_active_devices: 5, expected_customer_id: "cus_1", expected_revocation_seq: 4 });
  assert.equal(limits.deviceLimitError(5), null);
  for (const value of [0, 1_000_001, 1.5, Number.NaN]) assert.match(limits.deviceLimitError(value), /1 to 1,000,000/);
  const guards = await loadWorkflowModule("shared/mutationGuards.ts");
  const envelope = Object.defineProperties(
    { ok: false, code: "capacity_in_use", request_id: "req-4", data: { devices_in_use: 3 } },
    { __httpOk: { value: false }, __httpStatus: { value: 409 } },
  );
  assert.deepEqual(
    guards.parseMutationResponse(envelope, "entitlement_patched", () => true, guards.mutationFailurePolicies.entitlementPatch, "initial"),
    { kind: "failure", code: "capacity_in_use", requestId: "req-4", data: { devices_in_use: 3 } },
  );
  assert.deepEqual(guards.parseMutationResponse(envelope, "entitlement_patched", () => true, guards.mutationFailurePolicies.entitlementPatch, "replay"), { kind: "invalid" });
});

test("the policy editor edits every patchable field and never the policy's identity", async () => {
  const workflow = await loadWorkflowModule("features/policies/workflow.ts");
  const policy = { id: "pol_1", project: "APP", name: "Pro", type: "node_locked", status: "active", valid_from_offset_sec: null, duration_sec: 86400,
    assertion_ttl_seconds: 600, pool_size: 0, max_active_devices: 3, max_borrow_sec: 0, meter_quota: 10, meter_period_sec: 3600,
    expiry_strategy: "fixed_window", trial_expiration_basis: "from_issue", trial_duration_sec: 0, trial_one_per_device: 1, trial_require_device_proof: 0,
    notes: "tier", created_at: 1, updated_at: 2 };
  const form = workflow.policyFormFromPolicy(policy);
  assert.deepEqual(form, { project: "APP", name: "Pro", type: "node_locked", valid_from_offset_sec: "", duration_sec: "86400", assertion_ttl_seconds: 600,
    pool_size: 0, max_active_devices: 3, max_borrow_sec: 0, meter_quota: 10, meter_period_sec: 3600, expiry_strategy: "fixed_window",
    trial_expiration_basis: "from_issue", trial_duration_sec: 0, trial_one_per_device: true, trial_require_device_proof: false, notes: "tier" });
  const patch = workflow.normalizePolicyPatch({ ...form, max_active_devices: 5, name: "Renamed", project: "OTHER" });
  assert.deepEqual(patch, { valid_from_offset_sec: null, duration_sec: 86400, assertion_ttl_seconds: 600, pool_size: 0, max_active_devices: 5, max_borrow_sec: 0,
    meter_quota: 10, meter_period_sec: 3600, expiry_strategy: "fixed_window", trial_expiration_basis: "from_issue", trial_duration_sec: 0,
    trial_one_per_device: 1, trial_require_device_proof: 0, notes: "tier" });
  for (const key of ["project", "name", "type", "status"]) assert.equal(key in patch, false, key);
  assert.throws(() => workflow.normalizePolicyPatch({ ...form, max_active_devices: -1 }), /max_active_devices_must_be_between_0_and_1000000/);
  assert.throws(() => workflow.normalizePolicyPatch({ ...form, pool_size: 2 }), /node_locked_pool_size_must_be_0/);
});
