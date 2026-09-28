import { expect } from "@playwright/test";

import { makeAdminApiFixture, test } from "./admin-ui.fixture.mjs";

// Webhook event types are validated (worker + domain/runtime unit tests cover invalid_event_
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
  await expect(page.getByText("Webhook endpoint created.")).toBeVisible();

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
  await expect(page.getByText("Webhook endpoint changes saved.")).toBeVisible();

  expect(api.requests.webhookPatches).toHaveLength(1);
  expect(api.requests.webhookPatches[0].id).toBe("wh_1");
  // The URL was never touched in the edit form, so the PATCH omits it entirely -- only the field
  // that actually changed (event_types) is sent.
  expect(api.requests.webhookPatches[0].body).toEqual({ event_types: "update,disable" });

  await expect(row).toContainText("update,disable");
  // A successful patch closes the editor (mirrors the Policies edit flow).
  await expect(page.getByRole("form", { name: "Edit webhook endpoint", exact: true })).toHaveCount(0);
});

// webhook_endpoints.event_types has no database CHECK, so an existing row
// can already hold a token outside today's closed set. The PATCH form must never re-validate that
// legacy value just because some OTHER field changed, or such an endpoint could never be edited.
test("editing only the URL of an endpoint with a legacy event type still succeeds, and the legacy note names it", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.webhook("wh_legacy", "https://hooks.example.test/legacy", { event_types: "legacy_unknown_type" });
  await page.route("**/api/admin/**", api.route);

  await page.goto("/#/webhooks");
  const row = page.locator("tr").filter({ hasText: "https://hooks.example.test/legacy" });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const editForm = page.getByRole("form", { name: "Edit webhook endpoint", exact: true });
  await expect(editForm.getByText("Legacy event types not in the current list: legacy_unknown_type. Changing event types will remove them.", { exact: true })).toBeVisible();

  await editForm.getByLabel("URL", { exact: false }).fill("https://hooks.example.test/legacy-updated");
  await editForm.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Webhook endpoint changes saved.")).toBeVisible();

  expect(api.requests.webhookPatches).toHaveLength(1);
  // event_types was never touched, so the PATCH omits it -- the legacy value is never
  // re-validated against today's closed set just because the URL changed.
  expect(api.requests.webhookPatches[0].body).toEqual({ url: "https://hooks.example.test/legacy-updated" });

  const updatedRow = page.locator("tr").filter({ hasText: "https://hooks.example.test/legacy-updated" });
  await expect(updatedRow).toContainText("legacy_unknown_type");
});

// A save with nothing changed writes nothing: an empty PATCH would still bump updated_at and
// reorder the endpoint list for no change at all.
test("saving an unchanged webhook endpoint sends no request and says there was nothing to save", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.webhook("wh_unchanged", "https://hooks.example.test/unchanged", { event_types: "create,disable" });
  await page.route("**/api/admin/**", api.route);

  await page.goto("/#/webhooks");
  const row = page.locator("tr").filter({ hasText: "https://hooks.example.test/unchanged" });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const editForm = page.getByRole("form", { name: "Edit webhook endpoint", exact: true });
  await expect(editForm.getByLabel("URL", { exact: false })).toHaveValue("https://hooks.example.test/unchanged");
  await editForm.getByRole("button", { name: "Save changes", exact: true }).click();

  await expect(page.getByText("No changes to save.", { exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "Edit webhook endpoint", exact: true })).toHaveCount(0);
  expect(api.requests.webhookPatches).toHaveLength(0);
});

