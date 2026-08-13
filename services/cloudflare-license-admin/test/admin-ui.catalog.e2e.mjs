import { expect, test } from "@playwright/test";

import { makeAdminApiFixture } from "./admin-ui.fixture.mjs";

test("admin UI makes catalog-import Apply a modal, preview-bound, single-submit consequence", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();

  const form = page.getByRole("form", { name: "Catalog import" });
  const apply = form.getByRole("button", { name: "Apply import" });
  await expect(apply).toBeDisabled();
  const featureKey = `catalog_${"long_target_".repeat(7)}x`;
  const manifest = {
    format_version: 1,
    features: [{ project: "DEFAULT", feature_key: featureKey, name: "Long catalog target", description: "Consequence modal reflow proof" }],
    plans: [],
  };
  await form.getByLabel("Manifest JSON").fill(JSON.stringify(manifest));
  await form.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(1);
  await expect(apply).toBeEnabled();

  await apply.focus();
  await apply.click();
  let dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Apply this exact server-bound Preview");
  await expect(dialog).toContainText(featureKey);
  await expect(dialog.locator(".modalDetails")).toBeVisible();
  expect(api.requests.catalogImports).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const actionsBox = await dialog.locator(".actions").boundingBox();
  const viewport = page.viewportSize();
  expect(actionsBox).not.toBeNull();
  expect(actionsBox.y).toBeGreaterThanOrEqual(0);
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(viewport.height);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(apply).toBeFocused();
  expect(api.requests.catalogImports).toHaveLength(1);

  await apply.click();
  dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(apply).toBeFocused();
  expect(api.requests.catalogImports).toHaveLength(1);

  await apply.click();
  dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "Confirm" });
  api.behavior.deferMutations.add("catalog-import");
  await confirm.evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect.poll(() => api.requests.catalogImports.length).toBe(2);
  const applyRequest = api.requests.catalogImports[1];
  expect(applyRequest).toMatchObject({ dry_run: false, body: { preview_id: expect.stringMatching(/^civ_ui_/) } });
  expect(Object.keys(applyRequest.body)).toEqual(["preview_id"]);
  expect(applyRequest.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-import")).toBe(true);
  api.behavior.releaseMutations.get("catalog-import")();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-focus-section="catalog-import"] h2')).toBeFocused();
  expect(api.requests.catalogImports).toHaveLength(2);
});

test("admin UI reconciles an unknown catalog-import Apply with the original preview body and dialog key", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();

  const form = page.getByRole("form", { name: "Catalog import" });
  await form.getByLabel("Manifest JSON").fill(JSON.stringify({
    format_version: 1,
    features: [{ project: "DEFAULT", feature_key: "replay", name: "Replay" }],
    plans: [],
  }));
  await form.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(1);
  api.behavior.catalogImportAbortAfterApply = true;
  await form.getByRole("button", { name: "Apply import" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(2);
  const first = api.requests.catalogImports[1];
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(page.getByRole("button", { name: "Reconcile catalog import" })).toBeVisible();

  // The modal remains a true modal while the error is announced. Closing it
  // performs no second write and exposes the universal retained-attempt runner.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Reconcile catalog import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(3);
  const replay = api.requests.catalogImports[2];
  expect(replay.idempotency_key).toBe(first.idempotency_key);
  expect(replay.body).toEqual(first.body);
  expect(Object.keys(replay.body)).toEqual(["preview_id"]);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Replay replay/ })).toHaveCount(1);
});

