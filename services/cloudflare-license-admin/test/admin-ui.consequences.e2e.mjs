import { expect, test } from "@playwright/test";

import { makeAdminApiFixture, makeEnvelope } from "./admin-ui.fixture.mjs";

async function revealAction(button) {
  await button.waitFor({ state: "attached" });
  const disclosure = button.locator("xpath=ancestor::details[1]");
  if (await disclosure.count() && await disclosure.getAttribute("open") === null) {
    await disclosure.locator(":scope > summary").click();
  }
}

async function clickAction(button) {
  await revealAction(button);
  await button.click();
}

test("admin UI renders Workstream F charts, expiring panel, validity indicators, and force-release", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);

  await page.goto("/");

  // Seed one entitlement so the health badge + force-release verb have a row to act on.
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("a".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  // Lifecycle and expiry are shown without implying that activation/device checks passed.
  await expect(page.locator(".desktopRecords .status.active")).toHaveText("active");
  await expect(page.locator(".desktopRecords").getByText("No expiry", { exact: true })).toBeVisible();

  // FORCE-RELEASE: the danger verb routes through the typed-confirm modal (reason required).
  await clickAction(page.getByRole("button", { name: "Release seats", includeHidden: true }).first());
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByLabel(/Reason/).fill("dead machine");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.releaseSeats.length).toBe(2);
  expect(api.requests.releaseSeats[0].reason).toBe("dead machine");
  expect(api.requests.releaseSeats[1].idempotencyKey).toBe(api.requests.releaseSeats[0].idempotencyKey);
  expect(api.requests.releaseSeats[1].rawBody).toBe(api.requests.releaseSeats[0].rawBody);
  await expect(page.getByText(/released 2 seats/)).toBeVisible();

  // REPORTS TAB: the inline-SVG charts render (aria-labelled), plus the expiring-soon panel rows.
  if (await page.getByRole("button", { name: "Activity", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("link", { name: "Reports" }).click();
  await expect.poll(() => api.requests.timeseries.length).toBeGreaterThan(0);
  await expect(page.getByRole("img", { name: /Checkouts .* versus denials/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /Denial rate/ })).toBeVisible();
  // The expiring-soon panel lists the in-window rows; the first deep-links to its entitlement.
  await expect(page.getByRole("heading", { name: "Expiring soon" })).toBeVisible();
  await expect.poll(() => api.requests.expiring.length).toBeGreaterThan(0);
  await expect(page.locator(".expiringPanel tbody tr")).toHaveCount(2);
  await expect(page.locator(".expiringPanel tbody tr").first().locator(".daysLeft")).toHaveText("3");

  // The expiring horizon selector re-queries with the chosen within_days.
  await page.locator(".expiringPanel .rangeSelector").getByRole("button", { name: "90d" }).click();
  await expect.poll(() => api.requests.expiring.at(-1)).toBe("90");

  // The time-series window selector re-queries the timeseries for the chosen look-back.
  const before = api.requests.timeseries.length;
  await page.locator(".chartPanels .rangeSelector").getByRole("button", { name: "last 30d" }).click();
  await expect.poll(() => api.requests.timeseries.length).toBeGreaterThan(before);

  // Deep-link from an expiring row lands on exactly that one entitlement, not the whole
  // project/feature list, and the URL carries neither the row's identity nor its fingerprint.
  await page.locator(".expiringPanel tbody tr").first().getByRole("button", { name: "View" }).click();
  await expect(page.locator(".sidebar nav a[aria-current=page]")).toHaveText("License access");
  await expect(page.getByText("Showing 1 entitlement", { exact: false })).toBeVisible();
  await expect(page.locator(".desktopRecords tbody tr")).toHaveCount(1);
  expect(page.url()).not.toContain("a".repeat(64));
  expect(new URL(page.url()).hash).toBe("#/entitlements");

  // FULFILLMENT TAB: the fulfillment-events bar spark renders (aria-labelled).
  if (await page.getByRole("button", { name: "Activity", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("link", { name: "Order activity" }).click();
  await page.getByText("Activity summary and trends", { exact: true }).click();
  await expect(page.getByRole("img", { name: /Fulfillment .* events/ })).toBeVisible();
  await expect(page.locator(".fulfillmentSpark .rangeSelector button.active")).toHaveText("last 30d");

  // No secret material ever leaks into the rendered DOM.
  const pageText = await page.locator("body").innerText();
  expect(pageText).not.toContain("PRIVATE KEY");
  expect(pageText).not.toContain("Bearer ");
});

test("admin UI keeps destructive operator actions consequence-led, reason-gated, and cancellable", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.policy();
  api.seed.webhook();
  api.seed.catalogFeature();
  await page.route("**/api/admin/**", api.route);

  async function assertConfirmation(button, consequence, dismissWithEscape = false, typedPhrase = null, confirmLabel = "Confirm") {
    await clickAction(button);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(consequence);
    const confirm = dialog.getByRole("button", { name: confirmLabel, exact: true });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Reason (required)").fill("operator review");
    if (typedPhrase !== null) {
      // A reason alone never satisfies a terminal action; the exact typed phrase is a second, independent gate.
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel(`Type ${typedPhrase} to confirm`).fill(typedPhrase);
    }
    await expect(confirm).toBeEnabled();
    if (dismissWithEscape) {
      await page.keyboard.press("Escape");
    } else {
      await dialog.getByRole("button", { name: "Cancel" }).click();
    }
    await expect(dialog).toHaveCount(0);
  }

  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const entitlementRow = page.locator(".tablePane table tbody tr").first();
  await assertConfirmation(entitlementRow.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first(), "Verification and downloads stop until it is re-enabled", true);
  await assertConfirmation(entitlementRow.getByRole("button", { name: "Revoke", exact: true, includeHidden: true }).first(), "TERMINAL and cannot be undone", false, "REVOKE 1", "Revoke");
  await assertConfirmation(entitlementRow.getByRole("button", { name: "Release seats", exact: true, includeHidden: true }).first(), "dead/unreachable machine");
  expect(api.requests.transitions).toHaveLength(0);
  expect(api.requests.releaseSeats).toHaveLength(0);

  await clickAction(entitlementRow.getByRole("button", { name: "Devices", exact: true, includeHidden: true }).first());
  const devicePane = page.locator('[aria-label="Registered devices"]');
  await expect(devicePane).toBeVisible();
  await assertConfirmation(devicePane.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first(), "refused on its next online check");
  await assertConfirmation(devicePane.getByRole("button", { name: "Revoke", exact: true, includeHidden: true }).first(), "TERMINAL", false, "REVOKE 1", "Revoke");
  expect(api.requests.deviceTransitions).toHaveLength(0);

  await page.getByRole("link", { name: "Customers", exact: true }).click();
  await page.locator("#customer-open-cus_acme").click();
  await expect(page.getByRole("heading", { name: "Acme Corp" })).toBeVisible();
  await assertConfirmation(page.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first(), "customer-portal access");
  expect(api.requests.customerTransitions).toHaveLength(0);

  if (await page.getByRole("button", { name: "Configuration", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("link", { name: "Policies", exact: true }).click();
  const policyRow = page.locator("tr").filter({ hasText: "Confirm policy" });
  await expect(policyRow).toBeVisible();
  await assertConfirmation(policyRow.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first(), "already-stamped entitlements are frozen and unaffected");
  expect(api.requests.policyTransitions).toHaveLength(0);

  if (await page.getByRole("button", { name: "Configuration", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("link", { name: "Plans & features", exact: true }).click();
  await page.getByRole("navigation", { name: "Catalog views" }).getByRole("link", { name: "Features", exact: true }).click();
  const catalogFeatureRow = page.locator("tr").filter({ hasText: "Confirm feature" });
  await expect(catalogFeatureRow).toBeVisible();
  await assertConfirmation(catalogFeatureRow.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first(), "New plan projections skip disabled feature definitions");
  expect(api.requests.catalogFeatureTransitions).toHaveLength(0);

  if (await page.getByRole("button", { name: "Configuration", exact: true }).getAttribute("aria-expanded") === "false") await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("link", { name: "Webhooks", exact: true }).click();
  const webhookRow = page.locator("tr").filter({ hasText: "https://hooks.example.test/confirm" });
  await expect(webhookRow).toBeVisible();
  await assertConfirmation(webhookRow.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first(), "queued or failed deliveries already recorded are unaffected");
  expect(api.requests.webhookTransitions).toHaveLength(0);
});

test("admin UI entitlement disable reason presets fill the field and leave it editable", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("a".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const entitlementRow = page.locator(".tablePane table tbody tr").first();
  await clickAction(entitlementRow.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  const reason = dialog.getByLabel("Reason (required)");

  const presets = dialog.getByRole("group", { name: "Common reasons" });
  await presets.getByRole("button", { name: "Fraud review", exact: true }).click();
  await expect(reason).toHaveValue("Fraud review");
  // A preset only fills the field; it stays an ordinary, editable text input, and focus moves to
  // it so the filled value is announced.
  await expect(reason).toBeEditable();
  await expect(reason).toBeFocused();
  await reason.fill("Fraud review, escalated to trust & safety");
  await expect(reason).toHaveValue("Fraud review, escalated to trust & safety");
  await dialog.getByRole("button", { name: "Payment failed", exact: true }).click();
  await expect(reason).toHaveValue("Payment failed");
  await dialog.getByRole("button", { name: "Customer request", exact: true }).click();
  await expect(reason).toHaveValue("Customer request");

  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  expect(api.requests.transitions[0]).toMatchObject({ action: "disable", reason: "Customer request" });
});

test("admin UI consequence dialogs contain focus, isolate the background, and reflow long targets", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();

  const project = `project-${"long-segment-".repeat(8)}`;
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill(project);
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const row = page.locator('[data-focus-row^="entitlement:"]:visible').first();
  const trigger = row.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first();
  await revealAction(trigger);
  await trigger.focus();
  await clickAction(trigger);

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-labelledby", /confirm-title-/);
  await expect(dialog).toHaveAttribute("aria-describedby", /confirm-description-/);
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await expect(page.locator("main")).toHaveAttribute("aria-hidden", "true");
  await expect(dialog).toContainText(project);
  await dialog.locator(".modalSurface").evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(dialog).toBeVisible();

  const reason = dialog.getByLabel("Reason (required)");
  const confirm = dialog.getByRole("button", { name: "Confirm" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const paymentFailedPreset = dialog.getByRole("button", { name: "Payment failed", exact: true });
  const customerRequestPreset = dialog.getByRole("button", { name: "Customer request", exact: true });
  const fraudReviewPreset = dialog.getByRole("button", { name: "Fraud review", exact: true });
  await expect(reason).toBeFocused();
  await reason.fill("operator review");
  // The disable reason presets sit in the tab order between the reason field and the actions.
  await page.keyboard.press("Tab");
  await expect(paymentFailedPreset).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(customerRequestPreset).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(fraudReviewPreset).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(fraudReviewPreset).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(customerRequestPreset).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(paymentFailedPreset).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(reason).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await dialog.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const actionsBox = await dialog.locator(".actions").boundingBox();
  const viewport = page.viewportSize();
  expect(actionsBox).not.toBeNull();
  expect(actionsBox.y).toBeGreaterThanOrEqual(0);
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(viewport.height);

  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await expect(page.locator("main")).not.toHaveAttribute("aria-hidden", "true");

  await clickAction(trigger);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await clickAction(trigger);
  await expect(dialog).toBeVisible();
  await reason.fill("operator review");
  api.behavior.deferTransition = true;
  await confirm.evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByRole("status")).toContainText("Working");
  await expect(cancel).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await cancel.evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await expect.poll(() => api.behavior.releaseTransition).not.toBeNull();
  api.behavior.releaseTransition();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI fallback consequence dialogs keep the background inert", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: undefined });
    } catch {
      HTMLDialogElement.prototype.showModal = undefined;
    }
  });
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("fallback");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const trigger = page.locator(".tablePane table tbody tr").first().getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first();
  await revealAction(trigger);
  await trigger.focus();
  await clickAction(trigger);
  const dialog = page.getByRole("dialog");
  await expect(page.locator(".modalOverlay")).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await expect(dialog.getByLabel("Reason (required)")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
});

test("admin UI typed failures keep consequence dialogs open and restore focus", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("typed-failure");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const trigger = page.locator(".tablePane table tbody tr").first().getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first();
  await revealAction(trigger);
  await trigger.focus();
  await clickAction(trigger);
  const dialog = page.getByRole("dialog");
  const reason = dialog.getByLabel("Reason (required)");
  await reason.fill("operator review");
  api.behavior.transitionStatus = 400;
  // This is a documented pre-mutation rejection.  An arbitrary 4xx code
  // would be indeterminate and must instead keep the original attempt.
  api.behavior.transitionResponse = { ok: false, code: "reason_required", request_id: "ui-e2e-transition-failed" };
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  const retryableKey = api.requests.transitions[0].idempotencyKey;
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-busy", "false");
  await expect(dialog.locator(".modalError")).toContainText("reason_required");
  await expect(dialog.locator(".modalError")).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(2);
  // A definitive pre-mutation failure ends the attempt.  A subsequent
  // editable retry therefore receives a new key rather than reusing it.
  expect(api.requests.transitions[1].idempotencyKey).not.toBe(retryableKey);
  const secondRetryableKey = api.requests.transitions[1].idempotencyKey;
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

  api.behavior.transitionResponse = null;
  api.behavior.transitionStatus = 200;
  api.behavior.abortTransition = true;
  await clickAction(trigger);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(3);
  expect(api.requests.transitions[2].idempotencyKey).not.toBe(secondRetryableKey);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".modalError")).toBeVisible();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.locator(".modalError")).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  await expect.poll(() => api.requests.transitions.length).toBe(3);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  // The unresolved owner deliberately disables the original destructive
  // trigger; focus must still remain in a usable in-app target, never BODY.
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(page.locator(".operatorNotice")).toContainText("Other actions are unavailable until reconciliation completes.");
  await expect(page.getByRole("button", { name: "New entitlement", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reconcile status" })).toBeVisible();
  const unknownKey = api.requests.transitions[2].idempotencyKey;
  // An unresolved owner exposes the recovery path and disables the source
  // action; it must not silently accept a second destructive submission.
  await expect(trigger).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(api.requests.transitions.filter((item) => item.action === "disable").length).toBe(3);
  expect(api.requests.transitions[2].idempotencyKey).toBe(unknownKey);

  api.behavior.abortTransition = false;
  const beforeReplay = api.requests.transitions.length;
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect.poll(() => api.requests.transitions.length).toBe(beforeReplay + 1);
  expect(api.requests.transitions[3].idempotencyKey).toBe(unknownKey);
  expect(api.requests.transitions[3].body).toEqual(api.requests.transitions[2].body);
  await expect(page.locator(".tablePane table tbody tr").first().getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeEnabled();
});

test("admin UI direct re-enable replays an unknown mutation with the same key", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("direct-reenable-unknown");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("e".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const row = page.locator(".tablePane table tbody tr").first();
  await clickAction(row.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeEnabled();

  api.behavior.abortTransition = true;
  const reenable = row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first();
  await revealAction(reenable);
  await reenable.focus();
  await clickAction(reenable);
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(1);
  await expect(reenable).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await expect(page.getByRole("button", { name: "Reconcile status" })).toBeVisible();
  api.behavior.abortTransition = false;
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(row.locator(".status")).toBeFocused();
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(2);
  const reenableRequests = api.requests.transitions.filter((item) => item.action === "reenable");
  expect(reenableRequests[1].idempotencyKey).toBe(reenableRequests[0].idempotencyKey);
  expect(reenableRequests[1].body).toEqual(reenableRequests[0].body);
});

test("admin UI keeps a wrong-action reason_required rejection indeterminate", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("wrong-action-reason");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("1".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();
  const row = page.locator(".tablePane table tbody tr").first();
  await clickAction(row.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeEnabled();

  api.behavior.transitionStatus = 400;
  api.behavior.transitionResponse = { ok: false, code: "reason_required", request_id: "ui-e2e-wrong-action-reason" };
  await clickAction(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first());
  const attempts = () => api.requests.transitions.filter((item) => item.action === "reenable");
  await expect.poll(() => attempts().length).toBe(1);
  const key = attempts()[0].idempotencyKey;
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

  api.behavior.transitionStatus = 200;
  api.behavior.transitionResponse = null;
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect.poll(() => attempts().length).toBe(2);
  expect(attempts()[1].idempotencyKey).toBe(key);
  expect(attempts()[1].body).toEqual(attempts()[0].body);
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
});

test("admin UI keeps every same-key replay failure indeterminate until exact success", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("replay-outcomes");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("e".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const row = page.locator(".tablePane table tbody tr").first();
  await clickAction(row.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeEnabled();

  api.behavior.abortTransition = true;
  await clickAction(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first());
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  const attempts = () => api.requests.transitions.filter((item) => item.action === "reenable");
  const first = attempts()[0];

  // Network/response loss on the replay is indeterminate: the notice and key remain.
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect.poll(() => attempts().length).toBe(2);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  expect(attempts()[1].idempotencyKey).toBe(first.idempotencyKey);
  expect(attempts()[1].body).toEqual(first.body);

  // A replay conflict cannot prove that the original ambiguous request did
  // not commit. It remains retained with the exact original key/body; only
  // a replay exact success may settle this attempt.
  api.behavior.abortTransition = false;
  api.behavior.transitionStatus = 409;
  api.behavior.transitionResponse = { ok: false, code: "revoked_entitlement_is_terminal", request_id: "ui-e2e-replay-conflict" };
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect.poll(() => attempts().length).toBe(3);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  expect(attempts()[2].idempotencyKey).toBe(first.idempotencyKey);
  expect(attempts()[2].body).toEqual(first.body);

  api.behavior.transitionResponse = null;
  api.behavior.transitionStatus = 200;
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect.poll(() => attempts().length).toBe(4);
  expect(attempts()[3].idempotencyKey).toBe(first.idempotencyKey);
  expect(attempts()[3].body).toEqual(first.body);
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
});

test("admin UI rejects a partial successful mutation envelope as unknown", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("partial-mutation");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const trigger = page.locator(".tablePane table tbody tr").first().getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first();
  await clickAction(trigger);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.transitionResponse = {
    ok: true,
    code: "entitlement_disabled",
    request_id: "ui-e2e-partial",
    data: {
      project: "partial-mutation",
      feature: "float",
      license_fingerprint: "f".repeat(64),
      status: "disabled",
      revocation_seq: 2,
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI rejects a non-2xx response carrying a successful mutation envelope", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("http-status");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("7".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const trigger = page.locator(".tablePane table tbody tr").first().getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first();
  await clickAction(trigger);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.transitionStatus = 500;
  api.behavior.transitionResponseOnce = true;
  api.behavior.transitionResponse = {
    ok: true,
    code: "entitlement_disabled",
    request_id: "ui-e2e-http-status",
    data: {
      id: "ent-1",
      project: "http-status",
      feature: "float",
      license_fingerprint: "7".repeat(64),
      status: "disabled",
      revocation_seq: 2,
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
});

test("admin UI treats a well-formed 5xx rejection envelope as an unknown mutation", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("five-hundred-rejection");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("5".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const trigger = page.locator(".tablePane table tbody tr").first().getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first();
  await clickAction(trigger);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.transitionStatus = 503;
  api.behavior.transitionResponse = { ok: false, code: "mutation_failed", request_id: "ui-e2e-five-hundred" };
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
});

test("admin UI rejects duplicate batch result identities as unknown", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();

  async function createEntitlement(feature, fingerprint) {
    if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
    const createForm = page.locator(".editorLayout form");
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("License fingerprint").fill(fingerprint);
    await createForm.getByRole("button", { name: "Create entitlement" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
    await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();
  }
  await createEntitlement("batch-one", "a".repeat(64));
  await createEntitlement("batch-two", "b".repeat(64));
  await page.getByLabel(/^Select all \d+ loaded$/).check();
  await clickAction(page.locator(".bulkBar").getByRole("button", { name: "Disable", includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("operator review");
  api.behavior.batchResponse = {
    ok: true,
    code: "batch_done",
    request_id: "ui-e2e-batch-duplicate",
    data: {
      results: [
        { id: "ent-1", ok: true, code: "entitlement_disabled" },
        { id: "ent-1", ok: true, code: "entitlement_disabled" },
      ],
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.batches.length).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  // A single-request batch keeps the single-request recovery copy; there is no chunk to name.
  await expect(dialog.locator(".batchRun")).not.toContainText(/chunk/i);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Reconcile status", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Reconcile chunk/ })).toHaveCount(0);
});

test("admin UI rejects substituted batch result identities as unknown", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();

  async function createEntitlement(feature, fingerprint) {
    if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
    const createForm = page.locator(".editorLayout form");
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("License fingerprint").fill(fingerprint);
    await createForm.getByRole("button", { name: "Create entitlement" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
    await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();
  }
  await createEntitlement("batch-one", "a".repeat(64));
  await createEntitlement("batch-two", "b".repeat(64));
  await page.getByLabel(/^Select all \d+ loaded$/).check();
  await clickAction(page.locator(".bulkBar").getByRole("button", { name: "Disable", includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("operator review");
  api.behavior.batchResponse = {
    ok: true,
    code: "batch_done",
    request_id: "ui-e2e-batch-substitution",
    data: {
      results: [
        { id: "ent-1", ok: true, code: "entitlement_disabled" },
        { id: "ent-3", ok: true, code: "entitlement_disabled" },
      ],
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.batches.length).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI reports a known partial batch outcome when every row identity and code are exact", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();

  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();

  const createForm = page.locator(".editorLayout form");
  for (const [index, [feature, fingerprint]] of [["batch-exact-one", "4"], ["batch-exact-two", "5"]].entries()) {
    if (!await createForm.isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("License fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Create entitlement" }).click();
    await expect.poll(() => api.requests.creates).toBe(index + 1);
    await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();
    await expect(page.locator(".tablePane table tbody tr")).toHaveCount(index + 1);
  }
  await page.getByLabel(/^Select all \d+ loaded$/).check();
  await clickAction(page.locator(".bulkBar").getByRole("button", { name: "Disable", includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("operator review");
  api.behavior.batchResponse = {
    ok: true,
    code: "batch_done",
    request_id: "ui-e2e-batch-partial-row",
    data: {
      results: [
        { id: "ent-1", ok: true, code: "entitlement_disabled" },
        { id: "ent-2", ok: false, code: "not_found" },
      ],
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.batches.length).toBe(1);
  expect(api.requests.batches[0].ids).toEqual(["ent-1", "ent-2"]);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/disable: 1 ok, 1 not-found/)).toBeVisible();
});

test("admin UI rejects an unknown per-row batch failure code as ambiguous", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  for (const [feature, fingerprint] of [["batch-code-one", "c"], ["batch-code-two", "d"]]) {
    if (!await createForm.isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("License fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Create entitlement" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();
  await page.getByLabel(/^Select all \d+ loaded$/).check();
  await clickAction(page.locator(".bulkBar").getByRole("button", { name: "Disable", includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("operator review");
  api.behavior.batchResponse = {
    ok: true,
    code: "batch_done",
    request_id: "ui-e2e-batch-unknown-row-code",
    data: {
      results: [
        { id: "ent-1", ok: true, code: "entitlement_disabled" },
        { id: "ent-2", ok: false, code: "undocumented_batch_failure" },
      ],
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
});

test("admin UI rejects reordered batch proof rows as an unknown outcome", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();

  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();

  const createForm = page.locator(".editorLayout form");
  for (const [index, [feature, fingerprint]] of [["batch-order-one", "6"], ["batch-order-two", "7"]].entries()) {
    if (!await createForm.isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("License fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Create entitlement" }).click();
    await expect.poll(() => api.requests.creates).toBe(index + 1);
    await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();
    await expect(page.locator(".tablePane table tbody tr")).toHaveCount(index + 1);
  }
  await page.getByLabel(/^Select all \d+ loaded$/).check();
  await clickAction(page.locator(".bulkBar").getByRole("button", { name: "Disable", includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("operator review");
  api.behavior.batchResponse = {
    ok: true,
    code: "batch_done",
    request_id: "ui-e2e-batch-reordered",
    data: {
      results: [
        { id: "ent-2", ok: true, code: "entitlement_disabled" },
        { id: "ent-1", ok: true, code: "entitlement_disabled" },
      ],
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.batches.length).toBe(1);
  expect(api.requests.batches[0].ids).toEqual(["ent-1", "ent-2"]);
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
});

/**
 * Records every batch POST (its key and body) before it is answered: by `respond(attempt, api)` when that
 * returns `{ status, body }`, otherwise by the fixture.
 */
async function routeBatchPosts(page, api, respond) {
  const attempts = [];
  await page.route("**/api/admin/**", api.route);
  await page.route("**/api/admin/entitlements/batch", async (route) => {
    const request = route.request();
    attempts.push({ key: request.headers()["idempotency-key"], body: request.postDataJSON() });
    const scripted = respond(attempts.length, api);
    if (scripted === undefined) return route.fallback();
    return route.fulfill({ status: scripted.status, contentType: "application/json", body: JSON.stringify(scripted.body) });
  });
  return attempts;
}

/** Seeds twenty active rows, then selects them all and confirms a bulk Disable with one reason. */
async function openTwentyRowBatch(page, respond) {
  const api = makeAdminApiFixture();
  api.seed.entitlements(20);
  const attempts = await routeBatchPosts(page, api, respond);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  await expect(page.locator("tbody input[type=checkbox]")).toHaveCount(20);
  await page.getByLabel("Select all 20 loaded", { exact: true }).check();
  await clickAction(page.locator(".bulkBar").getByRole("button", { name: "Disable", includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  return { api, attempts, dialog };
}

const chunkIds = (chunk) => Array.from({ length: 4 }, (_unused, row) => `ent-${(chunk - 1) * 4 + row + 1}`);

test("admin UI stops a twenty-row batch at a 500 on chunk 3 and reconciles that chunk with its own key", async ({ page }) => {
  const { attempts, dialog } = await openTwentyRowBatch(page, (attempt) => attempt === 3
    ? { status: 500, body: { ok: false, code: "internal_error", request_id: "ui-e2e-batch-chunk-three" } }
    : undefined);

  await expect.poll(() => attempts.length).toBe(3);
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  await expect(dialog.locator(".batchRun").getByRole("listitem")).toHaveText(["8 done", "4 outcome unknown", "8 not attempted"]);
  // The control cannot be reached from inside the modal, so the guidance says where it is.
  await expect(dialog.locator(".batchRun")).toContainText("Close this dialog, then use “Reconcile chunk 3” in the notice at the bottom of the page.");
  // The run stopped: chunks 4 and 5 are never sent.
  await page.waitForTimeout(400);
  expect(attempts.map((attempt) => attempt.body.ids)).toEqual([chunkIds(1), chunkIds(2), chunkIds(3)]);
  expect(new Set(attempts.map((attempt) => attempt.key)).size).toBe(3);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  const panel = page.locator(".tablePane .batchRun");
  await expect(panel.getByRole("listitem")).toHaveText(["8 done", "4 outcome unknown", "8 not attempted"]);
  await expect(panel).toContainText("Use “Reconcile chunk 3” in the notice at the bottom of the page.");
  await expect(panel).toContainText(attempts[2].key);
  await expect(page.locator(".desktopRecords .status.disabled")).toHaveCount(8);

  // Reconcile replays chunk 3's exact request under chunk 3's own key, and sends nothing else.
  await page.getByRole("button", { name: "Reconcile chunk 3", exact: true }).click();
  await expect.poll(() => attempts.length).toBe(4);
  expect(attempts[3]).toEqual(attempts[2]);
  await expect(panel.getByRole("listitem")).toHaveText(["12 done", "8 not attempted"]);
  await expect(page.getByRole("button", { name: "Reconcile chunk 3", exact: true })).toHaveCount(0);
  await expect(page.locator(".desktopRecords .status.disabled")).toHaveCount(12);
  await page.waitForTimeout(400);
  expect(attempts).toHaveLength(4);
  // The eight rows that were never sent stay selected for a deliberate follow-up run.
  await expect(page.locator(".bulkBar")).toContainText("8 selected");
});

test("admin UI reports a refused chunk 2 as failed, not unknown, and sends nothing after it", async ({ page }) => {
  const { attempts, dialog } = await openTwentyRowBatch(page, (attempt) => attempt === 2
    ? { status: 409, body: { ok: false, code: "idempotency_request_conflict", request_id: "ui-e2e-batch-chunk-two" } }
    : undefined);

  await expect.poll(() => attempts.length).toBe(2);
  // A definite refusal is a known outcome: nothing is retained, so the dialog closes on the counts.
  await expect(dialog).toHaveCount(0);
  const panel = page.locator(".tablePane .batchRun");
  await expect(panel.getByRole("listitem")).toHaveText(["4 done", "4 failed", "12 not attempted"]);
  await expect(panel).not.toContainText("unknown");
  await expect(page.getByRole("button", { name: /^Reconcile/ })).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(attempts.map((attempt) => attempt.body.ids)).toEqual([chunkIds(1), chunkIds(2)]);
  await expect(page.locator(".desktopRecords .status.disabled")).toHaveCount(4);
  await expect(page.locator(".bulkBar")).toContainText("16 selected");
});

test("admin UI keeps the confirmation open when chunk 1 is refused, and a retry reruns the plan under fresh keys", async ({ page }) => {
  const { attempts, dialog } = await openTwentyRowBatch(page, (attempt) => attempt === 1
    ? { status: 400, body: { ok: false, code: "reason_required", request_id: "ui-e2e-batch-chunk-one" } }
    : undefined);

  await expect.poll(() => attempts.length).toBe(1);
  // Nothing was applied, so this reads as a single refused request always did: the dialog stays open to retry.
  await expect(dialog.locator(".modalError")).toContainText("stopped at chunk 1 of 5");
  await expect(dialog.locator(".batchRun").getByRole("listitem")).toHaveText(["0 done", "4 failed", "16 not attempted"]);
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeEnabled();
  await page.waitForTimeout(400);
  expect(attempts).toHaveLength(1);

  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => attempts.length).toBe(6);
  await expect(dialog).toHaveCount(0);
  expect(attempts[1].body).toEqual(attempts[0].body);
  expect(new Set(attempts.map((attempt) => attempt.key)).size).toBe(6);
  await expect(page.locator(".tablePane .batchRun").getByRole("listitem")).toHaveText(["20 done"]);
});

test("admin UI never reports success when the status refresh fails after a partially refused run", async ({ page }) => {
  const { attempts, dialog } = await openTwentyRowBatch(page, (attempt, api) => {
    if (attempt !== 2) return undefined;
    // The strict status read that follows the stop fails once.
    api.behavior.refreshFailure = "response-error";
    return { status: 409, body: { ok: false, code: "idempotency_request_conflict", request_id: "ui-e2e-batch-refresh-lost" } };
  });

  await expect.poll(() => attempts.length).toBe(2);
  await expect(dialog).toHaveCount(0);
  const notice = page.locator(".operatorNotice");
  await expect(notice).toContainText("Disable stopped at chunk 2 of 5");
  await expect(notice).toContainText("Status refresh failed");
  await expect(page.getByText(/succeeded/i)).toHaveCount(0);
  await expect(page.locator(".tablePane .batchRun").getByRole("listitem")).toHaveText(["4 done", "4 failed", "12 not attempted"]);

  // The recovery is a status read only: it proves the view and sends no batch request.
  await notice.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.locator(".desktopRecords .status.disabled")).toHaveCount(4);
  expect(attempts).toHaveLength(2);
});

/** Seeds five suspended rows, then selects them all and starts a bulk Reenable, which has no dialog. */
async function reenableFiveRows(page, respond) {
  const api = makeAdminApiFixture();
  api.seed.entitlements(Array.from({ length: 5 }, () => ({ status: "disabled" })));
  const attempts = await routeBatchPosts(page, api, respond);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  await expect(page.locator("tbody input[type=checkbox]")).toHaveCount(5);
  await page.getByLabel("Select all 5 loaded", { exact: true }).check();
  await clickAction(page.locator(".bulkBar").getByRole("button", { name: "Reenable", includeHidden: true }).first());
  return { attempts };
}

test("admin UI reenables five suspended rows without a dialog as two chunks with their own keys", async ({ page }) => {
  const { attempts } = await reenableFiveRows(page, () => undefined);

  await expect.poll(() => attempts.length).toBe(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(attempts.map((attempt) => attempt.body.ids)).toEqual([["ent-1", "ent-2", "ent-3", "ent-4"], ["ent-5"]]);
  for (const attempt of attempts) expect(attempt.body.action).toBe("reenable");
  expect(new Set(attempts.map((attempt) => attempt.key)).size).toBe(2);
  const panel = page.locator(".tablePane .batchRun");
  await expect(panel.getByRole("listitem")).toHaveText(["5 done"]);
  await expect(panel).toContainText("Reenable finished.");
  await expect(page.locator(".desktopRecords .status.active")).toHaveCount(5);
});

test("admin UI reconciles an unknown second reenable chunk by replaying its frozen key and body", async ({ page }) => {
  const { attempts } = await reenableFiveRows(page, (attempt) => attempt === 2
    ? { status: 500, body: { ok: false, code: "internal_error", request_id: "ui-e2e-reenable-chunk-two" } }
    : undefined);

  await expect.poll(() => attempts.length).toBe(2);
  const panel = page.locator(".tablePane .batchRun");
  await expect(panel.getByRole("listitem")).toHaveText(["4 done", "1 outcome unknown", "0 not attempted"]);
  await expect(panel).toContainText("Use “Reconcile chunk 2” in the notice at the bottom of the page.");
  await page.waitForTimeout(400);
  expect(attempts).toHaveLength(2);

  await page.getByRole("button", { name: "Reconcile chunk 2", exact: true }).click();
  await expect.poll(() => attempts.length).toBe(3);
  expect(attempts[2]).toEqual(attempts[1]);
  expect(attempts[1].body.ids).toEqual(["ent-5"]);
  await expect(panel.getByRole("listitem")).toHaveText(["5 done"]);
  await expect(panel).toContainText("Reenable finished; chunk 2 is now reconciled.");
  await expect(page.locator(".desktopRecords .status.active")).toHaveCount(5);
});

test("admin UI rejects duplicate release-seat identities as unknown", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("1".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  await clickAction(page.getByRole("button", { name: "Release seats", includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("dead machine");
  api.behavior.releaseSeatsResponse = {
    ok: true,
    code: "seats_released",
    request_id: "ui-e2e-release-duplicate",
    data: { released: 2, seat_ids: ["seat_1", "seat_1"] },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.releaseSeats.length).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI rejects a device transition that proves a different entitlement", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("device-evidence");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("e".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const row = page.locator(".tablePane table tbody tr").first();
  await clickAction(row.getByRole("button", { name: "Devices", exact: true, includeHidden: true }).first());
  const devices = page.getByRole("region", { name: "Registered devices" });
  await revealAction(devices.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  await expect(devices.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first()).toBeVisible();
  await clickAction(devices.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.deviceTransitionResponse = (parent, action) => makeEnvelope(`device_${action}d`, {
    ...parent,
    id: "ent-not-selected",
    status: "disabled",
    revocation_seq: parent.revocation_seq + 1,
  });
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.deviceTransitions.length).toBe(1);
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
});

test("admin UI gates ordinary mutations while consequence recovery is pending", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("recovery-gate");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("0".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const row = page.locator(".tablePane table tbody tr").first();
  await clickAction(row.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeEnabled();

  api.behavior.refreshFailures = ["response-error"];
  await clickAction(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first());
  await expect(page.getByRole("button", { name: "Refresh status" })).toBeVisible();
  api.behavior.deferRefresh = true;
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await refreshButton.click();
  await expect.poll(() => api.behavior.releaseRefresh).not.toBeNull();
  const createsBefore = api.requests.creates;
  // The unresolved owner makes the lock explicit instead of accepting a
  // silent no-op from an otherwise editable form.
  await expect(createForm).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New entitlement", exact: true })).toBeDisabled();
  expect(api.requests.creates).toBe(createsBefore);
  api.behavior.deferRefresh = false;
  api.behavior.releaseRefresh();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
});

test("admin UI gates ordinary mutations through the post-success refresh", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("post-success-gate");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("8".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const row = page.locator(".tablePane table tbody tr").first();
  await clickAction(row.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeEnabled();

  api.behavior.deferRefresh = true;
  await clickAction(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first());
  await expect.poll(() => api.behavior.releaseRefresh).not.toBeNull();
  const createsBefore = api.requests.creates;
  await expect(createForm).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New entitlement", exact: true })).toBeDisabled();
  expect(api.requests.creates).toBe(createsBefore);
  api.behavior.releaseRefresh();
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeDisabled();
});

test("admin UI direct re-enable treats a malformed mutation response as unknown", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("direct-reenable-malformed");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("7".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const row = page.locator(".tablePane table tbody tr").first();
  await clickAction(row.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeEnabled();

  api.behavior.transitionFailure = "malformed";
  const reenable = row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first();
  await clickAction(reenable);
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(1);
  await expect(reenable).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI direct re-enable keeps parsed refresh recovery visible", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("direct-reenable-refresh");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("6".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const row = page.locator(".tablePane table tbody tr").first();
  await clickAction(row.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeEnabled();

  api.behavior.refreshFailures = ["response-error", "response-error"];
  await clickAction(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first());
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true })).toHaveCount(0);
  await expect(row.locator(".status")).toBeFocused();
});

test("admin UI settles a same-key reconciliation across a stale filter context without stealing focus", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("stale-unknown");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("2".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const filter = page.locator('input[aria-label="Filter by project"]');
  await filter.fill("stale-unknown");
  const row = page.locator(".tablePane table tbody tr").first();
  await clickAction(row.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeEnabled();

  api.behavior.abortTransition = true;
  await clickAction(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first());
  await expect(page.getByRole("button", { name: "Reconcile status" })).toBeVisible();
  const unknownAttempt = api.requests.transitions.at(-1);
  api.behavior.deferTransition = true;
  api.behavior.abortTransition = false;
  const reconcile = page.locator(".operatorNotice button");
  await reconcile.click();
  await expect.poll(() => api.behavior.releaseTransition).not.toBeNull();
  await filter.fill("no-such-project");
  api.behavior.deferTransition = false;
  api.behavior.releaseTransition();
  await expect(filter).toBeFocused();
  // An exact same-key success resolves the global owner even when the source
  // list has since been superseded.  The stale source must not reclaim focus.
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  const replay = api.requests.transitions.at(-1);
  expect(api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(2);
  expect(replay.idempotencyKey).toBe(unknownAttempt.idempotencyKey);
  expect(replay.body).toEqual(unknownAttempt.body);

  await filter.fill("stale-unknown");
  await expect(page.locator(".tablePane table tbody tr").first()).toBeVisible();
  await expect(page.locator(".tablePane table tbody tr").first().getByRole("button", { name: "Reenable", exact: true, includeHidden: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI settles an ABA filter switch after an exact same-key replay", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("aba-replay");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("9".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const filter = page.locator('input[aria-label="Filter by project"]');
  await filter.fill("aba-replay");
  const row = page.locator(".tablePane table tbody tr").first();
  await clickAction(row.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeEnabled();

  api.behavior.abortTransition = true;
  await clickAction(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first());
  await expect(page.getByRole("button", { name: "Reconcile status" })).toBeVisible();
  const firstReplayCandidate = api.requests.transitions.at(-1);

  api.behavior.abortTransition = false;
  api.behavior.deferRefresh = true;
  const reconcile = page.locator(".operatorNotice button");
  await reconcile.click();
  await expect.poll(() => api.behavior.releaseRefresh).not.toBeNull();
  await expect(reconcile).toHaveText("Refreshing…");
  await filter.fill("not-aba-replay");
  await expect.poll(() => api.requests.entitlementReads.at(-1)).toBe("not-aba-replay");
  await filter.fill("aba-replay");
  await expect.poll(() => api.requests.entitlementReads.at(-1)).toBe("aba-replay");
  api.behavior.deferRefresh = false;
  api.behavior.releaseRefresh();

  await expect(filter).toBeFocused();
  // The replay's original strict GET started before the A → B → A switch, so
  // it cannot prove the final A view. A current-context GET-only recovery can.
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  const replay = api.requests.transitions.at(-1);
  expect(replay.idempotencyKey).toBe(firstReplayCandidate.idempotencyKey);
  expect(replay.rawBody).toBe(firstReplayCandidate.rawBody);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI keeps unresolved recovery exclusive without stealing focus after a filter change", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  await createForm.getByLabel("Project").fill("context-bound");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("License fingerprint").fill("8".repeat(64));
  await createForm.getByRole("button", { name: "Create entitlement" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  const row = page.locator(".tablePane table tbody tr").first();
  await clickAction(row.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeEnabled();

  api.behavior.refreshFailures = ["response-error"];
  await clickAction(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first());
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  const transitionCount = api.requests.transitions.filter((item) => item.action === "reenable").length;
  await expect(row.getByRole("button", { name: "Reenable", exact: true, includeHidden: true }).first()).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  expect(api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(transitionCount);

  api.behavior.deferRefresh = true;
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await refreshButton.click();
  await expect.poll(() => api.behavior.releaseRefresh).not.toBeNull();
  api.behavior.deferRefresh = false;
  const filter = page.locator('input[aria-label="Filter by project"]');
  await filter.fill("no-such-project");
  api.behavior.releaseRefresh();
  await expect(filter).toBeFocused();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  expect(api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(transitionCount);
  await filter.fill("");
  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI discards stale device recovery after filter supersession while actions are locked", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("link", { name: "License access", exact: true }).click();
  if (!await page.locator(".editorLayout form").isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const createForm = page.locator(".editorLayout form");
  for (const [project, fingerprint] of [["device-one", "9"], ["device-two", "a"]]) {
    if (!await createForm.isVisible()) await page.getByRole("button", { name: "New entitlement", exact: true }).click();
    await createForm.getByLabel("Project").fill(project);
    await createForm.getByLabel("Feature").fill("float");
    await createForm.getByLabel("License fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Create entitlement" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }
  await page.getByRole("button", { name: "Back to entitlements", exact: true }).click();

  await clickAction(page.locator(".desktopRecords").getByRole("button", { name: "Devices", exact: true, includeHidden: true }).nth(0));
  const devices = page.getByRole("region", { name: "Registered devices" });
  await expect(devices).toBeVisible();
  await expect.poll(() => api.requests.deviceReads.at(-1)).toBe("ent-1");
  await expect(devices.locator(".desktopRecords code").first()).toContainText("sha256:bbbbbbbb");

  api.behavior.deviceRefreshFailures = ["response-error"];
  await clickAction(devices.getByRole("button", { name: "Disable", exact: true, includeHidden: true }).first());
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.deviceTransitions.length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");

  // The retained recovery owns the operation gate, so switching device rows
  // is visibly unavailable. A still-editable filter can supersede the source
  // context without granting an overlapping mutation.
  await expect(page.locator(".desktopRecords").getByRole("button", { name: "Devices", exact: true, includeHidden: true }).nth(1)).toBeDisabled();
  api.behavior.deferDeviceRefresh = true;
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await refreshButton.click();
  await expect.poll(() => api.behavior.releaseDeviceRefresh).not.toBeNull();
  const releaseOriginalDeviceRefresh = api.behavior.releaseDeviceRefresh;
  const filter = page.locator('input[aria-label="Filter by project"]');
  await filter.fill("device-two");
  await expect.poll(() => api.requests.entitlementReads.at(-1)).toBe("device-two");
  api.behavior.deferDeviceRefresh = false;
  releaseOriginalDeviceRefresh();
  if (api.behavior.releaseDeviceRefresh !== releaseOriginalDeviceRefresh) api.behavior.releaseDeviceRefresh();
  await expect(filter).toBeFocused();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await filter.fill("");
  await expect.poll(() => api.requests.entitlementReads.at(-1)).toBe("");
  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(devices.locator(".desktopRecords code").first()).toContainText("sha256:bbbbbbbb");
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});
