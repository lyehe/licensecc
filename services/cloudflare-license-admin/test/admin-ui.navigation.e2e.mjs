import { expect, test } from "@playwright/test";

import { makeAdminApiFixture } from "./admin-ui.fixture.mjs";

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