test("admin UI replays a retained catalog-import Apply after a tab round-trip without publishing stale focus", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();

  const form = page.getByRole("form", { name: "Catalog import" });
  await form.getByLabel("Manifest JSON").fill(JSON.stringify({
    format_version: 1,
    features: [{ project: "DEFAULT", feature_key: "tab_replay", name: "Tab replay" }],
    plans: [],
  }));
  await form.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(1);
  api.behavior.catalogImportAbortAfterApply = true;
  await form.getByRole("button", { name: "Apply import" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(2);
  const first = api.requests.catalogImports[1];
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reconcile catalog import" })).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  }));

  // The screen that captured the dialog is now stale. Its immutable same-key
  // replay is still required to settle the retained server mutation, but may
  // not reclaim focus when the operator comes back to this pane.
  const reportsTab = page.getByRole("button", { name: "Reports", exact: true });
  await reportsTab.focus();
  await expect(reportsTab).toBeFocused();
  await page.keyboard.press("Enter");
  const plansTab = page.getByRole("button", { name: "Plans", exact: true });
  await plansTab.focus();
  await expect(plansTab).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(form.getByRole("button", { name: "Apply import" })).toBeDisabled();
  const catalogHeading = page.locator('[data-focus-section="catalog-import"] h2');
  const reconcile = page.getByRole("button", { name: "Reconcile catalog import" });
  await reconcile.focus();
  await expect(reconcile).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => api.requests.catalogImports.length).toBe(3);
  const replay = api.requests.catalogImports[2];
  expect(replay.idempotency_key).toBe(first.idempotency_key);
  expect(replay.body).toEqual(first.body);
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(() => resolve())));
  // The focused recovery control unmounts. Because the original Catalog
  // generation is stale, restoration must land on a live shell target rather
  // than the stale catalog heading or browser <body>.
  await expect(plansTab).toBeVisible();
  await expect(plansTab).toBeEnabled();
  await expect(plansTab).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await expect(catalogHeading).not.toBeFocused();
});

