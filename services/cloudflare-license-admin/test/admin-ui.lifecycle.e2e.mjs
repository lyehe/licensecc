import { expect } from "@playwright/test";

import { fillProtectedOwner, makeAdminApiFixture, makeEnvelope, test } from "./admin-ui.fixture.mjs";

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
    await form.getByLabel("License fingerprint", { exact: true }).fill("a".repeat(64));
    await form.getByText("Enter customer ID manually", { exact: true }).click();
    await form.getByLabel("Customer ID", { exact: true }).fill("cus_acme");
    await form.getByText("Enter license ID manually", { exact: true }).click();
    await form.getByLabel("License ID", { exact: true }).fill("lic_acme");
    await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reconcile status", exact: true })).toBeVisible();
    // The form stays open with its fields locked until the ambiguous create is reconciled.
    await expect(form.getByLabel("License fingerprint", { exact: true })).toBeDisabled();
  });
}

test("the create form has no protection choice", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/entitlements");
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const form = page.getByRole("form", { name: "New entitlement" });
  await expect(form.getByLabel("Protection", { exact: true })).toHaveCount(0);
  await expect(form.getByText("Protected devices", { exact: false })).toBeVisible();
});

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
  // The reconciled create opens its record: the form closes, and a new one starts over as protected.
  await expect(form).toHaveCount(0);
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  await expect(form.getByText("Protected devices", { exact: false })).toBeVisible();
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
  // The sidebar brand is plain text, not a heading; the workspace's own page title is the one h1.
  await expect(page.getByText("Licensecc admin", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "licensecc admin" })).toHaveCount(0);
  await page.getByRole("link", { name: "License access" }).click();

  if (!await page.locator("section.editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();

  const createForm = page.locator("section.editorLayout form");
  await createForm.getByLabel("Project").fill("DEFAULT");
  await createForm.getByLabel("Feature").fill("pro");
  await createForm.getByLabel("License fingerprint").fill("a".repeat(64));
  // A protected grant has no device hash or assertion TTL, so the form offers neither.
  await expect(createForm.getByText("Advanced settings", { exact: true })).toHaveCount(0);
  await expect(createForm.getByLabel(/device hash|assertion ttl/i)).toHaveCount(0);
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

  await expect(page.getByText("License (entitlement) created.")).toBeVisible();
  await expect.poll(() => api.requests.creates).toBe(1);
  const createdRow = page.locator(".desktopRecords tbody tr").filter({ hasText: "cus_e2e" });
  await createdRow.getByText("Technical details", { exact: true }).click();
  // The record's details name no device restriction, assertion TTL or borrowing.
  await expect(createdRow).not.toContainText(/device restriction|assertion ttl|borrow/i);
  await expect(createdRow).toContainText("cus_e2e");
  await expect(createdRow).toContainText("lic_e2e");

  await page.getByRole("button", { name: "Edit" }).click();
  const editForm = page.locator("section.editorLayout form");
  await expect(editForm.getByLabel(/device hash|assertion ttl/i)).toHaveCount(0);
  await editForm.getByLabel("Valid until").fill("2024-07-03");
  await editForm.getByText("Enter customer ID manually", { exact: true }).click();
  await editForm.getByLabel("Customer ID").fill("");
  await editForm.getByLabel("Notes").fill("");
  await editForm.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText("Entitlement changes saved.")).toBeVisible();
  await expect.poll(() => api.requests.patches.length).toBe(1);
  // The Worker refuses a PATCH naming a device hash or an assertion TTL, so the console sends neither.
  expect(api.requests.patches[0]).not.toHaveProperty("assertion_ttl_seconds");
  expect(api.requests.patches[0]).not.toHaveProperty("device_hash");
  expect(api.requests.patches[0]).toMatchObject({
    valid_from: 1709942400,
    valid_until: 1719964800,
    notes: "",
    customer_id: null,
    license_id: "lic_e2e",
  });
  const patchedRow = page.locator(".desktopRecords tbody tr").filter({ hasText: "DEFAULT" });
  await patchedRow.getByText("Technical details", { exact: true }).click();
  await expect(patchedRow).not.toContainText(/device restriction|assertion ttl|borrow/i);
  await expect(patchedRow).toContainText("ent-1");

  const entitlementActions = page.locator(".desktopRecords tbody tr").first();
  await clickAction(entitlementActions.getByRole("button", { name: "Disable", includeHidden: true }));
  await page.getByRole("dialog").getByLabel(/Reason/).fill("operator pause");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(entitlementActions.locator(".status.disabled")).toHaveText("suspended");

  await clickAction(entitlementActions.getByRole("button", { name: "Reenable", includeHidden: true }));
  await expect(entitlementActions.locator(".status.active")).toHaveText("active");

  // Revoke is irreversible -> it now opens a typed-confirm modal; the action fires only on the renamed button.
  await clickAction(entitlementActions.getByRole("button", { name: "Revoke", includeHidden: true }));
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".status.revoked")).toHaveCount(0); // not revoked until confirmed
  await page.getByRole("dialog").getByLabel(/Reason/).fill("chargeback");
  const revokeConfirm = page.getByRole("dialog").getByRole("button", { name: "Revoke", exact: true });
  await expect(revokeConfirm).toBeDisabled();
  // A reason alone is not enough for a terminal action: the operator must also type the exact phrase.
  await page.getByRole("dialog").getByLabel("Type REVOKE 1 to confirm").fill("REVOKE 1");
  await expect(revokeConfirm).toBeEnabled();
  await revokeConfirm.click();
  await expect(entitlementActions.locator(".status.revoked")).toHaveText("revoked");
  await expect(entitlementActions.getByRole("button", { name: "Edit" })).toBeDisabled();
  const revokedReenable = entitlementActions.getByRole("button", { name: "Reenable", includeHidden: true });
  await expect(revokedReenable).toHaveCount(0);

  if (await page.getByRole("button", { name: "Activity", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("link", { name: "Events" }).click();
  // Reason and Actor are dedicated columns: the disable/revoke reasons typed above, and who did
  // it, are both visible without expanding anything.
  const eventRows = page.locator('[aria-label="Audit event records"] tbody tr');
  for (const eventType of ["create", "update", "disable", "reenable", "revoke"]) {
    await expect(eventRows.getByRole("cell", { name: eventType, exact: true })).toBeVisible();
  }
  await expect(eventRows.filter({ hasText: "disable" }).getByRole("cell", { name: "operator pause" })).toBeVisible();
  await expect(eventRows.filter({ hasText: "revoke" }).getByRole("cell", { name: "chargeback" })).toBeVisible();
  await expect(eventRows.first().getByRole("cell", { name: "admin@example.com" })).toBeVisible();
  await page.getByText("Event details", { exact: true }).first().click();
  await expect(page.getByText("access", { exact: true }).first()).toBeVisible();

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
    await fillProtectedOwner(createForm);
    await createForm.getByRole("button", { name: "Create entitlement" }).click();
    await expect(page.getByText("License (entitlement) created.")).toBeVisible();
  }
  await createEntitlement("pro", "a".repeat(64));
  await createEntitlement("ent", "b".repeat(64));
  await expect(page.locator("tbody input[type=checkbox]")).toHaveCount(2);

  // BULK: select all loaded rows -> the bulk bar appears -> Disable -> typed-confirm (reason) -> Confirm.
  await page.getByLabel(/^Select all \d+ loaded$/).check();
  await expect(page.locator(".bulkBar")).toContainText("2 selected");
  await clickAction(page.locator(".bulkBar").getByRole("button", { name: "Disable", includeHidden: true }));
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByLabel(/Reason/).fill("quarterly audit");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.batches.length).toBe(1);
  expect(api.requests.batches[0]).toMatchObject({ action: "disable", reason: "quarterly audit" });
  expect(api.requests.batches[0].ids).toHaveLength(2);
  // The per-row roll-up renders in the status line, and the rows refreshed to disabled.
  await expect(page.getByText("Disable finished: 2 done.")).toBeVisible();
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
  await expect(page.getByText("Exported customers.csv.")).toBeVisible();
});

