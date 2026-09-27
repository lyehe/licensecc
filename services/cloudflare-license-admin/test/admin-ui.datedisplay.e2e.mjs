import { expect, test } from "@playwright/test";

import { makeAdminApiFixture } from "./admin-ui.fixture.mjs";

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
  await createForm.getByLabel("Valid until").fill("2026-12-31");
  await createForm.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();
  const row = page.locator(".desktopRecords tbody tr").filter({ hasText: "utc-validity" });
  await expect(row).toContainText("2026-12-31 UTC");
  await expect(row).not.toContainText("2026-12-30");

  await row.getByRole("button", { name: "Edit" }).click();
  const editForm = page.getByRole("form", { name: "Edit entitlement" });
  await expect(editForm).toContainText("Stored expiry: 2026-12-31 UTC.");
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  if (await page.getByRole("button", { name: "Activity", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Events", exact: true }).click();
  const eventTime = page.getByRole("region", { name: "Audit event records", exact: true }).locator("tbody tr").first().locator("td").first();
  await expect(eventTime).not.toHaveText("-");
  // A local event timestamp stays local (unlike a validity date): it must carry a zone label, not "UTC".
  await expect(eventTime).toHaveText(/[A-Za-z]{2,6}$/);
  await expect(eventTime).not.toHaveText(/ UTC$/);
});

test("the reports expiring-soon deadline renders in UTC in a non-UTC browser time zone", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  if (await page.getByRole("button", { name: "Activity", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Reports", exact: true }).click();
  const expiring = page.locator(".expiringPanel");
  // Fixture default (within_days=30) seeds a "pro-30" row with valid_until 1_760_500_000 = 2025-10-15T03:46:40Z.
  await expect(expiring).toContainText("2025-10-15 03:46 UTC");
});
