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
  // Valid-from/until are now <input type="date"> (YYYY-MM-DD), converted to UTC-midnight epoch.
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

  // normalizeEntitlementForm drops the UI-only policy_id and date strings, emitting the EntitlementInput.
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
  const workflow = await loadWorkflowModule();
  const body = workflow.normalizeCreateFromPolicy({
    ...workflow.emptyEntitlementForm,
    policy_id: "pol_123",
    license_fingerprint: "b".repeat(64),
    valid_from: "2024-03-09",
  });
  // Carries the full EntitlementInput (overrides) PLUS policy_id so the backend stamps from the template.
  assert.equal(body.policy_id, "pol_123");
  assert.equal(body.license_fingerprint, "b".repeat(64));
  assert.equal(body.valid_from, 1709942400);
  assert.equal(body.project, "DEFAULT");
});

test("admin UI workflow converts dates to/from epoch (UTC-midnight, round-trips)", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.dateInputToEpoch("", "valid_from"), null);
  assert.equal(workflow.dateInputToEpoch("1970-01-01", "valid_from"), 0);
  assert.equal(workflow.dateInputToEpoch("2024-03-09", "valid_from"), 1709942400);
  assert.equal(workflow.dateInputToEpoch("2024-07-03", "valid_until"), 1719964800);
  assert.throws(() => workflow.dateInputToEpoch("2024-3-9", "valid_from"), /valid_from_must_be_a_valid_date/);
  assert.throws(() => workflow.dateInputToEpoch("not-a-date", "valid_from"), /valid_from_must_be_a_valid_date/);
  assert.throws(() => workflow.dateInputToEpoch("2024-13-40", "valid_until"), /valid_until_must_be_a_valid_date/);

  assert.equal(workflow.epochToDateInput(null), "");
  assert.equal(workflow.epochToDateInput(undefined), "");
  assert.equal(workflow.epochToDateInput(0), "1970-01-01");
  assert.equal(workflow.epochToDateInput(1709942400), "2024-03-09");
  // Round-trip a UTC-midnight epoch.
  assert.equal(workflow.dateInputToEpoch(workflow.epochToDateInput(1719964800), "x"), 1719964800);
});

test("admin UI workflow prepares entitlement edit patch payloads", async () => {
  const workflow = await loadWorkflowModule();
  // valid_from is a UTC-midnight epoch so it round-trips through the YYYY-MM-DD edit field.
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

test("withCursor appends a cursor param respecting an existing query string", async () => {
  const workflow = await loadWorkflowModule();
  // No existing query -> '?'; existing filters -> '&'; value is URL-encoded.
  assert.equal(workflow.withCursor("/api/admin/customers", "50"), "/api/admin/customers?cursor=50");
  assert.equal(
    workflow.withCursor("/api/admin/customers?status=active", "100"),
    "/api/admin/customers?status=active&cursor=100",
  );
  assert.equal(workflow.withCursor("/api/admin/orders", "a b/c"), "/api/admin/orders?cursor=a%20b%2Fc");
});

test("destructive-action confirm copy echoes the exact target", async () => {
  const workflow = await loadWorkflowModule();
  const revoke = workflow.revokeEntitlementConfirm({ project: "DEFAULT", feature: "pro", license_fingerprint: "a".repeat(64) });
  assert.match(revoke, /Revoke the entitlement for DEFAULT \/ pro/);
  assert.match(revoke, /TERMINAL and cannot be undone/);
  assert.match(revoke, new RegExp(workflow.shortHash("a".repeat(64))));

  const named = workflow.disableCustomerConfirm({ id: "cus_1", name: "Acme" });
  assert.match(named, /Disable customer Acme \(cus_1\)/);
  assert.match(named, /severs all of their license\/token auth and customer-portal access/);
  // Falls back to the id when the name is empty.
  assert.match(workflow.disableCustomerConfirm({ id: "cus_2", name: "" }), /Disable customer cus_2\./);
});

test("admin UI workflow builds filtered policy API paths", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.policiesPath({ project: "", type: "", status: "" }), "/api/admin/policies");
  assert.equal(
    workflow.policiesPath({ project: "DEFAULT", type: "trial", status: "active" }),
    "/api/admin/policies?project=DEFAULT&type=trial&status=active",
  );
  assert.equal(workflow.policiesPath({ project: "", type: "", status: "active" }), "/api/admin/policies?status=active");
});

