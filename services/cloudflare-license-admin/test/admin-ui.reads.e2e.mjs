import { expect, test } from "@playwright/test";

import { makeAdminApiFixture, makeEnvelope } from "./admin-ui.fixture.mjs";

test("admin UI loads every active-policy selector page and accepts production nullable read fields", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.policy("pol_first", "First policy");
  api.seed.policy("pol_second", "Second policy");
  api.seed.webhook();
  api.behavior.activePolicyPagination = true;
  api.behavior.deliveryPagination = true;
  api.behavior.licenseRows = [{ id: "lic_null", customer_id: null, project: "DEFAULT", label: null, created_at: 1_760_000_000, updated_at: 1_760_000_000 }];
  api.behavior.orderRows = [{ event_id: "evt-string-id", subscription_id: "sub_string", project: "DEFAULT", feature: "pro", order_epoch: 1, seq: 1, intent: "upsert", key_id: null, status: "accepted", received_at: 1_760_000_000, processed_at: null, stale: false }];
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const policySelect = page.locator("aside form").getByLabel("Policy (optional)");
  await expect(policySelect.locator("option")).toHaveCount(3);
  await expect(policySelect).toContainText("First policy");
  await expect(policySelect).toContainText("Second policy");

  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const policyOptions = page.locator("#active-policy-ids option");
  await expect(policyOptions).toHaveCount(2);
  await expect(policyOptions.nth(1)).toHaveAttribute("value", "pol_second");

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const endpointRow = page.locator(".tablePane > table tbody tr").first();
  await endpointRow.getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  const deliveriesMore = deliveries.getByRole("button", { name: "Load more" });
  await expect(deliveriesMore).toBeVisible();
  await deliveriesMore.click();
  await expect(deliveries.locator("tbody tr")).toHaveCount(2);

  await page.getByRole("button", { name: "Licenses", exact: true }).click();
  await expect(page.locator(".tablePane tbody tr")).toContainText("lic_null");
  await expect(page.locator(".tablePane tbody tr")).toContainText("-");

  await page.getByRole("button", { name: "Fulfillment", exact: true }).click();
  await expect(page.locator(".tablePane tbody tr")).toContainText("sub_string");
});

