import { expect, test } from "@playwright/test";

import { makeAdminApiFixture } from "./admin-ui.fixture.mjs";

// E4: webhook event types are validated (worker + domain/runtime unit tests cover invalid_event_
// types), and webhooks can be edited. This e2e proves the operator-facing half: the create form's
// event_types are grouped checkboxes (not freeform csv text), "disable"/"reenable" are shared
// between the Entitlement and Customer groups, and the existing PATCH /api/admin/webhooks/{id}
// route now has an Edit form on it.

test("an operator creates a webhook via grouped event-type checkboxes and then edits it", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);

  await page.goto("/#/webhooks");
  await page.getByRole("button", { name: "New endpoint", exact: true }).click();
  const createForm = page.getByRole("form", { name: "New webhook endpoint", exact: true });
  await createForm.getByLabel("URL", { exact: false }).fill("https://hooks.example.test/e4");

  // One token from each group, plus the shared disable/reenable token via its Entitlement box.
  await createForm.getByLabel("Entitlement create", { exact: true }).check();
  await createForm.getByLabel("Entitlement disable", { exact: true }).check();
  await createForm.getByLabel("Order subscription.active", { exact: true }).check();

  // Checking the Entitlement "disable" box also shows the Customer "disable" box as checked --
  // it is the exact same csv token, matching both sources at once.
  await expect(createForm.getByLabel("Customer disable", { exact: true })).toBeChecked();
  await expect(createForm.getByText(/"disable" and "reenable" match both entitlement and customer events/)).toBeVisible();

  await createForm.getByRole("button", { name: "Create endpoint", exact: true }).click();
  await expect(page.getByText(/webhook_created/)).toBeVisible();

  expect(api.requests.webhookCreates).toHaveLength(1);
  expect(api.requests.webhookCreates[0]).toMatchObject({
    url: "https://hooks.example.test/e4",
    event_types: "create,disable,subscription.active",
  });

  const row = page.locator("tr").filter({ hasText: "https://hooks.example.test/e4" });
  await expect(row).toContainText("create,disable,subscription.active");

  // Edit the endpoint the create just produced: the PATCH form pre-fills from the row and reuses
  // the existing PATCH /api/admin/webhooks/{id} route.
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const editForm = page.getByRole("form", { name: "Edit webhook endpoint", exact: true });
  await expect(editForm.getByLabel("URL", { exact: false })).toHaveValue("https://hooks.example.test/e4");
  await expect(editForm.getByLabel("Entitlement create", { exact: true })).toBeChecked();
  await expect(editForm.getByLabel("Entitlement disable", { exact: true })).toBeChecked();
  await expect(editForm.getByLabel("Order subscription.active", { exact: true })).toBeChecked();

  await editForm.getByLabel("Entitlement create", { exact: true }).uncheck();
  await editForm.getByLabel("Entitlement update", { exact: true }).check();
  await editForm.getByLabel("Order subscription.active", { exact: true }).uncheck();
  await editForm.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText(/webhook_patched/)).toBeVisible();

  expect(api.requests.webhookPatches).toHaveLength(1);
  expect(api.requests.webhookPatches[0].id).toBe("wh_1");
  expect(api.requests.webhookPatches[0].body).toMatchObject({
    url: "https://hooks.example.test/e4",
    event_types: "update,disable",
  });

  await expect(row).toContainText("update,disable");
  // A successful patch closes the editor (mirrors the Policies edit flow).
  await expect(page.getByRole("form", { name: "Edit webhook endpoint", exact: true })).toHaveCount(0);
});