test("admin UI retains the server-owned four-entitlement batch limit", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator("section.editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator("section.editorLayout form");
  for (const [index, fingerprint] of ["a", "b", "c", "d", "e"].entries()) {
    if (!await createForm.isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
    await createForm.getByLabel("Feature").fill(`batch-${index}`);
    await createForm.getByLabel("License fingerprint").fill(fingerprint.repeat(64));
    await fillProtectedOwner(createForm);
    await createForm.getByRole("button", { name: "Create entitlement" }).click();
    await expect.poll(() => api.requests.creates).toBe(index + 1);
  }
  const rowChecks = page.locator("tbody input[type=checkbox]");
  await expect(rowChecks).toHaveCount(5);
  // Selection is no longer capped: the fifth row is selectable, and the run splits it off into
  // its own request, so no single request ever carries more than the Worker's four ids.
  await page.getByLabel("Select all 5 loaded", { exact: true }).check();
  await expect(page.locator(".bulkBar")).toContainText("5 selected");
  await expect(page.locator(".bulkBar")).toContainText("2 chunks of up to 4");
  await expect(rowChecks.nth(4)).toBeEnabled();
  await clickAction(page.locator(".bulkBar").getByRole("button", { name: "Disable", includeHidden: true }));
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("four-row free tier proof");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.batches.length).toBe(2);
  expect(api.requests.batches.map((batch) => batch.ids)).toEqual([["ent-1", "ent-2", "ent-3", "ent-4"], ["ent-5"]]);
});

