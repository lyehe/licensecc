import { expect, test } from "@playwright/test";

import { makeAdminApiFixture, makeEnvelope } from "./admin-ui.fixture.mjs";

for (const mode of [undefined, "legacy"]) {
  test(`protected creation does not accept a ${mode ?? "missing"} response mode`, async ({ page }) => {
    const api = makeAdminApiFixture();
    await page.route("**/api/admin/**", api.route);
    await page.route("**/api/admin/entitlements", async route => {
      if (route.request().method() !== "POST") return route.fallback();
      const row = api.seed.entitlement(route.request().postDataJSON());
      if (mode === undefined) delete row.enforcement_mode; else row.enforcement_mode = mode;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(makeEnvelope("entitlement_saved", row)) });
    });
    await page.goto("/#/entitlements");
    await page.getByRole("button", { name: "New entitlement", exact: true }).click();
    const form = page.getByRole("form", { name: "New entitlement" });
    await form.getByLabel("Protection", { exact: true }).selectOption("device_bound_v1");
    await form.getByLabel("License fingerprint", { exact: true }).fill("a".repeat(64));
    await form.getByText("Enter customer ID manually", { exact: true }).click();
    await form.getByLabel("Customer ID", { exact: true }).fill("cus_acme");
    await form.getByText("Enter license ID manually", { exact: true }).click();
    await form.getByLabel("License ID", { exact: true }).fill("lic_acme");
    await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reconcile status", exact: true })).toBeVisible();
    await expect(form.getByLabel("Protection", { exact: true })).toHaveValue("device_bound_v1");
    await expect(form.getByLabel("Protection", { exact: true })).toBeDisabled();
  });
}

test("protected creation requires ownership and preserves mode and key through response recovery", async ({ page }) => {
  const api = makeAdminApiFixture(), attempts = [];
  await page.route("**/api/admin/**", api.route);
  await page.route("**/api/admin/entitlements", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (attempts.length === 1) return route.abort("failed");
    return route.fallback();
  });
  await page.goto("/#/entitlements");
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const form = page.getByRole("form", { name: "New entitlement" });
  await form.getByLabel("Protection", { exact: true }).selectOption("device_bound_v1");
  await form.getByLabel("License fingerprint", { exact: true }).fill("a".repeat(64));
  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await expect(form.getByText("Choose the customer who owns this license.", { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(0);
  const customerDisclosure = form.getByText("Enter customer ID manually", { exact: true });
  if (await customerDisclosure.locator("..").getAttribute("open") === null) await customerDisclosure.click();
  await form.getByLabel("Customer ID", { exact: true }).fill("cus_acme");
  const licenseDisclosure = form.getByText("Enter license ID manually", { exact: true });
  if (await licenseDisclosure.locator("..").getAttribute("open") === null) await licenseDisclosure.click();
  await form.getByLabel("License ID", { exact: true }).fill("lic_acme");
  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await page.getByRole("button", { name: "Reconcile status", exact: true }).click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0].body.enforcement_mode).toBe("device_bound_v1");
  await expect(page.getByRole("status").filter({ hasText: "Status reconciled." })).toBeVisible();
  await expect(form.getByLabel("Protection", { exact: true })).toHaveValue("legacy");
});

async function openActionMenu(button) {
  const disclosure = button.locator("xpath=ancestor::details[1]");
  if (await disclosure.count() && await disclosure.getAttribute("open") === null) {
    await disclosure.locator(":scope > summary").click();
  }
}

async function clickAction(button) {
  await expect(button).toBeEnabled();
  await openActionMenu(button);
  await button.click();
}

async function openCatalogView(page, name) {
  const back = page.getByRole("button", { name: /^Back to (features|plans)$/ });
  if (await back.count() && await back.first().isVisible()) await back.first().click();
  await page.getByRole("navigation", { name: "Catalog views" }).getByRole("link", { name, exact: true }).click();
}

async function openCatalogEditor(page, view, trigger, formName) {
  await openCatalogView(page, view);
  const form = page.getByRole("form", { name: formName });
  if (!await form.isVisible()) await page.getByRole("button", { name: trigger, exact: true }).click();
  return form;
}

