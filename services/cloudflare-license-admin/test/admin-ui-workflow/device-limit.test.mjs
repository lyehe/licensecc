import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

// The device limit is visible and settable, policies say what they grant, and a policy's
// patchable fields are editable.
const failure = (code, data, requestId = "req-3") => ({ kind: "failure", code, requestId, ...(data === undefined ? {} : { data }) });
const refusal = (code, requestId, data) => Object.defineProperties(
  { ok: false, code, request_id: requestId, ...(data === undefined ? {} : { data }) },
  { __httpOk: { value: false }, __httpStatus: { value: 409 } },
);

// The console sends a device limit only when the operator sets one. An upsert of an existing key
// then keeps its stored limit, as every upsert did before the console could set a limit at all.
test("an untouched device limit is not sent; a typed one is; a policy create leaves it to the policy", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const { MAX_DEVICE_LIMIT } = await loadWorkflowModule("../shared/api.ts");
  assert.equal(MAX_DEVICE_LIMIT, 1_000_000);
  assert.equal(workflow.emptyEntitlementForm.max_active_devices, "");
  const form = { ...workflow.emptyEntitlementForm, license_fingerprint: "a".repeat(64) };
  assert.equal(Object.hasOwn(workflow.normalizeEntitlementForm(form), "max_active_devices"), false);
  assert.deepEqual(workflow.entitlementFormErrors(form), {});
  const typed = { ...form, max_active_devices: 3 };
  assert.equal(workflow.normalizeEntitlementForm(typed).max_active_devices, 3);
  assert.deepEqual(workflow.entitlementFormErrors(typed), {});
  assert.equal("max_active_devices" in workflow.normalizeCreateFromPolicy({ ...typed, policy_id: "pol_1" }), false);
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
  // A floating policy grants a seat pool, not a device limit; the read-only field says the same.
  assert.equal(workflow.policyOptionLabel(policy("team", "APP", { pool_size: 5 })), "Policy team · 5 seats · APP");
  assert.deepEqual(workflow.policyGrant(policy("pro", "APP")), { label: "Device limit", count: 3 });
  assert.deepEqual(workflow.policyGrant(policy("team", "APP", { pool_size: 5, max_active_devices: 9 })), { label: "Seats", count: 5 });
  const policies = [policy("a", "APP"), policy("b", "OTHER"), policy("c", "APP")];
  assert.deepEqual(workflow.policiesForProject(policies, "APP").map((item) => item.id), ["a", "c"]);
  assert.deepEqual(workflow.policiesForProject(policies, "NONE"), []);
});

test("a refused device limit names the connected devices in words, never its code", async () => {
  const limits = await loadWorkflowModule("features/entitlements/deviceLimit.ts");
  assert.equal(limits.deviceLimitFailureMessage(failure("capacity_in_use", { devices_in_use: 3 }), 2), "3 devices are connected; disconnect one first.");
  // Saying "one" would send the operator back for a second refusal.
  assert.equal(limits.deviceLimitFailureMessage(failure("capacity_in_use", { devices_in_use: 5 }), 2), "5 devices are connected; disconnect 3 first.");
  // The count is read after the refusal; if devices disconnected meanwhile, nothing needs to go.
  for (const [connected, requested] of [[2, 2], [0, 1], [1, 3]]) {
    assert.equal(limits.deviceLimitFailureMessage(failure("capacity_in_use", { devices_in_use: connected }), requested),
      "The connected devices changed while you were saving; try again.", `${connected} for ${requested}`);
  }
  for (const data of [undefined, null, {}, { devices_in_use: -1 }, { devices_in_use: 2.5 }, { devices_in_use: "3" }]) {
    const message = limits.deviceLimitFailureMessage(failure("capacity_in_use", data), 2);
    assert.match(message, /; disconnect one first\.$/, JSON.stringify(data));
    assert.doesNotMatch(message, /capacity_in_use|undefined|NaN|null/);
  }
  assert.equal(limits.deviceLimitFailureMessage(failure("stale_transition"), 2),
    "This license (entitlement) changed after you opened it; its current values were refreshed. Check the device limit and save again.");
  assert.equal(limits.deviceLimitFailureMessage(failure("revoked_entitlement_is_terminal"), 2),
    "Revocation is permanent; this license (entitlement) can no longer change.");
  assert.equal(limits.deviceLimitFailureMessage(failure("invalid_request"), 2), null);
});

test("the device limit PATCH carries only the limit and the observed state, and admits its refusals", async () => {
  const limits = await loadWorkflowModule("features/entitlements/deviceLimit.ts");
  const item = { id: "ent-1", customer_id: "cus_1", revocation_seq: 4 };
  assert.deepEqual(JSON.parse(limits.deviceLimitRequestBody(item, 5)), { max_active_devices: 5, expected_customer_id: "cus_1", expected_revocation_seq: 4 });
  assert.equal(limits.deviceLimitError(5), null);
  for (const value of [0, 1_000_001, 1.5, Number.NaN]) assert.match(limits.deviceLimitError(value), /1 to 1,000,000/);
  const guards = await loadWorkflowModule("shared/mutationGuards.ts");
  const patchPolicy = guards.mutationFailurePolicies.entitlementPatch;
  assert.deepEqual(
    guards.parseMutationResponse(refusal("capacity_in_use", "req-4", { devices_in_use: 3 }), "entitlement_patched", () => true, patchPolicy, "initial"),
    { kind: "failure", code: "capacity_in_use", requestId: "req-4", data: { devices_in_use: 3 } },
  );
  // A stale expectation writes nothing, so it is a definitive refusal, not an unknown outcome to reconcile.
  assert.deepEqual(
    guards.parseMutationResponse(refusal("stale_transition", "req-6"), "entitlement_patched", () => true, patchPolicy, "initial"),
    { kind: "failure", code: "stale_transition", requestId: "req-6" },
  );
  for (const code of ["capacity_in_use", "stale_transition"]) {
    assert.deepEqual(guards.parseMutationResponse(refusal(code, "req-7"), "entitlement_patched", () => true, patchPolicy, "replay"), { kind: "invalid" });
  }
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

test("a create refused for connected devices says which rule: the device limit, or a move to another customer", async () => {
  const onboarding = await loadWorkflowModule("features/entitlements/protectedCreate.ts");
  const say = (reason) => onboarding.protectedCreateFailureMessage({ code: "protected_creation_conflict", requestId: "req-5", data: { reason } });
  assert.match(say("invalid_capacity"), /^The device limit must be 1 to 1,000,000 and can't drop below the devices already connected; raise the limit, choose another policy, or disconnect devices first\.$/);
  // Moving a grant with connected devices to another customer is a different rule from the device
  // limit, so its sentence must not suggest raising the limit.
  const moved = say("devices_connected");
  assert.equal(moved, "This license (entitlement) still has connected devices; disconnect them before moving it to another customer.");
  assert.doesNotMatch(moved, /raise the limit/);
});
