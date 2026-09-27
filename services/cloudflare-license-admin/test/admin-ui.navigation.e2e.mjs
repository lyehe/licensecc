import { expect, test } from "@playwright/test";

import { makeAdminApiFixture } from "./admin-ui.fixture.mjs";

async function clickAction(button) {
  await button.waitFor({ state: "attached" });
  const disclosure = button.locator("xpath=ancestor::details[1]");
  if (await disclosure.count() && await disclosure.getAttribute("open") === null) {
    await disclosure.locator(":scope > summary").click();
  }
  await button.click();
}

test("direct customer section URLs survive intent consumption and refresh", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/customers/cus_acme?section=access");

  const access = page.getByRole("navigation", { name: "Customer detail sections" }).getByRole("button", { name: "Apps & access", exact: true });
  await expect(page.getByRole("heading", { name: "Apps & access", exact: true })).toBeVisible();
  await expect(access).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Customer detail sections" }).getByRole("button")).toHaveText(["Apps & access", "Activity", "Account"]);
  await expect(page).toHaveURL(/#\/customers\/cus_acme\?section=access$/u);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Apps & access", exact: true })).toBeVisible();
  await expect(access).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/#\/customers\/cus_acme\?section=access$/u);
  expect(api.requests.customerTransitions).toEqual([]);
});

test("customer secondary records keep legacy URLs and their primary section", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  for (const [section, tab, heading] of [["overview", "Apps & access", "Apps & access"], ["licenses", "Apps & access", "Customer licenses"], ["orders", "Activity", "Customer orders"], ["tokens", "Account", "Account tokens"]]) {
    await page.goto(`/#/customers/cus_acme?section=${section}`);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Customer detail sections" }).getByRole("button", { name: tab, exact: true })).toHaveAttribute("aria-current", "page");
  }
  expect(api.requests.customerTransitions).toEqual([]);
});

test("customer list history remembers edited filters while refresh restores only URL-safe state", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  const query = "ops@acme.test";
  const status = page.getByRole("combobox", { name: "Status", exact: true });
  const search = page.getByRole("textbox", { name: "Search customers" });

  for (const initialHash of ["#/customers", "#/customers?status=disabled"]) {
    await page.goto(`/${initialHash}`);
    await expect(status).toHaveValue(initialHash.includes("disabled") ? "disabled" : "");
    await status.selectOption("active");
    await search.fill(query);
    await expect(page.locator("#customer-open-cus_acme")).toBeVisible();
    await expect(page).toHaveURL(/#\/customers\?status=active$/u);
    await expect.poll(() => api.requests.customerReads.at(-1)).toBe("?status=active&q=ops%40acme.test");

    await page.locator("#customer-open-cus_acme").click();
    await expect(page.getByRole("heading", { name: "Acme Corp", exact: true })).toBeVisible();
    await page.goBack();
    await expect(status).toHaveValue("active");
    await expect(search).toHaveValue(query);
    await expect(page.locator("#customer-open-cus_acme")).toBeVisible();
    await expect(page).toHaveURL(/#\/customers\?status=active$/u);
    expect(await page.evaluate(() => JSON.stringify(window.history.state))).not.toContain(query);

    await page.reload();
    await expect(status).toHaveValue("active");
    await expect(search).toHaveValue("");
    await expect(page.locator("#customer-open-cus_acme")).toBeVisible();
    await expect.poll(() => api.requests.customerReads.at(-1)).toBe("?status=active");
    await expect(page).toHaveURL(/#\/customers\?status=active$/u);
  }
  expect(api.requests.customerTransitions).toEqual([]);
});

test("entitlement, license, and fulfillment history restore edited list filters", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.setViewportSize({ width: 1280, height: 900 });
  const cases = [
    {
      initial: "#/entitlements?project=OLD&status=disabled",
      expected: "#/entitlements?project=PROJECT_A&feature=feature_a&status=active",
      fields: [
        { label: "Filter by project", value: "PROJECT_A" },
        { label: "Filter by feature", value: "feature_a" },
        { label: "Filter by status", value: "active", select: true },
      ],
    },
    {
      initial: "#/licenses?project=OLD",
      expected: "#/licenses?project=PROJECT_A&customer_id=cus_acme",
      fields: [
        { label: "Project", value: "PROJECT_A" },
        { label: "Customer ID", value: "cus_acme" },
        { label: "Search licenses", value: "private-license-label", sessionOnly: true },
      ],
    },
    {
      initial: "#/fulfillment?status=accepted&subscription_id=sub_old",
      expected: "#/fulfillment?status=processed&subscription_id=sub_new",
      fields: [
        { label: "Status", value: "processed", select: true },
        { label: "Subscription ID", value: "sub_new" },
      ],
    },
  ];
  for (const scenario of cases) {
    await page.goto(`/${scenario.initial}`);
    for (const field of scenario.fields) {
      const control = page.getByRole(field.select ? "combobox" : "textbox", { name: field.label, exact: true });
      if (field.select) await control.selectOption(field.value);
      else await control.fill(field.value);
    }
    await expect.poll(() => new URL(page.url()).hash).toBe(scenario.expected);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page.locator("[data-workspace-heading]")).toHaveText("Overview");
    await page.goBack();
    for (const field of scenario.fields) await expect(page.getByRole(field.select ? "combobox" : "textbox", { name: field.label, exact: true })).toHaveValue(field.value);
    await expect.poll(() => new URL(page.url()).hash).toBe(scenario.expected);
    expect(await page.evaluate(() => JSON.stringify(window.history.state))).not.toContain("private-license-label");

    await page.reload();
    for (const field of scenario.fields) await expect(page.getByRole(field.select ? "combobox" : "textbox", { name: field.label, exact: true })).toHaveValue(field.sessionOnly ? "" : field.value);
    await expect.poll(() => new URL(page.url()).hash).toBe(scenario.expected);
  }
});