test("admin UI workflow builds policy detail and transition paths with encoding", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.policyPath("pol_123"), "/api/admin/policies/pol_123");
  assert.equal(workflow.policyPath("pol/with space"), "/api/admin/policies/pol%2Fwith%20space");
  assert.equal(workflow.policyTransitionPath("pol_123", "disable"), "/api/admin/policies/pol_123/disable");
  assert.equal(workflow.policyTransitionPath("pol_123", "reenable"), "/api/admin/policies/pol_123/reenable");
  assert.equal(workflow.policyTransitionPath("pol/x", "disable"), "/api/admin/policies/pol%2Fx/disable");
});

test("admin UI workflow policy action rules match kill-switch invariants", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.canRunPolicyAction("active", "disable"), true);
  assert.equal(workflow.canRunPolicyAction("active", "reenable"), false);
  assert.equal(workflow.canRunPolicyAction("disabled", "disable"), false);
  assert.equal(workflow.canRunPolicyAction("disabled", "reenable"), true);
  assert.equal(workflow.canRunPolicyAction("unknown", "disable"), false);
  assert.equal(workflow.canRunPolicyAction("unknown", "reenable"), false);
});

test("admin UI workflow normalizes the policy editor form", async () => {
  const workflow = await loadWorkflowModule();
  // Defaults: empty offset/duration -> null; trial flags false -> 0; numeric defaults pass through.
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
    expiry_strategy: "fixed_window",
    trial_expiration_basis: "from_issue",
    trial_duration_sec: 0,
    trial_one_per_device: 0,
    trial_require_device_proof: 0,
    notes: "",
  });

  // A fully-specified floating policy: offset/duration parsed, trial flags coerced to 1.
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
    expiry_strategy: "non_expiring",
    trial_expiration_basis: "from_first_activation",
    trial_duration_sec: 1209600,
    trial_one_per_device: true,
    trial_require_device_proof: true,
    notes: "team plan",
  });
  assert.equal(full.duration_sec, 2592000);
  assert.equal(full.pool_size, 25);
  assert.equal(full.expiry_strategy, "non_expiring");
  assert.equal(full.trial_one_per_device, 1);
  assert.equal(full.trial_require_device_proof, 1);

  // Out-of-range numeric fields throw the bounded-validator message.
  assert.throws(() => workflow.normalizePolicyForm({ ...workflow.emptyPolicyForm, name: "x", assertion_ttl_seconds: 0 }), /assertion_ttl_seconds_must_be_between_1_and_3600/);
  assert.throws(() => workflow.normalizePolicyForm({ ...workflow.emptyPolicyForm, name: "x", pool_size: -1 }), /pool_size_must_be_between_0_and_1000000/);
  assert.throws(() => workflow.normalizePolicyForm({ ...workflow.emptyPolicyForm, name: "x", duration_sec: "-5" }), /duration_sec_must_be_between_0_and_/);
});

test("disable-policy confirm copy echoes the policy and clarifies frozen entitlements", async () => {
  const workflow = await loadWorkflowModule();
  const copy = workflow.disablePolicyConfirm({ name: "Trial 14d", type: "trial" });
  assert.match(copy, /Disable policy "Trial 14d" \(trial\)/);
  assert.match(copy, /already-stamped entitlements are frozen and unaffected/);
});

// ── Workstream C: bulk transitions ────────────────────────────────────────────
test("admin UI workflow builds the bulk transition path and body", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.batchPath(), "/api/admin/entitlements/batch");
  assert.deepEqual(workflow.batchBody("disable", ["a", "b"], "audit"), {
    action: "disable",
    reason: "audit",
    ids: ["a", "b"],
  });
  // The ids array is copied (a new array), so a later mutation of the source can't leak into the body.
  const ids = ["x"];
  const body = workflow.batchBody("revoke", ids, "chargeback");
  ids.push("y");
  assert.deepEqual(body.ids, ["x"]);
});

