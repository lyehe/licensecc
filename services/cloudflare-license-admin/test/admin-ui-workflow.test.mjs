import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

async function loadWorkflowModule() {
  const source = readFileSync(new URL("../src/ui/operatorWorkflow.ts", import.meta.url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
  }).outputText;
  const dir = mkdtempSync(join(tmpdir(), "licensecc-admin-ui-"));
  const file = join(dir, "operatorWorkflow.mjs");
  writeFileSync(file, transpiled, "utf8");
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("admin UI workflow builds filtered entitlement API paths", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.entitlementsPath({ project: "", feature: "", status: "" }), "/api/admin/entitlements");
  assert.equal(
    workflow.entitlementsPath({ project: "DEFAULT", feature: "pro seats", status: "active" }),
    "/api/admin/entitlements?project=DEFAULT&feature=pro+seats&status=active",
  );
});

test("admin UI workflow normalizes create form payloads", async () => {
  const workflow = await loadWorkflowModule();
  const body = workflow.normalizeEntitlementForm({
    ...workflow.emptyEntitlementForm,
    license_fingerprint: "a".repeat(64),
    assertion_ttl_seconds: 120,
    valid_from: "1710000000",
    valid_until: "",
    notes: "operator note",
    customer_id: "cus_123",
    license_id: "lic_123",
  });

  assert.deepEqual(body, {
    ...workflow.emptyEntitlementForm,
    license_fingerprint: "a".repeat(64),
    assertion_ttl_seconds: 120,
    valid_from: 1710000000,
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
    valid_from: "not-a-number",
  }), /valid_from_must_be_a_non_negative_integer/);
});

test("admin UI workflow prepares entitlement edit patch payloads", async () => {
  const workflow = await loadWorkflowModule();
  const item = {
    id: "ent-123",
    device_hash: "b".repeat(64),
    assertion_ttl_seconds: 600,
    valid_from: 1710000000,
    valid_until: null,
    notes: "existing note",
    customer_id: "cus_123",
    license_id: null,
  };
  const editForm = workflow.editFormFromEntitlement(item);
  assert.deepEqual(editForm, {
    device_hash: "b".repeat(64),
    assertion_ttl_seconds: 600,
    valid_from: "1710000000",
    valid_until: "",
    notes: "existing note",
    customer_id: "cus_123",
    license_id: "",
  });

  const patch = workflow.normalizeEntitlementPatch({
    ...editForm,
    assertion_ttl_seconds: 900,
    valid_until: "1720000000",
    notes: "",
    customer_id: "",
    license_id: "lic_123",
  });
  assert.deepEqual(patch, {
    device_hash: "b".repeat(64),
    assertion_ttl_seconds: 900,
    valid_from: 1710000000,
    valid_until: 1720000000,
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
  const workflow = await loadWorkflowModule();
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
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.transitionPath({ id: "ent-123" }, "revoke"), "/api/admin/entitlements/ent-123/revoke");
  assert.equal(workflow.shortHash("short"), "short");
  assert.equal(workflow.shortHash("a".repeat(64)), "aaaaaaaa...aaaaaaaa");
});

test("admin UI workflow builds filtered customer API paths", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.customersPath({ status: "", q: "" }), "/api/admin/customers");
  assert.equal(
    workflow.customersPath({ status: "disabled", q: "acme corp" }),
    "/api/admin/customers?status=disabled&q=acme+corp",
  );
  assert.equal(workflow.customersPath({ status: "active", q: "" }), "/api/admin/customers?status=active");
  assert.equal(workflow.customersPath({ status: "", q: "jane@example.com" }), "/api/admin/customers?q=jane%40example.com");
});

test("admin UI workflow builds customer detail and transition paths with encoding", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.customerDetailPath("cus_123"), "/api/admin/customers/cus_123");
  assert.equal(workflow.customerDetailPath("cus/with space"), "/api/admin/customers/cus%2Fwith%20space");
  assert.equal(workflow.customerTransitionPath("cus_123", "disable"), "/api/admin/customers/cus_123/disable");
  assert.equal(workflow.customerTransitionPath("cus_123", "reenable"), "/api/admin/customers/cus_123/reenable");
  assert.equal(workflow.customerTransitionPath("cus/x", "disable"), "/api/admin/customers/cus%2Fx/disable");
});

test("admin UI workflow customer action rules match kill-switch invariants", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.canRunCustomerAction("active", "disable"), true);
  assert.equal(workflow.canRunCustomerAction("active", "reenable"), false);
  assert.equal(workflow.canRunCustomerAction("disabled", "disable"), false);
  assert.equal(workflow.canRunCustomerAction("disabled", "reenable"), true);
  assert.equal(workflow.canRunCustomerAction("unknown", "disable"), false);
  assert.equal(workflow.canRunCustomerAction("unknown", "reenable"), false);
});

test("admin UI workflow builds filtered license and order API paths", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.licensesPath({ project: "", customer_id: "", q: "" }), "/api/admin/licenses");
  assert.equal(
    workflow.licensesPath({ project: "DEFAULT", customer_id: "cus_1", q: "seat pack" }),
    "/api/admin/licenses?project=DEFAULT&customer_id=cus_1&q=seat+pack",
  );
  assert.equal(workflow.licensesPath({ project: "DEFAULT", customer_id: "", q: "" }), "/api/admin/licenses?project=DEFAULT");

  assert.equal(workflow.ordersPath({ status: "", subscription_id: "" }), "/api/admin/orders");
  assert.equal(
    workflow.ordersPath({ status: "accepted", subscription_id: "sub_42" }),
    "/api/admin/orders?status=accepted&subscription_id=sub_42",
  );
  assert.equal(workflow.ordersPath({ status: "rejected", subscription_id: "" }), "/api/admin/orders?status=rejected");
});

test("admin UI workflow formats epoch timestamps", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.formatEpoch(null), "-");
  assert.equal(workflow.formatEpoch(undefined), "-");
  assert.equal(workflow.formatEpoch(1710000000), new Date(1710000000 * 1000).toLocaleString());
  assert.equal(workflow.formatEpoch(0), new Date(0).toLocaleString());
});
