import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

// Each creation path sends exactly the fields its Worker route reads, and a policy create sends no
// status: the Worker refuses any other field.
test("protected form sends only its grant fields through either creation path and reports incompatible identifiers", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const form = { ...workflow.emptyEntitlementForm, license_fingerprint: "a".repeat(64), customer_id: "owner", license_id: "license" };
  assert.deepEqual(Object.keys(workflow.normalizeEntitlementForm(form)).sort(), ["customer_id", "feature", "license_fingerprint", "license_id", "notes",
    "project", "valid_from", "valid_until"]);
  const fromPolicy = workflow.normalizeCreateFromPolicy({ ...form, policy_id: "policy", notes: "n", valid_from: "2024-03-09", valid_until: "2025-03-09" });
  assert.deepEqual(Object.keys(fromPolicy).sort(), ["customer_id", "feature", "license_fingerprint", "license_id", "notes", "policy_id", "project",
    "valid_from", "valid_until"]);
  assert.deepEqual(workflow.entitlementFormErrors(form), {});
  for (const [field, value] of [["project", "APP\u2029"], ["feature", "PRO SPACE"], ["license_fingerprint", "A".repeat(64)], ["customer_id", ""], ["license_id", ""]]) {
    assert.ok(workflow.entitlementFormErrors({ ...form, [field]: value })[field]);
  }
});

test("admin UI workflow builds filtered entitlement API paths", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  assert.equal(workflow.entitlementsPath({ project: "", feature: "", status: "" }), "/api/admin/entitlements");
  assert.equal(
    workflow.entitlementsPath({ project: "DEFAULT", feature: "pro seats", status: "active" }),
    "/api/admin/entitlements?project=DEFAULT&feature=pro+seats&status=active",
  );
  assert.equal(
    workflow.entitlementsPath({ project: "", feature: "", status: "", license_id: "lic_1" }),
    "/api/admin/entitlements?license_id=lic_1",
  );
  assert.equal(
    workflow.entitlementsPath({ project: "", feature: "", status: "", id: "ent-1", customer_id: "cus_1", license_id: "lic_1" }),
    "/api/admin/entitlements?id=ent-1&customer_id=cus_1&license_id=lic_1",
  );
});

test("admin UI workflow flags a single-entitlement deep link and Show all drops its identity filters", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  assert.equal(workflow.isSingleEntitlementFilter({ project: "", feature: "", status: "" }), false);
  assert.equal(workflow.isSingleEntitlementFilter({ project: "", feature: "", status: "", id: "" }), false);
  assert.equal(workflow.isSingleEntitlementFilter({ project: "", feature: "", status: "", id: "ent-1" }), true);
  assert.deepEqual(
    workflow.filterAfterShowAll({ project: "DEFAULT", feature: "pro", status: "active", id: "ent-1", customer_id: "cus_1", license_id: "lic_1" }),
    { project: "DEFAULT", feature: "pro", status: "active" },
  );
});

test("admin UI workflow normalizes create form payloads", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const body = workflow.normalizeEntitlementForm({
    ...workflow.emptyEntitlementForm,
    license_fingerprint: "a".repeat(64),
    valid_from: "2024-03-09",
    valid_until: "",
    notes: "operator note",
    customer_id: "cus_123",
    license_id: "lic_123",
  });

  // Every create is protected, so the body names no mode.
  assert.deepEqual(body, {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: "a".repeat(64),
    valid_from: 1709942400,
    valid_until: null,
    notes: "operator note",
    customer_id: "cus_123",
    license_id: "lic_123",
  });
  // An untouched device limit is not sent, so an upsert never overwrites a stored limit the operator did not set.
  assert.equal(Object.hasOwn(body, "max_active_devices"), false);
  assert.throws(() => workflow.normalizeEntitlementForm({
    ...workflow.emptyEntitlementForm,
    valid_from: "not-a-date",
  }), /valid_from_must_be_a_valid_date/);
});

