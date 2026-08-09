import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

test("admin UI workflow builds filtered license and order API paths", async () => {
  const licenses = await loadWorkflowModule("features/licenses/workflow.ts");
  const fulfillment = await loadWorkflowModule("features/fulfillment/workflow.ts");
  assert.equal(licenses.licensesPath({ project: "", customer_id: "", q: "" }), "/api/admin/licenses");
  assert.equal(
    licenses.licensesPath({ project: "DEFAULT", customer_id: "cus_1", q: "seat pack" }),
    "/api/admin/licenses?project=DEFAULT&customer_id=cus_1&q=seat+pack",
  );
  assert.equal(licenses.licensesPath({ project: "DEFAULT", customer_id: "", q: "" }), "/api/admin/licenses?project=DEFAULT");

  assert.equal(fulfillment.ordersPath({ status: "", subscription_id: "" }), "/api/admin/orders");
  assert.equal(
    fulfillment.ordersPath({ status: "accepted", subscription_id: "sub_42" }),
    "/api/admin/orders?status=accepted&subscription_id=sub_42",
  );
  assert.equal(fulfillment.ordersPath({ status: "rejected", subscription_id: "" }), "/api/admin/orders?status=rejected");
});

test("admin UI workflow formats epoch timestamps", async () => {
  const format = await loadWorkflowModule("shared/format.ts");
  assert.equal(format.formatEpoch(null), "-");
  assert.equal(format.formatEpoch(undefined), "-");
  assert.equal(format.formatEpoch(1710000000), new Date(1710000000 * 1000).toLocaleString());
  assert.equal(format.formatEpoch(0), new Date(0).toLocaleString());
});

test("withCursor appends a cursor param respecting an existing query string", async () => {
  const urls = await loadWorkflowModule("shared/urls.ts");
  assert.equal(urls.withCursor("/api/admin/customers", "50"), "/api/admin/customers?cursor=50");
  assert.equal(
    urls.withCursor("/api/admin/customers?status=active", "100"),
    "/api/admin/customers?status=active&cursor=100",
  );
  assert.equal(urls.withCursor("/api/admin/orders", "a b/c"), "/api/admin/orders?cursor=a%20b%2Fc");
});

test("admin UI workflow builds the timeseries path with a from/to window for a last-N-days range", async () => {
  const workflow = await loadWorkflowModule("shared/timeseries.ts");
  const now = 1_700_000_000;
  assert.equal(
    workflow.timeseriesPath(7, undefined, now),
    `/api/admin/report/timeseries?from=${now - 7 * 86400}&to=${now}`,
  );
  assert.equal(
    workflow.timeseriesPath(30, undefined, now),
    `/api/admin/report/timeseries?from=${now - 30 * 86400}&to=${now}`,
  );
  assert.equal(
    workflow.timeseriesPath(90, 24, now),
    `/api/admin/report/timeseries?from=${now - 90 * 86400}&to=${now}&buckets=24`,
  );
  assert.deepEqual(workflow.TIMESERIES_RANGE_DAYS, [7, 30, 90]);
});

test("admin UI workflow builds the expiring + release-seats paths", async () => {
  const reports = await loadWorkflowModule("features/reports/workflow.ts");
  const entitlements = await loadWorkflowModule("features/entitlements/workflow.ts");
  const urls = await loadWorkflowModule("shared/urls.ts");
  assert.equal(reports.expiringPath(30), "/api/admin/report/expiring?within_days=30");
  assert.equal(reports.expiringPath(7), "/api/admin/report/expiring?within_days=7");
  assert.equal(
    urls.withCursor(reports.expiringPath(90), "50"),
    "/api/admin/report/expiring?within_days=90&cursor=50",
  );
  assert.equal(entitlements.releaseSeatsPath("ent-123"), "/api/admin/entitlements/ent-123/release-seats");
});

test("admin UI workflow classifies entitlement health by status + valid_until window", async () => {
  const workflow = await loadWorkflowModule("shared/charts.tsx");
  const now = 1_700_000_000;
  const DAY = 86400;
  assert.equal(workflow.entitlementHealth("disabled", now + 100 * DAY, now), "suspended");
  assert.equal(workflow.entitlementHealth("revoked", null, now), "suspended");
  assert.equal(workflow.entitlementHealth("disabled", now - DAY, now), "suspended");
  assert.equal(workflow.entitlementHealth("active", now - 1, now), "expired");
  assert.equal(workflow.entitlementHealth("active", now, now), "expired");
  assert.equal(workflow.entitlementHealth("active", now + 5 * DAY, now), "expiring");
  assert.equal(workflow.entitlementHealth("active", now + 30 * DAY, now), "expiring");
  assert.equal(workflow.entitlementHealth("active", null, now), "healthy");
  assert.equal(workflow.entitlementHealth("active", undefined, now), "healthy");
  assert.equal(workflow.entitlementHealth("active", now + 31 * DAY, now), "healthy");
  assert.equal(workflow.entitlementHealth("active", now + 10 * DAY, now, 7), "healthy");
  assert.equal(workflow.entitlementHealth("active", now + 10 * DAY, now, 14), "expiring");
  assert.equal(workflow.entitlementHealth("pending", now - DAY, now), "healthy");
});

