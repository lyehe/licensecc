import { expect, test } from "@playwright/test";

import { makeAdminApiFixture, makeEnvelope } from "./admin-ui.fixture.mjs";

const enterpriseCustomerId = "cus_enterprise_northwind_global_licensing_operations_0001";
const enterpriseCustomerName = "Northwind Global Infrastructure and Licensing Operations for Distributed Manufacturing";

async function installRealisticFixture(page) {
  const api = makeAdminApiFixture();
  api.seed.realistic();
  await page.route("**/api/admin/**", api.route);
  return api;
}

async function expectDocumentFitsViewport(page) {
  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

test("admin adds a portal user and reconciles a lost creation response without duplicating the account", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  const attempts = []; let result;
  await page.route("**/api/admin/customers", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const input = route.request().postDataJSON();
    attempts.push({ key: route.request().headers()["idempotency-key"], input });
    if (!result) {
      const row = api.seed.customer({ id: "cust_added_from_admin", name: input.name, email: "", login_email: input.email, status: "active" });
      result = makeEnvelope("customer_created", row);
      return route.abort("failed");
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(result) });
  });
  await page.goto("/#/customers");
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  const form = page.getByRole("form", { name: "Add portal user" });
  await form.getByLabel("Name", { exact: true }).fill("New portal user");
  await form.getByLabel("Login email", { exact: true }).fill("new-portal@example.test");
  await form.getByLabel("Initial password", { exact: true }).fill("A long initial passphrase 123!");
  await form.getByRole("button", { name: "Add user", exact: true }).click();
  await page.getByRole("button", { name: "Reconcile status", exact: true }).click();
  await expect(page.getByRole("heading", { name: "User added", exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Open user", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New portal user", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByText("Login email: new-portal@example.test", { exact: true })).toBeVisible();
  expect(page.url()).not.toContain("example.test");
});

