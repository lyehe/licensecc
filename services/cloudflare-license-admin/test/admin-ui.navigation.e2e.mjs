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