test("admin UI workflow scaleY maps values y-down with a flat-series mid-line", async () => {
  const workflow = await loadWorkflowModule("shared/charts.tsx");
  assert.equal(workflow.scaleY(10, 0, 10, 100, 0), 0);
  assert.equal(workflow.scaleY(0, 0, 10, 100, 0), 100);
  assert.equal(workflow.scaleY(5, 0, 10, 100, 0), 50);
  assert.equal(workflow.scaleY(10, 0, 10, 100, 10), 10);
  assert.equal(workflow.scaleY(0, 0, 10, 100, 10), 90);
  assert.equal(workflow.scaleY(0, 0, 0, 100, 0), 50);
  assert.equal(workflow.scaleY(7, 7, 7, 100, 10), 50);
});

test("admin UI workflow pointXs spreads N points across the width", async () => {
  const workflow = await loadWorkflowModule("shared/charts.tsx");
  assert.deepEqual(workflow.pointXs(0, 600), []);
  assert.deepEqual(workflow.pointXs(1, 600), [0]);
  assert.deepEqual(workflow.pointXs(2, 600), [0, 600]);
  assert.deepEqual(workflow.pointXs(3, 600), [0, 300, 600]);
  assert.deepEqual(workflow.pointXs(5, 600), [0, 150, 300, 450, 600]);
});

test("admin UI workflow linePath emits a min/max-scaled polyline 'd' string", async () => {
  const workflow = await loadWorkflowModule("shared/charts.tsx");
  assert.equal(workflow.linePath([], 600, 100), "");
  assert.equal(workflow.linePath([5], 600, 100, 0), "M 0 50 L 600 50");
  assert.equal(workflow.linePath([0, 10], 600, 100, 0), "M 0 100 L 600 0");
  assert.equal(workflow.linePath([0, 5, 10], 600, 100, 0), "M 0 100 L 300 50 L 600 0");
  assert.equal(workflow.linePath([4, 4, 4], 600, 100, 0), "M 0 50 L 300 50 L 600 50");
});

test("admin UI workflow linePathScaled draws a series on an external shared y-scale", async () => {
  const workflow = await loadWorkflowModule("shared/charts.tsx");
  assert.equal(workflow.linePathScaled([0, 5], 0, 10, 600, 100, 0), "M 0 100 L 600 50");
  assert.equal(workflow.linePathScaled([10, 10], 0, 10, 600, 100, 0), "M 0 0 L 600 0");
  assert.equal(workflow.linePathScaled([3, 7], 5, 5, 600, 100, 0), "M 0 50 L 600 50");
  assert.equal(workflow.linePathScaled([], 0, 10, 600, 100), "");
});

test("admin UI workflow areaPath closes the line down to the baseline", async () => {
  const workflow = await loadWorkflowModule("shared/charts.tsx");
  assert.equal(workflow.areaPath([], 600, 100), "");
  assert.equal(workflow.areaPath([0, 10], 600, 100, 0), "M 0 100 L 600 0 L 600 100 L 0 100 Z");
  assert.equal(workflow.areaPath([5], 600, 100, 0), "M 0 50 L 600 50 L 600 100 L 0 100 Z");
  assert.equal(workflow.areaPathScaled([0, 5], 0, 10, 600, 100, 0), "M 0 100 L 600 50 L 600 100 L 0 100 Z");
});

test("admin UI workflow barRects positions value-scaled bars from the baseline", async () => {
  const workflow = await loadWorkflowModule("shared/charts.tsx");
  assert.deepEqual(workflow.barRects([], 600, 100), []);
  const rects = workflow.barRects([5, 10], 600, 100, 0.2);
  assert.equal(rects.length, 2);
  assert.deepEqual(rects[0], { x: 30, y: 50, w: 240, h: 50 });
  assert.deepEqual(rects[1], { x: 330, y: 0, w: 240, h: 100 });
  const zero = workflow.barRects([0, 0], 600, 100, 0.2);
  assert.equal(zero[0].h, 0);
  assert.equal(zero[0].y, 100);
});

test("admin UI workflow isEmptySeries guards the chart empty-state", async () => {
  const workflow = await loadWorkflowModule("shared/charts.tsx");
  assert.equal(workflow.isEmptySeries([]), true);
  assert.equal(workflow.isEmptySeries([0, 0, 0]), true);
  assert.equal(workflow.isEmptySeries([0, 1, 0]), false);
  assert.equal(workflow.isEmptySeries([3]), false);
});

test("admin UI workflow appends format=csv respecting an existing query string", async () => {
  const urls = await loadWorkflowModule("shared/urls.ts");
  const entitlements = await loadWorkflowModule("features/entitlements/workflow.ts");
  const customers = await loadWorkflowModule("features/customers/workflow.ts");
  assert.equal(urls.csvExportPath("/api/admin/entitlements"), "/api/admin/entitlements?format=csv");
  assert.equal(
    urls.csvExportPath("/api/admin/entitlements?project=DEFAULT&status=active"),
    "/api/admin/entitlements?project=DEFAULT&status=active&format=csv",
  );
  assert.equal(urls.csvExportPath("/api/admin/customers?q=acme"), "/api/admin/customers?q=acme&format=csv");
  assert.equal(
    urls.csvExportPath(entitlements.entitlementsPath({ project: "P", feature: "", status: "active" })),
    "/api/admin/entitlements?project=P&status=active&format=csv",
  );
  assert.equal(
    urls.csvExportPath(customers.customersPath({ status: "disabled", q: "" })),
    "/api/admin/customers?status=disabled&format=csv",
  );
});
