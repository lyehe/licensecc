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

// ── Webhooks tab (audit R6.5 UI) ───────────────────────────────────────────────
test("admin UI workflow builds filtered webhook list + delivery paths", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.webhooksPath({ status: "" }), "/api/admin/webhooks");
  assert.equal(workflow.webhooksPath({ status: "active" }), "/api/admin/webhooks?status=active");
  assert.equal(workflow.webhooksPath({ status: "disabled" }), "/api/admin/webhooks?status=disabled");

  assert.equal(workflow.webhookDeliveriesPath({ endpoint_id: "", status: "" }), "/api/admin/webhooks/deliveries");
  assert.equal(
    workflow.webhookDeliveriesPath({ endpoint_id: "wh_1", status: "failed" }),
    "/api/admin/webhooks/deliveries?endpoint_id=wh_1&status=failed",
  );
  assert.equal(
    workflow.webhookDeliveriesPath({ endpoint_id: "", status: "pending" }),
    "/api/admin/webhooks/deliveries?status=pending",
  );
});

test("admin UI workflow builds webhook detail/transition/redrive paths with encoding", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.webhookPath("wh_1"), "/api/admin/webhooks/wh_1");
  assert.equal(workflow.webhookPath("wh/with space"), "/api/admin/webhooks/wh%2Fwith%20space");
  assert.equal(workflow.webhookTransitionPath("wh_1", "disable"), "/api/admin/webhooks/wh_1/disable");
  assert.equal(workflow.webhookTransitionPath("wh_1", "reenable"), "/api/admin/webhooks/wh_1/reenable");
  // The deliveries redrive path is anchored under /deliveries/{id}/redrive (never a /webhooks/{id}).
  assert.equal(workflow.webhookRedrivePath("42"), "/api/admin/webhooks/deliveries/42/redrive");
  assert.equal(workflow.webhookRedrivePath("a/b"), "/api/admin/webhooks/deliveries/a%2Fb/redrive");
});

test("admin UI workflow webhook action rules match the disable/reenable invariants", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.canRunWebhookAction("active", "disable"), true);
  assert.equal(workflow.canRunWebhookAction("active", "reenable"), false);
  assert.equal(workflow.canRunWebhookAction("disabled", "disable"), false);
  assert.equal(workflow.canRunWebhookAction("disabled", "reenable"), true);
  assert.equal(workflow.canRunWebhookAction("unknown", "disable"), false);
});

test("admin UI workflow normalizes the webhook create form (mirrors the Worker validators)", async () => {
  const workflow = await loadWorkflowModule();
  // A minimal valid endpoint: https URL, all-events, no scope.
  assert.deepEqual(
    workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "https://hooks.example.com/lcc" }),
    { url: "https://hooks.example.com/lcc", event_types: "", description: "", scope_project: "", scope_customer_id: "" },
  );
  // event_types is trimmed, empty tokens dropped, re-serialized canonically; scope_project set.
  const scoped = workflow.normalizeWebhookForm({
    ...workflow.emptyWebhookForm,
    url: "https://hooks.example.com/lcc",
    event_types: " entitlement.revoked , , customer.disabled ",
    description: "prod alerts",
    scope_project: "DEFAULT",
  });
  assert.equal(scoped.event_types, "entitlement.revoked,customer.disabled");
  assert.equal(scoped.scope_project, "DEFAULT");
  assert.equal(scoped.scope_customer_id, "");

  // Rejections mirror the server: non-https, blank, whitespace-in-URL, whitespace-in-token, both scopes.
  assert.throws(() => workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "http://x.example.com" }), /url_must_be_https/);
  assert.throws(() => workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "" }), /url_must_be_a_single_https_url/);
  assert.throws(() => workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "https://a b.example.com" }), /url_must_be_a_single_https_url/);
  assert.throws(
    () => workflow.normalizeWebhookForm({ ...workflow.emptyWebhookForm, url: "https://x.example.com", event_types: "a b" }),
    /event_types_token_has_whitespace/,
  );
  assert.throws(
    () => workflow.normalizeWebhookForm({
      ...workflow.emptyWebhookForm,
      url: "https://x.example.com",
      scope_project: "DEFAULT",
      scope_customer_id: "cus_1",
    }),
    /scope_set_project_or_customer_not_both/,
  );
});