test("customer app pages recover failed refreshes and manage only the selected owner's grant", async ({ page }) => {
  const api = makeAdminApiFixture();
  const customer = api.seed.customer();
  api.seed.entitlements([
    { customer_id: customer.id, project: "CAD", feature: "render" },
    { customer_id: "another-customer", project: "CAD", feature: "render" },
  ]);
  await page.route("**/api/admin/**", api.route);
  let appRequests = 0;
  await page.route(`**/api/admin/customers/${customer.id}/apps*`, async route => {
    appRequests++;
    if (appRequests === 2) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, code: "unavailable", request_id: "retry-test" }) });
    return route.fallback();
  });
  await page.goto(`/#/customers/${customer.id}?section=access`);
  await expect(page.getByRole("heading", { name: "CAD", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("unavailable");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "View app", exact: true }).click();
  await expect(page.getByRole("button", { name: "Manage access", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Registered nodes", exact: true }).click();
  await expect(page.getByText("No records found.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Floating sessions", exact: true }).click();
  await expect(page.getByText("No records found.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Access grants", exact: true }).click();
  await page.getByRole("button", { name: "Manage access", exact: true }).click();
  await expect(page.getByText(/License access for customer/)).toContainText(customer.id);
  await expect(page.locator(".desktopRecords tbody tr")).toHaveCount(1);
  expect(page.url()).toContain(`/customers/${customer.id}`);
  await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toHaveCount(0);
  const grantRow = page.locator(".desktopRecords tbody tr");
  await grantRow.locator("summary").filter({ hasText: "More actions" }).click();
  await grantRow.getByRole("button", { name: "Disable", exact: true }).click();
  const confirmation = page.getByRole("dialog");
  await confirmation.getByLabel("Reason (required)").fill("customer requested pause");
  await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(grantRow.locator(".status")).toHaveText("disabled");
  expect(api.requests.transitions.at(-1).body).toMatchObject({ expected_customer_id: customer.id, expected_revocation_seq: 1 });
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.getByRole("button", { name: "Manage access", exact: true })).toHaveCount(1);
  await page.goto("/#/plans");
  await page.getByRole("button", { name: "Browse apps", exact: true }).click();
  await page.getByRole("region", { name: "App inventory" }).getByRole("button", { name: "CAD", exact: true }).click();
  await expect(page.getByLabel("Plan project", { exact: true })).toHaveValue("CAD");
});

test("workspace shell has no document overflow at supported viewports", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const api = await installRealisticFixture(page);
  api.seed.policy();
  api.seed.webhook();
  api.seed.catalogFeature();
  api.seed.catalogPlan();
  const screens = ["overview", "customers", "licenses", "entitlements", "plans", "plans?view=features", "plans?view=import", "policies", "webhooks", "events", "fulfillment", "reports"];
  for (const [width, height] of [[320, 740], [390, 844], [768, 1024], [1024, 768], [1280, 900], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    for (const screen of screens) {
      await page.goto(`/#/${screen}`);
      await expect(page.locator("[data-workspace-heading]")).toBeVisible();
      await expect(page.locator('.environmentBadge')).toHaveText('Staging');
      await expectDocumentFitsViewport(page);
      if (["customers", "licenses", "entitlements", "plans", "plans?view=features", "policies", "webhooks", "events", "fulfillment"].includes(screen)) {
        const firstContent = page.locator(".workspaceContent tbody tr:visible, .workspaceContent .recordCard:visible, .workspaceContent .emptyState:visible").first();
        await expect(firstContent).toBeVisible();
        const bounds = await firstContent.boundingBox();
        expect(bounds.y, `${screen} first record or empty state at ${width}px`).toBeLessThan(height - 32);
      }
      await page.screenshot({ path: testInfo.outputPath(`${width}-${screen.replace(/[^a-z]/gu, "-")}.png`), fullPage: true });
      if (["customers", "entitlements"].includes(screen)) await page.screenshot({ path: testInfo.outputPath(`${width}-${screen}-viewport.png`) });
      if (screen === "plans" && [390, 1440].includes(width)) {
        await page.getByRole("button", { name: "New plan", exact: true }).click();
        const heading = page.getByRole("heading", { name: "New plan", exact: true });
        const project = page.getByRole("form", { name: "Catalog plan" }).getByLabel("Project");
        await expect(project).toBeVisible();
        const headingBox = await heading.boundingBox();
        const projectBox = await project.boundingBox();
        expect(projectBox.y).toBeGreaterThan(headingBox.y + headingBox.height);
        await expectDocumentFitsViewport(page);
        await page.screenshot({ path: testInfo.outputPath(`${width}-plan-editor.png`), fullPage: true });
      }
    }
  }
});

test("workspace navigation uses the mobile menu and desktop links", async ({ page }) => {
  await installRealisticFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.getByRole("button", { name: /menu/i }).click();
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation.getByRole("link", { name: "Customers", exact: true })).toBeVisible();
  await navigation.getByRole("link", { name: "Customers", exact: true }).click();
  await expect(page.locator("[data-workspace-heading]")).toHaveText("Customers");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const desktopNavigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(desktopNavigation.getByRole("button", { name: "Activity", exact: true })).toHaveAttribute("aria-expanded", "false");
  if (await page.getByRole("button", { name: "Activity", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Activity", exact: true }).click();
  await desktopNavigation.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
});

test("global search opens, submits records, escapes, and keeps private queries out of the URL", async ({ page }) => {
  const api = await installRealisticFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.getByRole("button", { name: /search/i }).click();
  const searchInput = page.getByRole("searchbox", { name: "Global search" });
  await expect(searchInput).toBeVisible();
  await searchInput.fill(enterpriseCustomerName);
  await page.getByRole("button", { name: "Search records", exact: true }).click();
  await expect.poll(() => api.requests.searches).toEqual([enterpriseCustomerName]);
  await expect(page.getByRole("region", { name: "Search workspace" })).toContainText(enterpriseCustomerName);
  expect(page.url()).not.toContain(enterpriseCustomerName);

  await searchInput.press("Escape");
  await expect(searchInput).toBeHidden();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
});

test("entitlements open list-first without an always-visible editor", async ({ page }, testInfo) => {
  await installRealisticFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/entitlements");

  await expect(page.getByRole("heading", { name: "License access", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New entitlement", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create entitlement", exact: true })).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Create entitlement", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Reason", { exact: true })).toHaveCount(0);
  const actions = page.locator(".desktopRecords .contextActions").first();
  await actions.locator("summary").click();
  const extend = actions.getByRole("button", { name: "Extend validity", exact: true });
  await expect(extend).toBeVisible();
  await extend.focus();
  await extend.press("Escape");
  await expect(actions).not.toHaveAttribute("open");
  await expect(actions.locator("summary")).toBeFocused();
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByLabel("License fingerprint", { exact: true })).toBeVisible();
    await expectDocumentFitsViewport(page);
    await page.screenshot({ path: testInfo.outputPath(`${width}-entitlement-editor.png`), fullPage: true });
  }
});

