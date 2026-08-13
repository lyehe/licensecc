import { expect, test } from "@playwright/test";

import { makeAdminApiFixture, makeEnvelope } from "./admin-ui.fixture.mjs";

test("admin UI renders Workstream F charts, expiring panel, health badge, and force-release", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);

  await page.goto("/");

  // Seed one entitlement so the health badge + force-release verb have a row to act on.
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("a".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  // HEALTH BADGE: an active, non-expiring (no valid_until) entitlement reads as "healthy".
  await expect(page.locator(".healthBadge.health-healthy")).toHaveText("healthy");

  // FORCE-RELEASE: the danger verb routes through the typed-confirm modal (reason required).
  await page.locator(".reason").getByLabel("Reason", { exact: true }).fill("dead machine");
  await page.getByRole("button", { name: "Release seats" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByLabel(/Reason/).fill("dead machine");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.releaseSeats.length).toBe(2);
  expect(api.requests.releaseSeats[0].reason).toBe("dead machine");
  expect(api.requests.releaseSeats[1].idempotencyKey).toBe(api.requests.releaseSeats[0].idempotencyKey);
  expect(api.requests.releaseSeats[1].rawBody).toBe(api.requests.releaseSeats[0].rawBody);
  await expect(page.getByText(/released 2 seats/)).toBeVisible();

  // REPORTS TAB: the inline-SVG charts render (aria-labelled), plus the expiring-soon panel rows.
  await page.getByRole("button", { name: "Reports" }).click();
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

  // Deep-link from an expiring row into the Entitlements tab filtered to that project/feature.
  await page.locator(".expiringPanel tbody tr").first().getByRole("button", { name: "View" }).click();
  await expect(page.locator("nav button.active")).toHaveText("Entitlements");

  // FULFILLMENT TAB: the fulfillment-events bar spark renders (aria-labelled).
  await page.getByRole("button", { name: "Fulfillment" }).click();
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

  async function assertConfirmation(button, consequence, dismissWithEscape = false) {
    await button.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(consequence);
    const confirm = dialog.getByRole("button", { name: "Confirm" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Reason (required)").fill("operator review");
    await expect(confirm).toBeEnabled();
    if (dismissWithEscape) {
      await page.keyboard.press("Escape");
    } else {
      await dialog.getByRole("button", { name: "Cancel" }).click();
    }
    await expect(dialog).toHaveCount(0);
  }

  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const entitlementRow = page.locator(".tablePane > table tbody tr").first();
  await assertConfirmation(entitlementRow.getByRole("button", { name: "Disable", exact: true }), "Verification and downloads stop until it is re-enabled", true);
  await assertConfirmation(entitlementRow.getByRole("button", { name: "Revoke", exact: true }), "TERMINAL and cannot be undone");
  await assertConfirmation(entitlementRow.getByRole("button", { name: "Release seats", exact: true }), "dead/unreachable machine");
  expect(api.requests.transitions).toHaveLength(0);
  expect(api.requests.releaseSeats).toHaveLength(0);

  await entitlementRow.getByRole("button", { name: "Devices", exact: true }).click();
  const devicePane = page.locator('[aria-label="Registered devices"]');
  await expect(devicePane).toBeVisible();
  await assertConfirmation(devicePane.getByRole("button", { name: "Disable", exact: true }), "refused on its next online check");
  await assertConfirmation(devicePane.getByRole("button", { name: "Revoke", exact: true }), "TERMINAL");
  expect(api.requests.deviceTransitions).toHaveLength(0);

  await page.getByRole("button", { name: "Customers", exact: true }).click();
  await page.getByRole("button", { name: "cus_acme", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Acme Corp" })).toBeVisible();
  await assertConfirmation(page.getByRole("button", { name: "Disable", exact: true }), "customer-portal access");
  expect(api.requests.customerTransitions).toHaveLength(0);

  await page.getByRole("button", { name: "Policies", exact: true }).click();
  const policyRow = page.locator("tr").filter({ hasText: "Confirm policy" });
  await expect(policyRow).toBeVisible();
  await assertConfirmation(policyRow.getByRole("button", { name: "Disable", exact: true }), "already-stamped entitlements are frozen and unaffected");
  expect(api.requests.policyTransitions).toHaveLength(0);

  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const catalogFeatureRow = page.locator("tr").filter({ hasText: "Confirm feature" });
  await expect(catalogFeatureRow).toBeVisible();
  await assertConfirmation(catalogFeatureRow.getByRole("button", { name: "Disable", exact: true }), "New plan projections skip disabled feature definitions");
  expect(api.requests.catalogFeatureTransitions).toHaveLength(0);

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const webhookRow = page.locator("tr").filter({ hasText: "https://hooks.example.test/confirm" });
  await expect(webhookRow).toBeVisible();
  await assertConfirmation(webhookRow.getByRole("button", { name: "Disable", exact: true }), "queued or failed deliveries already recorded are unaffected");
  expect(api.requests.webhookTransitions).toHaveLength(0);
});

test("admin UI consequence dialogs contain focus, isolate the background, and reflow long targets", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();

  const project = `project-${"long-segment-".repeat(8)}`;
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill(project);
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  const trigger = row.getByRole("button", { name: "Disable", exact: true });
  await trigger.focus();
  await trigger.click();

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
  await expect(reason).toBeFocused();
  await reason.fill("operator review");
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
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

  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
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
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeFocused();
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("fallback");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const trigger = page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Disable", exact: true });
  await trigger.focus();
  await trigger.click();
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("typed-failure");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const trigger = page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Disable", exact: true });
  await trigger.focus();
  await trigger.click();
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
  await trigger.click();
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
  await expect(createForm.getByRole("button", { name: "Save" })).toBeDisabled();
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
  await expect(page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
});

test("admin UI direct re-enable replays an unknown mutation with the same key", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("direct-reenable-unknown");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("e".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.abortTransition = true;
  const reenable = row.getByRole("button", { name: "Reenable", exact: true });
  await reenable.focus();
  await reenable.click();
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("wrong-action-reason");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("r".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.transitionStatus = 400;
  api.behavior.transitionResponse = { ok: false, code: "reason_required", request_id: "ui-e2e-wrong-action-reason" };
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("replay-outcomes");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("o".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.abortTransition = true;
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("partial-mutation");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("p".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const trigger = page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.transitionResponse = {
    ok: true,
    code: "entitlement_disabled",
    request_id: "ui-e2e-partial",
    data: {
      project: "partial-mutation",
      feature: "float",
      license_fingerprint: "p".repeat(64),
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("http-status");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("h".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const trigger = page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
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
      license_fingerprint: "h".repeat(64),
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("five-hundred-rejection");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("v".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const trigger = page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();

  async function createEntitlement(feature, fingerprint) {
    const createForm = page.locator("aside form");
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("Fingerprint").fill(fingerprint);
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }
  await createEntitlement("batch-one", "a".repeat(64));
  await createEntitlement("batch-two", "b".repeat(64));
  await page.getByLabel("Select all loaded rows").check();
  await page.locator(".bulkBar").getByRole("button", { name: "Disable" }).click();
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
});

test("admin UI rejects substituted batch result identities as unknown", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();

  async function createEntitlement(feature, fingerprint) {
    const createForm = page.locator("aside form");
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("Fingerprint").fill(fingerprint);
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }
  await createEntitlement("batch-one", "a".repeat(64));
  await createEntitlement("batch-two", "b".repeat(64));
  await page.getByLabel("Select all loaded rows").check();
  await page.locator(".bulkBar").getByRole("button", { name: "Disable" }).click();
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();

  const createForm = page.locator("aside form");
  for (const [index, [feature, fingerprint]] of [["batch-exact-one", "u"], ["batch-exact-two", "v"]].entries()) {
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("Fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => api.requests.creates).toBe(index + 1);
    await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(index + 1);
  }
  await page.getByLabel("Select all loaded rows").check();
  await page.locator(".bulkBar").getByRole("button", { name: "Disable" }).click();
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  for (const [feature, fingerprint] of [["batch-code-one", "c"], ["batch-code-two", "d"]]) {
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("Fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }
  await page.getByLabel("Select all loaded rows").check();
  await page.locator(".bulkBar").getByRole("button", { name: "Disable" }).click();
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();

  const createForm = page.locator("aside form");
  for (const [index, [feature, fingerprint]] of [["batch-order-one", "w"], ["batch-order-two", "x"]].entries()) {
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("Fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => api.requests.creates).toBe(index + 1);
    await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(index + 1);
  }
  await page.getByLabel("Select all loaded rows").check();
  await page.locator(".bulkBar").getByRole("button", { name: "Disable" }).click();
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

test("admin UI rejects duplicate release-seat identities as unknown", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("r".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  await page.locator(".reason").getByLabel("Reason", { exact: true }).fill("dead machine");
  await page.getByRole("button", { name: "Release seats" }).click();
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("device-evidence");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("e".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Devices", exact: true }).click();
  const devices = page.getByRole("region", { name: "Registered devices" });
  await expect(devices.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
  await devices.getByRole("button", { name: "Disable", exact: true }).click();
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("recovery-gate");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("q".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.refreshFailures = ["response-error"];
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh status" })).toBeVisible();
  api.behavior.deferRefresh = true;
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await refreshButton.click();
  await expect.poll(() => api.behavior.releaseRefresh).not.toBeNull();
  const createsBefore = api.requests.creates;
  // The unresolved owner makes the lock explicit instead of accepting a
  // silent no-op from an otherwise editable form.
  await expect(createForm.getByLabel("Project")).toBeDisabled();
  await expect(createForm.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(api.requests.creates).toBe(createsBefore);
  api.behavior.deferRefresh = false;
  api.behavior.releaseRefresh();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
});

test("admin UI gates ordinary mutations through the post-success refresh", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("post-success-gate");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("y".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.deferRefresh = true;
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
  await expect.poll(() => api.behavior.releaseRefresh).not.toBeNull();
  const createsBefore = api.requests.creates;
  await createForm.getByLabel("Project").fill("must-not-overlap");
  await expect(createForm.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(api.requests.creates).toBe(createsBefore);
  api.behavior.releaseRefresh();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeDisabled();
});

test("admin UI direct re-enable treats a malformed mutation response as unknown", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("direct-reenable-malformed");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("h".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.transitionFailure = "malformed";
  const reenable = row.getByRole("button", { name: "Reenable", exact: true });
  await reenable.click();
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("direct-reenable-refresh");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("g".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.refreshFailures = ["response-error", "response-error"];
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeDisabled();
  await expect(row.locator(".status")).toBeFocused();
});

test("admin UI settles a same-key reconciliation across a stale filter context without stealing focus", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("stale-unknown");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("s".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const filter = page.locator('input[placeholder="project"]');
  await filter.fill("stale-unknown");
  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.abortTransition = true;
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
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
  await expect(page.locator(".tablePane > table tbody tr").first()).toBeVisible();
  await expect(page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Reenable", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI settles an ABA filter switch after an exact same-key replay", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("aba-replay");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("z".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const filter = page.locator('input[placeholder="project"]');
  await filter.fill("aba-replay");
  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.abortTransition = true;
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("context-bound");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("i".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.refreshFailures = ["response-error"];
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  const transitionCount = api.requests.transitions.filter((item) => item.action === "reenable").length;
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  expect(api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(transitionCount);

  api.behavior.deferRefresh = true;
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await refreshButton.click();
  await expect.poll(() => api.behavior.releaseRefresh).not.toBeNull();
  api.behavior.deferRefresh = false;
  const filter = page.locator('input[placeholder="project"]');
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
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  for (const [project, fingerprint] of [["device-one", "j"], ["device-two", "k"]]) {
    await createForm.getByLabel("Project").fill(project);
    await createForm.getByLabel("Feature").fill("float");
    await createForm.getByLabel("Fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }

  await page.getByRole("button", { name: "Devices", exact: true }).nth(0).click();
  const devices = page.getByRole("region", { name: "Registered devices" });
  await expect(devices).toBeVisible();
  await expect.poll(() => api.requests.deviceReads.at(-1)).toBe("ent-1");
  await expect(devices.locator(".mono")).toContainText("sha256:bbbbbbbb");

  api.behavior.deviceRefreshFailures = ["response-error"];
  await devices.getByRole("button", { name: "Disable", exact: true }).click();
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.deviceTransitions.length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");

  // The retained recovery owns the operation gate, so switching device rows
  // is visibly unavailable. A still-editable filter can supersede the source
  // context without granting an overlapping mutation.
  await expect(page.getByRole("button", { name: "Devices", exact: true }).nth(1)).toBeDisabled();
  api.behavior.deferDeviceRefresh = true;
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await refreshButton.click();
  await expect.poll(() => api.behavior.releaseDeviceRefresh).not.toBeNull();
  const filter = page.locator('input[placeholder="project"]');
  await filter.fill("device-two");
  await expect.poll(() => api.requests.entitlementReads.at(-1)).toBe("device-two");
  api.behavior.deferDeviceRefresh = false;
  api.behavior.releaseDeviceRefresh();
  await expect(filter).toBeFocused();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await filter.fill("");
  await expect.poll(() => api.requests.entitlementReads.at(-1)).toBe("");
  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(devices.locator(".mono")).toContainText("sha256:bbbbbbbb");
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});
