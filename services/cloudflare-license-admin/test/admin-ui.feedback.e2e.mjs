import { expect } from "@playwright/test";

import { expectNoRawResultCodes, fillProtectedOwner, makeAdminApiFixture, test } from "./admin-ui.fixture.mjs";

// Operator feedback is readable, local and fresh: a sentence instead of a code (the code and
// request id wait under Technical details), page messages that do not follow the operator to
// another workspace, a validation error beside its field, and a create that opens its record.

const workspaceHeading = (page) => page.locator("[data-workspace-heading]");

async function goTo(page, name) {
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name, exact: true }).click();
  await expect(workspaceHeading(page)).toHaveText(name);
}

async function rowAction(row, name) {
  const menu = row.locator("details.contextActions");
  await expect(menu).toHaveCount(1);
  if (!await menu.evaluate((details) => details.open)) await menu.locator("summary").click();
  await row.getByRole("button", { name, exact: true }).click();
}

/** The input's inline error: named by aria-describedby, marked aria-invalid, with exactly this text. */
async function expectFieldError(field, text) {
  await expect(field).toHaveAttribute("aria-invalid", "true");
  const ids = (await field.getAttribute("aria-describedby")).split(" ");
  const errors = await Promise.all(ids.map((id) => field.page().locator(`[id="${id}"]`).textContent()));
  expect(errors).toContain(text);
}

test("a page message clears when the operator moves to another workspace", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/policies");
  await page.getByRole("button", { name: "New policy", exact: true }).click();
  const form = page.getByRole("form", { name: "New policy", exact: true });
  await form.getByLabel("Name (required)").fill("Banner policy");
  await form.getByRole("button", { name: "Create policy", exact: true }).click();

  const banner = page.locator(".activityMessage");
  await expect(banner).toContainText("Policy created.");
  await expect(banner.getByText(/policy_created/)).toBeHidden();
  await banner.getByText("Technical details", { exact: true }).click();
  await expect(banner.getByText(/^policy_created · ui-e2e-\d+$/)).toBeVisible();
  await expectNoRawResultCodes(page);

  await goTo(page, "Overview");
  await expect(page.locator(".activityMessage")).toHaveCount(0);
  // Browser history back to the workspace the message came from does not bring it back.
  await page.goBack();
  await expect(workspaceHeading(page)).toHaveText("Policies");
  await expect(page.locator(".activityMessage")).toHaveCount(0);
});

test("a retained unknown outcome keeps its notice, lock and Reconcile control across navigation", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.entitlement();
  api.behavior.abortTransition = true;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/entitlements");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  await expect(page.locator(".activityMessage")).toContainText("Exported entitlements.csv.");
  const row = page.getByRole("region", { name: "Entitlement records", exact: true }).locator("tbody tr").first();
  await rowAction(row, "Disable");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog.locator(".modalError")).toContainText("The outcome of this change is unknown. Don't repeat it; reconcile its status first.");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const notice = page.locator(".operatorNotice");
  await expect(notice).toContainText("The outcome of this change is unknown. Don't repeat it; reconcile its status first.");
  await expect(notice).toContainText("Other actions are unavailable until reconciliation completes.");
  // The notice is the one surface for this outcome: the page banner neither repeats it nor keeps
  // the earlier export message beside it.
  await expect(page.locator(".activityMessage")).toHaveCount(0);

  await goTo(page, "Overview");
  await expect(notice).toContainText("The outcome of this change is unknown. Don't repeat it; reconcile its status first.");
  await expect(notice.getByRole("button", { name: "Reconcile status", exact: true })).toBeEnabled();
  await expect(page.locator("main.consoleShell")).toHaveClass(/hasOperationNotice/);
  await goTo(page, "License access");
  await expect(notice.getByRole("button", { name: "Reconcile status", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "New entitlement", exact: true })).toBeDisabled();

  api.behavior.abortTransition = false;
  await notice.getByRole("button", { name: "Reconcile status", exact: true }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(page.locator(".activityMessage")).toContainText("Status reconciled.");
});