test("disable-webhook confirm copy echoes the endpoint URL and clarifies queued deliveries", async () => {
  const workflow = await loadWorkflowModule();
  const copy = workflow.disableWebhookConfirm({ url: "https://hooks.example.com/lcc" });
  assert.match(copy, /Disable webhook endpoint https:\/\/hooks\.example\.com\/lcc/);
  assert.match(copy, /queued or failed deliveries already recorded are unaffected/);
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

// ── Workstream F: report path builders (timeseries / expiring / release-seats) ──
test("admin UI workflow builds the timeseries path with a from/to window for a last-N-days range", async () => {
  const workflow = await loadWorkflowModule();
  // A fixed `now` makes the from/to window deterministic. from = now - days*86400; to = now.
  const now = 1_700_000_000;
  assert.equal(
    workflow.timeseriesPath(7, undefined, now),
    `/api/admin/report/timeseries?from=${now - 7 * 86400}&to=${now}`,
  );
  assert.equal(
    workflow.timeseriesPath(30, undefined, now),
    `/api/admin/report/timeseries?from=${now - 30 * 86400}&to=${now}`,
  );
  // buckets rides along when provided.
  assert.equal(
    workflow.timeseriesPath(90, 24, now),
    `/api/admin/report/timeseries?from=${now - 90 * 86400}&to=${now}&buckets=24`,
  );
  // The exported range list is the three look-backs the selector offers.
  assert.deepEqual(workflow.TIMESERIES_RANGE_DAYS, [7, 30, 90]);
});

test("admin UI workflow builds the expiring + release-seats paths", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.expiringPath(30), "/api/admin/report/expiring?within_days=30");
  assert.equal(workflow.expiringPath(7), "/api/admin/report/expiring?within_days=7");
  // Compose with withCursor for the pager (mirrors the other lists).
  assert.equal(
    workflow.withCursor(workflow.expiringPath(90), "50"),
    "/api/admin/report/expiring?within_days=90&cursor=50",
  );
  assert.equal(workflow.releaseSeatsPath("ent-123"), "/api/admin/entitlements/ent-123/release-seats");
});

test("force-release confirm copy echoes the exact target and warns it frees all live seats", async () => {
  const workflow = await loadWorkflowModule();
  const copy = workflow.releaseSeatsConfirm({ project: "DEFAULT", feature: "pro", license_fingerprint: "a".repeat(64) });
  assert.match(copy, /Force-release ALL live seats for DEFAULT \/ pro/);
  assert.match(copy, new RegExp(workflow.shortHash("a".repeat(64))));
  assert.match(copy, /dead\/unreachable machine/);
});

// ── Workstream F: entitlement-health classifier ────────────────────────────────
test("admin UI workflow classifies entitlement health by status + valid_until window", async () => {
  const workflow = await loadWorkflowModule();
  const now = 1_700_000_000;
  const DAY = 86400;
  // suspended: disabled/revoked beats every date consideration.
  assert.equal(workflow.entitlementHealth("disabled", now + 100 * DAY, now), "suspended");
  assert.equal(workflow.entitlementHealth("revoked", null, now), "suspended");
  assert.equal(workflow.entitlementHealth("disabled", now - DAY, now), "suspended");
  // expired: active AND valid_until in the past (<= now).
  assert.equal(workflow.entitlementHealth("active", now - 1, now), "expired");
  assert.equal(workflow.entitlementHealth("active", now, now), "expired");
  // expiring: active AND valid_until within the default 30-day horizon.
  assert.equal(workflow.entitlementHealth("active", now + 5 * DAY, now), "expiring");
  assert.equal(workflow.entitlementHealth("active", now + 30 * DAY, now), "expiring");
  // healthy: active, non-expiring (null) OR expiry beyond the horizon.
  assert.equal(workflow.entitlementHealth("active", null, now), "healthy");
  assert.equal(workflow.entitlementHealth("active", undefined, now), "healthy");
  assert.equal(workflow.entitlementHealth("active", now + 31 * DAY, now), "healthy");
  // A custom horizon narrows/widens the expiring band.
  assert.equal(workflow.entitlementHealth("active", now + 10 * DAY, now, 7), "healthy");
  assert.equal(workflow.entitlementHealth("active", now + 10 * DAY, now, 14), "expiring");
  // An unknown status is never escalated (the status pill shows the raw value).
  assert.equal(workflow.entitlementHealth("pending", now - DAY, now), "healthy");
});

// ── Workstream F: inline-SVG chart geometry (pure helpers) ─────────────────────
test("admin UI workflow scaleY maps values y-down with a flat-series mid-line", async () => {
  const workflow = await loadWorkflowModule();
  // y-down: the MAX value sits at the top (= pad), the MIN at the bottom (= height - pad).
  assert.equal(workflow.scaleY(10, 0, 10, 100, 0), 0); // max -> top
  assert.equal(workflow.scaleY(0, 0, 10, 100, 0), 100); // min -> bottom
  assert.equal(workflow.scaleY(5, 0, 10, 100, 0), 50); // midpoint
  // pad insets both edges.
  assert.equal(workflow.scaleY(10, 0, 10, 100, 10), 10);
  assert.equal(workflow.scaleY(0, 0, 10, 100, 10), 90);
  // A flat series (max <= min, including all-zero) sits on the mid-line, not collapsed to an edge.
  assert.equal(workflow.scaleY(0, 0, 0, 100, 0), 50);
  assert.equal(workflow.scaleY(7, 7, 7, 100, 10), 50);
});