test("customer records retain desktop tables, mobile cards, and fluid detail sections", async ({ page }, testInfo) => {
  await installRealisticFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/customers");

  const desktopOpen = page.locator(`#customer-open-${enterpriseCustomerId}`);
  await expect(desktopOpen).toBeVisible();
  await desktopOpen.click();
  await expect(page.getByRole("heading", { name: enterpriseCustomerName, exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Customer detail sections" })).toBeVisible();
  await page.getByRole("button", { name: "Apps & access", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Apps & access", exact: true })).toBeVisible();
  const detailWidth = await page.locator(".recordDetail").evaluate((element) => element.getBoundingClientRect().width);
  expect(detailWidth).toBeGreaterThan(320);
  const statusBox = await page.locator(".customerTitle > .status").boundingBox();
  expect(statusBox.width).toBeLessThan(100);
  expect(statusBox.height).toBeLessThan(40);
  await expect(page.locator(".customerHeader").getByRole("textbox")).toHaveCount(0);
  await expect(page.locator(".customerHeader").getByRole("button", { name: "Reenable", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("1280-customer-header.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("390-customer-header.png") });
  await page.goto("/#/customers");
  const customerCard = page.locator(".recordCard").filter({ hasText: enterpriseCustomerName });
  await expect(customerCard).toBeVisible();
  await expect(customerCard.getByText("disabled", { exact: true })).toBeVisible();
  await expect(customerCard.getByRole("button", { name: "Open details", exact: true })).toBeVisible();
});

test("customer list read failures offer retry and recover the seeded list", async ({ page }) => {
  const api = await installRealisticFixture(page);
  let failNextCustomerList = true;
  await page.route(/\/api\/admin\/customers(?:\?.*)?$/u, async (route) => {
    if (failNextCustomerList) {
      failNextCustomerList = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "customers_unavailable", request_id: "ui-e2e-customers-unavailable" }),
      });
      return;
    }
    await api.route(route);
  });
  await page.goto("/#/customers");

  const failure = page.getByRole("alert");
  await expect(failure).toContainText("Could not load customers");
  await failure.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(`#customer-open-${enterpriseCustomerId}`)).toBeVisible();
});

test("customer URLs support direct entry and history while unavailable settings show unknown", async ({ page }) => {
  const api = await installRealisticFixture(page);
  api.behavior.settingsFailure = "response-error";
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/customers");
  await expect(page.locator(".environmentBadge")).toContainText(/unknown/i);

  await page.locator(`#customer-open-${enterpriseCustomerId}`).click();
  await expect(page.getByRole("heading", { name: enterpriseCustomerName, exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#\/customers\/${enterpriseCustomerId}`, "u"));
  await page.goBack();
  await expect(page.locator("[data-workspace-heading]")).toHaveText("Customers");
  await page.goForward();
  await expect(page.getByRole("heading", { name: enterpriseCustomerName, exact: true })).toBeVisible();
});

test("customer assignment replaces an untouched editor with customer and app context", async ({ page }) => {
  await installRealisticFixture(page);
  await page.goto("/#/entitlements");
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  await page.evaluate(id => { location.hash = `/customers/${id}?section=access`; }, enterpriseCustomerId);
  await page.getByRole("button", { name: "View assigned licenses", exact: true }).click();
  await expect(page.locator(".editorLayout form")).toHaveCount(0);
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  await page.getByText("Enter customer ID manually", { exact: true }).click();
  await expect(page.getByLabel("Customer ID", { exact: true })).toHaveValue(enterpriseCustomerId);
  await page.getByText("Enter license ID manually", { exact: true }).click();
  await page.getByLabel("License ID", { exact: true }).fill("lic_previous_project");
  await page.getByLabel("Project", { exact: true }).fill("OTHER_APP");
  await expect(page.getByLabel("License ID", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Customer ID", { exact: true })).toHaveValue(enterpriseCustomerId);
});