test("a policy validation error sits beside its field, and a name conflict marks the name", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.policy("pol_taken", "Taken name");
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/policies");
  await page.getByRole("button", { name: "New policy", exact: true }).click();
  const form = page.getByRole("form", { name: "New policy", exact: true });
  await form.getByLabel("Name (required)").fill("Negative duration");
  const duration = form.getByLabel("Duration (sec)", { exact: true });
  await duration.fill("-5");
  await form.getByRole("button", { name: "Create policy", exact: true }).click();
  await expectFieldError(duration, "Enter a whole number from 0 to 3,153,600,000.");
  await expect(duration).toBeFocused();
  // One surface per failure: the field carries it, the page banner does not.
  await expect(page.locator(".activityMessage")).toHaveCount(0);
  expect(api.requests.policyCreates).toHaveLength(0);

  // Correcting the field clears its error.
  await duration.fill("86400");
  await expect(duration).not.toHaveAttribute("aria-invalid", "true");

  await form.getByLabel("Name (required)").fill("Taken name");
  await form.getByRole("button", { name: "Create policy", exact: true }).click();
  const name = form.getByLabel("Name (required)");
  await expectFieldError(name, "A policy with this name already exists in this project. Choose another name.");
  await expect(page.locator(".activityMessage")).toHaveCount(0);
  expect(api.requests.policyCreates).toHaveLength(1);
  // A server refusal keeps its code and request id under Technical details beside the field, while
  // the input still names only the error sentence.
  expect((await name.getAttribute("aria-describedby")).split(" ")).toHaveLength(1);
  const technical = form.locator(".feedbackDetails").filter({ hasText: "policy_name_conflict" });
  await technical.getByText("Technical details", { exact: true }).click();
  await expect(technical.getByText("policy_name_conflict · ui-e2e-policy-conflict", { exact: true })).toBeVisible();
  // A local rule has no request to name.
  await name.fill("Fresh name");
  await expect(form.locator(".feedbackDetails")).toHaveCount(0);
});

test("a webhook URL error sits beside the URL, and a whole-form rule stays with the form", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/webhooks");
  await page.getByRole("button", { name: "New endpoint", exact: true }).click();
  const form = page.getByRole("form", { name: "New webhook endpoint", exact: true });
  const url = form.getByLabel("URL (required)");
  await url.fill("http://hooks.example.test/plain");
  await form.getByRole("button", { name: "Create endpoint", exact: true }).click();
  await expectFieldError(url, "The URL must start with https://.");
  await expect(page.locator(".activityMessage")).toHaveCount(0);

  await url.fill("https://hooks.example.test/scoped");
  await form.getByLabel("Scope: project (blank = all)").fill("DEFAULT");
  await form.getByLabel("Scope: customer id (blank = all)").fill("cus_acme");
  await form.getByRole("button", { name: "Create endpoint", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("Set a project scope or a customer scope, not both.");
  await expect(url).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".activityMessage")).toHaveCount(0);
  expect(api.requests.webhookCreates).toHaveLength(0);
});

test("a catalog feature key error sits beside the key, for a local rule and for a server conflict", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogFeature();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/plans?view=features");
  await page.getByRole("button", { name: "New feature", exact: true }).click();
  const form = page.getByRole("form", { name: "Catalog feature", exact: true });
  const key = form.getByLabel("Feature key");
  await key.fill("a-feature-key-too-long");
  await form.getByLabel("Name").fill("Too long");
  await form.getByRole("button", { name: "Create feature", exact: true }).click();
  await expectFieldError(key, "Required. Use one line within the length limit.");
  await expect(page.locator(".activityMessage")).toHaveCount(0);
  expect(api.requests.catalogFeatures).toHaveLength(0);

  await key.fill("confirm");
  await form.getByRole("button", { name: "Create feature", exact: true }).click();
  await expectFieldError(key, "A feature with this key already exists in this project.");
  await expect(page.locator(".activityMessage")).toHaveCount(0);
});

test("a device limit that is not a number is flagged beside the field and never saved", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.entitlement();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/entitlements");

  // The create form: a half-typed number reads as blank to the page, but it is not blank.
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const create = page.getByRole("form", { name: "New entitlement", exact: true });
  await create.getByLabel("Feature").fill("badinput");
  await create.getByLabel("License fingerprint").fill("c".repeat(64));
  const createLimit = create.getByLabel("Device limit");
  await createLimit.pressSequentially("5e");
  await create.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await expectFieldError(createLimit, "Enter a whole number of devices from 1 to 1,000,000.");
  expect(api.requests.creates).toBe(0);
  page.once("dialog", (prompt) => prompt.accept());
  await create.getByRole("button", { name: "Cancel", exact: true }).click();

  // The existing entitlement's own device limit form.
  const row = page.getByRole("region", { name: "Entitlement records", exact: true }).locator("tbody tr").first();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const limitForm = page.getByRole("form", { name: "Device limit", exact: true });
  const limit = limitForm.getByLabel("Device limit");
  await limit.fill("");
  await limit.pressSequentially("-");
  await limitForm.getByRole("button", { name: "Save device limit", exact: true }).click();
  await expectFieldError(limit, "Enter a whole number of devices from 1 to 1,000,000.");
  expect(api.requests.patches).toHaveLength(0);
});