test("a global search entitlement result lands on exactly that row with no fingerprint in the URL; Show all restores the list", async ({ page }) => {
  const api = makeAdminApiFixture();
  const fingerprint = "5".repeat(64);
  const target = api.seed.entitlement({ project: "DEFAULT", feature: "pro", license_fingerprint: fingerprint, customer_id: "cus_acme" });
  api.seed.entitlement({ project: "DEFAULT", feature: "pro", license_fingerprint: "6".repeat(64) });
  await page.route("**/api/admin/**", api.route);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("searchbox", { name: "Global search" }).fill(fingerprint);
  await page.getByRole("button", { name: "Search records", exact: true }).click();
  await page.getByRole("link", { name: new RegExp(target.id) }).click();

  await expect(page.locator(".sidebar nav a[aria-current=page]")).toHaveText("License access");
  await expect(page.getByText("Showing 1 entitlement", { exact: false })).toBeVisible();
  await expect(page.locator(".desktopRecords tbody tr")).toHaveCount(1);
  expect(page.url()).not.toContain(fingerprint);
  expect(new URL(page.url()).hash).toBe("#/entitlements");

  await page.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(page.locator(".desktopRecords tbody tr")).toHaveCount(2);
  expect(new URL(page.url()).hash).toBe("#/entitlements");
});

test("reloading a deep-linked single-entitlement view drops the session-only id and shows the full list", async ({ page }) => {
  const api = makeAdminApiFixture();
  const fingerprint = "9".repeat(64);
  const target = api.seed.entitlement({ project: "DEFAULT", feature: "pro", license_fingerprint: fingerprint, customer_id: "cus_acme" });
  api.seed.entitlement({ project: "DEFAULT", feature: "pro", license_fingerprint: "1".repeat(64) });
  await page.route("**/api/admin/**", api.route);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("searchbox", { name: "Global search" }).fill(fingerprint);
  await page.getByRole("button", { name: "Search records", exact: true }).click();
  await page.getByRole("link", { name: new RegExp(target.id) }).click();
  await expect(page.getByText("Showing 1 entitlement", { exact: false })).toBeVisible();
  await expect(page.locator(".desktopRecords tbody tr")).toHaveCount(1);

  // id is session-only (never in the URL/hash), so a reload has nothing to restore it from: the
  // banner is gone and the full, unfiltered list shows instead of the single deep-linked row.
  await page.reload();
  await expect(page.locator(".sidebar nav a[aria-current=page]")).toHaveText("License access");
  await expect(page.getByText("Showing 1 entitlement", { exact: false })).toHaveCount(0);
  await expect(page.locator(".desktopRecords tbody tr")).toHaveCount(2);
  expect(new URL(page.url()).hash).toBe("#/entitlements");
});

