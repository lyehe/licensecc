import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

test("admin UI workflow builds filtered customer API paths", async () => {
  const workflow = await loadWorkflowModule("features/customers/workflow.ts");
  assert.equal(workflow.customersPath({ status: "", q: "" }), "/api/admin/customers");
  assert.equal(
    workflow.customersPath({ status: "disabled", q: "acme corp" }),
    "/api/admin/customers?status=disabled&q=acme+corp",
  );
  assert.equal(workflow.customersPath({ status: "active", q: "" }), "/api/admin/customers?status=active");
  assert.equal(workflow.customersPath({ status: "", q: "jane@example.com" }), "/api/admin/customers?q=jane%40example.com");
});

test("admin UI workflow builds customer detail and transition paths with encoding", async () => {
  const workflow = await loadWorkflowModule("features/customers/workflow.ts");
  assert.equal(workflow.customerDetailPath("cus_123"), "/api/admin/customers/cus_123");
  assert.equal(workflow.customerDetailPath("cus/with space"), "/api/admin/customers/cus%2Fwith%20space");
  assert.equal(workflow.customerTransitionPath("cus_123", "disable"), "/api/admin/customers/cus_123/disable");
  assert.equal(workflow.customerTransitionPath("cus_123", "reenable"), "/api/admin/customers/cus_123/reenable");
  assert.equal(workflow.customerTransitionPath("cus/x", "disable"), "/api/admin/customers/cus%2Fx/disable");
});

test("admin UI workflow customer action rules match kill-switch invariants", async () => {
  const workflow = await loadWorkflowModule("features/customers/workflow.ts");
  assert.equal(workflow.canRunCustomerAction("active", "disable"), true);
  assert.equal(workflow.canRunCustomerAction("active", "reenable"), false);
  assert.equal(workflow.canRunCustomerAction("disabled", "disable"), false);
  assert.equal(workflow.canRunCustomerAction("disabled", "reenable"), true);
  assert.equal(workflow.canRunCustomerAction("unknown", "disable"), false);
  assert.equal(workflow.canRunCustomerAction("unknown", "reenable"), false);
});

test("destructive-action confirm copy echoes the exact target", async () => {
  const entitlements = await loadWorkflowModule("features/entitlements/workflow.ts");
  const customers = await loadWorkflowModule("features/customers/workflow.ts");
  const format = await loadWorkflowModule("shared/format.ts");
  const revoke = entitlements.revokeEntitlementConfirm({ project: "DEFAULT", feature: "pro", license_fingerprint: "a".repeat(64) });
  assert.match(revoke, /Revoke the entitlement for DEFAULT \/ pro/);
  assert.match(revoke, /TERMINAL and cannot be undone/);
  assert.match(revoke, new RegExp(format.shortHash("a".repeat(64))));

  const disable = entitlements.disableEntitlementConfirm({ project: "DEFAULT", feature: "pro", license_fingerprint: "b".repeat(64) });
  assert.match(disable, /Disable the entitlement for DEFAULT \/ pro/);
  assert.match(disable, /Verification and downloads stop until it is re-enabled/);
  assert.match(disable, new RegExp(format.shortHash("b".repeat(64))));

  const named = customers.disableCustomerConfirm({ id: "cus_1", name: "Acme" });
  assert.match(named, /Disable customer Acme \(cus_1\)/);
  assert.match(named, /severs all of their license\/token auth and customer-portal access/);
  assert.match(customers.disableCustomerConfirm({ id: "cus_2", name: "" }), /Disable customer cus_2\./);
});

test("admin UI workflow builds the global search path with an encoded query", async () => {
  const workflow = await loadWorkflowModule("features/search/workflow.ts");
  assert.equal(workflow.searchPath("acme"), "/api/admin/search?q=acme");
  assert.equal(workflow.searchPath("jane@example.com"), "/api/admin/search?q=jane%40example.com");
  assert.equal(workflow.searchPath("a b/c"), "/api/admin/search?q=a+b%2Fc");
});

test("admin UI workflow maps each search-result type to its deep-link navigation", async () => {
  const workflow = await loadWorkflowModule("features/search/workflow.ts");
  assert.deepEqual(
    workflow.navigationForResult({ type: "customer", id: "cus_1", label: "Acme", email: "a@b.c", status: "active" }),
    { tab: "customers", filter: { status: "", q: "cus_1" }, selectCustomerId: "cus_1" },
  );
  assert.deepEqual(
    workflow.navigationForResult({ type: "entitlement", id: "ent-enc", label: "a".repeat(64), project: "DEFAULT", feature: "pro", status: "active" }),
    { tab: "entitlements", filter: { project: "DEFAULT", feature: "pro", status: "" } },
  );
  assert.deepEqual(
    workflow.navigationForResult({ type: "license", id: "lic_9", label: "Seat pack", project: "DEFAULT", customer_id: "cus_1" }),
    { tab: "licenses", filter: { project: "DEFAULT", customer_id: "", q: "lic_9" } },
  );
  assert.deepEqual(
    workflow.navigationForResult({ type: "order", id: "sub_42", label: "sub_42", project: "DEFAULT", feature: "pro" }),
    { tab: "fulfillment", filter: { status: "", subscription_id: "sub_42" } },
  );
  assert.deepEqual(
    workflow.navigationForResult({ type: "entitlement", id: "x", label: "y" }),
    { tab: "entitlements", filter: { project: "", feature: "", status: "" } },
  );
  assert.deepEqual(
    workflow.navigationForResult({ type: "license", id: "lic_x", label: "z" }),
    { tab: "licenses", filter: { project: "", customer_id: "", q: "lic_x" } },
  );
});