test("admin UI gates a batch revoke behind an exact typed REVOKE phrase", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator("section.editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator("section.editorLayout form");
  for (const [index, fingerprint] of ["a", "b", "c", "d"].entries()) {
    if (!await createForm.isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
    await createForm.getByLabel("Feature").fill(`revoke-batch-${index}`);
    await createForm.getByLabel("License fingerprint").fill(fingerprint.repeat(64));
    await fillProtectedOwner(createForm);
    await createForm.getByRole("button", { name: "Create entitlement" }).click();
    await expect.poll(() => api.requests.creates).toBe(index + 1);
  }
  await page.getByLabel("Select all 4 loaded", { exact: true }).check();
  await expect(page.locator(".bulkBar")).toContainText("4 selected");
  await clickAction(page.locator(".bulkBar").getByRole("button", { name: "Revoke selected", includeHidden: true }));
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "Revoke", exact: true });
  const typed = dialog.getByLabel("Type REVOKE 4 to confirm");
  // The dialog itself moves focus to the typed field when it opens (the field has no autofocus of its own).
  await expect(typed).toBeFocused();
  await dialog.getByLabel(/Reason/).fill("mass revoke test");
  await expect(confirm).toBeDisabled();
  await typed.fill("revoke 4");
  await expect(confirm).toBeDisabled(); // the match is case-sensitive
  await typed.fill("REVOKE 3");
  await expect(confirm).toBeDisabled(); // the count must match exactly
  await typed.fill("REVOKE 4");
  await expect(confirm).toBeEnabled();
  await typed.fill(" REVOKE 4 ");
  await expect(confirm).toBeEnabled(); // surrounding whitespace is trimmed
  expect(api.requests.batches).toHaveLength(0);
  await confirm.click();
  await expect.poll(() => api.requests.batches.length).toBe(1);
  expect(api.requests.batches[0]).toMatchObject({ action: "revoke", reason: "mass revoke test" });
  expect(api.requests.batches[0].ids).toHaveLength(4);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".desktopRecords .status.revoked")).toHaveCount(4);
});

