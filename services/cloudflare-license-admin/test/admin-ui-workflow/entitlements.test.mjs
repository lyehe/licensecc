import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

test("admin UI workflow builds filtered entitlement API paths", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  assert.equal(workflow.entitlementsPath({ project: "", feature: "", status: "" }), "/api/admin/entitlements");
  assert.equal(
    workflow.entitlementsPath({ project: "DEFAULT", feature: "pro seats", status: "active" }),
    "/api/admin/entitlements?project=DEFAULT&feature=pro+seats&status=active",
  );
});

test("admin UI workflow normalizes create form payloads", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const body = workflow.normalizeEntitlementForm({
    ...workflow.emptyEntitlementForm,
    license_fingerprint: "a".repeat(64),
    assertion_ttl_seconds: 120,
    valid_from: "2024-03-09",
    valid_until: "",
    notes: "operator note",
    customer_id: "cus_123",
    license_id: "lic_123",
  });

  assert.deepEqual(body, {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: "a".repeat(64),
    device_hash: "",
    assertion_ttl_seconds: 120,
    valid_from: 1709942400,
    valid_until: null,
    notes: "operator note",
    customer_id: "cus_123",
    license_id: "lic_123",
  });
  assert.throws(() => workflow.normalizeEntitlementForm({
    ...workflow.emptyEntitlementForm,
    assertion_ttl_seconds: 0,
  }), /assertion_ttl_seconds_must_be_between_1_and_3600/);
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
  assert.equal("assertion_ttl_seconds" in inherited, false, "blank/default TTL inherits from the policy");
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
    device_hash: "b".repeat(64),
    assertion_ttl_seconds: 600,
    valid_from: 1709942400,
    valid_until: null,
    notes: "existing note",
    customer_id: "cus_123",
    license_id: null,
  };
  const editForm = workflow.editFormFromEntitlement(item);
  assert.deepEqual(editForm, {
    device_hash: "b".repeat(64),
    assertion_ttl_seconds: 600,
    valid_from: "2024-03-09",
    valid_until: "",
    notes: "existing note",
    customer_id: "cus_123",
    license_id: "",
  });

  const patch = workflow.normalizeEntitlementPatch({
    ...editForm,
    assertion_ttl_seconds: 900,
    valid_until: "2024-07-03",
    notes: "",
    customer_id: "",
    license_id: "lic_123",
  });
  assert.deepEqual(patch, {
    device_hash: "b".repeat(64),
    assertion_ttl_seconds: 900,
    valid_from: 1709942400,
    valid_until: 1719964800,
    notes: "",
    customer_id: null,
    license_id: "lic_123",
  });
  assert.equal(workflow.patchPath(item), "/api/admin/entitlements/ent-123");
  assert.throws(() => workflow.normalizeEntitlementPatch({
    ...workflow.emptyEntitlementEditForm,
    assertion_ttl_seconds: 3601,
  }), /assertion_ttl_seconds_must_be_between_1_and_3600/);
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

test("admin UI workflow builds device list + transition paths with encoding", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const dev = `sha256:${"b".repeat(64)}`;
  assert.equal(workflow.entitlementDevicesPath("ent-123"), "/api/admin/entitlements/ent-123/devices");
  assert.equal(workflow.entitlementDevicesPath("ent/x"), "/api/admin/entitlements/ent%2Fx/devices");
  assert.equal(workflow.entitlementMeterPath("ent-123"), "/api/admin/entitlements/ent-123/meter");
  assert.equal(workflow.entitlementMeterPath("ent/x"), "/api/admin/entitlements/ent%2Fx/meter");
  assert.equal(
    workflow.deviceTransitionPath("ent-123", dev, "revoke"),
    `/api/admin/entitlements/ent-123/devices/sha256%3A${"b".repeat(64)}/revoke`,
  );
  assert.equal(
    workflow.deviceTransitionPath("ent-123", dev, "disable"),
    `/api/admin/entitlements/ent-123/devices/sha256%3A${"b".repeat(64)}/disable`,
  );
  assert.equal(
    workflow.deviceTransitionPath("ent-123", dev, "reenable"),
    `/api/admin/entitlements/ent-123/devices/sha256%3A${"b".repeat(64)}/reenable`,
  );
});

test("admin UI workflow device action rules make revoke terminal", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  assert.equal(workflow.canRunDeviceAction("active", "disable"), true);
  assert.equal(workflow.canRunDeviceAction("active", "reenable"), false);
  assert.equal(workflow.canRunDeviceAction("active", "revoke"), true);
  assert.equal(workflow.canRunDeviceAction("disabled", "disable"), false);
  assert.equal(workflow.canRunDeviceAction("disabled", "reenable"), true);
  assert.equal(workflow.canRunDeviceAction("disabled", "revoke"), true);
  assert.equal(workflow.canRunDeviceAction("revoked", "disable"), false);
  assert.equal(workflow.canRunDeviceAction("revoked", "reenable"), false);
  assert.equal(workflow.canRunDeviceAction("revoked", "revoke"), false);
});

test("admin UI workflow renders short device key ids and device confirm copy", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  assert.equal(workflow.shortDeviceKeyId(`sha256:${"b".repeat(64)}`), "sha256:bbbbbbbb…");
  assert.equal(workflow.shortDeviceKeyId("short"), "short");
  const revoke = workflow.revokeDeviceConfirm({ device_key_id: `sha256:${"b".repeat(64)}` });
  assert.match(revoke, /Revoke device key sha256:bbbbbbbb…/);
  assert.match(revoke, /TERMINAL/);
  assert.match(workflow.disableDeviceConfirm({ device_key_id: `sha256:${"b".repeat(64)}` }), /Disable device key sha256:bbbbbbbb…/);
});

test("admin UI workflow builds the bulk transition path and body", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  assert.equal(workflow.batchPath(), "/api/admin/entitlements/batch");
  assert.equal(workflow.entitlementBatchSelectionNotice, "Select up to 4 entitlements per batch.");
  assert.deepEqual(
    workflow.boundedBatchSelection(["a", "b", "c", "d", "e", "a"]),
    ["a", "b", "c", "d"],
    "the UI preserves first-loaded order and never silently selects a fifth row",
  );
  assert.deepEqual(workflow.batchBody("disable", ["a", "b"], "audit"), {
    action: "disable",
    reason: "audit",
    ids: ["a", "b"],
  });
  const ids = ["x"];
  const body = workflow.batchBody("revoke", ids, "chargeback");
  ids.push("y");
  assert.deepEqual(body.ids, ["x"]);
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

test("force-release confirm copy echoes the exact target and warns it frees all live seats", async () => {
  const workflow = await loadWorkflowModule("features/entitlements/workflow.ts");
  const format = await loadWorkflowModule("shared/format.ts");
  const copy = workflow.releaseSeatsConfirm({ project: "DEFAULT", feature: "pro", license_fingerprint: "a".repeat(64) });
  assert.match(copy, /Force-release ALL live seats for DEFAULT \/ pro/);
  assert.match(copy, new RegExp(format.shortHash("a".repeat(64))));
  assert.match(copy, /dead\/unreachable machine/);
});
