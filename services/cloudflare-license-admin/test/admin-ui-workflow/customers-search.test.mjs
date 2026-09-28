import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

test("protected connection pages reject malformed identities, enum coercion and pagination",async()=>{
  const workflow=await loadWorkflowModule('features/customers/connectionWorkflow.ts');
  const row={binding_id:Buffer.alloc(16,1).toString('base64url'),project:'APP',feature:'PRO',license_fingerprint:'a'.repeat(64),label:'Workstation',state:'active',generation:1,revision:0,hold_until:2000,last_proof_at:900,created_at:900};
  const capacityRow={project:'APP',feature:'PRO',license_fingerprint:'a'.repeat(64),in_use:1,limit:2};
  const deniedRow={project:'APP',feature:'PRO',license_fingerprint:'a'.repeat(64),device_key_id:'sha256:'+'a'.repeat(64),ts:950};
  const page={customer:{id:'owner',status:'active'},operator:{subject:'operator',actor_type:'access',role:'admin'},server_time:1000,capacity:[capacityRow],denied:[deniedRow],items:[row],next_cursor:null};
  assert.equal(workflow.validPage(page,'owner'),true);
  for(const mutate of [v=>{v.customer.id='other';},v=>{v.customer.status=['active'];},v=>{v.operator.role=['admin'];},v=>{v.items[0].state=['active'];},
    v=>{v.items[0].state='released';},v=>{v.items[0].state='retiring';v.items[0].hold_until=1000;},v=>{v.items.push({...v.items[0]});},
    v=>{v.next_cursor=v.items[0].binding_id;},v=>{v.items[0].extra='unexpected';},v=>{v.operator.subject='\ud800';},
    v=>{delete v.capacity;},v=>{v.capacity[0].in_use=-1;},v=>{v.capacity[0].limit=['2'];},v=>{v.capacity.push({...v.capacity[0],extra:1});},
    v=>{delete v.denied;},v=>{v.denied[0].ts=-1;},v=>{v.denied[0].device_key_id=123;},v=>{v.denied.push({...v.denied[0],extra:1});}]) {
    const invalid=structuredClone(page);mutate(invalid);assert.equal(workflow.validPage(invalid,'owner'),false);
  }
  assert.equal(workflow.validPage(page,'owner',row.binding_id),false);
  assert.equal(workflow.validPage(page,'owner','',row.binding_id),true);
});

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
  // Disabling sends no email or notice; the confirm must say so rather than let the operator assume it.
  assert.match(named, /until you re-enable them\. The customer is not notified\.$/);
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
  // An entitlement result deep-links by its exact id (+ customer_id when known), never by
  // project/feature alone: that guarantees exactly one row, where project/feature could match many.
  assert.deepEqual(
    workflow.navigationForResult({ type: "entitlement", id: "ent-enc", label: "a".repeat(64), project: "DEFAULT", feature: "pro", status: "active", customer_id: "cus_1" }),
    { tab: "entitlements", filter: { id: "ent-enc", project: "", feature: "", status: "", customer_id: "cus_1" } },
  );
  assert.deepEqual(
    workflow.navigationForResult({ type: "entitlement", id: "ent-enc", label: "a".repeat(64), project: "DEFAULT", feature: "pro", status: "active" }),
    { tab: "entitlements", filter: { id: "ent-enc", project: "", feature: "", status: "" } },
    "no customer on the result -> no customer_id key at all (never a blank one)",
  );
  // A license result deep-links into the entitlements it backs (the license row itself has no
  // detail view), via the new license_id list filter, never a fuzzy licenses-tab text search.
  assert.deepEqual(
    workflow.navigationForResult({ type: "license", id: "lic_9", label: "Seat pack", project: "DEFAULT", customer_id: "cus_1" }),
    { tab: "entitlements", filter: { license_id: "lic_9", project: "", feature: "", status: "", customer_id: "cus_1" } },
  );
  assert.deepEqual(
    workflow.navigationForResult({ type: "order", id: "sub_42", label: "sub_42", project: "DEFAULT", feature: "pro" }),
    { tab: "fulfillment", filter: { status: "", subscription_id: "sub_42" } },
  );
  assert.deepEqual(
    workflow.navigationForResult({ type: "entitlement", id: "x", label: "y" }),
    { tab: "entitlements", filter: { id: "x", project: "", feature: "", status: "" } },
  );
  assert.deepEqual(
    workflow.navigationForResult({ type: "license", id: "lic_x", label: "z" }),
    { tab: "entitlements", filter: { license_id: "lic_x", project: "", feature: "", status: "" } },
  );
});

// The UI cannot import the Worker's constant (UI code never imports Worker implementation files),
// so the two per-type search caps are declared separately and must be read back and compared here;
// this test is what keeps them from silently drifting apart.
test("the UI's per-type search limit agrees with the Worker's", () => {
  const uiSource = readFileSync(new URL("../../src/ui/features/search/workflow.ts", import.meta.url), "utf8");
  const workerSource = readFileSync(new URL("../../src/worker/query.ts", import.meta.url), "utf8");
  // Either declaration may carry a `: number` annotation without falling out of this comparison.
  const uiPattern = /SEARCH_RESULTS_PER_TYPE_LIMIT(?:\s*:\s*number)?\s*=\s*(\d+)/;
  const workerPattern = /SEARCH_PER_TYPE_LIMIT(?:\s*:\s*number)?\s*=\s*(\d+)/;
  assert.equal("export const SEARCH_RESULTS_PER_TYPE_LIMIT: number = 10;".match(uiPattern)?.[1], "10");
  assert.equal("const SEARCH_PER_TYPE_LIMIT : number = 10;".match(workerPattern)?.[1], "10");
  const uiMatch = uiSource.match(uiPattern);
  const workerMatch = workerSource.match(workerPattern);
  assert.ok(uiMatch, "features/search/workflow.ts must declare a parseable SEARCH_RESULTS_PER_TYPE_LIMIT");
  assert.ok(workerMatch, "worker/query.ts must declare a parseable SEARCH_PER_TYPE_LIMIT");
  assert.equal(uiMatch[1], workerMatch[1], "the UI's search limit note fires at a different count than the Worker actually caps at");
});