test("the Licenses 'View entitlements' button scopes the list by license_id with a visible, removable indicator", async ({ page }) => {
  const api = makeAdminApiFixture();
  const licenseId = "lic_seat_pack";
  api.behavior.licenseRows = [{ id: licenseId, customer_id: "cus_acme", project: "DEFAULT", label: "Seat pack", created_at: 1_760_000_000, updated_at: 1_760_000_000 }];
  api.seed.entitlement({ project: "DEFAULT", feature: "pro", license_fingerprint: "7".repeat(64), customer_id: "cus_acme", license_id: licenseId });
  api.seed.entitlement({ project: "DEFAULT", feature: "other", license_fingerprint: "8".repeat(64), customer_id: "cus_acme", license_id: null });
  await page.route("**/api/admin/**", api.route);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/licenses");

  await page.getByRole("button", { name: "View entitlements", exact: true }).click();

  await expect(page.locator(".sidebar nav a[aria-current=page]")).toHaveText("License access");
  await expect(page.getByText(`License ${licenseId}`, { exact: false })).toBeVisible();
  await expect(page.locator(".desktopRecords tbody tr")).toHaveCount(1);
  expect(new URL(page.url()).hash).toBe("#/entitlements?license_id=lic_seat_pack");

  // license_id is an ordinary browsing filter (unlike id/customer_id): it survives a reload.
  await page.reload();
  await expect(page.getByText(`License ${licenseId}`, { exact: false })).toBeVisible();
  await expect(page.locator(".desktopRecords tbody tr")).toHaveCount(1);

  await page.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(page.getByText(`License ${licenseId}`, { exact: false })).toHaveCount(0);
  await expect(page.locator(".desktopRecords tbody tr")).toHaveCount(2);
});