test("creating a record opens it: policy, webhook, plan, feature and entitlement", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);

  await page.goto("/#/policies");
  await page.getByRole("button", { name: "New policy", exact: true }).click();
  let form = page.getByRole("form", { name: "New policy", exact: true });
  await form.getByLabel("Name (required)").fill("Opened policy");
  await form.getByRole("button", { name: "Create policy", exact: true }).click();
  const policyEditor = page.getByRole("form", { name: "Edit policy", exact: true });
  await expect(policyEditor.getByLabel("Name (required)")).toHaveValue("Opened policy");
  await expect(page.locator(".activityMessage")).toContainText("Policy created.");

  await page.goto("/#/webhooks");
  await page.getByRole("button", { name: "New endpoint", exact: true }).click();
  form = page.getByRole("form", { name: "New webhook endpoint", exact: true });
  await form.getByLabel("URL (required)").fill("https://hooks.example.test/opened");
  await form.getByRole("button", { name: "Create endpoint", exact: true }).click();
  const webhookEditor = page.getByRole("form", { name: "Edit webhook endpoint", exact: true });
  await expect(webhookEditor.getByLabel("URL (required)")).toHaveValue("https://hooks.example.test/opened");
  await expect(page.locator(".activityMessage")).toContainText("Webhook endpoint created.");

  await page.goto("/#/plans");
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  form = page.getByRole("form", { name: "Catalog plan", exact: true });
  await form.getByLabel("Plan key").fill("opened");
  await form.getByLabel("Name").fill("Opened plan");
  await form.getByRole("button", { name: "Create plan", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Opened plan", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/plans\?plan=/);
  await expect(page.locator(".activityMessage")).toContainText("Plan created.");

  await page.getByRole("button", { name: "Back to plans", exact: true }).click();
  await page.getByRole("navigation", { name: "Catalog views" }).getByRole("link", { name: "Features", exact: true }).click();
  await page.getByRole("button", { name: "New feature", exact: true }).click();
  form = page.getByRole("form", { name: "Catalog feature", exact: true });
  await form.getByLabel("Feature key").fill("opened");
  await form.getByLabel("Name").fill("Opened feature");
  await form.getByRole("button", { name: "Create feature", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit feature", exact: true })).toBeVisible();
  await expect(form.getByLabel("Feature key")).toHaveValue("opened");
  await expect(page.locator(".activityMessage")).toContainText("Feature created.");

  await page.goto("/#/entitlements");
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  form = page.getByRole("form", { name: "New entitlement", exact: true });
  await form.getByLabel("Feature").fill("opened");
  await form.getByLabel("License fingerprint").fill("d".repeat(64));
  await fillProtectedOwner(form);
  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await expect(page.locator(".activityMessage")).toContainText("License (entitlement) created.");
  await expect(page.getByRole("form", { name: "New entitlement", exact: true })).toHaveCount(0);
  const created = page.locator("[data-focus-row]").filter({ hasText: "opened" });
  await expect(created).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-focus-row]")?.textContent ?? "")).toContain("opened");
  // The list it was created from includes it, so it is focused there rather than shown on its own.
  await expect(page.getByText("Showing 1 entitlement")).toHaveCount(0);
});

test("a stale save of the entitlement editor explains itself and reloads the entitlement", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.entitlement();
  await page.route("**/api/admin/**", api.route);
  let refused = false;
  await page.route("**/api/admin/entitlements/ent-1", async (route) => {
    if (route.request().method() === "PATCH" && !refused) {
      refused = true;
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, code: "stale_transition", request_id: "ui-e2e-stale-edit" }) });
      return;
    }
    await route.fallback();
  });
  await page.goto("/#/entitlements");
  const row = page.getByRole("region", { name: "Entitlement records", exact: true }).locator("tbody tr").first();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("form", { name: "Edit entitlement", exact: true });
  await editor.getByLabel("Notes").fill("after a concurrent change");
  const readsBefore = api.requests.entitlementReads.length;
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();

  const banner = page.locator(".activityMessage");
  await expect(banner).toContainText("This license (entitlement) changed after you opened it; its current values were refreshed. Check your changes and save again.");
  await banner.getByText("Technical details", { exact: true }).click();
  await expect(banner.getByText("stale_transition · ui-e2e-stale-edit", { exact: true })).toBeVisible();
  await expect.poll(() => api.requests.entitlementReads.length).toBeGreaterThan(readsBefore);
  // The draft is kept, and saving again against the reloaded entitlement succeeds.
  await expect(editor.getByLabel("Notes")).toHaveValue("after a concurrent change");
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(banner).toContainText("Entitlement changes saved.");
  expect(api.requests.patches).toHaveLength(1);
});