test("admin UI workflow stamps a create-from-policy payload (attaches policy_id)", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const inherited = workflow.normalizeCreateFromPolicy({
    ...workflow.emptyEntitlementForm,
    policy_id: "pol_123",
    license_fingerprint: "b".repeat(64),
  });
  assert.equal(inherited.policy_id, "pol_123");
  assert.equal(inherited.license_fingerprint, "b".repeat(64));
  assert.equal(inherited.project, "DEFAULT");
  // The forms carry exactly the fields a create or PATCH reads; the Worker refuses any other field.
  assert.deepEqual(Object.keys(workflow.emptyEntitlementForm).sort(), ["customer_id", "feature", "license_fingerprint",
    "license_id", "max_active_devices", "notes", "policy_id", "project", "valid_from", "valid_until"]);
  assert.deepEqual(Object.keys(workflow.emptyEntitlementEditForm).sort(), ["customer_id", "license_id", "notes", "valid_from", "valid_until"]);
  assert.deepEqual(Object.keys(inherited).sort(), ["feature", "license_fingerprint", "policy_id", "project"]);
  assert.equal("valid_from" in inherited, false, "blank valid_from inherits from the policy");
  assert.equal("valid_until" in inherited, false, "blank valid_until inherits from the policy");

  const body = workflow.normalizeCreateFromPolicy({
    ...workflow.emptyEntitlementForm,
    policy_id: "pol_123",
    license_fingerprint: "b".repeat(64),
    valid_from: "2024-03-09",
  });
  assert.equal(body.policy_id, "pol_123");
  assert.equal(body.license_fingerprint, "b".repeat(64));
  assert.equal(body.valid_from, 1709942400);
  assert.equal(body.project, "DEFAULT");
});

test("admin UI workflow converts dates to/from epoch (UTC-midnight, round-trips)", async () => {
  const dates = await loadWorkflowModule("shared/dates.ts");
  assert.equal(dates.dateInputToEpoch("", "valid_from"), null);
  assert.equal(dates.dateInputToEpoch("1970-01-01", "valid_from"), 0);
  assert.equal(dates.dateInputToEpoch("2024-03-09", "valid_from"), 1709942400);
  assert.equal(dates.dateInputToEpoch("2024-07-03", "valid_until"), 1719964800);
  assert.throws(() => dates.dateInputToEpoch("2024-3-9", "valid_from"), /valid_from_must_be_a_valid_date/);
  assert.throws(() => dates.dateInputToEpoch("not-a-date", "valid_from"), /valid_from_must_be_a_valid_date/);
  assert.throws(() => dates.dateInputToEpoch("2024-13-40", "valid_until"), /valid_until_must_be_a_valid_date/);

  assert.equal(dates.epochToDateInput(null), "");
  assert.equal(dates.epochToDateInput(undefined), "");
  assert.equal(dates.epochToDateInput(0), "1970-01-01");
  assert.equal(dates.epochToDateInput(1709942400), "2024-03-09");
  assert.equal(dates.dateInputToEpoch(dates.epochToDateInput(1719964800), "x"), 1719964800);
});

test("admin UI workflow prepares entitlement edit patch payloads", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const item = {
    id: "ent-123",
    valid_from: 1709942400,
    valid_until: null,
    notes: "existing note",
    customer_id: "cus_123",
    license_id: null,
  };
  const editForm = workflow.editFormFromEntitlement(item);
  assert.deepEqual(editForm, {
    valid_from: "2024-03-09",
    valid_until: "",
    notes: "existing note",
    customer_id: "cus_123",
    license_id: "",
  });

  const patch = workflow.normalizeEntitlementPatch({
    ...editForm,
    valid_until: "2024-07-03",
    notes: "",
    customer_id: "cus_456",
    license_id: "lic_123",
  });
  assert.deepEqual(patch, {
    valid_from: 1709942400,
    valid_until: 1719964800,
    notes: "",
    customer_id: "cus_456",
    license_id: "lic_123",
  });
  assert.equal(workflow.patchPath(item), "/api/admin/entitlements/ent-123");
});

// Every grant has an owner: the edit form can move it to another customer but never clear it, so an
// empty customer is a form error and the edit never sends a null owner.
test("the edit form requires an owner and never sends a null customer", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const edit = { valid_from: "", valid_until: "", notes: "", customer_id: "", license_id: "lic_1" };
  for (const customer_id of ["", "   "]) {
    assert.equal(workflow.entitlementFormErrors({ ...edit, customer_id }).customer_id, "Choose the customer who owns this license.", JSON.stringify(customer_id));
  }
  assert.throws(() => workflow.normalizeEntitlementPatch(edit), /^Error: customer_id_required$/);
  assert.deepEqual(workflow.entitlementFormErrors({ ...edit, customer_id: "cus_2" }), {});
  assert.equal(workflow.normalizeEntitlementPatch({ ...edit, customer_id: "cus_2" }).customer_id, "cus_2");
});

