import { expect, test } from "@playwright/test";

import { makeAdminApiFixture, makeEnvelope } from "./admin-ui.fixture.mjs";

test("admin UI disables hidden catalog-plan controls while its filtered page one is unsettled", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan("plan_old", "OLD", "old");
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const plansPane = page.getByRole("heading", { name: "Catalog plans" }).locator("..");
  await expect(plansPane.getByText("Plan old")).toBeVisible();
  await plansPane.getByRole("button", { name: "Use", exact: true }).click();
  const planFeatureForm = page.getByRole("form", { name: "Plan feature" });
  await expect(planFeatureForm.getByLabel("Selected plan")).toHaveValue("plan_old");

  const deferredRead = "catalog-plans:HIDDEN::page-1";
  api.behavior.deferReads.add(deferredRead);
  await plansPane.getByPlaceholder("project").fill("HIDDEN");
  await expect.poll(() => api.behavior.releaseReads.has(deferredRead)).toBe(true);
  await expect(planFeatureForm.getByLabel("Selected plan")).toBeDisabled();
  await expect(planFeatureForm.getByRole("button", { name: "Save plan feature" })).toBeDisabled();
  expect(api.requests.catalogPlanFeatures).toHaveLength(0);

  api.behavior.releaseReads.get(deferredRead)();
  await expect(plansPane.locator("tbody tr")).toHaveCount(0);
  await expect(planFeatureForm.getByRole("button", { name: "Save plan feature" })).toBeDisabled();
  expect(api.requests.catalogPlanFeatures).toHaveLength(0);
});

test("admin UI rejects repeated cursors and duplicate rows from shared and custom pagers", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan("plan_one", "DEFAULT", "one");
  api.seed.catalogPlan("plan_two", "DEFAULT", "two");
  api.behavior.catalogPlanPagination = true;
  const endpoint = api.seed.webhook("wh_pager", "https://hooks.example.test/pager");
  api.behavior.deliveryRows = [
    { id: 301, endpoint_id: endpoint.id, event_id: 1, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
    { id: 302, endpoint_id: endpoint.id, event_id: 2, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
  ];
  api.behavior.deliveryPagination = true;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const plansPane = page.getByRole("heading", { name: "Catalog plans" }).locator("..");
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  api.behavior.catalogPlanRepeatCursor = true;
  await plansPane.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("invalid_api_response (repeated_cursor)")).toBeVisible();
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await expect(plansPane.getByRole("button", { name: "Load more" })).toHaveCount(0);

  // A bad cursor is retired, so give the duplicate-row branch a new settled
  // page-one snapshot instead of expecting a second unsafe append from it.
  api.behavior.catalogPlanRepeatCursor = false;
  api.behavior.catalogPlanDuplicatePage = true;
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  await page.getByRole("button", { name: "Plans", exact: true }).click();
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await plansPane.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("invalid_api_response (duplicate_page_item)")).toBeVisible();
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await expect(plansPane.getByRole("button", { name: "Load more" })).toHaveCount(0);

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const webhookRow = page.locator(".tablePane > table tbody tr").filter({ hasText: "https://hooks.example.test/pager" });
  await webhookRow.getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  api.behavior.deliveryDuplicatePage = true;
  await deliveries.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("invalid_api_response (duplicate_page_item)")).toBeVisible();
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await expect(deliveries.getByRole("button", { name: "Load more" })).toHaveCount(0);

  // Re-entering the feature establishes a new delivery page-one snapshot.
  api.behavior.deliveryDuplicatePage = false;
  api.behavior.deliveryRepeatCursor = true;
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await deliveries.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("invalid_api_response (repeated_cursor)")).toBeVisible();
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
});

test("admin UI clears a definitive pre-mutation attempt so the next ordinary retry receives a new key", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.webhookCreateResponses.push({
    // A missing/expired operator credential is a real pre-mutation rejection
    // for this route. The locally bounded webhook form cannot produce the
    // Worker body's 8KiB rejection.
    status: 401,
    body: { ok: false, code: "missing_access_jwt", request_id: "ui-e2e-webhook-auth" },
  });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const form = page.locator("aside form");
  await form.getByLabel("URL").fill("https://hooks.example.test/new-key");
  await form.getByRole("button", { name: "Create endpoint" }).click();
  await expect.poll(() => api.requests.webhookCreateAttempts.length).toBe(1);
  await expect(page.getByText(/missing_access_jwt/)).toBeVisible();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(form.getByLabel("URL")).toBeEnabled();

  await form.getByRole("button", { name: "Create endpoint" }).click();
  await expect.poll(() => api.requests.webhookCreateAttempts.length).toBe(2);
  expect(api.requests.webhookCreateAttempts[1].idempotencyKey).not.toBe(api.requests.webhookCreateAttempts[0].idempotencyKey);
});