// "Send test event" runs through the backend, which alone holds the signing secret. The
// operator sees a sentence naming the receiver's status class; the request id stays under
// Technical details, and a disabled endpoint cannot be tested.
test("Send test event shows the receiver's status class, with the request id under Technical details", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.webhook("wh_test", "https://hooks.example.test/test");
  api.seed.webhook("wh_off", "https://hooks.example.test/off", { status: "disabled" });
  api.behavior.webhookTestResponses.push(
    { status: 200, body: { ok: true, code: "webhook_test_sent", request_id: "ui-e2e-test-5xx", data: { status_class: "5xx" } } },
    { status: 429, body: { ok: false, code: "rate_limited", request_id: "ui-e2e-test-limited", data: { retry_after: 42 } } },
  );
  await page.route("**/api/admin/**", api.route);

  await page.goto("/#/webhooks");
  const disabledRow = page.locator("tr").filter({ hasText: "https://hooks.example.test/off" });
  await expect(disabledRow.getByRole("button", { name: "Send test event", exact: true })).toBeDisabled();

  const row = page.locator("tr").filter({ hasText: "https://hooks.example.test/test" });
  const result = page.getByRole("status").filter({ hasText: "Test event to https://hooks.example.test/test" });

  await row.getByRole("button", { name: "Send test event", exact: true }).click();
  await expect(result).toContainText("The endpoint answered with a 5xx server error.");
  await expect(result.getByText("ui-e2e-test-5xx")).toBeHidden();
  await result.getByText("Technical details", { exact: true }).click();
  await expect(result.getByText(/webhook_test_sent · ui-e2e-test-5xx/)).toBeVisible();

  await row.getByRole("button", { name: "Send test event", exact: true }).click();
  await expect(result).toContainText("A test event was sent to this endpoint less than a minute ago. Try again in 42 seconds.");

  // With no scripted answer left the fixture behaves like a healthy receiver.
  await row.getByRole("button", { name: "Send test event", exact: true }).click();
  await expect(result).toContainText("The endpoint answered with a 2xx success.");

  expect(api.requests.webhookTests).toEqual(["wh_test", "wh_test", "wh_test"]);
});

// A test result describes the list it was sent from; a different filter is a different view.
test("a Send test event result clears when the endpoint filter changes", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.webhook("wh_test", "https://hooks.example.test/test");
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/webhooks");
  const row = page.locator("tr").filter({ hasText: "https://hooks.example.test/test" });
  await row.getByRole("button", { name: "Send test event", exact: true }).click();
  const result = page.getByRole("status").filter({ hasText: "Test event to https://hooks.example.test/test" });
  await expect(result).toContainText("The endpoint answered with a 2xx success.");

  await page.getByLabel("Filter endpoints by status").selectOption("active");
  await expect(result).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Send test event", exact: true })).toBeEnabled();
});

// Like its sibling row actions, Send test event waits until the endpoint list it belongs to has
// settled, so it never tests a row the current filter is still replacing.
test("Send test event waits while the endpoint list is reloading", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.webhook("wh_test", "https://hooks.example.test/test");
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/webhooks");
  const row = page.locator("tr").filter({ hasText: "https://hooks.example.test/test" });
  const send = row.getByRole("button", { name: "Send test event", exact: true });
  await expect(send).toBeEnabled();

  api.behavior.deferReads.add("webhooks:active");
  await page.getByLabel("Filter endpoints by status").selectOption("active");
  await expect.poll(() => api.behavior.releaseReads.has("webhooks:active")).toBe(true);
  await expect(send).toBeDisabled();
  await expect(row.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();

  api.behavior.releaseReads.get("webhooks:active")();
  await expect(send).toBeEnabled();
  expect(api.requests.webhookTests).toEqual([]);
});

// A result that arrives after the operator changed the filter belongs to a view that is gone.
test("a Send test event result that arrives after a filter change is dropped", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.webhook("wh_test", "https://hooks.example.test/test");
  await page.route("**/api/admin/**", api.route);
  let release = null;
  await page.route("**/api/admin/webhooks/wh_test/test", async (route) => {
    await new Promise((resolve) => { release = resolve; });
    await route.fallback();
  });
  await page.goto("/#/webhooks");
  const row = page.locator("tr").filter({ hasText: "https://hooks.example.test/test" });
  const send = row.getByRole("button", { name: "Send test event", exact: true });
  await send.click();
  await expect.poll(() => release !== null).toBe(true);
  await page.getByLabel("Filter endpoints by status").selectOption("active");
  release();
  await expect.poll(() => api.requests.webhookTests.length).toBe(1);
  await expect(send).toBeEnabled();
  await expect(page.getByRole("status").filter({ hasText: "Test event to" })).toHaveCount(0);
});