test("admin UI fences duplicate and stale load-more appends for deliveries, orders, and expiring rows", async ({ page }) => {
  const api = makeAdminApiFixture();
  const endpoint = api.seed.webhook("wh_pagination", "https://hooks.example.test/pagination");
  api.behavior.deliveryPagination = true;
  api.behavior.deliveryRows = [
    { id: 101, endpoint_id: endpoint.id, event_id: 101, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
    { id: 102, endpoint_id: endpoint.id, event_id: 102, event_source: "entitlement", event_type: "disabled", status: "failed", attempts: 2, last_status: 503, last_error: "retry", next_attempt_at: 1_760_000_010, created_at: 1_760_000_010, delivered_at: null },
  ];
  api.behavior.ordersPagination = true;
  api.behavior.orderRows = [
    { event_id: "evt_accept", subscription_id: "sub_page", project: "DEFAULT", feature: "pro", order_epoch: 1, seq: 1, intent: "upsert", key_id: null, status: "accepted", received_at: 1_760_000_000, processed_at: null, stale: false },
    { event_id: "evt_reject", subscription_id: "sub_page", project: "DEFAULT", feature: "pro", order_epoch: 1, seq: 2, intent: "upsert", key_id: null, status: "rejected", received_at: 1_760_000_001, processed_at: null, stale: false },
  ];
  api.behavior.expiringPagination = true;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  await page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  const deliveriesMore = deliveries.getByRole("button", { name: "Load more", exact: true });
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  api.behavior.deferReads.add(`deliveries:${endpoint.id}:deliveries-next`);
  await deliveriesMore.click({ noWaitAfter: true });
  await deliveriesMore.click({ noWaitAfter: true });
  await expect.poll(() => api.requests.deliveryCursors.filter((cursor) => cursor === "deliveries-next").length).toBe(1);
  await expect.poll(() => api.behavior.releaseReads.has(`deliveries:${endpoint.id}:deliveries-next`)).toBe(true);
  await deliveries.getByRole("combobox").selectOption("delivered");
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  api.behavior.releaseReads.get(`deliveries:${endpoint.id}:deliveries-next`)();
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await expect(deliveries).not.toContainText("retry");

  await page.getByRole("button", { name: "Fulfillment", exact: true }).click();
  const fulfillment = page.locator("section.tablePane.full").filter({ has: page.locator('input[placeholder="subscription_id"]') });
  const ordersMore = fulfillment.getByRole("button", { name: "Load more", exact: true });
  await expect(fulfillment.locator("tbody tr")).toHaveCount(1);
  api.behavior.deferReads.add("orders:orders-next");
  await ordersMore.click({ noWaitAfter: true });
  await ordersMore.click({ noWaitAfter: true });
  await expect.poll(() => api.requests.orderCursors.filter((cursor) => cursor === "orders-next").length).toBe(1);
  await expect.poll(() => api.behavior.releaseReads.has("orders:orders-next")).toBe(true);
  await fulfillment.getByRole("combobox").selectOption("accepted");
  await expect(fulfillment.locator("tbody tr")).toHaveCount(1);
  api.behavior.releaseReads.get("orders:orders-next")();
  await expect(fulfillment.locator("tbody tr")).toHaveCount(1);
  await expect(fulfillment).not.toContainText("evt_reject");

  await page.getByRole("button", { name: "Reports", exact: true }).click();
  const expiring = page.locator(".expiringPanel");
  const expiringMore = expiring.getByRole("button", { name: "Load more", exact: true });
  await expect(expiring.locator("tbody tr")).toHaveCount(1);
  api.behavior.deferReads.add("expiring:30:expiring-next");
  await expiringMore.click({ noWaitAfter: true });
  await expiringMore.click({ noWaitAfter: true });
  await expect.poll(() => api.requests.expiringCursors.filter((cursor) => cursor === "expiring-next").length).toBe(1);
  await expect.poll(() => api.behavior.releaseReads.has("expiring:30:expiring-next")).toBe(true);
  await page.getByRole("group", { name: "Expiring horizon" }).getByRole("button", { name: "7d", exact: true }).click();
  await expect(expiring).toContainText("pro-7");
  api.behavior.releaseReads.get("expiring:30:expiring-next")();
  await expect(expiring).toContainText("pro-7");
  await expect(expiring).not.toContainText("pro-30");
});

test("admin UI retires contract-invalid null, scalar, and envelope append cursors across shared and custom pagers", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan("plan_invalid_one", "DEFAULT", "invalid-one");
  api.seed.catalogPlan("plan_invalid_two", "DEFAULT", "invalid-two");
  api.behavior.catalogPlanPagination = true;
  api.behavior.catalogPlanAppendResponses.push({
    status: 200,
    // Explicit JSON null must not silently fall back to the fixture object.
    body: null,
  });
  const endpoint = api.seed.webhook("wh_invalid_append", "https://hooks.example.test/invalid-append");
  api.behavior.deliveryPagination = true;
  api.behavior.deliveryRows = [
    { id: 501, endpoint_id: endpoint.id, event_id: 1, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
    { id: 502, endpoint_id: endpoint.id, event_id: 2, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
  ];
  api.behavior.deliveryAppendResponses.push({
    status: 200,
    body: "not-an-envelope",
  });
  api.behavior.ordersPagination = true;
  api.behavior.orderRows = [
    { event_id: "evt_invalid_one", subscription_id: "sub_invalid", project: "DEFAULT", feature: "pro", order_epoch: 1, seq: 1, intent: "upsert", key_id: null, status: "accepted", received_at: 1_760_000_000, processed_at: null, stale: false },
    { event_id: "evt_invalid_two", subscription_id: "sub_invalid", project: "DEFAULT", feature: "pro", order_epoch: 1, seq: 2, intent: "upsert", key_id: null, status: "accepted", received_at: 1_760_000_001, processed_at: null, stale: false },
  ];
  api.behavior.orderAppendResponses.push({
    status: 200,
    body: { ok: true, code: "orders_listed", request_id: "ui-e2e-invalid-order-append", data: { items: [], summary: { accepted: 0 }, stale_secs: 300, next_cursor: null } },
  });
  api.behavior.expiringPagination = true;
  api.behavior.expiringAppendResponses.push({
    status: 200,
    body: false,
  });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const plansPane = page.getByRole("heading", { name: "Catalog plans" }).locator("..");
  const plansMore = plansPane.getByRole("button", { name: "Load more", exact: true });
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await plansMore.click();
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await expect(plansMore).toHaveCount(0);

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  await page.locator(".tablePane > table tbody tr").filter({ hasText: endpoint.url }).getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  const deliveriesMore = deliveries.getByRole("button", { name: "Load more", exact: true });
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await deliveriesMore.click();
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await expect(deliveriesMore).toHaveCount(0);

  await page.getByRole("button", { name: "Fulfillment", exact: true }).click();
  const fulfillment = page.locator("section.tablePane.full").filter({ has: page.locator('input[placeholder="subscription_id"]') });
  const ordersMore = fulfillment.getByRole("button", { name: "Load more", exact: true });
  await expect(fulfillment.locator("tbody tr")).toHaveCount(1);
  await ordersMore.click();
  await expect(fulfillment.locator("tbody tr")).toHaveCount(1);
  await expect(ordersMore).toHaveCount(0);

  await page.getByRole("button", { name: "Reports", exact: true }).click();
  const expiring = page.locator(".expiringPanel");
  const expiringMore = expiring.getByRole("button", { name: "Load more", exact: true });
  await expect(expiring.locator("tbody tr")).toHaveCount(1);
  await expiringMore.click();
  await expect(expiring.locator("tbody tr")).toHaveCount(1);
  await expect(expiringMore).toHaveCount(0);
});

test("admin UI keeps 5xx null and scalar append cursors retryable", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan("plan_retry_one", "DEFAULT", "retry-one");
  api.seed.catalogPlan("plan_retry_two", "DEFAULT", "retry-two");
  api.behavior.catalogPlanPagination = true;
  api.behavior.catalogPlanAppendResponses.push({
    status: 503,
    body: null,
  });
  const endpoint = api.seed.webhook("wh_retry_append", "https://hooks.example.test/retry-append");
  api.behavior.deliveryPagination = true;
  api.behavior.deliveryRows = [
    { id: 601, endpoint_id: endpoint.id, event_id: 1, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
    { id: 602, endpoint_id: endpoint.id, event_id: 2, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
  ];
  api.behavior.deliveryAppendResponses.push({ status: 503, body: "upstream unavailable" });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const plansPane = page.getByRole("heading", { name: "Catalog plans" }).locator("..");
  const plansMore = plansPane.getByRole("button", { name: "Load more", exact: true });
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await plansMore.click();
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByText("invalid_api_response (missing_request_id)")).toBeVisible();
  await expect(plansMore).toBeVisible();
  await plansMore.click();
  await expect(plansPane.locator("tbody tr")).toHaveCount(2);
  await expect(plansMore).toHaveCount(0);

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  await page.locator(".tablePane > table tbody tr").filter({ hasText: endpoint.url }).getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  const deliveriesMore = deliveries.getByRole("button", { name: "Load more", exact: true });
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await deliveriesMore.click();
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await expect(deliveriesMore).toBeVisible();
  await deliveriesMore.click();
  await expect(deliveries.locator("tbody tr")).toHaveCount(2);
  await expect(deliveriesMore).toHaveCount(0);
});

test("admin UI invalidates a batch selection when its entitlement filter context changes", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("selection-context");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("u".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  const row = page.locator(".tablePane > table tbody tr").first();
  const selectRow = row.getByLabel("Select selection-context/float");
  await selectRow.check();
  await expect(page.locator(".bulkBar")).toContainText("1 selected");

  const projectFilter = page.locator('input[placeholder="project"]');
  await projectFilter.fill("no-such-project");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  await expect(page.locator(".bulkBar")).toHaveCount(0);
  expect(api.requests.batches).toHaveLength(0);

  await projectFilter.fill("selection-context");
  await expect(selectRow).not.toBeChecked();
});

test("admin UI fences ordinary device and meter reads across an ABA selection", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  for (const [project, fingerprint] of [["fence-device-one", "a"], ["fence-device-two", "b"]]) {
    await createForm.getByLabel("Project").fill(project);
    await createForm.getByLabel("Feature").fill("float");
    await createForm.getByLabel("Fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }

  const rows = page.locator(".tablePane > table tbody tr");
  const devicePane = page.getByRole("region", { name: "Registered devices" });
  api.behavior.deferReads.add("devices:ent-1");
  await rows.nth(0).getByRole("button", { name: "Devices", exact: true }).click();
  await expect.poll(() => api.behavior.releaseReads.has("devices:ent-1")).toBe(true);
  await rows.nth(1).getByRole("button", { name: "Devices", exact: true }).click();
  await expect(devicePane.locator(".mono")).toContainText("sha256:cccccccc");
  await rows.nth(0).getByRole("button", { name: "Devices", exact: true }).click();
  await expect(devicePane.locator(".mono")).toContainText("sha256:bbbbbbbb");
  api.behavior.releaseReads.get("devices:ent-1")();
  await expect(devicePane.locator(".mono")).toContainText("sha256:bbbbbbbb");

  const meterPane = page.getByRole("region", { name: "Metering status" });
  api.behavior.deferReads.add("meter:ent-1");
  await rows.nth(0).getByRole("button", { name: "Meter", exact: true }).click();
  await expect.poll(() => api.behavior.releaseReads.has("meter:ent-1")).toBe(true);
  await rows.nth(1).getByRole("button", { name: "Meter", exact: true }).click();
  await expect(meterPane).toContainText("Consumed this period: 20");
  await rows.nth(0).getByRole("button", { name: "Meter", exact: true }).click();
  await expect(meterPane).toContainText("Consumed this period: 10");
  api.behavior.releaseReads.get("meter:ent-1")();
  await expect(meterPane).toContainText("Consumed this period: 10");
});

test("admin UI fences webhook deliveries and report reads after a superseded context", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.webhook();
  api.seed.webhook("wh_second", "https://hooks.example.test/second");
  api.behavior.reportVersioned = true;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const endpointRows = page.locator(".tablePane > table tbody tr");
  await expect(endpointRows).toHaveCount(2);
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  api.behavior.deferReads.add("deliveries:wh_confirm");
  await endpointRows.nth(0).getByRole("button", { name: "Deliveries", exact: true }).click();
  await expect.poll(() => api.behavior.releaseReads.has("deliveries:wh_confirm")).toBe(true);
  await endpointRows.nth(1).getByRole("button", { name: "Deliveries", exact: true }).click();
  await expect(deliveries.locator(".mono")).toContainText("wh_second");
  await endpointRows.nth(0).getByRole("button", { name: "Deliveries", exact: true }).click();
  await expect(deliveries.locator(".mono")).toContainText("wh_confirm");
  api.behavior.releaseReads.get("deliveries:wh_confirm")();
  await expect(deliveries.locator(".mono")).toContainText("wh_confirm");

  api.behavior.deferReads.add("report");
  api.behavior.deferReads.add("timeseries");
  api.behavior.deferReads.add("expiring:30");
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect.poll(() => api.behavior.releaseReads.has("report")).toBe(true);
  await expect.poll(() => api.behavior.releaseReads.has("timeseries")).toBe(true);
  await expect.poll(() => api.behavior.releaseReads.has("expiring:30")).toBe(true);

  await page.locator(".chartPanels .rangeSelector").getByRole("button", { name: "last 30d" }).click();
  const checkoutLine = page.locator(".checkoutsLine");
  await expect(checkoutLine).toBeVisible();
  const currentLine = await checkoutLine.getAttribute("d");
  await page.getByRole("group", { name: "Expiring horizon" }).getByRole("button", { name: "7d" }).click();
  await expect(page.locator(".expiringPanel")).toContainText("pro-7");

  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  const reportTotal = page.locator(".reportsTab .reportCards > div").first().locator("strong");
  await expect(reportTotal).toHaveText("2");

  api.behavior.releaseReads.get("timeseries")();
  api.behavior.releaseReads.get("expiring:30")();
  api.behavior.releaseReads.get("report")();
  await expect(checkoutLine).toHaveAttribute("d", currentLine ?? "");
  await expect(page.locator(".expiringPanel")).toContainText("pro-7");
  await expect(reportTotal).toHaveText("2");
});

test("admin UI treats accepted mutation plus aborted refresh as success with manual recovery", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("refresh-abort");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("a".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  const trigger = row.getByRole("button", { name: "Disable", exact: true });
  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.refreshFailure = "abort";
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(page.getByRole("button", { name: "Refresh status" })).toBeVisible();
  await expect(row.locator(".status")).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
});

test("admin UI treats malformed post-success refresh as success with manual recovery", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("refresh-malformed");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("b".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  const trigger = row.getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.refreshFailure = "malformed";
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(page.getByRole("button", { name: "Refresh status" })).toBeVisible();
  await expect(row.locator(".status")).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
});

for (const refreshFailure of ["truncated", "wrong-enum"]) {
  test(`admin UI rejects a ${refreshFailure} entitlement refresh before clearing a successful consequence`, async ({ page }) => {
    const api = makeAdminApiFixture();
    await page.route("**/api/admin/**", api.route);
    await page.goto("/");
    await page.getByRole("button", { name: "Entitlements", exact: true }).click();
    const createForm = page.locator("aside form");
    await createForm.getByLabel("Project").fill(`refresh-${refreshFailure}`);
    await createForm.getByLabel("Feature").fill("float");
    await createForm.getByLabel("Fingerprint").fill((refreshFailure === "truncated" ? "t" : "u").repeat(64));
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();

    const row = page.locator(".tablePane > table tbody tr").first();
    await row.getByRole("button", { name: "Disable", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Reason (required)").fill("operator review");
    api.behavior.refreshFailure = refreshFailure;
    await dialog.getByRole("button", { name: "Confirm" }).click();

    await expect.poll(() => api.requests.transitions.length).toBe(1);
    await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
    const refreshButton = page.getByRole("button", { name: "Refresh status" });
    await refreshButton.click();
    await expect(page.locator(".operatorNotice")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
  });
}

test("admin UI rejects a nested-null customer detail refresh before clearing a successful consequence", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Customers", exact: true }).click();
  await page.getByRole("button", { name: "cus_acme", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Acme Corp" })).toBeVisible();

  const disable = page.getByRole("button", { name: "Disable", exact: true });
  await disable.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.customerDetailFailure = "nested-null";
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.customerTransitions.length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
});

test("admin UI rejects a non-2xx refresh carrying an ok response", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("refresh-http-status");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("e".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.refreshFailure = "http-success";
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(page.getByRole("button", { name: "Refresh status" })).toBeVisible();
  await expect(row.locator(".status")).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI keeps the success warning after a parsed refresh error and clears it after recovery", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("refresh-error");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("c".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  const trigger = row.getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.refreshFailures = ["response-error", "response-error"];
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await expect(refreshButton).toBeVisible();
  await expect(row.locator(".status")).toBeFocused();

  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(row.locator(".status")).toBeFocused();
  await expect.poll(() => api.requests.transitions.length).toBe(1);

  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI treats missing refresh data as success with manual recovery", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("refresh-missing-data");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("d".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  const trigger = row.getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.refreshFailures = ["missing-data"];
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await expect(row.locator(".status")).toBeFocused();
  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI falls back to a stable section when a successful row disappears", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.dropTransitionRow = true;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("missing-focus-row");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const trigger = page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-focus-section="entitlements"]')).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI discards stale create/import follow-ups after filter, selection, and form supersession", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  // A form edit and a list-filter change while the POST is in flight make the
  // original webhook result stale.  It must neither reset the draft nor
  // republish the old active list after the disabled filter is current.
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const webhookForm = page.locator("aside form");
  await webhookForm.getByLabel("URL").fill("https://hooks.example.test/stale-create");
  api.behavior.deferMutations.add("webhook-create");
  await webhookForm.getByRole("button", { name: "Create endpoint" }).click();
  await expect.poll(() => api.requests.webhookCreates.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("webhook-create")).toBe(true);
  await webhookForm.getByLabel("URL").fill("https://hooks.example.test/new-draft");
  await page.getByLabel("Filter endpoints by status").selectOption("disabled");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  api.behavior.releaseMutations.get("webhook-create")();
  await expect.poll(() => api.behavior.completedMutations.has("webhook-create")).toBe(true);
  await expect(webhookForm.getByLabel("URL")).toHaveValue("https://hooks.example.test/new-draft");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  await expect(page.getByText(/webhook_created/)).toHaveCount(0);

  // The policy editor follows the same contract independently of webhooks.
  await page.getByRole("button", { name: "Policies", exact: true }).click();
  const policyForm = page.locator("aside form");
  await policyForm.getByLabel("Name").fill("stale policy");
  api.behavior.deferMutations.add("policy-create");
  await policyForm.getByRole("button", { name: "Create policy" }).click();
  await expect.poll(() => api.requests.policyCreates.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("policy-create")).toBe(true);
  await policyForm.getByLabel("Name").fill("replacement policy draft");
  const policyFilters = page.locator(".tablePane .filters").first();
  await policyFilters.locator("select").last().selectOption("disabled");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  api.behavior.releaseMutations.get("policy-create")();
  await expect.poll(() => api.behavior.completedMutations.has("policy-create")).toBe(true);
  await expect(policyForm.getByLabel("Name")).toHaveValue("replacement policy draft");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  await expect(page.getByText(/policy_created/)).toHaveCount(0);

  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const featureForm = page.getByRole("form", { name: "Catalog feature" });
  await featureForm.getByLabel("Feature key").fill("stale_feature");
  await featureForm.getByLabel("Name").fill("Stale feature");
  api.behavior.deferMutations.add("catalog-feature-create");
  await featureForm.getByRole("button", { name: "Create feature" }).click();
  await expect.poll(() => api.requests.catalogFeatures.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-feature-create")).toBe(true);
  await featureForm.getByLabel("Name").fill("Feature draft after save");
  const featurePane = page.getByRole("heading", { name: "Catalog features" }).locator("..");
  await featurePane.locator(".filters select").selectOption("disabled");
  await expect(featurePane.locator("tbody tr")).toHaveCount(0);
  api.behavior.releaseMutations.get("catalog-feature-create")();
  await expect.poll(() => api.behavior.completedMutations.has("catalog-feature-create")).toBe(true);
  await expect(featureForm.getByLabel("Name")).toHaveValue("Feature draft after save");
  await expect(featurePane.locator("tbody tr")).toHaveCount(0);
  await expect(page.getByText(/catalog_feature_created/)).toHaveCount(0);

  const planForm = page.getByRole("form", { name: "Catalog plan" });
  await planForm.getByLabel("Plan key").fill("staleplan");
  await planForm.getByLabel("Name").fill("Stale plan");
  api.behavior.deferMutations.add("catalog-plan-create");
  await planForm.getByRole("button", { name: "Create plan" }).click();
  await expect.poll(() => api.requests.catalogPlans.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-plan-create")).toBe(true);
  await planForm.getByLabel("Name").fill("Plan draft after save");
  const planPane = page.getByRole("heading", { name: "Catalog plans" }).locator("..");
  await planPane.locator(".filters select").selectOption("disabled");
  await expect(planPane.locator("tbody tr")).toHaveCount(0);
  api.behavior.releaseMutations.get("catalog-plan-create")();
  await expect.poll(() => api.behavior.completedMutations.has("catalog-plan-create")).toBe(true);
  await expect(planForm.getByLabel("Name")).toHaveValue("Plan draft after save");
  await expect(planPane.locator("tbody tr")).toHaveCount(0);
  await expect(page.getByText(/catalog_plan_created/)).toHaveCount(0);

  // Create current catalog dependencies, then supersede the selected plan
  // while its plan-feature write is pending.
  await featurePane.locator(".filters select").selectOption("");
  await planPane.locator(".filters select").selectOption("");
  await featureForm.getByLabel("Feature key").fill("attachedfeat");
  await featureForm.getByLabel("Name").fill("Attached feature");
  await featureForm.getByRole("button", { name: "Create feature" }).click();
  await expect.poll(() => api.requests.catalogFeatures.length).toBe(2);
  await planForm.getByLabel("Plan key").fill("attachedplan");
  await planForm.getByLabel("Name").fill("Attached plan");
  await planForm.getByRole("button", { name: "Create plan" }).click();
  await expect.poll(() => api.requests.catalogPlans.length).toBe(2);

  // Feature and plan update paths use the same form/list fence as create;
  // verify a superseded edit cannot publish its old refresh either.
  const attachedFeatureRow = featurePane.locator("tbody tr").filter({ hasText: "attachedfeat" });
  await attachedFeatureRow.getByRole("button", { name: "Edit", exact: true }).click();
  await featureForm.getByLabel("Name").fill("Attached feature edited");
  api.behavior.deferMutations.add("catalog-feature-patch");
  await featureForm.getByRole("button", { name: "Update feature" }).click();
  await expect.poll(() => api.requests.catalogFeaturePatches.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-feature-patch")).toBe(true);
  await featureForm.getByLabel("Name").fill("Feature patch draft");
  await featurePane.locator(".filters select").selectOption("disabled");
  api.behavior.releaseMutations.get("catalog-feature-patch")();
  await expect.poll(() => api.behavior.completedMutations.has("catalog-feature-patch")).toBe(true);
  await expect(featureForm.getByLabel("Name")).toHaveValue("Feature patch draft");
  await expect(featurePane.locator("tbody tr")).toHaveCount(0);
  await expect(page.getByText(/catalog_feature_patched/)).toHaveCount(0);
  await featurePane.locator(".filters select").selectOption("");

  const attachedPlanRow = planPane.locator("tbody tr").filter({ hasText: "attachedplan" });
  await attachedPlanRow.getByRole("button", { name: "Edit", exact: true }).click();
  await planForm.getByLabel("Name").fill("Attached plan edited");
  api.behavior.deferMutations.add("catalog-plan-patch");
  await planForm.getByRole("button", { name: "Update plan" }).click();
  await expect.poll(() => api.requests.catalogPlanPatches.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-plan-patch")).toBe(true);
  await planForm.getByLabel("Name").fill("Plan patch draft");
  await planPane.locator(".filters select").selectOption("disabled");
  api.behavior.releaseMutations.get("catalog-plan-patch")();
  await expect.poll(() => api.behavior.completedMutations.has("catalog-plan-patch")).toBe(true);
  await expect(planForm.getByLabel("Name")).toHaveValue("Plan patch draft");
  await expect(planPane.locator("tbody tr")).toHaveCount(0);
  await expect(page.getByText(/catalog_plan_patched/)).toHaveCount(0);
  await planPane.locator(".filters select").selectOption("");

  const planFeatureForm = page.getByRole("form", { name: "Plan feature" });
  await planFeatureForm.getByLabel("Feature key").fill("attachedfeat");
  api.behavior.deferMutations.add("catalog-plan-feature-save");
  await planFeatureForm.getByRole("button", { name: "Save plan feature" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatures.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-plan-feature-save")).toBe(true);
  await planFeatureForm.getByLabel("Selected plan").selectOption("");
  await expect(page.getByText("No rows for the selected plan.")).toBeVisible();
  api.behavior.releaseMutations.get("catalog-plan-feature-save")();
  await expect.poll(() => api.behavior.completedMutations.has("catalog-plan-feature-save")).toBe(true);
  await expect(planFeatureForm.getByLabel("Feature key")).toHaveValue("attachedfeat");
  await expect(page.getByText("No rows for the selected plan.")).toBeVisible();
  await expect(page.getByText(/catalog_plan_feature_saved/)).toHaveCount(0);

  // Import has its own form generation. A replacement manifest must not be
  // overwritten by a late Preview response or retain its old capability.
  const importForm = page.getByRole("form", { name: "Catalog import" });
  const oldManifest = JSON.stringify({
    format_version: 1,
    features: [{ project: "DEFAULT", feature_key: "imported_old", name: "Imported old", description: "", category: "", status: "active" }],
    plans: [],
  });
  const replacementManifest = JSON.stringify({ format_version: 1, features: [], plans: [] });
  await importForm.getByLabel("Manifest JSON").fill(oldManifest);
  api.behavior.deferMutations.add("catalog-import-preview");
  await importForm.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-import-preview")).toBe(true);
  await importForm.getByLabel("Manifest JSON").fill(replacementManifest);
  await expect(importForm.getByRole("button", { name: "Apply import" })).toBeDisabled();
  api.behavior.releaseMutations.get("catalog-import-preview")();
  await expect.poll(() => api.behavior.completedMutations.has("catalog-import-preview")).toBe(true);
  await expect(importForm.getByLabel("Manifest JSON")).toHaveValue(replacementManifest);
  await expect(importForm.getByRole("button", { name: "Apply import" })).toBeDisabled();
  await expect(page.getByText("Imported old")).toHaveCount(0);
  await expect(page.getByText(/catalog_import_previewed/)).toHaveCount(0);
});

test("admin UI discards a stale webhook redrive follow-up after delivery-filter supersession", async ({ page }) => {
  const api = makeAdminApiFixture();
  const endpoint = api.seed.webhook("wh_redrive", "https://hooks.example.test/redrive");
  api.behavior.deliveryRows = [{
    id: 88,
    endpoint_id: endpoint.id,
    event_id: 9,
    event_source: "entitlement",
    event_type: "disabled",
    status: "failed",
    attempts: 3,
    last_status: 503,
    last_error: "upstream unavailable",
    next_attempt_at: 1_760_000_000,
    created_at: 1_760_000_000,
    delivered_at: null,
  }];
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  await page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  await expect(deliveries.getByRole("button", { name: "Redrive", exact: true })).toBeEnabled();
  api.behavior.deferMutations.add("webhook-redrive");
  await deliveries.getByRole("button", { name: "Redrive", exact: true }).click();
  await expect.poll(() => api.requests.webhookRedrives).toEqual([88]);
  await expect.poll(() => api.behavior.releaseMutations.has("webhook-redrive")).toBe(true);
  await page.getByLabel("Filter deliveries by status").selectOption("delivered");
  await expect(deliveries.locator("tbody tr")).toHaveCount(0);
  api.behavior.releaseMutations.get("webhook-redrive")();
  await expect.poll(() => api.behavior.completedMutations.has("webhook-redrive")).toBe(true);
  await expect(deliveries.locator("tbody tr")).toHaveCount(0);
  await expect(page.getByText(/webhook_delivery_redriven/)).toHaveCount(0);
});

test("admin UI retains an ambiguous keyed ordinary mutation and replays its immutable request", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.webhookCreateResponses.push(
    { status: 500, body: { ok: false, code: "mutation_failed", request_id: "ui-e2e-webhook-post-commit" } },
    {
      status: 200,
      body: makeEnvelope("webhook_created", {
        id: "wh_recovered", url: "https://hooks.example.test/recovered", event_types: "", status: "active", description: "",
        scope_project: null, scope_customer_id: null, created_at: 1_760_000_001, updated_at: 1_760_000_001,
      }),
    },
  );
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const form = page.locator("aside form");
  await form.getByLabel("URL").fill("https://hooks.example.test/recovered");
  await form.getByRole("button", { name: "Create endpoint" }).click();
  await expect.poll(() => api.requests.webhookCreateAttempts.length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(form.getByLabel("URL")).toBeDisabled();
  await expect(form.getByRole("button", { name: "Create endpoint" })).toBeDisabled();

  // A replay may prove the POST while its required strict GET is malformed.
  // That must release the immutable replay owner and leave only GET recovery.
  api.behavior.webhookRefreshFailures.push("malformed");
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect.poll(() => api.requests.webhookCreateAttempts.length).toBe(2);
  expect(api.requests.webhookCreateAttempts[1].idempotencyKey).toBe(api.requests.webhookCreateAttempts[0].idempotencyKey);
  expect(api.requests.webhookCreateAttempts[1].body).toBe(api.requests.webhookCreateAttempts[0].body);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(page.locator(".operatorNotice")).not.toContainText("Other actions are unavailable until reconciliation completes.");
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  expect(api.requests.webhookCreateAttempts).toHaveLength(2);
  await expect(form.getByLabel("URL")).toBeEnabled();
});

test("admin UI keeps an exact ordinary success in GET-only recovery after a 5xx refresh", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.webhookCreateResponses.push({
    status: 200,
    body: makeEnvelope("webhook_created", {
      id: "wh_exact_refresh", url: "https://hooks.example.test/exact-refresh", event_types: "", status: "active", description: "",
      scope_project: null, scope_customer_id: null, created_at: 1_760_000_001, updated_at: 1_760_000_001,
    }),
  });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const form = page.locator("aside form");
  await form.getByLabel("URL").fill("https://hooks.example.test/exact-refresh");
  api.behavior.webhookRefreshFailures.push("response-error");
  await form.getByRole("button", { name: "Create endpoint" }).click();
  await expect.poll(() => api.requests.webhookCreateAttempts.length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(form.getByRole("button", { name: "Create endpoint" })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  expect(api.requests.webhookCreateAttempts).toHaveLength(1);
});