test("a discarded catalog editor keeps none of its old inline errors", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan("plan_pro", "DEFAULT", "pro");
  api.seed.catalogFeature();
  await page.route("**/api/admin/**", api.route);
  page.on("dialog", (prompt) => prompt.accept());
  const openPlan = async () => {
    await page.getByRole("row", { name: /Plan pro pro/ }).getByRole("button", { name: "View plan", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Plan pro", exact: true })).toBeVisible();
  };
  await page.goto("/#/plans");

  // A projection previewed without a plan, discarded, then opened again from plan "pro".
  await page.getByRole("button", { name: "Apply plan", exact: true }).click();
  const projection = page.getByRole("form", { name: "Plan projection", exact: true });
  await projection.getByLabel("License ID").fill("lic_1");
  await projection.getByRole("button", { name: "Preview", exact: true }).click();
  const planKey = projection.getByLabel("Plan key");
  await expectFieldError(planKey, "Enter a plan key or a plan ID.");
  await page.getByRole("button", { name: "Back to plans", exact: true }).click();
  await openPlan();
  await page.getByRole("button", { name: "Apply plan", exact: true }).click();
  await expect(planKey).toHaveValue("pro");
  await expect(planKey).not.toHaveAttribute("aria-invalid", "true");
  await expect(projection.locator(".fieldError")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to plans", exact: true }).click();

  // A plan feature refused for its display order, discarded, then added again.
  await openPlan();
  await page.getByRole("button", { name: "Add feature", exact: true }).click();
  const row = page.getByRole("form", { name: "Plan feature", exact: true });
  await row.getByLabel("Feature key").fill("confirm");
  const order = row.getByLabel("Display order");
  await order.fill("-1");
  await row.getByRole("button", { name: "Save plan feature", exact: true }).click();
  await expectFieldError(order, "Enter a whole number from 0 to 1,000,000.");
  await page.getByRole("button", { name: "Back to plans", exact: true }).click();
  await openPlan();
  await page.getByRole("button", { name: "Add feature", exact: true }).click();
  await expect(order).toHaveValue("0");
  await expect(order).not.toHaveAttribute("aria-invalid", "true");
  await expect(row.locator(".fieldError")).toHaveCount(0);
});

test("a device limit cleared after unreadable text creates with the default limit", async ({ page }) => {
  const api = makeAdminApiFixture();
  const writes = [];
  await page.route("**/api/admin/**", api.route);
  await page.route("**/api/admin/entitlements", async (route) => {
    if (route.request().method() === "POST") writes.push(route.request().postDataJSON());
    await route.fallback();
  });
  await page.goto("/#/entitlements");
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const form = page.getByRole("form", { name: "New entitlement", exact: true });
  await form.getByLabel("Feature").fill("cleared");
  await form.getByLabel("License fingerprint").fill("c".repeat(64));
  const limit = form.getByLabel("Device limit");
  await limit.pressSequentially("5e");
  // Clearing unreadable text leaves the value blank both before and after, so no change event fires.
  await limit.fill("");
  await fillProtectedOwner(form);
  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await expect(page.locator(".activityMessage")).toContainText("License (entitlement) created.");
  expect(writes).toHaveLength(1);
  expect(Object.hasOwn(writes[0], "max_active_devices")).toBe(false);
});

test("a created entitlement outside the current filter opens alone, and its id stays out of the address", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/entitlements");
  await page.getByLabel("Filter by status").selectOption("disabled");
  await expect(page).toHaveURL(/status=disabled/);
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const fingerprint = "ab".repeat(32);
  const form = page.getByRole("form", { name: "New entitlement", exact: true });
  await form.getByLabel("Feature").fill("alone");
  await form.getByLabel("License fingerprint").fill(fingerprint);
  await fillProtectedOwner(form);
  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await expect(page.locator(".activityMessage")).toContainText("License (entitlement) created.");
  // Active, so not in the suspended list: the list shows the new record on its own.
  await expect(page.getByText("Showing 1 entitlement")).toBeVisible();
  const created = page.locator("[data-focus-row]").filter({ hasText: "alone" });
  await expect(created).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-focus-row]")?.textContent ?? "")).toContain("alone");
  const entitlementId = (await created.getAttribute("data-focus-row")).replace("entitlement:", "");
  expect(entitlementId).not.toBe("");
  // The single-record view is session memory: neither the address nor history state names the record.
  for (const secret of [entitlementId, fingerprint]) {
    expect(page.url()).not.toContain(secret);
    expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain(secret);
  }
});