test("admin UI disables twenty loaded entitlements with one confirmation, one reason and five keyed requests", async ({ page }) => {
  // Count every modal the page opens, so "one confirmation" is a fact, not an absence of a later check.
  await page.addInitScript(() => {
    window.__dialogOpens = 0;
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function countedShowModal() {
      window.__dialogOpens += 1;
      return showModal.call(this);
    };
  });
  const api = makeAdminApiFixture();
  api.seed.entitlements(20);
  const keys = [];
  let releaseSecond = () => {};
  const secondHeld = new Promise((resolve) => { releaseSecond = resolve; });
  await page.route("**/api/admin/**", api.route);
  await page.route("**/api/admin/entitlements/batch", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length === 2) await secondHeld;
    return route.fallback();
  });
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  await expect(page.locator("tbody input[type=checkbox]")).toHaveCount(20);

  await page.getByLabel("Select all 20 loaded", { exact: true }).check();
  await expect(page.locator(".bulkBar")).toContainText("20 selected");
  await expect(page.locator(".bulkBar")).toContainText("5 chunks of up to 4");
  await clickAction(page.locator(".bulkBar").getByRole("button", { name: "Disable", includeHidden: true }));
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("5 chunks of up to 4");
  await dialog.getByLabel(/Reason/).fill("contract ended");
  await dialog.getByRole("button", { name: "Confirm" }).click();

  // While chunk 2 is in flight the open dialog reports it in a live region. The dialog itself must
  // not be aria-busy during the run, or assistive technology can suppress that live announcement.
  await expect.poll(() => keys.length).toBe(2);
  await expect(dialog.locator(".batchRun [aria-live=polite]")).toContainText("Chunk 2 of 5");
  expect(await dialog.evaluate((node) => node.getAttribute("aria-busy"))).not.toBe("true");
  expect(await dialog.locator(".batchRun [aria-live=polite]").evaluate((node) => node.closest('[aria-busy="true"]'))).toBeNull();
  releaseSecond();

  await expect.poll(() => api.requests.batches.length).toBe(5);
  await expect(dialog).toHaveCount(0);
  expect(api.requests.batches.map((batch) => batch.ids)).toEqual(
    Array.from({ length: 5 }, (_unused, chunk) => Array.from({ length: 4 }, (_item, row) => `ent-${chunk * 4 + row + 1}`)),
  );
  for (const batch of api.requests.batches) expect(batch).toMatchObject({ action: "disable", reason: "contract ended" });
  expect(keys).toHaveLength(5);
  expect(new Set(keys).size).toBe(5);
  expect(await page.evaluate(() => window.__dialogOpens)).toBe(1);

  const panel = page.locator(".tablePane .batchRun");
  await expect(panel.getByRole("listitem")).toHaveText(["20 done"]);
  await expect(panel).toContainText("Disable finished");
  await expect(page.locator(".desktopRecords .status.disabled")).toHaveCount(20);
  await expect(page.locator(".bulkBar")).toHaveCount(0);
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
  api.seed.policy("pol_node", "Node policy", { type: "node_locked" });
  api.seed.policy("pol_team", "Team policy", { max_active_devices: 2 });
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
  await expect(page.getByText("Feature created.")).toBeVisible();
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
  await expect(page.getByText("Plan created.")).toBeVisible();
  await page.getByRole("button", { name: "Back to plans", exact: true }).click();

  await page.getByRole("row", { name: /Pro pro/ }).getByRole("button", { name: "View plan", exact: true }).click();
  await page.getByRole("button", { name: "Add feature", exact: true }).click();
  const planFeatureForm = page.getByRole("form", { name: "Plan feature" });
  await planFeatureForm.getByLabel("Feature key").fill("core");
  await planFeatureForm.getByLabel("Policy", { exact: true }).selectOption("pol_node");
  await planFeatureForm.getByRole("button", { name: "Save plan feature" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatures.length).toBe(1);
  await expect(page.getByText("Plan feature saved.")).toBeVisible();
  // Saving a row opens it in its plan; adding another starts again from the plan.
  await expect(page.getByRole("row", { name: /core/ })).toBeVisible();
  await page.getByRole("button", { name: "Add feature", exact: true }).click();

  await planFeatureForm.getByLabel("Feature key").fill("team");
  await planFeatureForm.getByLabel("Inclusion").selectOption("addon");
  await planFeatureForm.getByLabel("Add-on key").fill("team_seats");
  await planFeatureForm.getByLabel("Policy", { exact: true }).selectOption("pol_team");
  // A plan feature grants a device limit only: the form has no seat, borrowing, meter or TTL field.
  await expect(planFeatureForm.getByLabel(/pool size|max borrow|meter|ttl/i)).toHaveCount(0);
  await planFeatureForm.getByLabel("Device limit").fill("6");
  await planFeatureForm.getByRole("button", { name: "Save plan feature" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatures.length).toBe(2);
  expect(api.requests.catalogPlanFeatures[1]).toEqual({
    plan_id: "plan_pro",
    project: "DEFAULT",
    feature_key: "team",
    feature_inclusion: "addon",
    addon_key: "team_seats",
    policy_id: "pol_team",
    status: "active",
    display_order: 0,
    max_active_devices: 6,
  });
  await page.getByRole("button", { name: "Back to plans", exact: true }).click();
  await page.getByRole("row", { name: /Pro pro/ }).getByRole("button", { name: "View plan", exact: true }).click();
  await expect(page.getByRole("row", { name: /Team Seats team addon team_seats pol_team device limit 6/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "team_seats", exact: true })).toBeVisible();

  await openCatalogView(page, "Features");
  await page.getByRole("row", { name: /Core core/ }).getByRole("button", { name: "Edit" }).click();
  await featureForm.getByLabel("Name").fill("Core Runtime");
  await featureForm.getByLabel("Category").fill("");
  await featureForm.getByRole("button", { name: "Update feature" }).click();
  await expect.poll(() => api.requests.catalogFeaturePatches.length).toBe(1);
  expect(api.requests.catalogFeaturePatches[0]).toMatchObject({ id: "feat_core", name: "Core Runtime", category: "" });
  await expect(page.getByText("Feature changes saved.")).toBeVisible();
  await page.getByRole("button", { name: "Back to features", exact: true }).click();

  const featureRow = page.getByRole("row", { name: /Core Runtime core/ });
  await clickAction(featureRow.getByRole("button", { name: "Disable", includeHidden: true }));
  await page.getByLabel("Reason (required)").fill("catalog lifecycle test");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogFeatureTransitions.length).toBe(1);
  expect(api.requests.catalogFeatureTransitions[0]).toMatchObject({ id: "feat_core", action: "disable", reason: "catalog lifecycle test" });
  await expect(page.getByText("Feature disabled.")).toBeVisible();
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
  await expect(page.getByText("Plan changes saved.")).toBeVisible();
  await page.getByRole("button", { name: "Back to plans", exact: true }).click();

  await page.getByRole("row", { name: /Pro Annual pro/ }).getByRole("button", { name: "View plan", exact: true }).click();
  const planFeatureRow = page.getByRole("row", { name: /Team Seats team addon team_seats pol_team/ });
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
  await expect(page.getByText("Import preview ready. Review it before you apply it.")).toBeVisible();

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
          { project: "DEFAULT", feature_key: "analytics", feature_inclusion: "included", addon_key: null, policy_id: "pol_node", status: "active", display_order: 4, max_active_devices: null },
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
  await expect(page.getByText("Catalog import applied.")).toBeVisible();
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
  await expect(page.getByText("Plan preview ready. Review it before you apply it.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "core", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "team", exact: true })).toBeVisible();
  // Each item is a protected grant: the trial policy's row is a trial, the other is node-locked,
  // and each shows its device limit.
  await expect(page.getByRole("row", { name: /^team trial pol_team .* 6 team_seats$/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /^core node_locked pol_node .* 1 included$/ })).toBeVisible();

  const applyButton = form.getByRole("button", { name: "Apply" });
  await expect(applyButton).toBeEnabled();
  await expect(page.getByText(/Server preview ppv_ui_/)).toBeVisible();
  await page.locator("fieldset").getByText("Technical details", { exact: true }).click();
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
  await expect(page.getByText("Plan applied.")).toBeVisible();

  await page.getByRole("link", { name: "License access", exact: true }).click();
  await expect(page.getByRole("cell", { name: /DEFAULT\s+core/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /DEFAULT\s+team/ })).toBeVisible();
  await expect(page.locator(".desktopRecords tbody tr").filter({ hasText: "team" }).first()).toContainText("Device limit 6");
  const projectedEntitlement = page.locator(".desktopRecords tbody tr").filter({ hasText: "core" }).first();
  await projectedEntitlement.getByText("Technical details", { exact: true }).click();
  await expect(projectedEntitlement).toContainText("License ID");
  await expect(projectedEntitlement).toContainText("lic_plan");
});

// A policy's patchable fields are editable in place; its project, name, and type are not.
test("an operator edits a policy's device limit without touching its identity", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.policy("pol_edit", "Editable", { project: "APP", type: "node_locked", max_active_devices: 3, notes: "tier" });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/policies");
  const row = page.locator(".tablePane table tbody tr").filter({ hasText: "Editable" });
  await expect(row).toContainText("Max devices 3");
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("form", { name: "Edit policy", exact: true });
  await expect(editor.getByLabel("Name (required)", { exact: true })).toHaveValue("Editable");
  await expect(editor.getByLabel("Name (required)", { exact: true })).toHaveAttribute("readonly", "");
  await expect(editor.getByLabel("Project", { exact: true })).toHaveAttribute("readonly", "");
  await expect(editor.getByLabel("Type", { exact: true })).toBeDisabled();
  await expect(editor.getByLabel("Device limit", { exact: true })).toHaveValue("3");
  await editor.getByLabel("Device limit", { exact: true }).fill("5");
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Policy changes saved.")).toBeVisible();
  expect(api.requests.policyPatches).toHaveLength(1);
  const [patch] = api.requests.policyPatches;
  expect(patch.id).toBe("pol_edit");
  expect(patch.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(patch.body).toMatchObject({ max_active_devices: 5, notes: "tier" });
  // A PATCH names only patchable fields: never the identity, and never a seat, borrowing, meter,
  // TTL or device-proof field, which the Worker refuses.
  for (const field of ["project", "name", "type", "status", "pool_size", "max_borrow_sec", "meter_quota", "meter_period_sec", "assertion_ttl_seconds", "trial_require_device_proof"]) {
    expect(Object.hasOwn(patch.body, field)).toBe(false);
  }
  await expect(row).toContainText("Max devices 5");
  await expect(editor).toHaveCount(0);
});

// A protected grant's device limit is set on its own; a limit below its connected devices is
// refused with their count, in words.
test("an operator sets a protected grant's device limit and is told how many devices block a lower one", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.entitlement({ project: "APP", feature: "PRO", enforcement_mode: "device_bound_v1", customer_id: "cus_acme", license_id: "lic_acme", max_active_devices: 5 });
  api.behavior.devicesInUse = 3;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/entitlements");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const limitForm = page.getByRole("form", { name: "Device limit", exact: true });
  const limit = limitForm.getByLabel("Device limit", { exact: true });
  await expect(limit).toHaveValue("5");
  await limit.fill("2");
  await limitForm.getByRole("button", { name: "Save device limit", exact: true }).click();
  const refusal = page.getByRole("alert").filter({ hasText: "3 devices are connected; disconnect one first." });
  await expect(refusal).toBeVisible();
  await expect(refusal.getByText("capacity_in_use · ui-e2e-capacity-in-use", { exact: true })).toBeHidden();
  await refusal.getByText("Technical details", { exact: true }).click();
  await expect(refusal.getByText("capacity_in_use · ui-e2e-capacity-in-use", { exact: true })).toBeVisible();
  await expect(limit).toHaveValue("2");
  await limit.fill("3");
  await limitForm.getByRole("button", { name: "Save device limit", exact: true }).click();
  await expect(page.getByText("Device limit set to 3.", { exact: false })).toBeVisible();
  expect(api.requests.patches).toEqual([
    { max_active_devices: 2, expected_customer_id: "cus_acme", expected_revocation_seq: 1 },
    { max_active_devices: 3, expected_customer_id: "cus_acme", expected_revocation_seq: 1 },
  ]);
  await expect(limit).toHaveValue("3");
  // An unsaved limit is a draft like any other: leaving asks before discarding it.
  await limit.fill("7");
  const prompts = [];
  page.once("dialog", async (dialog) => { prompts.push(dialog.message()); await dialog.dismiss(); });
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();
  await expect.poll(() => prompts).toEqual([expect.stringMatching(/Discard your unsaved changes/)]);
  await expect(limit).toHaveValue("7");
  await limit.fill("3");
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();
  await expect(page.locator(".desktopRecords tbody tr").first()).toContainText("Device limit 3");
  expect(api.requests.patches).toHaveLength(2);
});