test("admin UI completes entitlement lifecycle and blocks duplicate create submissions", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "licensecc admin" })).toBeVisible();
  await page.getByRole("link", { name: "License access" }).click();

  if (!await page.locator("section.editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();

  const createForm = page.locator("section.editorLayout form");
  await createForm.getByLabel("Project").fill("DEFAULT");
  await createForm.getByLabel("Feature").fill("pro");
  await createForm.getByLabel("License fingerprint").fill("a".repeat(64));
  await createForm.getByText("Advanced settings", { exact: true }).click();
  await createForm.getByLabel("Assertion TTL (seconds)").fill("120");
  // Valid from / until are <input type="date"> (YYYY-MM-DD -> UTC-midnight epoch).
  await createForm.getByLabel("Valid from").fill("2024-03-09");
  await createForm.getByLabel("Valid until").fill("");
  await createForm.getByText("Enter customer ID manually", { exact: true }).click();
  await createForm.getByLabel("Customer ID").fill("cus_e2e");
  await createForm.getByText("Enter license ID manually", { exact: true }).click();
  await createForm.getByLabel("License ID").fill("lic_e2e");
  await createForm.getByLabel("Notes").fill("created from browser e2e");
  await page.evaluate(() => {
    const form = document.querySelector("section.editorLayout form");
    form.requestSubmit();
    form.requestSubmit();
  });

  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await expect.poll(() => api.requests.creates).toBe(1);
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();
  const createdRow = page.locator(".desktopRecords tbody tr").filter({ hasText: "cus_e2e" });
  await createdRow.getByText("Technical details", { exact: true }).click();
  await expect(createdRow).toContainText("120 seconds");
  await expect(createdRow).toContainText("cus_e2e");
  await expect(createdRow).toContainText("lic_e2e");

  await page.getByRole("button", { name: "Edit" }).click();
  const editForm = page.locator("section.editorLayout form");
  await editForm.getByText("Advanced settings", { exact: true }).click();
  await editForm.getByLabel("Assertion TTL (seconds)").fill("900");
  await editForm.getByLabel("Valid until").fill("2024-07-03");
  await editForm.getByText("Enter customer ID manually", { exact: true }).click();
  await editForm.getByLabel("Customer ID").fill("");
  await editForm.getByLabel("Notes").fill("");
  await editForm.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText(/entitlement_patched/)).toBeVisible();
  await expect.poll(() => api.requests.patches.length).toBe(1);
  expect(api.requests.patches[0]).toMatchObject({
    assertion_ttl_seconds: 900,
    valid_from: 1709942400,
    valid_until: 1719964800,
    notes: "",
    customer_id: null,
    license_id: "lic_e2e",
  });
  const patchedRow = page.locator(".desktopRecords tbody tr").filter({ hasText: "DEFAULT" });
  await patchedRow.getByText("Technical details", { exact: true }).click();
  await expect(patchedRow).toContainText("900 seconds");
  await expect(patchedRow).toContainText("ent-1");

  const entitlementActions = page.locator(".desktopRecords tbody tr").first();
  await clickAction(entitlementActions.getByRole("button", { name: "Disable", includeHidden: true }));
  await page.getByRole("dialog").getByLabel(/Reason/).fill("operator pause");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(entitlementActions.locator(".status.disabled")).toHaveText("disabled");

  await clickAction(entitlementActions.getByRole("button", { name: "Reenable", includeHidden: true }));
  await expect(entitlementActions.locator(".status.active")).toHaveText("active");

  // Revoke is irreversible -> it now opens a typed-confirm modal; the action fires only on Confirm.
  await clickAction(entitlementActions.getByRole("button", { name: "Revoke", includeHidden: true }));
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".status.revoked")).toHaveCount(0); // not revoked until confirmed
  await page.getByRole("dialog").getByLabel(/Reason/).fill("chargeback");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(entitlementActions.locator(".status.revoked")).toHaveText("revoked");
  await expect(entitlementActions.getByRole("button", { name: "Edit" })).toBeDisabled();
  const revokedReenable = entitlementActions.getByRole("button", { name: "Reenable", includeHidden: true });
  await expect(revokedReenable).toHaveCount(0);

  if (await page.getByRole("button", { name: "Activity", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("link", { name: "Events" }).click();
  for (const eventType of ["create", "update", "disable", "reenable", "revoke"]) {
    await expect(page.getByText(eventType, { exact: true })).toBeVisible();
  }
  await page.getByText("Event details", { exact: true }).first().click();
  await expect(page.getByText("admin@example.com (access)", { exact: true }).first()).toBeVisible();

  const pageText = await page.locator("body").innerText();
  expect(pageText).not.toContain("PRIVATE KEY");
  expect(pageText).not.toContain("BEGIN");
  expect(pageText).not.toContain("Bearer ");
  expect(pageText).not.toContain("Cf-Access-Jwt-Assertion");
});

test("admin UI runs bulk transitions, global search deep-link, and CSV export", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);

  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();

  // Seed two entitlements via the create form (the fixture stores them so bulk/search can act).
  async function createEntitlement(feature, fingerprint) {
    if (!await page.locator("section.editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
    const createForm = page.locator("section.editorLayout form");
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("License fingerprint").fill(fingerprint);
    await createForm.getByRole("button", { name: "Create entitlement" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }
  await createEntitlement("pro", "a".repeat(64));
  await createEntitlement("ent", "b".repeat(64));
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();
  await expect(page.locator("tbody input[type=checkbox]")).toHaveCount(2);

  // BULK: select all loaded rows -> the bulk bar appears -> Disable -> typed-confirm (reason) -> Confirm.
  await page.getByLabel("Select all loaded rows").check();
  await expect(page.locator(".bulkBar")).toContainText("2 selected");
  await clickAction(page.locator(".bulkBar").getByRole("button", { name: "Disable", includeHidden: true }));
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByLabel(/Reason/).fill("quarterly audit");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.batches.length).toBe(1);
  expect(api.requests.batches[0]).toMatchObject({ action: "disable", reason: "quarterly audit" });
  expect(api.requests.batches[0].ids).toHaveLength(2);
  // The per-row roll-up renders in the status line, and the rows refreshed to disabled.
  await expect(page.getByText(/disable: 2 ok/)).toBeVisible();
  await expect(page.locator(".desktopRecords .status.disabled")).toHaveCount(2);
  // Selection cleared after the batch (the bulk bar is gone).
  await expect(page.locator(".bulkBar")).toHaveCount(0);

  // GLOBAL SEARCH: search a customer name -> results dropdown -> click -> deep-link to Customers tab.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Global search").fill("Acme");
  await page.getByRole("button", { name: "Search records", exact: true }).click();
  await expect(page.locator(".searchResults")).toBeVisible();
  await expect.poll(() => api.requests.searches.at(-1)).toBe("Acme");
  await page.locator(".searchResult").filter({ hasText: "Acme Corp" }).click();
  // Deep-linked: Customers tab is active and the searched customer's detail pane is open.
  await expect(page.locator(".sidebar nav a[aria-current=page]")).toHaveText("Customers");
  await expect(page.getByRole("heading", { name: "Acme Corp" })).toBeVisible();
  await expect(page.locator(".searchResults")).toHaveCount(0);

  // CSV EXPORT: the Customers pane Export CSV button hits ?format=csv with the active filter.
  await page.getByRole("button", { name: "Back to customers" }).click();
  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect.poll(() => api.requests.csvExports.length).toBeGreaterThan(0);
  expect(api.requests.csvExports.at(-1)).toBe("/api/admin/customers");
  await expect(page.getByText(/exported customers\.csv/)).toBeVisible();
});

test("admin UI retains the server-owned four-entitlement batch limit", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator("section.editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator("section.editorLayout form");
  for (const [index, fingerprint] of ["a", "b", "c", "d", "e"].entries()) {
    await createForm.getByLabel("Feature").fill(`batch-${index}`);
    await createForm.getByLabel("License fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Create entitlement" }).click();
    await expect.poll(() => api.requests.creates).toBe(index + 1);
  }
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();
  const rowChecks = page.locator("tbody input[type=checkbox]");
  await expect(rowChecks).toHaveCount(5);
  await page.getByLabel("Select all loaded rows").check();
  await expect(page.locator(".bulkBar")).toContainText("4 selected (maximum 4 per batch)");
  await expect(page.getByText("Select up to 4 entitlements per batch.", { exact: true })).toBeVisible();
  await expect(rowChecks.nth(4)).toBeDisabled();
  await clickAction(page.locator(".bulkBar").getByRole("button", { name: "Disable", includeHidden: true }));
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("four-row free tier proof");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.batches.length).toBe(1);
  expect(api.requests.batches[0].ids).toHaveLength(4);
  expect(api.requests.batches[0].ids).not.toContain("ent-5");
});