test("an entitlement's 'History' item opens Events filtered to exactly that entitlement, session-only", async ({ page }) => {
  const api = makeAdminApiFixture();
  const alpha = api.seed.entitlement({ project: "DEFAULT", feature: "alpha", license_fingerprint: "1".repeat(64) });
  api.seed.entitlement({ project: "DEFAULT", feature: "beta", license_fingerprint: "2".repeat(64) });
  await page.route("**/api/admin/**", api.route);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/entitlements");

  async function disableWithReason(feature, reason) {
    const row = page.locator(".desktopRecords tbody tr").filter({ hasText: feature });
    await clickAction(row.getByRole("button", { name: "Disable", exact: true, includeHidden: true }));
    await page.getByRole("dialog").getByLabel(/Reason/).fill(reason);
    await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
    await expect(row.locator(".status.disabled")).toHaveText("suspended");
  }
  await disableWithReason("alpha", "alpha note");
  await disableWithReason("beta", "beta note");

  const alphaRow = page.locator(".desktopRecords tbody tr").filter({ hasText: "alpha" });
  await clickAction(alphaRow.getByRole("button", { name: "History", exact: true, includeHidden: true }));

  await expect(page.locator(".sidebar nav a[aria-current=page]")).toHaveText("Events");
  await expect(page.getByText("Showing events for 1 entitlement", { exact: false })).toBeVisible();
  const eventRows = page.locator('[aria-label="Audit event records"] tbody tr');
  await expect(eventRows).toHaveCount(1);
  await expect(eventRows.getByRole("cell", { name: "alpha note" })).toBeVisible();
  // entitlement_id is session-only (like the entitlements id/customer_id filters): it never
  // reaches the URL, and neither does the fingerprint or opaque id it would otherwise encode.
  expect(page.url()).not.toContain(alpha.license_fingerprint);
  expect(page.url()).not.toContain(alpha.id);
  expect(new URL(page.url()).hash).toBe("#/events");

  await page.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(eventRows).toHaveCount(2);
  await expect(eventRows.getByRole("cell", { name: "beta note" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#/events");
});

test("mobile customer Back restores the visible card action and list scroll", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.customers(20);
  await page.route("**/api/admin/**", api.route);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/customers");
  const opener = page.locator("#customer-open-card-cus_seed_015");
  await opener.scrollIntoViewIfNeeded();
  await opener.focus();
  const scrollY = await page.evaluate(() => window.scrollY);
  await opener.click();
  await expect(page.getByRole("heading", { name: "Seed customer 15", exact: true })).toBeVisible();
  await page.goBack();
  await expect(opener).toBeFocused();
  expect(Math.abs(await page.evaluate(() => window.scrollY) - scrollY)).toBeLessThan(2);
});

function seedCustomerApps(api) {
  const customer = api.seed.customer();
  const [grant] = api.seed.entitlements([
    { customer_id: customer.id, project: "CAD", feature: "render", id: "ent_history_probe_cad_render", license_fingerprint: "c".repeat(64) },
    { customer_id: customer.id, project: "CAM", feature: "mill" },
  ]);
  return { customer, grant };
}

const currentHash = (page) => () => new URL(page.url()).hash;

test("a customer's app and record view are history entries that survive reload", async ({ page }) => {
  const api = makeAdminApiFixture();
  const { customer } = seedCustomerApps(api);
  await page.route("**/api/admin/**", api.route);
  const accessHash = `#/customers/${customer.id}?section=access`;
  await page.goto(`/${accessHash}`);
  const records = page.getByRole("navigation", { name: "App records" });
  const recordView = (name) => records.getByRole("button", { name, exact: true });

  await page.locator(".recordCard").filter({ hasText: "CAD" }).getByRole("button", { name: "View app", exact: true }).click();
  await expect(recordView("Access grants")).toHaveAttribute("aria-current", "page");
  await expect.poll(currentHash(page)).toBe(`${accessHash}&app=CAD`);
  // The app's existence check reads one record; it does not repeat the grants list read.
  await expect.poll(() => api.requests.customerWorkspaceReads.filter((read) => read.startsWith("access")).sort()).toEqual(["access?project=CAD", "access?project=CAD&limit=1"]);
  await recordView("Activated devices").click();
  await expect(recordView("Activated devices")).toHaveAttribute("aria-current", "page");
  await expect.poll(currentHash(page)).toBe(`${accessHash}&app=CAD&view=nodes`);

  await page.reload();
  await expect(recordView("Activated devices")).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("CAD", { exact: true })).toBeVisible();
  await expect.poll(currentHash(page)).toBe(`${accessHash}&app=CAD&view=nodes`);

  await page.goBack();
  await expect(recordView("Access grants")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Manage access", exact: true })).toBeVisible();
  await expect.poll(currentHash(page)).toBe(`${accessHash}&app=CAD`);
  await page.goBack();
  await expect(page.getByRole("button", { name: "View app", exact: true })).toHaveCount(2);
  await expect(records).toHaveCount(0);
  await expect.poll(currentHash(page)).toBe(accessHash);
  await page.goForward();
  await expect(recordView("Access grants")).toHaveAttribute("aria-current", "page");
  await expect.poll(currentHash(page)).toBe(`${accessHash}&app=CAD`);
});

test("Back from Manage access returns to the app's access grants and Forward reopens it in the same session", async ({ page }) => {
  const api = makeAdminApiFixture();
  const { customer, grant } = seedCustomerApps(api);
  await page.route("**/api/admin/**", api.route);
  const appHash = `#/customers/${customer.id}?section=access&app=CAD`;
  await page.goto(`/${appHash}`);
  const scoped = page.getByText(/License access for customer/);

  await page.getByRole("button", { name: "Manage access", exact: true }).click();
  await expect(scoped).toContainText(customer.id);
  await expect(page.locator(".desktopRecords tbody tr")).toHaveCount(1);
  await expect.poll(currentHash(page)).toBe(`${appHash}&manage=1`);
  // The managed grant's id encodes its fingerprint: neither may reach the address or history.state.
  const state = await page.evaluate(() => JSON.stringify(window.history.state));
  for (const secret of [grant.id, grant.license_fingerprint]) {
    expect(page.url()).not.toContain(secret);
    expect(state).not.toContain(secret);
  }

  await page.goBack();
  await expect(page.getByRole("button", { name: "Manage access", exact: true })).toBeVisible();
  await expect(page.getByText("CAD", { exact: true })).toBeVisible();
  await expect(scoped).toHaveCount(0);
  await expect.poll(currentHash(page)).toBe(appHash);

  await page.goForward();
  await expect(scoped).toContainText(customer.id);
  await expect(page.locator(".desktopRecords tbody tr")).toHaveCount(1);
  await expect.poll(currentHash(page)).toBe(`${appHash}&manage=1`);
  await expect(page.getByText("Reopen Manage access from the list.", { exact: true })).toHaveCount(0);
});

test("leaving Manage access with an unsaved edit asks once, then returns to the app's access grants", async ({ page }) => {
  const api = makeAdminApiFixture();
  const { customer } = seedCustomerApps(api);
  await page.route("**/api/admin/**", api.route);
  const prompts = [];
  page.on("dialog", (dialog) => {
    prompts.push(dialog.message());
    void dialog.accept();
  });
  const appHash = `#/customers/${customer.id}?section=access&app=CAD`;
  await page.goto(`/${appHash}`);
  await page.getByRole("button", { name: "Manage access", exact: true }).click();
  await page.locator(".desktopRecords tbody tr").getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("form", { name: "Edit entitlement" }).getByLabel("Notes").fill("unsaved note");

  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.getByRole("button", { name: "Manage access", exact: true })).toBeVisible();
  await expect.poll(currentHash(page)).toBe(appHash);
  expect(prompts).toEqual([expect.stringMatching(/Discard your unsaved changes/)]);
});

test("reloading or entering a Manage access address shows the app's access grants with a reopen notice", async ({ page }) => {
  const api = makeAdminApiFixture();
  const { customer } = seedCustomerApps(api);
  await page.route("**/api/admin/**", api.route);
  const appHash = `#/customers/${customer.id}?section=access&app=CAD`;
  const scoped = page.getByText(/License access for customer/);
  const notice = page.getByText("Reopen Manage access from the list.", { exact: true });
  await page.goto(`/${appHash}`);
  await page.getByRole("button", { name: "Manage access", exact: true }).click();
  await expect(scoped).toContainText(customer.id);

  await page.reload();
  await expect(notice).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage access", exact: true })).toBeVisible();
  await expect(scoped).toHaveCount(0);
  await expect.poll(currentHash(page)).toBe(appHash);

  await page.goto("/#/overview");
  await expect(notice).toHaveCount(0);
  await page.goto(`/${appHash}&manage=1`);
  await expect(notice).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage access", exact: true })).toBeVisible();
  await expect(scoped).toHaveCount(0);
  await expect.poll(currentHash(page)).toBe(appHash);
});

test("app, record-view, and plan combinations the console cannot address fall back with the unrecognized-address notice", async ({ page }) => {
  const api = makeAdminApiFixture();
  const { customer } = seedCustomerApps(api);
  const plan = api.seed.catalogPlan();
  await page.route("**/api/admin/**", api.route);
  for (const hash of [
    `#/customers/${customer.id}?section=access&view=nodes`,
    `#/customers/${customer.id}?section=history&app=CAD`,
    `#/customers/${customer.id}?section=access&app=CAD&view=sideways`,
    `#/plans?view=features&plan=${plan.id}`,
  ]) {
    await page.goto(`/${hash}`);
    await expect(page.getByText("This workspace address is not recognized. Overview is shown.", { exact: true })).toBeVisible();
    await expect(page.locator("[data-workspace-heading]")).toHaveText("Overview");
    await expect.poll(currentHash(page)).toBe("#/overview");
    await page.goto("/#/reports");
    await expect(page.locator("[data-workspace-heading]")).toHaveText("Reports");
  }
});

test("a deep link to an app the customer no longer has shows all apps with a not-found notice", async ({ page }) => {
  const api = makeAdminApiFixture();
  const { customer } = seedCustomerApps(api);
  await page.route("**/api/admin/**", api.route);
  const accessHash = `#/customers/${customer.id}?section=access`;
  await page.goto(`/${accessHash}&app=RETIRED&view=nodes`);
  await expect(page.getByText("That app was not found for this customer. All apps are shown.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "View app", exact: true })).toHaveCount(2);
  await expect(page.getByRole("navigation", { name: "App records" })).toHaveCount(0);
  await expect.poll(currentHash(page)).toBe(accessHash);
});

test("catalog plan detail is a history entry that survives reload", async ({ page }) => {
  const api = makeAdminApiFixture();
  const plan = api.seed.catalogPlan();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/plans");
  const viewPlan = page.getByRole("row", { name: /Plan confirm/ }).getByRole("button", { name: "View plan", exact: true });
  const detail = page.getByRole("heading", { name: "Plan confirm", exact: true });

  await viewPlan.click();
  await expect(detail).toBeVisible();
  await expect.poll(currentHash(page)).toBe(`#/plans?plan=${plan.id}`);
  // The in-page "Back to plans" returns focus to the plan's own row, as browser Back does.
  await page.getByRole("button", { name: "Back to plans", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect.poll(currentHash(page)).toBe("#/plans");
  await expect(viewPlan).toBeFocused();
  await viewPlan.click();
  await expect(detail).toBeVisible();
  await page.goBack();
  await expect(detail).toHaveCount(0);
  await expect.poll(currentHash(page)).toBe("#/plans");
  // Back within the session restores focus to the plan's own row, not the list heading.
  await expect(viewPlan).toBeFocused();
  await page.goForward();
  await expect(detail).toBeVisible();

  await page.reload();
  await expect(detail).toBeVisible();
  await expect(page.getByRole("button", { name: "Add feature", exact: true })).toBeVisible();
  await expect.poll(currentHash(page)).toBe(`#/plans?plan=${plan.id}`);
  await page.goBack();
  await expect(viewPlan).toBeVisible();
  await expect(detail).toHaveCount(0);
  await expect.poll(currentHash(page)).toBe("#/plans");
  await page.goForward();
  await expect(detail).toBeVisible();
  await expect.poll(currentHash(page)).toBe(`#/plans?plan=${plan.id}`);
});

test("a deep link to a plan that does not exist shows the plans list with a not-found notice", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/plans?plan=plan_retired");
  await expect(page.getByText("That plan was not found. The plans list is shown.", { exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: /Plan confirm/ }).getByRole("button", { name: "View plan", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plan unavailable", exact: true })).toHaveCount(0);
  await expect.poll(currentHash(page)).toBe("#/plans");
  // Only the plan's own read may declare it missing.
  expect(api.requests.catalogPlanReads).toEqual(["plan_retired"]);
});

test("a plan the list filters hide still opens from history, clearing the filters with a notice", async ({ page }) => {
  const api = makeAdminApiFixture();
  const plan = api.seed.catalogPlan();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/plans");
  const plansPane = page.locator('[data-focus-section="catalog-list"]');
  const viewPlan = page.getByRole("row", { name: /Plan confirm/ }).getByRole("button", { name: "View plan", exact: true });
  const detail = page.getByRole("heading", { name: "Plan confirm", exact: true });
  const cleared = page.getByText("Plan filters were cleared to show this plan.", { exact: true });
  const hideWith = [
    async () => plansPane.getByLabel("Plan status").selectOption("disabled"),
    async () => plansPane.getByPlaceholder("project").fill("OTHER"),
  ];
  for (const hide of hideWith) {
    await viewPlan.click();
    await expect(detail).toBeVisible();
    await page.goBack();
    await expect(viewPlan).toBeVisible();
    await hide();
    await expect(plansPane.locator("tbody tr")).toHaveCount(0);

    await page.goForward();
    await expect(detail).toBeVisible();
    await expect(cleared).toBeVisible();
    await expect(page.getByText("That plan was not found. The plans list is shown.", { exact: true })).toHaveCount(0);
    await expect.poll(currentHash(page)).toBe(`#/plans?plan=${plan.id}`);
    await page.goBack();
    await expect(plansPane.getByLabel("Plan status")).toHaveValue("");
    await expect(plansPane.getByPlaceholder("project")).toHaveValue("");
    await expect(viewPlan).toBeVisible();
    await expect(cleared).toHaveCount(0);
  }
});

test("a plan that cannot be read while it resolves shows Plan unavailable until Retry succeeds", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan("plan_page_one", "DEFAULT", "page-one");
  const target = api.seed.catalogPlan("plan_page_two", "DEFAULT", "page-two");
  api.behavior.catalogPlanPagination = true;
  // The plan's own read fails first; once it answers, the list page that holds the plan fails.
  api.behavior.catalogPlanReadResponses.push({ status: 503, body: null });
  api.behavior.catalogPlanAppendResponses.push({ status: 503, body: null });
  await page.route("**/api/admin/**", api.route);
  const task = page.locator('[data-focus-section="catalog-task"]');
  const unavailable = task.getByRole("heading", { name: "Plan unavailable", exact: true });
  const loading = task.getByRole("heading", { name: "Loading plan…", exact: true });
  const detail = page.getByRole("heading", { name: "Plan page-two", exact: true });

  await page.goto(`/#/plans?plan=${target.id}`);
  await expect(unavailable).toBeVisible();
  await expect(loading).toHaveCount(0);
  await expect.poll(currentHash(page)).toBe(`#/plans?plan=${target.id}`);

  await task.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => api.behavior.catalogPlanAppendResponses.length).toBe(0);
  await expect(unavailable).toBeVisible();
  await expect(loading).toHaveCount(0);
  await expect(page.getByText("That plan was not found. The plans list is shown.", { exact: true })).toHaveCount(0);
  await expect.poll(currentHash(page)).toBe(`#/plans?plan=${target.id}`);

  await task.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(detail).toBeVisible();
  await expect(unavailable).toHaveCount(0);
});

test("an unreadable list page while a plan resolves shows Plan unavailable, never not found", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan("plan_page_one", "DEFAULT", "page-one");
  const target = api.seed.catalogPlan("plan_page_two", "DEFAULT", "page-two");
  api.behavior.catalogPlanPagination = true;
  // A malformed 200 retires the cursor: the append can never succeed as issued.
  api.behavior.catalogPlanAppendResponses.push({ status: 200, body: null });
  await page.route("**/api/admin/**", api.route);
  const task = page.locator('[data-focus-section="catalog-task"]');
  const unavailable = task.getByRole("heading", { name: "Plan unavailable", exact: true });

  await page.goto(`/#/plans?plan=${target.id}`);
  await expect(unavailable).toBeVisible();
  await expect(task.getByRole("heading", { name: "Loading plan…", exact: true })).toHaveCount(0);
  await expect(page.getByText("That plan was not found. The plans list is shown.", { exact: true })).toHaveCount(0);
  await expect.poll(currentHash(page)).toBe(`#/plans?plan=${target.id}`);

  await task.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Plan page-two", exact: true })).toBeVisible();
});

/** Two earlier entries, then a plan detail, then a reload: every earlier entry now comes from another session. */
async function reloadOnPlanDetail(page, plan) {
  await page.goto("/#/customers");
  await page.goto("/#/overview");
  await page.goto("/#/plans");
  await page.getByRole("row", { name: /Plan confirm/ }).getByRole("button", { name: "View plan", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Plan confirm", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Plan confirm", exact: true })).toBeVisible();
  await expect.poll(currentHash(page)).toBe(`#/plans?plan=${plan.id}`);
}

async function expectAppAndAddress(page, hash, heading) {
  await expect.poll(currentHash(page)).toBe(hash);
  await expect(page.locator("[data-workspace-heading]")).toHaveText(heading);
}

async function leaveForOverview(page) {
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Overview", exact: true }).click();
}

test("a refused Back into an entry from before a reload keeps the address on the current plan", async ({ page }) => {
  const api = makeAdminApiFixture();
  const plan = api.seed.catalogPlan();
  await page.route("**/api/admin/**", api.route);
  let answer = "dismiss";
  const prompts = [];
  page.on("dialog", (dialog) => {
    prompts.push(dialog.message());
    void dialog[answer]();
  });
  await reloadOnPlanDetail(page, plan);
  await page.getByRole("button", { name: "Edit plan", exact: true }).click();
  const name = page.getByRole("form", { name: "Catalog plan" }).getByLabel("Name");
  await name.fill("Draft after reload");

  await page.goBack();
  await expect.poll(() => prompts.length).toBe(1);
  await expectAppAndAddress(page, `#/plans?plan=${plan.id}`, "Plans & features");
  await expect(name).toHaveValue("Draft after reload");

  // History still drives the app: an accepted leave, then Back, keep address and page together.
  answer = "accept";
  await leaveForOverview(page);
  await expectAppAndAddress(page, "#/overview", "Overview");
  await page.goBack();
  await expectAppAndAddress(page, `#/plans?plan=${plan.id}`, "Plans & features");
  await expect(page.getByRole("heading", { name: "Plan confirm", exact: true })).toBeVisible();
  await page.goBack();
  await expectAppAndAddress(page, "#/overview", "Overview");
  expect(prompts).toHaveLength(2);
});

test("a Back refused during a plan save after a reload keeps the address, and history works once it settles", async ({ page }) => {
  const api = makeAdminApiFixture();
  const plan = api.seed.catalogPlan();
  await page.route("**/api/admin/**", api.route);
  await reloadOnPlanDetail(page, plan);
  await page.getByRole("button", { name: "Edit plan", exact: true }).click();
  const form = page.getByRole("form", { name: "Catalog plan" });
  await form.getByLabel("Name").fill("Saved after reload");
  api.behavior.deferMutations.add("catalog-plan-patch");
  await form.getByRole("button", { name: "Update plan" }).click();
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-plan-patch")).toBe(true);

  await page.goBack();
  await expectAppAndAddress(page, `#/plans?plan=${plan.id}`, "Plans & features");
  await expect(form.getByLabel("Name")).toHaveValue("Saved after reload");

  api.behavior.releaseMutations.get("catalog-plan-patch")();
  await expect(page.getByText(/catalog_plan_patched/)).toBeVisible();
  await leaveForOverview(page);
  await expectAppAndAddress(page, "#/overview", "Overview");
  await page.goBack();
  await expectAppAndAddress(page, `#/plans?plan=${plan.id}`, "Plans & features");
  await expect(page.getByRole("heading", { name: "Saved after reload", exact: true })).toBeVisible();
});

test("a refused Forward after Back into an entry from before a reload keeps the address on the current page", async ({ page }) => {
  const api = makeAdminApiFixture();
  const plan = api.seed.catalogPlan();
  await page.route("**/api/admin/**", api.route);
  let answer = "dismiss";
  const prompts = [];
  page.on("dialog", (dialog) => {
    prompts.push(dialog.message());
    void dialog[answer]();
  });
  await reloadOnPlanDetail(page, plan);
  await page.goBack();
  await expectAppAndAddress(page, "#/plans", "Plans & features");
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  const name = page.getByRole("form", { name: "Catalog plan" }).getByLabel("Name");
  await name.fill("Draft before Forward");

  await page.goForward();
  await expect.poll(() => prompts.length).toBe(1);
  await expectAppAndAddress(page, "#/plans", "Plans & features");
  await expect(name).toHaveValue("Draft before Forward");

  answer = "accept";
  await leaveForOverview(page);
  await expectAppAndAddress(page, "#/overview", "Overview");
  await page.goBack();
  await expectAppAndAddress(page, "#/plans", "Plans & features");
  expect(prompts).toHaveLength(2);
});

test("Back after a reload with nothing unsaved still walks the earlier entries", async ({ page }) => {
  const api = makeAdminApiFixture();
  const plan = api.seed.catalogPlan();
  await page.route("**/api/admin/**", api.route);
  await reloadOnPlanDetail(page, plan);
  await page.goBack();
  await expectAppAndAddress(page, "#/plans", "Plans & features");
  await expect(page.getByRole("row", { name: /Plan confirm/ }).getByRole("button", { name: "View plan", exact: true })).toBeVisible();
  await page.goBack();
  await expectAppAndAddress(page, "#/overview", "Overview");
  await page.goBack();
  await expectAppAndAddress(page, "#/customers", "Customers");
  await page.goForward();
  await expectAppAndAddress(page, "#/overview", "Overview");
});