test("admin UI keeps a same-key replay conflict indeterminate after a post-commit failure", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.transitionResponses.push(
    { status: 500, body: { ok: false, code: "mutation_failed", request_id: "ui-e2e-transition-post-commit" } },
    { status: 409, body: { ok: false, code: "revoked_entitlement_is_terminal", request_id: "ui-e2e-transition-replay-conflict" } },
  );
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("replay-conflict");
  await createForm.getByLabel("Feature").fill("pro");
  await createForm.getByLabel("Fingerprint").fill("1".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(2);
  expect(api.requests.transitions[1].idempotencyKey).toBe(api.requests.transitions[0].idempotencyKey);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(page.getByRole("button", { name: "Reconcile status" })).toBeEnabled();
});

test("admin UI accepts a legitimate empty customer name in a transition RETURNING record", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.customerTransitionEmptyName = true;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Customers", exact: true }).click();
  await page.getByRole("button", { name: "cus_acme", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("empty name is valid");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(page.locator(".modalError")).toHaveCount(0);
  await expect(page.locator(".details .status")).toContainText("disabled");
});

test("admin UI reconciles release seats through the exact entitlement GET even when the target is off page one", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("release-page-two");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("2".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  const row = page.locator(".tablePane > table tbody tr").first();
  api.behavior.releaseSeatTargetOnSecondPage = true;
  await row.getByRole("button", { name: "Release seats", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("stuck host");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.releaseSeats.length).toBe(2);
  await expect.poll(() => api.requests.entitlementDetailReads.length).toBe(1);
  expect(api.requests.entitlementDetailReads[0]).toBe(api.requests.releaseSeats[0].id);
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
});

test("admin UI keeps a release-seat result unknown when same-key replay evidence differs", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.releaseSeatsResponses.push(
    { status: 200, body: makeEnvelope("seats_released", { released: 2, seat_ids: ["seat_1", "seat_2"] }) },
    { status: 200, body: makeEnvelope("seats_released", { released: 2, seat_ids: ["seat_2", "seat_1"] }) },
  );
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("release-evidence");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("3".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Release seats", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("compare replay proof");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.releaseSeats.length).toBe(2);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
});

test("admin UI keeps an undocumented release-seat 4xx indeterminate", async ({ page }) => {
  const api = makeAdminApiFixture();
  // `invalid_request` is documented for other mutation routes, but never for
  // release-seats. It must not clear this keyed attempt merely because it is a
  // well-formed 400 envelope.
  api.behavior.releaseSeatsResponses.push({
    status: 400,
    body: { ok: false, code: "invalid_request", request_id: "ui-e2e-release-wrong-route-400" },
  });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("release-wrong-route");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("4".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Release seats", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("unexpected response");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  await expect(page.locator(".operatorNotice")).toContainText("Other actions are unavailable until reconciliation completes.");
  expect(api.requests.releaseSeats).toHaveLength(1);
});

test("admin UI clears known webhook recovery only after an additional current-context GET", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.webhookCreateResponses.push({
    status: 200,
    body: makeEnvelope("webhook_created", {
      id: "wh_stale_refresh", url: "https://hooks.example.test/stale-refresh", event_types: "", status: "active", description: "",
      scope_project: null, scope_customer_id: null, created_at: 1_760_000_001, updated_at: 1_760_000_001,
    }),
  });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const form = page.locator("aside form");
  await form.getByLabel("URL").fill("https://hooks.example.test/stale-refresh");
  api.behavior.webhookRefreshFailures.push("response-error");
  await form.getByRole("button", { name: "Create endpoint" }).click();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");

  // This changes the list's read context after the known-success POST. The
  // saved recovery callback may not clear solely because its old closure is a
  // no-op: it needs a new exact GET for the visible context, or must retain
  // the recovery notice.
  await page.getByLabel("Filter endpoints by status").selectOption("disabled");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  await expect.poll(() => api.requests.webhookReads.some((search) => new URLSearchParams(search).get("status") === "disabled")).toBe(true);
  const readsBeforeRecovery = api.requests.webhookReads.length;
  api.behavior.deferReads.add("webhooks:disabled");
  await page.getByRole("button", { name: "Refresh status" }).click({ noWaitAfter: true });
  await expect.poll(() => api.requests.webhookReads.length).toBe(readsBeforeRecovery + 1);
  expect(new URLSearchParams(api.requests.webhookReads.at(-1)).get("status")).toBe("disabled");
  await expect.poll(() => api.behavior.releaseReads.has("webhooks:disabled")).toBe(true);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  api.behavior.releaseReads.get("webhooks:disabled")();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  expect(api.requests.webhookCreateAttempts).toHaveLength(1);
});

test("admin UI retains known webhook recovery after its current read becomes stale", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.webhookCreateResponses.push({
    status: 200,
    body: makeEnvelope("webhook_created", {
      id: "wh_noop_refresh", url: "https://hooks.example.test/noop-refresh", event_types: "", status: "active", description: "",
      scope_project: null, scope_customer_id: null, created_at: 1_760_000_002, updated_at: 1_760_000_002,
    }),
  });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const form = page.locator("aside form");
  await form.getByLabel("URL").fill("https://hooks.example.test/noop-refresh");
  api.behavior.webhookRefreshFailures.push("response-error");
  await form.getByRole("button", { name: "Create endpoint" }).click();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");

  const filter = page.getByLabel("Filter endpoints by status");
  await filter.selectOption("disabled");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  const readsBeforeRecovery = api.requests.webhookReads.length;
  api.behavior.deferReads.add("webhooks:disabled");
  await page.getByRole("button", { name: "Refresh status" }).click({ noWaitAfter: true });
  await expect.poll(() => api.requests.webhookReads.length).toBe(readsBeforeRecovery + 1);
  await expect.poll(() => api.behavior.releaseReads.has("webhooks:disabled")).toBe(true);

  // The deferred recovery read is no longer current once the filter changes.
  // Releasing it must be a no-op, not proof that clears the notice.
  await filter.selectOption("active");
  await expect.poll(() => api.requests.webhookReads.some((search) => new URLSearchParams(search).get("status") === "active")).toBe(true);
  api.behavior.releaseReads.get("webhooks:disabled")();
  // The deferred stale attempt must settle before inspecting the retained
  // recovery notice; otherwise this assertion can pass before its no-op
  // callback has actually run.
  await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toBeEnabled();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  expect(api.requests.webhookCreateAttempts).toHaveLength(1);
});

test("admin UI rejects A-to-B-to-A cursor cycles before shared or custom pagers commit a third page", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan("plan_cycle_one", "DEFAULT", "cycle-one");
  api.seed.catalogPlan("plan_cycle_two", "DEFAULT", "cycle-two");
  api.seed.catalogPlan("plan_cycle_three", "DEFAULT", "cycle-three");
  api.behavior.catalogPlanPagination = true;
  api.behavior.catalogPlanCursorCycle = true;
  const endpoint = api.seed.webhook("wh_cycle", "https://hooks.example.test/cycle");
  api.behavior.deliveryRows = [
    { id: 401, endpoint_id: endpoint.id, event_id: 1, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
    { id: 402, endpoint_id: endpoint.id, event_id: 2, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
    { id: 403, endpoint_id: endpoint.id, event_id: 3, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
  ];
  api.behavior.deliveryPagination = true;
  api.behavior.deliveryCursorCycle = true;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const plansPane = page.getByRole("heading", { name: "Catalog plans" }).locator("..");
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await plansPane.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(plansPane.locator("tbody tr")).toHaveCount(2);
  await plansPane.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.getByText("invalid_api_response (repeated_cursor)")).toBeVisible();
  await expect(plansPane.locator("tbody tr")).toHaveCount(2);
  await expect(plansPane.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const endpointRow = page.locator(".tablePane > table tbody tr").filter({ hasText: "https://hooks.example.test/cycle" });
  await endpointRow.getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await deliveries.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(deliveries.locator("tbody tr")).toHaveCount(2);
  await deliveries.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.getByText("invalid_api_response (repeated_cursor)")).toBeVisible();
  await expect(deliveries.locator("tbody tr")).toHaveCount(2);
  await expect(deliveries.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
});
