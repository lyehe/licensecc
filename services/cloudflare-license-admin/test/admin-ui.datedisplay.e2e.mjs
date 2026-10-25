import { expect } from "@playwright/test";

import { fillProtectedOwner, makeAdminApiFixture, test } from "./admin-ui.fixture.mjs";

// The whole file runs in a non-UTC browser time zone so a validity date's displayed value can only
// match what the operator typed (or the server enforces) if it is built from UTC, not local time.
test.use({ timezoneId: "America/New_York" });

test("an operator-typed validity date shows the same UTC day in the list and the editor, and an event keeps its local zone label", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/entitlements");

  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator("section.editorLayout form");
  await createForm.getByLabel("Project").fill("DEFAULT");
  await createForm.getByLabel("Feature").fill("utc-validity");
  await createForm.getByLabel("License fingerprint").fill("a".repeat(64));
  // Valid until is a plain <input type="date">; New York vs UTC only matters for what renders next.
  await createForm.getByLabel("Valid through").fill("2026-12-31");
  await expect(createForm).toContainText("Expiry: 2027-01-01T00:00:00Z (UTC).");
  await fillProtectedOwner(createForm);
  await createForm.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await expect(page.getByText("License (entitlement) created.")).toBeVisible();
  const row = page.locator(".desktopRecords tbody tr").filter({ hasText: "utc-validity" });
  await expect(row).toContainText("2026-12-31 UTC");
  await expect(row).not.toContainText("2026-12-30");

  await row.getByRole("button", { name: "Edit" }).click();
  const editForm = page.getByRole("form", { name: "Edit entitlement" });
  await expect(editForm).toContainText("Stored expiry: Valid through 2026-12-31 UTC.");
  await expect(editForm.getByLabel("Valid through")).toHaveValue("2026-12-31");
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  if (await page.getByRole("button", { name: "Activity", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Events", exact: true }).click();
  const eventTime = page.getByRole("region", { name: "Audit event records", exact: true }).locator("tbody tr").first().locator("td").first();
  await expect(eventTime).not.toHaveText("-");
  // A local event timestamp stays local (unlike a validity date): it must carry a zone label, not "UTC".
  await expect(eventTime).toHaveText(/[A-Za-z]{2,6}$/);
  await expect(eventTime).not.toHaveText(/ UTC$/);
});

test("the events date filters say they are UTC days and send UTC day bounds from a non-UTC browser", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  const eventQueries = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/admin/events") eventQueries.push(url.search);
  });
  await page.goto("/#/events");
  await page.getByText("More filters", { exact: true }).click();
  const since = page.getByLabel("Filter events since (UTC)", { exact: true });
  const until = page.getByLabel("Filter events until (UTC)", { exact: true });
  // The Time column beside these filters is local, so the filters must name their own zone.
  await expect(page.locator("label").filter({ has: since })).toContainText("Since (UTC)");
  await expect(page.locator("label").filter({ has: until })).toContainText("Until (UTC)");
  await since.fill("2026-09-27");
  await until.fill("2026-09-27");
  // 2026-09-27 as a UTC day: its first and last second, not New York's.
  await expect.poll(() => eventQueries.some((search) => search.includes("since=1790467200") && search.includes("until=1790553599"))).toBe(true);
});

test("the reports expiring-soon deadline renders in UTC in a non-UTC browser time zone", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  if (await page.getByRole("button", { name: "Activity", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Reports", exact: true }).click();
  const expiring = page.locator(".expiringPanel");
  // Fixture default (within_days=30) seeds a "pro-30" row with valid_until 1_760_500_000 = 2025-10-15T03:46:40Z.
  await expect(expiring).toContainText("2025-10-15T03:46:40Z");
});

test("an out-of-range validity date renders honestly instead of blanking the page", async ({ page }) => {
  const api = makeAdminApiFixture();
  // Number.MAX_SAFE_INTEGER seconds: a value the admin UI's own read guard accepts (it allows any
  // safe integer), but that is far beyond the JS Date range once formatted as a validity date.
  api.seed.entitlement({ project: "DEFAULT", feature: "far-future-expiry", valid_until: 9007199254740991 });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/entitlements");

  const row = page.locator(".desktopRecords tbody tr").filter({ hasText: "far-future-expiry" });
  await expect(row).toContainText("after 275760-09-13 UTC");
  // The rest of the page must stay usable: no render threw and blanked the workspace.
  await expect(page.getByRole("button", { name: "New entitlement", exact: true })).toBeVisible();
});

test("contextual edits preserve a precise expiry until the operator explicitly replaces it",async({page})=>{
  const api=makeAdminApiFixture(),customer=api.seed.customer({id:'cust_exact'});
  const exact=Date.parse('2026-12-20T18:42:03Z')/1000;
  api.seed.entitlement({customer_id:customer.id,project:'APP',feature:'PRO',valid_until:exact});
  await page.route('**/api/admin/**',api.route);
  await page.goto(`/#/customers/${customer.id}?section=access&app=APP`);
  await page.getByRole('button',{name:'Manage access',exact:true}).click();
  await expect(page.getByRole('region',{name:'Access details',exact:true})).toContainText('2026-12-20T18:42:03Z');
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  const form=page.getByRole('form',{name:'Edit entitlement'});
  await expect(form.getByLabel('Valid through')).toHaveCount(0);
  await form.getByLabel('Notes',{exact:true}).fill('Keep the exact deadline');
  await form.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Access details',exact:true})).toBeVisible();
  expect(api.requests.patches.at(-1).valid_until).toBe(exact);
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  await form.getByRole('button',{name:'Change expiry',exact:true}).click();
  await form.getByLabel('Valid through').fill('2026-12-31');
  await form.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByRole('region',{name:'Access details',exact:true})).toContainText('Valid through 2026-12-31 UTC');
  expect(api.requests.patches.at(-1).valid_until).toBe(Date.parse('2027-01-01T00:00:00Z')/1000);
});