test("admin UI retains a substituted initial catalog-import Apply response for exact same-key reconciliation", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.catalogImportApplyResponseTransforms.push((preview) => ({
    ...preview,
    effects: {
      ...preview.effects,
      features: preview.effects.features.map((effect, index) => index === 0
        ? { ...effect, after: { ...effect.after, name: "Substituted server effect" } }
        : effect),
    },
  }));
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();

  const form = page.getByRole("form", { name: "Catalog import" });
  await form.getByLabel("Manifest JSON").fill(JSON.stringify({
    format_version: 1,
    features: [{ project: "DEFAULT", feature_key: "initial_substitution", name: "Initial substitution" }],
    plans: [],
  }));
  await form.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(1);
  await form.getByRole("button", { name: "Apply import" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(2);
  const first = api.requests.catalogImports[1];
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Reconcile catalog import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(3);
  const replay = api.requests.catalogImports[2];
  expect(replay.idempotency_key).toBe(first.idempotency_key);
  expect(replay.body).toEqual(first.body);
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
});

test("admin UI retains a substituted replayed catalog-import response until an exact replay arrives", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();

  const form = page.getByRole("form", { name: "Catalog import" });
  await form.getByLabel("Manifest JSON").fill(JSON.stringify({
    format_version: 1,
    features: [{ project: "DEFAULT", feature_key: "replay_substitution", name: "Replay substitution" }],
    plans: [],
  }));
  await form.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(1);
  api.behavior.catalogImportAbortAfterApply = true;
  await form.getByRole("button", { name: "Apply import" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(2);
  const first = api.requests.catalogImports[1];
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  api.behavior.catalogImportApplyResponseTransforms.push((preview) => ({
    ...preview,
    preview_id: `${preview.preview_id}_substituted`,
  }));
  await page.getByRole("button", { name: "Reconcile catalog import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(3);
  const substitutedReplay = api.requests.catalogImports[2];
  expect(substitutedReplay.idempotency_key).toBe(first.idempotency_key);
  expect(substitutedReplay.body).toEqual(first.body);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(page.getByRole("button", { name: "Reconcile catalog import" })).toBeVisible();

  await page.getByRole("button", { name: "Reconcile catalog import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(4);
  const exactReplay = api.requests.catalogImports[3];
  expect(exactReplay.idempotency_key).toBe(first.idempotency_key);
  expect(exactReplay.body).toEqual(first.body);
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
});

test("admin UI surfaces catalog-import capability failures exactly and recovers known success with a current read", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const form = page.getByRole("form", { name: "Catalog import" });
  const manifest = JSON.stringify({
    format_version: 1,
    features: [{ project: "DEFAULT", feature_key: "capability", name: "Capability" }],
    plans: [],
  });
  const preview = async () => {
    await form.getByLabel("Manifest JSON").fill(manifest);
    await form.getByRole("button", { name: "Preview import" }).click();
    await expect.poll(() => api.requests.catalogImports.at(-1)?.dry_run).toBe(true);
  };
  const attempt = async () => {
    await form.getByRole("button", { name: "Apply import" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Confirm" }).click();
    return dialog;
  };

  await preview();
  api.catalogImportState.claimAsOtherOperator(api.catalogImportState.latestPreviewId());
  let dialog = await attempt();
  await expect(dialog.locator(".modalError")).toContainText("stale_catalog_import_preview — preview again");
  await expect(page.getByRole("row", { name: /Capability capability/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(form.getByRole("button", { name: "Apply import" })).toBeDisabled();

  await preview();
  api.catalogImportState.expire(api.catalogImportState.latestPreviewId());
  dialog = await attempt();
  await expect(dialog.locator(".modalError")).toContainText("expired_catalog_import_preview — preview again");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await preview();
  api.catalogImportState.claim(api.catalogImportState.latestPreviewId());
  dialog = await attempt();
  await expect(dialog.locator(".modalError")).toContainText("claimed_catalog_import_preview — preview again");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await preview();
  api.behavior.catalogImportApplyErrors.push("catalog_import_too_large");
  dialog = await attempt();
  await expect(dialog.locator(".modalError")).toContainText("catalog_import_too_large — preview again");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await preview();
  api.behavior.catalogImportReadFailures.push("response-error");
  dialog = await attempt();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(form.getByRole("button", { name: "Apply import" })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(page.locator('[data-focus-section="catalog-import"] h2')).toBeFocused();
  await expect(page.getByRole("row", { name: /Capability capability/ })).toHaveCount(1);
});

test("admin UI clears its bound preview for stale and fingerprint-conflict Apply responses", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans" }).click();

  const featureForm = page.getByRole("form", { name: "Catalog feature" });
  await featureForm.getByLabel("Feature key").fill("core");
  await featureForm.getByLabel("Name").fill("Core");
  await featureForm.getByRole("button", { name: "Create feature" }).click();
  const planForm = page.getByRole("form", { name: "Catalog plan" });
  await planForm.getByLabel("Plan key").fill("pro");
  await planForm.getByLabel("Name").fill("Pro");
  await planForm.getByRole("button", { name: "Create plan" }).click();
  const planFeatureForm = page.getByRole("form", { name: "Plan feature" });
  await planFeatureForm.getByLabel("Feature key").fill("core");
  await planFeatureForm.getByRole("button", { name: "Save plan feature" }).click();

  const projectionForm = page.getByRole("form", { name: "Plan projection" });
  await projectionForm.getByLabel("License ID").fill("lic_stale");
  await projectionForm.getByLabel("Fingerprint").fill("d".repeat(64));
  await projectionForm.getByLabel("Plan key").fill("pro");
  await projectionForm.getByRole("button", { name: "Preview" }).click();
  const applyButton = projectionForm.getByRole("button", { name: "Apply" });
  await expect(applyButton).toBeEnabled();

  api.projectionState.staleNextPlanApply = true;
  await applyButton.click();
  await expect(page.getByText(/stale_projection_preview.*preview again/)).toBeVisible();
  await expect(applyButton).toBeDisabled();
  await projectionForm.getByRole("button", { name: "Preview" }).click();
  await expect(applyButton).toBeEnabled();

  api.projectionState.nextPlanApplyError = "license_fingerprint_conflict";
  await applyButton.click();
  await expect(page.getByText(/license_fingerprint_conflict.*preview again/)).toBeVisible();
  await expect(applyButton).toBeDisabled();
  // Both simulated 409s return before the fixture's entitlement/event/assignment
  // mutation path; the UI has only sent the server-bound preview_id.
  expect(api.requests.planApplies).toHaveLength(2);
  expect(api.requests.planApplies.every((body) => Object.keys(body).length === 1 && typeof body.preview_id === "string")).toBe(true);
});