test("admin UI workflow action rules match entitlement lifecycle invariants", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  assert.equal(workflow.canRunAction("active", "disable"), true);
  assert.equal(workflow.canRunAction("active", "reenable"), false);
  assert.equal(workflow.canRunAction("active", "revoke"), true);
  assert.equal(workflow.canRunAction("disabled", "disable"), false);
  assert.equal(workflow.canRunAction("disabled", "reenable"), true);
  assert.equal(workflow.canRunAction("disabled", "revoke"), true);
  assert.equal(workflow.canRunAction("revoked", "disable"), false);
  assert.equal(workflow.canRunAction("revoked", "reenable"), false);
  assert.equal(workflow.canRunAction("revoked", "revoke"), false);
  assert.equal(workflow.canEditEntitlement("active"), true);
  assert.equal(workflow.canEditEntitlement("disabled"), true);
  assert.equal(workflow.canEditEntitlement("revoked"), false);
});

test("admin UI workflow builds transition paths and short fingerprints", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const format = await loadWorkflowModule("shared/format.ts");
  assert.equal(workflow.transitionPath({ id: "ent-123" }, "revoke"), "/api/admin/entitlements/ent-123/revoke");
  assert.equal(format.shortHash("short"), "short");
  assert.equal(format.shortHash("a".repeat(64)), "aaaaaaaa...aaaaaaaa");
});

test("admin UI workflow shortens a refused connection's device key id", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  assert.equal(workflow.shortDeviceKeyId(`sha256:${"b".repeat(64)}`), "sha256:bbbbbbbb…");
  assert.equal(workflow.shortDeviceKeyId("short"), "short");
  assert.equal(workflow.shortDeviceKeyId("c".repeat(20)), `${"c".repeat(12)}…`);
});

test("admin UI workflow builds the bulk transition path and body", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  assert.equal(workflow.batchPath(), "/api/admin/entitlements/batch");
  // Selection is no longer capped at four; the batch runner splits a larger run into chunks.
  assert.equal(workflow.boundedBatchSelection, undefined);
  assert.equal(workflow.entitlementBatchSelectionNotice, undefined);
  assert.deepEqual(workflow.batchBody("disable", [{ id: "a", customer_id: "cus_a", revocation_seq: 1 }, { id: "b", customer_id: null, revocation_seq: 2 }], "audit"), {
    action: "disable",
    reason: "audit",
    rows: [
      { id: "a", expected_customer_id: "cus_a", expected_revocation_seq: 1 },
      { id: "b", expected_customer_id: null, expected_revocation_seq: 2 },
    ],
  });
  const rows = [{ id: "x", customer_id: "cus_x", revocation_seq: 1 }];
  const body = workflow.batchBody("revoke", rows, "chargeback");
  rows.push({ id: "y", customer_id: "cus_y", revocation_seq: 1 });
  assert.deepEqual(body.rows, [{ id: "x", expected_customer_id: "cus_x", expected_revocation_seq: 1 }]);
});

test("admin UI workflow summarizes per-row batch results into one operator line", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  assert.equal(
    workflow.summarizeBatchResults([
      { id: "a", ok: true, code: "entitlement_disabled" },
      { id: "b", ok: true, code: "entitlement_disabled" },
    ]),
    "2 ok",
  );
  assert.equal(
    workflow.summarizeBatchResults([
      { id: "a", ok: true, code: "entitlement_revoked" },
      { id: "b", ok: false, code: "revoked_entitlement_is_terminal" },
      { id: "c", ok: false, code: "not_found" },
      { id: "d", ok: false, code: "revoked_entitlement_is_terminal" },
    ]),
    "1 ok, 2 revoked-terminal, 1 not-found",
  );
  assert.equal(
    workflow.summarizeBatchResults([
      { id: "a", ok: false, code: "invalid_entitlement_id" },
      { id: "b", ok: false, code: "mutation_failed" },
      { id: "c", ok: false, code: "weird_code" },
    ]),
    "0 ok, 1 invalid-id, 1 failed, 1 weird_code",
  );
  assert.equal(workflow.summarizeBatchResults([]), "0 ok");
});