test("admin UI workflow summarizes per-row batch results into one operator line", async () => {
  const workflow = await loadWorkflowModule();
  // All ok -> just the ok count.
  assert.equal(
    workflow.summarizeBatchResults([
      { id: "a", ok: true, code: "entitlement_disabled" },
      { id: "b", ok: true, code: "entitlement_disabled" },
    ]),
    "2 ok",
  );
  // Mixed: ok count collapses; each distinct failure code becomes a short slug + count.
  assert.equal(
    workflow.summarizeBatchResults([
      { id: "a", ok: true, code: "entitlement_revoked" },
      { id: "b", ok: false, code: "revoked_entitlement_is_terminal" },
      { id: "c", ok: false, code: "not_found" },
      { id: "d", ok: false, code: "revoked_entitlement_is_terminal" },
    ]),
    "1 ok, 2 revoked-terminal, 1 not-found",
  );
  // Unknown failure codes pass through verbatim; invalid-id + failed get their slugs.
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

// ── Workstream C: global search path + result-to-navigation mapping ────────────
test("admin UI workflow builds the global search path with an encoded query", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.searchPath("acme"), "/api/admin/search?q=acme");
  assert.equal(workflow.searchPath("jane@example.com"), "/api/admin/search?q=jane%40example.com");
  assert.equal(workflow.searchPath("a b/c"), "/api/admin/search?q=a+b%2Fc");
});

test("admin UI workflow maps each search-result type to its deep-link navigation", async () => {
  const workflow = await loadWorkflowModule();

  // A customer deep-links to the Customers tab, filters to itself, AND selects it (detail pane opens).
  assert.deepEqual(
    workflow.navigationForResult({ type: "customer", id: "cus_1", label: "Acme", email: "a@b.c", status: "active" }),
    { tab: "customers", filter: { status: "", q: "cus_1" }, selectCustomerId: "cus_1" },
  );

  // An entitlement deep-links to the Entitlements tab filtered to its exact project + feature.
  assert.deepEqual(
    workflow.navigationForResult({ type: "entitlement", id: "ent-enc", label: "a".repeat(64), project: "DEFAULT", feature: "pro", status: "active" }),
    { tab: "entitlements", filter: { project: "DEFAULT", feature: "pro", status: "" } },
  );

  // A license deep-links to the Licenses tab filtered to its project + q=id.
  assert.deepEqual(
    workflow.navigationForResult({ type: "license", id: "lic_9", label: "Seat pack", project: "DEFAULT", customer_id: "cus_1" }),
    { tab: "licenses", filter: { project: "DEFAULT", customer_id: "", q: "lic_9" } },
  );

  // An order deep-links to the Fulfillment tab filtered by subscription_id (the result id).
  assert.deepEqual(
    workflow.navigationForResult({ type: "order", id: "sub_42", label: "sub_42", project: "DEFAULT", feature: "pro" }),
    { tab: "fulfillment", filter: { status: "", subscription_id: "sub_42" } },
  );

  // Missing optional project/feature on an entitlement/license fall back to empty (no undefined leaks).
  assert.deepEqual(
    workflow.navigationForResult({ type: "entitlement", id: "x", label: "y" }),
    { tab: "entitlements", filter: { project: "", feature: "", status: "" } },
  );
  assert.deepEqual(
    workflow.navigationForResult({ type: "license", id: "lic_x", label: "z" }),
    { tab: "licenses", filter: { project: "", customer_id: "", q: "lic_x" } },
  );
});

// ── Workstream C: CSV export path ──────────────────────────────────────────────
test("admin UI workflow appends format=csv respecting an existing query string", async () => {
  const workflow = await loadWorkflowModule();
  // No existing query -> '?'; existing filters -> '&'. Mirrors withCursor's join logic.
  assert.equal(workflow.csvExportPath("/api/admin/entitlements"), "/api/admin/entitlements?format=csv");
  assert.equal(
    workflow.csvExportPath("/api/admin/entitlements?project=DEFAULT&status=active"),
    "/api/admin/entitlements?project=DEFAULT&status=active&format=csv",
  );
  assert.equal(workflow.csvExportPath("/api/admin/customers?q=acme"), "/api/admin/customers?q=acme&format=csv");
  // Composes with the real path builders so the export uses the SAME filters as the JSON list.
  assert.equal(
    workflow.csvExportPath(workflow.entitlementsPath({ project: "P", feature: "", status: "active" })),
    "/api/admin/entitlements?project=P&status=active&format=csv",
  );
  assert.equal(
    workflow.csvExportPath(workflow.customersPath({ status: "disabled", q: "" })),
    "/api/admin/customers?status=disabled&format=csv",
  );
});