test("admin UI previews and applies a license plan projection", async ({ page }) => {
  page.on("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("Discard this unsaved catalog task?");
    await dialog.accept();
  });
  const api = makeAdminApiFixture();
  // Plan-feature policy IDs must resolve against the complete active-policy
  // selector, just as they do in the Worker contract.
  api.seed.policy("pol_node", "Node policy");
  api.seed.policy("pol_float", "Capacity policy");
  await page.route("**/api/admin/**", api.route);

  await page.goto("/");
  if (await page.getByRole("button", { name: "Configuration", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("link", { name: "Plans & features" }).click();
  await expect(page.locator(".sidebar nav a[aria-current=page]")).toHaveText("Plans & features");

  let featureForm = await openCatalogEditor(page, "Features", "New feature", "Catalog feature");
  await featureForm.getByLabel("Feature key").fill("core");
  await featureForm.getByLabel("Name").fill("Core");
  await featureForm.getByRole("button", { name: "Create feature" }).click();
  await expect.poll(() => api.requests.catalogFeatures.length).toBe(1);
  await expect(page.getByText(/catalog_feature_created/)).toBeVisible();
  featureForm = await openCatalogEditor(page, "Features", "New feature", "Catalog feature");
  await featureForm.getByLabel("Feature key").fill("team");
  await featureForm.getByLabel("Name").fill("Team Seats");
  await featureForm.getByRole("button", { name: "Create feature" }).click();
  await expect.poll(() => api.requests.catalogFeatures.length).toBe(2);

  const catalogPlanForm = await openCatalogEditor(page, "Plans", "New plan", "Catalog plan");
  await catalogPlanForm.getByLabel("Plan key").fill("pro");
  await catalogPlanForm.getByLabel("Name").fill("Pro");
  await catalogPlanForm.getByRole("button", { name: "Create plan" }).click();
  await expect.poll(() => api.requests.catalogPlans.length).toBe(1);
  await expect(page.getByText(/catalog_plan_created/)).toBeVisible();
  await page.getByRole("button", { name: "Back to plans", exact: true }).click();

  await page.getByRole("row", { name: /Pro pro/ }).getByRole("button", { name: "View plan", exact: true }).click();
  await page.getByRole("button", { name: "Add feature", exact: true }).click();
  const planFeatureForm = page.getByRole("form", { name: "Plan feature" });
  await planFeatureForm.getByLabel("Feature key").fill("core");
  await planFeatureForm.getByLabel("Policy", { exact: true }).selectOption("pol_node");
  await planFeatureForm.getByRole("button", { name: "Save plan feature" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatures.length).toBe(1);
  await expect(page.getByText(/catalog_plan_feature_saved/)).toBeVisible();

  await planFeatureForm.getByLabel("Feature key").fill("team");
  await planFeatureForm.getByLabel("Inclusion").selectOption("addon");
  await planFeatureForm.getByLabel("Add-on key").fill("team_seats");
  await planFeatureForm.getByLabel("Policy", { exact: true }).selectOption("pol_float");
  await planFeatureForm.getByLabel("Pool size").fill("6");
  await planFeatureForm.getByLabel("Max devices").fill("6");
  await planFeatureForm.getByLabel("Max borrow").fill("172800");
  await planFeatureForm.getByRole("button", { name: "Save plan feature" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatures.length).toBe(2);
  expect(api.requests.catalogPlanFeatures[1]).toMatchObject({
    plan_id: "plan_pro",
    feature_key: "team",
    feature_inclusion: "addon",
    addon_key: "team_seats",
    policy_id: "pol_float",
    pool_size: 6,
    max_active_devices: 6,
    max_borrow_sec: 172800,
  });
  await page.getByRole("button", { name: "Back to plans", exact: true }).click();
  await page.getByRole("row", { name: /Pro pro/ }).getByRole("button", { name: "View plan", exact: true }).click();
  await expect(page.getByRole("row", { name: /Team Seats team addon team_seats pol_float/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "team_seats", exact: true })).toBeVisible();

  await openCatalogView(page, "Features");
  await page.getByRole("row", { name: /Core core/ }).getByRole("button", { name: "Edit" }).click();
  await featureForm.getByLabel("Name").fill("Core Runtime");
  await featureForm.getByLabel("Category").fill("");
  await featureForm.getByRole("button", { name: "Update feature" }).click();
  await expect.poll(() => api.requests.catalogFeaturePatches.length).toBe(1);
  expect(api.requests.catalogFeaturePatches[0]).toMatchObject({ id: "feat_core", name: "Core Runtime", category: "" });
  await expect(page.getByText(/catalog_feature_patched/)).toBeVisible();
  await page.getByRole("button", { name: "Back to features", exact: true }).click();

  const featureRow = page.getByRole("row", { name: /Core Runtime core/ });
  await clickAction(featureRow.getByRole("button", { name: "Disable", includeHidden: true }));
  await page.getByLabel("Reason (required)").fill("catalog lifecycle test");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogFeatureTransitions.length).toBe(1);
  expect(api.requests.catalogFeatureTransitions[0]).toMatchObject({ id: "feat_core", action: "disable", reason: "catalog lifecycle test" });
  await expect(page.getByText(/catalog_feature_disabled/)).toBeVisible();
  await clickAction(featureRow.getByRole("button", { name: "Reenable", includeHidden: true }));
  await expect.poll(() => api.requests.catalogFeatureTransitions.length).toBe(2);
  expect(api.requests.catalogFeatureTransitions[1]).toMatchObject({ id: "feat_core", action: "reenable" });

  await openCatalogView(page, "Plans");
  await page.getByRole("row", { name: /Pro pro/ }).getByRole("button", { name: "Edit" }).click();
  await catalogPlanForm.getByLabel("Name").fill("Pro Annual");
  await catalogPlanForm.getByLabel("Description").fill("Annual plan");
  await catalogPlanForm.getByRole("button", { name: "Update plan" }).click();
  await expect.poll(() => api.requests.catalogPlanPatches.length).toBe(1);
  expect(api.requests.catalogPlanPatches[0]).toMatchObject({ id: "plan_pro", name: "Pro Annual", description: "Annual plan" });
  await expect(page.getByText(/catalog_plan_patched/)).toBeVisible();
  await page.getByRole("button", { name: "Back to plans", exact: true }).click();

  await page.getByRole("row", { name: /Pro Annual pro/ }).getByRole("button", { name: "View plan", exact: true }).click();
  const planFeatureRow = page.getByRole("row", { name: /Team Seats team addon team_seats pol_float/ });
  await clickAction(planFeatureRow.getByRole("button", { name: "Disable", includeHidden: true }));
  await page.getByLabel("Reason (required)").fill("hide add-on");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatureTransitions.length).toBe(1);
  expect(api.requests.catalogPlanFeatureTransitions[0]).toMatchObject({ plan_id: "plan_pro", feature_key: "team", action: "disable", reason: "hide add-on" });
  await clickAction(planFeatureRow.getByRole("button", { name: "Reenable", includeHidden: true }));
  await expect.poll(() => api.requests.catalogPlanFeatureTransitions.length).toBe(2);

  await openCatalogView(page, "Plans");
  const planRow = page.getByRole("row", { name: /Pro Annual pro/ });
  await clickAction(planRow.getByRole("button", { name: "Disable", includeHidden: true }));
  await page.getByLabel("Reason (required)").fill("pause plan");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogPlanTransitions.length).toBe(1);
  expect(api.requests.catalogPlanTransitions[0]).toMatchObject({ id: "plan_pro", action: "disable", reason: "pause plan" });
  await clickAction(planRow.getByRole("button", { name: "Reenable", includeHidden: true }));
  await expect.poll(() => api.requests.catalogPlanTransitions.length).toBe(2);

  await clickAction(planRow.getByRole("button", { name: "Export", includeHidden: true }));
  await expect.poll(() => api.requests.catalogPlanExports.length).toBe(1);
  expect(api.requests.catalogPlanExports[0]).toBe("plan_pro");

  await openCatalogView(page, "Import");
  const importForm = page.getByRole("form", { name: "Catalog import" });
  await importForm.getByLabel("Manifest JSON").fill(JSON.stringify({ format_version: 1, features: [], plans: [] }));
  await importForm.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(1);
  expect(api.requests.catalogImports[0]).toMatchObject({ dry_run: true, body: { format_version: 1, features: [], plans: [] } });
  await expect(page.getByText(/catalog_import_previewed/)).toBeVisible();

  const importedManifest = {
    format_version: 1,
    features: [
      { project: "DEFAULT", feature_key: "analytics", name: "Analytics", description: "Usage analytics", category: "insights", status: "active" },
    ],
    plans: [
      {
        project: "DEFAULT",
        plan_key: "growth",
        name: "Growth",
        description: "Growth tier",
        version: 1,
        status: "active",
        features: [
          { project: "DEFAULT", feature_key: "analytics", feature_inclusion: "included", addon_key: null, policy_id: "pol_node", status: "active", display_order: 4, assertion_ttl_seconds: null, pool_size: null, max_active_devices: null, max_borrow_sec: null, meter_quota: null, meter_period_sec: null },
        ],
      },
    ],
  };
  await importForm.getByLabel("Manifest JSON").fill(JSON.stringify(importedManifest));
  // Editing the manifest invalidates the previous persisted capability. Apply
  // cannot re-read the textarea or bypass a fresh Preview.
  await expect(importForm.getByRole("button", { name: "Apply import" })).toBeDisabled();
  await importForm.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(2);
  expect(api.requests.catalogImports[1]).toMatchObject({ dry_run: true, body: importedManifest, idempotency_key: null });
  await expect(page.getByText(/Server preview civ_ui_/)).toBeVisible();
  await expect(page.getByText(/Local manifest digest [0-9a-f]{64}/)).toBeVisible();
  const importDelta = page.locator("details").filter({ hasText: "Before → after" }).first();
  await expect(importDelta).toBeVisible();
  await importDelta.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(importDelta).toContainText("status");
  await importForm.getByRole("button", { name: "Apply import" }).click();
  const importDialog = page.getByRole("dialog");
  await expect(importDialog).toContainText("Apply catalog import");
  await expect(importDialog).toContainText("Features: 1 create, 0 update, 0 disable, 0 reenable, 0 unchanged");
  await expect(importDialog).toContainText("Server preview civ_ui_");
  expect(api.requests.catalogImports).toHaveLength(2);
  await importDialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(3);
  expect(api.requests.catalogImports[2]).toMatchObject({ dry_run: false, body: { preview_id: expect.stringMatching(/^civ_ui_/) } });
  expect(api.requests.catalogImports[2].idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  expect(Object.keys(api.requests.catalogImports[2].body)).toEqual(["preview_id"]);
  await expect(page.getByText(/catalog_import_applied/)).toBeVisible();
  await openCatalogView(page, "Plans");
  await expect(page.getByRole("row", { name: /Growth growth/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Analytics analytics/ })).toHaveCount(0);
  await page.getByRole("row", { name: /Growth growth/ }).getByRole("button", { name: "View plan", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Plan features / growth" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Analytics analytics included - pol_node/ })).toBeVisible();

  await openCatalogView(page, "Plans");
  await page.getByRole("button", { name: "Apply plan", exact: true }).click();
  const form = page.getByRole("form", { name: "Plan projection" });
  let projectionNotes = "";
  async function fillProjectionForm() {
    await form.getByLabel("License ID").fill("lic_plan");
    await form.getByLabel("Fingerprint").fill("c".repeat(64));
    await form.getByLabel("Customer ID").fill("cus_plan");
    await form.getByLabel("Plan key").fill("pro");
    await form.getByLabel("Support until").fill("2026-07-05");
    await form.getByLabel("Add-ons (csv)").fill("team_seats");
    await form.getByLabel("Notes").fill(projectionNotes);
  }
  async function openProjectionEditor() {
    if (!await form.isVisible()) {
      const backToPlans = page.getByRole("button", { name: "Back to plans", exact: true });
      if (await backToPlans.isVisible()) await backToPlans.click();
      await openCatalogView(page, "Plans");
      await page.getByRole("button", { name: "Apply plan", exact: true }).click();
    }
    await fillProjectionForm();
  }
  await fillProjectionForm();
  await form.getByRole("button", { name: "Preview" }).click();

  await expect.poll(() => api.requests.planPreviews.length).toBe(1);
  expect(api.requests.planPreviews[0]).toMatchObject({
    project: "DEFAULT",
    license_id: "lic_plan",
    plan_key: "pro",
    support_until: 1783209600,
    addons: ["team_seats"],
  });
  await expect(page.getByText(/license_plan_projection_previewed/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "core", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "team", exact: true })).toBeVisible();
  await expect(page.getByText("floating")).toBeVisible();

  const applyButton = form.getByRole("button", { name: "Apply" });
  await expect(applyButton).toBeEnabled();
  await expect(page.getByText(/Server preview ppv_ui_/)).toBeVisible();
  await page.getByText("Technical details", { exact: true }).click();
  await expect(page.getByText(/Local form digest [0-9a-f]{64}/)).toBeVisible();

  // Any projection-form edit invalidates the bound preview until the operator previews again.
  projectionNotes = "changed after preview";
  await form.getByLabel("Notes").fill(projectionNotes);
  await expect(applyButton).toBeDisabled();
  await expect.poll(() => api.requests.planApplies.length).toBe(0);

  let expectedPreviews = 1;
  async function freshPreview() {
    await fillProjectionForm();
    await form.getByRole("button", { name: "Preview" }).click();
    expectedPreviews += 1;
    await expect.poll(() => api.requests.planPreviews.length).toBe(expectedPreviews);
    await expect(applyButton).toBeEnabled();
  }

  await freshPreview();
  expect(api.requests.planPreviews[1]).toMatchObject({
    notes: "changed after preview",
  });

  // Each successful catalog dependency mutation invalidates the projection binding.
  await openCatalogView(page, "Features");
  const coreFeatureRow = page.getByRole("row", { name: /Core Runtime core/ });
  await coreFeatureRow.getByRole("button", { name: "Edit" }).click();
  await featureForm.getByLabel("Name").fill("Core Runtime v2");
  await featureForm.getByRole("button", { name: "Update feature" }).click();
  await expect.poll(() => api.requests.catalogFeaturePatches.length).toBe(2);
  await openProjectionEditor();
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  await openCatalogView(page, "Features");
  await clickAction(page.getByRole("row", { name: /Core Runtime v2 core/ }).getByRole("button", { name: "Disable", includeHidden: true }));
  await page.getByLabel("Reason (required)").fill("invalidate projection feature");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogFeatureTransitions.length).toBe(3);
  await openProjectionEditor();
  await expect(applyButton).toBeDisabled();
  await openCatalogView(page, "Features");
  await clickAction(page.getByRole("row", { name: /Core Runtime v2 core/ }).getByRole("button", { name: "Reenable", includeHidden: true }));
  await expect.poll(() => api.requests.catalogFeatureTransitions.length).toBe(4);
  await openProjectionEditor();
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  await openCatalogView(page, "Plans");
  const proPlanRow = page.getByRole("row", { name: /Pro Annual pro/ });
  await proPlanRow.getByRole("button", { name: "Edit" }).click();
  await catalogPlanForm.getByLabel("Description").fill("Annual plan v2");
  await catalogPlanForm.getByRole("button", { name: "Update plan" }).click();
  await expect.poll(() => api.requests.catalogPlanPatches.length).toBe(2);
  await openProjectionEditor();
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  await openCatalogView(page, "Plans");
  await clickAction(page.getByRole("row", { name: /Pro Annual pro/ }).getByRole("button", { name: "Disable", includeHidden: true }));
  await page.getByLabel("Reason (required)").fill("invalidate projection plan");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogPlanTransitions.length).toBe(3);
  await openProjectionEditor();
  await expect(applyButton).toBeDisabled();
  await openCatalogView(page, "Plans");
  await clickAction(page.getByRole("row", { name: /Pro Annual pro/ }).getByRole("button", { name: "Reenable", includeHidden: true }));
  await expect.poll(() => api.requests.catalogPlanTransitions.length).toBe(4);
  await openProjectionEditor();
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  await openCatalogView(page, "Plans");
  await page.getByRole("row", { name: /Pro Annual pro/ }).getByRole("button", { name: "View plan", exact: true }).click();
  await page.getByRole("button", { name: "Add feature", exact: true }).click();
  await planFeatureForm.getByLabel("Feature key").fill("analytics");
  await planFeatureForm.getByLabel("Policy", { exact: true }).selectOption("pol_node");
  await planFeatureForm.getByRole("button", { name: "Save plan feature" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatures.length).toBe(3);
  await openProjectionEditor();
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  await openCatalogView(page, "Plans");
  await page.getByRole("row", { name: /Pro Annual pro/ }).getByRole("button", { name: "View plan", exact: true }).click();
  const analyticsRow = page.getByRole("row", { name: /Analytics analytics included - pol_node/ });
  await clickAction(analyticsRow.getByRole("button", { name: "Disable", includeHidden: true }));
  await page.getByLabel("Reason (required)").fill("invalidate projection row");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatureTransitions.length).toBe(3);
  await openProjectionEditor();
  await expect(applyButton).toBeDisabled();
  await openCatalogView(page, "Plans");
  await page.getByRole("row", { name: /Pro Annual pro/ }).getByRole("button", { name: "View plan", exact: true }).click();
  await clickAction(analyticsRow.getByRole("button", { name: "Reenable", includeHidden: true }));
  await expect.poll(() => api.requests.catalogPlanFeatureTransitions.length).toBe(4);
  await openProjectionEditor();
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  await openCatalogView(page, "Import");
  await importForm.getByLabel("Manifest JSON").fill(JSON.stringify(importedManifest));
  await expect(importForm.getByRole("button", { name: "Apply import" })).toBeDisabled();
  await importForm.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(4);
  await importForm.getByRole("button", { name: "Apply import" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(5);
  await openProjectionEditor();
  await expect(applyButton).toBeDisabled();
  await openCatalogView(page, "Plans");
  await page.getByRole("row", { name: /Growth growth/ }).getByRole("button", { name: "View plan", exact: true }).click();
  await page.getByRole("button", { name: "Apply plan", exact: true }).click();
  await form.getByLabel("Plan ID").fill("");
  await form.getByLabel("Plan key").fill("pro");
  await freshPreview();

  // Returning to the pane and refreshing its catalog data both require a new preview.
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (await page.getByRole("button", { name: "Configuration", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Plans & features", exact: true }).click();
  await page.getByRole("button", { name: "Apply plan", exact: true }).click();
  await expect(applyButton).toBeDisabled();
  await freshPreview();
  await page.getByRole("button", { name: "Back to plans", exact: true }).click();
  await page.locator(".tablePane .filters").first().locator("input").fill("DEFAULT");
  await openProjectionEditor();
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  await applyButton.click();
  await expect.poll(() => api.requests.planApplies.length).toBe(1);
  expect(api.requests.planApplies[0]).toEqual({ preview_id: expect.stringMatching(/^ppv_ui_/) });
  await expect(applyButton).toBeDisabled();
  await expect(page.getByText(/Execution result; re-preview required before another Apply/)).toBeVisible();
  await expect(page.getByText(/license_plan_projection_applied/)).toBeVisible();

  await page.getByRole("link", { name: "License access", exact: true }).click();
  await expect(page.getByRole("cell", { name: /DEFAULT\s+core/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /DEFAULT\s+team/ })).toBeVisible();
  await expect(page.locator(".desktopRecords").getByText("floating", { exact: true })).toBeVisible();
  const projectedEntitlement = page.locator(".desktopRecords tbody tr").filter({ hasText: "core" }).first();
  await projectedEntitlement.getByText("Technical details", { exact: true }).click();
  await expect(projectedEntitlement).toContainText("License ID");
  await expect(projectedEntitlement).toContainText("lic_plan");
});