test("a finished batch reads as one sentence, with every per-row outcome in words and never a code", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  assert.equal(workflow.batchResultSentence("disable", [
    { id: "a", ok: true, code: "entitlement_disabled" },
    { id: "b", ok: true, code: "entitlement_disabled" },
  ]), "Disable finished: 2 done.");
  assert.equal(workflow.batchResultSentence("disable", [
    { id: "a", ok: true, code: "entitlement_disabled" },
    { id: "b", ok: false, code: "not_found" },
  ]), "Disable finished: 1 done, 1 not found.");
  const mixed = workflow.batchResultSentence("revoke", [
    { id: "a", ok: false, code: "revoked_entitlement_is_terminal" },
    { id: "b", ok: false, code: "revoked_entitlement_is_terminal" },
    { id: "c", ok: false, code: "invalid_entitlement_id" },
    { id: "d", ok: false, code: "mutation_failed" },
    { id: "e", ok: false, code: "stale_transition" },
    { id: "f", ok: false, code: "weird_code" },
    { id: "g", ok: false, code: "constructor" },
  ]);
  assert.equal(mixed, "Revoke finished: 0 done, 2 already revoked, 1 with an invalid ID, 1 failed, 1 changed meanwhile, 2 not changed.");
  assert.doesNotMatch(mixed, /\b[a-z]+_[a-z_]+\b/);
  assert.equal(workflow.batchResultSentence("reenable", []), "Reenable finished: 0 done.");
});

test("the entitlement record guard accepts the protected row shape", async () => {
  const guards = await loadWorkflowModule("shared/mutationGuards.ts");
  // Only the columns a grant record carries; none of the dropped seat, borrow, meter, TTL or
  // mode columns.
  const row = {
    id: "ent-1", project: "APP", feature: "PRO", license_fingerprint: "a".repeat(64),
    status: "active", license_mode: "node_locked",
    revocation_seq: 1, valid_from: null, valid_until: null, notes: "",
    customer_id: "cus_1", license_id: "lic_1", policy_id: null,
    is_trial: 0, trial_expiration_basis: null, trial_duration_sec: 0,
    trial_one_per_device: 0, trial_started_at: null, trial_device_key_id: null,
    max_active_devices: 3, lease_seconds: 0, created_at: 1, updated_at: 2,
  };
  assert.equal(guards.hasEntitlementRecordData(row), true);
  const { max_active_devices, ...withoutDeviceLimit } = row;
  assert.equal(guards.hasEntitlementRecordData(withoutDeviceLimit), false);
});

test("the policy record guard accepts a protected policy record", async () => {
  const guards = await loadWorkflowModule("shared/mutationGuards.ts");
  const policy = {
    id: "pol_1", project: "APP", name: "Pro", type: "node_locked", status: "active",
    valid_from_offset_sec: null, duration_sec: 86400, max_active_devices: 3,
    expiry_strategy: "fixed_window", trial_expiration_basis: "from_issue", trial_duration_sec: 0,
    trial_one_per_device: 1, notes: "tier", created_at: 1, updated_at: 2,
  };
  assert.equal(guards.hasPolicyData(policy), true);
});

test("entitlement date edits preserve stored instants and use UTC midnight for changed dates", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const original = {
    ...workflow.emptyEntitlementForm,
    valid_from: Date.parse("2026-09-07T13:25:17Z") / 1000,
    valid_until: Date.parse("2026-09-08T18:42:03Z") / 1000,
    customer_id: "cus_1",
    license_id: null,
  };
  const edit = workflow.editFormFromEntitlement(original);
  const unchanged = workflow.normalizeEntitlementPatch({ ...edit, notes: "Updated note" }, original);
  assert.equal(unchanged.valid_from, original.valid_from);
  assert.equal(unchanged.valid_until, original.valid_until);
  const extended = workflow.normalizeEntitlementPatch({ ...edit, valid_until: "2026-09-10" }, original);
  assert.equal(extended.valid_until, Date.parse("2026-09-10T00:00:00Z") / 1000);
  assert.equal(workflow.normalizeEntitlementPatch({ ...edit, valid_until: "" }, original).valid_until, null);
  assert.deepEqual(workflow.entitlementFormErrors(edit, original), {});
  assert.ok(workflow.entitlementFormErrors({ ...edit, valid_until: "2026-09-07" }, original).valid_until);
  assert.ok(workflow.entitlementFormErrors({ ...edit, valid_until: "2026-02-30" }, original).valid_until);
});