test("admin UI workflow pointXs spreads N points across the width", async () => {
  const workflow = await loadWorkflowModule();
  assert.deepEqual(workflow.pointXs(0, 600), []);
  assert.deepEqual(workflow.pointXs(1, 600), [0]); // single point pins to the left edge
  assert.deepEqual(workflow.pointXs(2, 600), [0, 600]);
  assert.deepEqual(workflow.pointXs(3, 600), [0, 300, 600]);
  assert.deepEqual(workflow.pointXs(5, 600), [0, 150, 300, 450, 600]);
});

test("admin UI workflow linePath emits a min/max-scaled polyline 'd' string", async () => {
  const workflow = await loadWorkflowModule();
  // Empty -> "" (the caller renders the empty-state).
  assert.equal(workflow.linePath([], 600, 100), "");
  // A single value -> a flat full-width segment at its scaled y (mid-line for a 1-point series).
  assert.equal(workflow.linePath([5], 600, 100, 0), "M 0 50 L 600 50");
  // A rising series: first point at the bottom (min), last at the top (max), y-down.
  assert.equal(workflow.linePath([0, 10], 600, 100, 0), "M 0 100 L 600 0");
  assert.equal(workflow.linePath([0, 5, 10], 600, 100, 0), "M 0 100 L 300 50 L 600 0");
  // A flat (all-equal) series rides the mid-line across the width.
  assert.equal(workflow.linePath([4, 4, 4], 600, 100, 0), "M 0 50 L 300 50 L 600 50");
});

test("admin UI workflow linePathScaled draws a series on an external shared y-scale", async () => {
  const workflow = await loadWorkflowModule();
  // Drawn against [0,10] regardless of the values' own range, so several series share one axis.
  assert.equal(workflow.linePathScaled([0, 5], 0, 10, 600, 100, 0), "M 0 100 L 600 50");
  assert.equal(workflow.linePathScaled([10, 10], 0, 10, 600, 100, 0), "M 0 0 L 600 0");
  // A degenerate external scale puts every point on the mid-line.
  assert.equal(workflow.linePathScaled([3, 7], 5, 5, 600, 100, 0), "M 0 50 L 600 50");
  assert.equal(workflow.linePathScaled([], 0, 10, 600, 100), "");
});

test("admin UI workflow areaPath closes the line down to the baseline", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.areaPath([], 600, 100), "");
  // The line, then down to the baseline at the last x, across to the first x, and closed (Z).
  assert.equal(workflow.areaPath([0, 10], 600, 100, 0), "M 0 100 L 600 0 L 600 100 L 0 100 Z");
  // A single value: a full-width flat segment, closed to the baseline.
  assert.equal(workflow.areaPath([5], 600, 100, 0), "M 0 50 L 600 50 L 600 100 L 0 100 Z");
  // areaPathScaled mirrors it on an external scale.
  assert.equal(workflow.areaPathScaled([0, 5], 0, 10, 600, 100, 0), "M 0 100 L 600 50 L 600 100 L 0 100 Z");
});

test("admin UI workflow barRects positions value-scaled bars from the baseline", async () => {
  const workflow = await loadWorkflowModule();
  assert.deepEqual(workflow.barRects([], 600, 100), []);
  // Two bars over width 600 -> slot 300; gap 0.2 -> barWidth 240, offset 30. Heights scale by the MAX.
  const rects = workflow.barRects([5, 10], 600, 100, 0.2);
  assert.equal(rects.length, 2);
  assert.deepEqual(rects[0], { x: 30, y: 50, w: 240, h: 50 }); // 5/10 -> half height
  assert.deepEqual(rects[1], { x: 330, y: 0, w: 240, h: 100 }); // 10/10 -> full height
  // An all-zero series -> zero-height bars sitting on the baseline (y === height).
  const zero = workflow.barRects([0, 0], 600, 100, 0.2);
  assert.equal(zero[0].h, 0);
  assert.equal(zero[0].y, 100);
});

test("admin UI workflow isEmptySeries guards the chart empty-state", async () => {
  const workflow = await loadWorkflowModule();
  assert.equal(workflow.isEmptySeries([]), true);
  assert.equal(workflow.isEmptySeries([0, 0, 0]), true);
  assert.equal(workflow.isEmptySeries([0, 1, 0]), false);
  assert.equal(workflow.isEmptySeries([3]), false);
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