test("a created entitlement opens in the list read after its save, even when an older read lands in between", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  let releaseCreate;
  const createHeld = new Promise((resolve) => { releaseCreate = resolve; });
  await page.route("**/api/admin/entitlements", async (route) => {
    if (route.request().method() === "POST") await createHeld;
    await route.fallback();
  });
  await page.goto("/#/entitlements");
  await expect(page.getByText("No entitlements yet. Create an entitlement to grant access.", { exact: true })).toBeVisible();
  // The read for the new filter is held, so it is still in flight when the save is sent.
  api.behavior.deferRefresh = true;
  await page.getByLabel("Filter by status").selectOption("active");
  await expect.poll(() => typeof api.behavior.releaseRefresh).toBe("function");
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const form = page.getByRole("form", { name: "New entitlement", exact: true });
  await form.getByLabel("Feature").fill("revealed");
  await form.getByLabel("License fingerprint").fill("e".repeat(64));
  await fillProtectedOwner(form);
  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  // That older read, sent before the save, lands while the save is still unanswered; then the save lands.
  const olderRead = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/admin/entitlements" && response.request().method() === "GET");
  api.behavior.releaseRefresh();
  await olderRead;
  releaseCreate();
  await expect(page.locator(".activityMessage")).toContainText("License (entitlement) created.");
  // The new row is active, so the save's own read shows it in this active list: it opens there, not alone.
  const created = page.locator("[data-focus-row]").filter({ hasText: "revealed" });
  await expect(created).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-focus-row]")?.textContent ?? "")).toContain("revealed");
  await expect(page.getByText("Showing 1 entitlement")).toHaveCount(0);
  await expect(page.getByLabel("Filter by status")).toHaveValue("active");
});

test("a create that settles after the operator changes the filter leaves that filter alone", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/entitlements");
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const form = page.getByRole("form", { name: "New entitlement", exact: true });
  await form.getByLabel("Feature").fill("late");
  await form.getByLabel("License fingerprint").fill("d".repeat(64));
  // The write lands, but the list read that should show it fails.
  api.behavior.refreshFailure = "response-error";
  await fillProtectedOwner(form);
  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  const notice = page.locator(".operatorNotice");
  await expect(notice).toContainText("The change was applied, but its status could not be refreshed.");
  // The operator moves to another view of the list before the new record could be shown.
  const status = page.getByLabel("Filter by status");
  await status.selectOption("disabled");
  await expect(page).toHaveURL(/status=disabled/);
  await notice.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Entitlement records", exact: true })).toBeVisible();
  await expect(status).toHaveValue("disabled");
  await expect(page.getByText("Showing 1 entitlement")).toHaveCount(0);
});

test("a stale save whose refresh fails says the values were not refreshed", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.entitlement();
  await page.route("**/api/admin/**", api.route);
  await page.route("**/api/admin/entitlements/ent-1", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, code: "stale_transition", request_id: "ui-e2e-stale-unreloaded" }) });
      return;
    }
    await route.fallback();
  });
  await page.goto("/#/entitlements");
  const row = page.getByRole("region", { name: "Entitlement records", exact: true }).locator("tbody tr").first();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("form", { name: "Edit entitlement", exact: true });
  await editor.getByLabel("Notes").fill("changed meanwhile");
  api.behavior.refreshFailure = "response-error";
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  const banner = page.locator(".activityMessage");
  await expect(banner).toContainText("This license (entitlement) changed after you opened it, and its current values could not be refreshed. Use Retry to refresh the list before you save again.");
  await expect(banner).not.toContainText("were refreshed");
  await expect(editor.getByLabel("Notes")).toHaveValue("changed meanwhile");
});
