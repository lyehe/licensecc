import { expect, test } from "@playwright/test";

// C5: every license lifecycle state tells the customer what happens next, dates render as UTC
// calendar days, a trial shows when it ends, an inactive license offers no download, and the Apps
// list flags an app whose licenses need attention -- in words, never colour alone.
function makeEnvelope(code, data) {
  return { ok: true, code, request_id: "lifecycle-e2e", data };
}

function license(feature, fields = {}) {
  return {
    id: `ent_${feature}`, project: "ALPHA", feature, status: "active", license_fingerprint: "c".repeat(64),
    valid_from: null, valid_until: 4_102_444_800, enforcement_mode: "legacy", license_mode: "node_locked",
    pool_size: 0, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: null,
    trial_ends_at: null, trial_starts_on_activation: false,
    ...fields,
  };
}

const LICENSES = [
  license("solo"),
  license("lapsed", { valid_until: 1_750_000_000 }),
  license("paused", { status: "disabled" }),
  license("cancelled", { status: "revoked", enforcement_mode: "device_bound_v1" }),
  license("upcoming", { valid_from: 4_102_444_800, valid_until: null }),
  license("runtrial", { enforcement_mode: "device_bound_v1", license_mode: "trial", valid_until: null, trial_ends_at: 4_133_980_800 }),
  license("newtrial", { enforcement_mode: "device_bound_v1", license_mode: "trial", valid_until: null, trial_ends_at: null, trial_starts_on_activation: true }),
  license("endtrial", { license_mode: "trial", valid_until: null, trial_ends_at: 1_760_000_000 }),
  // A trial with no end of its own: a zero-duration legacy trial, or the admin's default from_issue
  // trial with no end date. Nothing ends it, so it must not read as starting later or as expired.
  license("opentrial", { license_mode: "trial", valid_until: null, trial_ends_at: null, trial_starts_on_activation: false }),
  license("steady", { project: "BETA" }),
];

async function setup(page, { support } = {}) {
  const requests = { downloads: 0 };
  const handler = (route) => {
    const path = new URL(route.request().url()).pathname;
    const fulfill = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/portal/v1/auth/providers") return fulfill(200, makeEnvelope("auth_providers", { google: false, github: false, email: true, password: false, support: support ?? null }));
    if (path === "/api/portal/me") return fulfill(200, makeEnvelope("me", { customer_id: "cus_lifecycle", email: null }));
    if (path === "/api/portal/entitlements") return fulfill(200, makeEnvelope("entitlements", { items: LICENSES.map((item) => ({ ...item })) }));
    if (path === "/api/portal/devices") return fulfill(200, makeEnvelope("devices", { items: [] }));
    if (path === "/api/portal/usage") return fulfill(200, makeEnvelope("usage", { items: [] }));
    if (path === "/api/portal/download") {
      requests.downloads += 1;
      return fulfill(403, { ok: false, code: "no_active_entitlement", request_id: "lifecycle-e2e-download" });
    }
    return fulfill(404, { ok: false, code: "not_found", request_id: "lifecycle-e2e-unhandled" });
  };
  await page.route("**/portal/v1/auth/**", handler);
  await page.route("**/api/portal/**", handler);
  return requests;
}

const row = (page, feature) => page.locator(".licenseTable tbody tr").filter({ hasText: feature });
const cell = (page, feature, label) => row(page, feature).locator(`td[data-label="${label}"]`);

test("license lifecycle: each state reads as words with its UTC date and next step, and only an active license offers a download", async ({ page }, testInfo) => {
  const requests = await setup(page, { support: "mailto:help@example.com" });
  await page.goto("/");

  // --- Apps list: the attention badge is text, on the app with an inactive license only ---
  const alpha = page.locator(".appRow").filter({ has: page.getByRole("heading", { name: "ALPHA", exact: true }) });
  const beta = page.locator(".appRow").filter({ has: page.getByRole("heading", { name: "BETA", exact: true }) });
  await expect(alpha.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(beta).toBeVisible();
  await expect(beta.getByText("Needs attention", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("license-lifecycle-apps.png"), fullPage: true });

  await page.getByRole("link", { name: "View app ALPHA" }).click();
  await expect(page.getByRole("heading", { name: "ALPHA", exact: true })).toBeVisible();

  // --- Status: the state, its date, and the next step ---
  await expect(cell(page, "solo", "Status")).toHaveText("Active");
  await expect(cell(page, "lapsed", "Status")).toHaveText("Expired on 2025-06-15. Contact support to renew.");
  await expect(cell(page, "lapsed", "Status").getByRole("link", { name: "Contact support", exact: true })).toHaveAttribute("href", "mailto:help@example.com");
  await expect(cell(page, "paused", "Status")).toHaveText("Suspended. Contact support.");
  await expect(cell(page, "cancelled", "Status")).toHaveText("Revoked.");
  await expect(cell(page, "upcoming", "Status")).toHaveText("Starts 2100-01-01.");

  // --- Trials: the end date, or that the clock starts at activation; an ended trial is expired ---
  await expect(cell(page, "runtrial", "Mode")).toHaveText("Protected device · Trial · ends 2101-01-01");
  await expect(cell(page, "runtrial", "Status")).toHaveText("Active");
  await expect(cell(page, "runtrial", "Action")).toHaveText("Connect from your app");
  await expect(cell(page, "newtrial", "Mode")).toHaveText("Protected device · Trial starts when you activate");
  await expect(cell(page, "endtrial", "Mode")).toHaveText("Trial · ended 2025-10-09");
  await expect(cell(page, "endtrial", "Status")).toHaveText("Expired on 2025-10-09. Contact support to renew.");
  // A trial with no end of its own reads just "Trial", stays active and keeps its download.
  await expect(cell(page, "opentrial", "Mode")).toHaveText("Trial");
  await expect(cell(page, "opentrial", "Status")).toHaveText("Active");
  await expect(cell(page, "opentrial", "Valid")).toHaveText("No start date to No end date");
  await expect(row(page, "opentrial").getByText("Activate and download", { exact: true })).toBeVisible();

  // --- Validity window: a missing start or end says so ---
  await expect(cell(page, "solo", "Valid")).toHaveText("No start date to 2100-01-01");
  await expect(cell(page, "upcoming", "Valid")).toHaveText("2100-01-01 to No end date");

  // --- Only an active license offers an action; an inactive one offers no download at all ---
  await expect(row(page, "solo").getByText("Activate and download", { exact: true })).toBeVisible();
  for (const feature of ["lapsed", "paused", "cancelled", "upcoming", "endtrial"]) {
    await expect(row(page, feature).getByText("Activate and download")).toHaveCount(0);
    await expect(row(page, feature).getByRole("textbox")).toHaveCount(0);
    await expect(cell(page, feature, "Action").locator("*")).toHaveCount(0);
    await expect(cell(page, feature, "Action")).toHaveText("");
  }
  await expect(row(page, "cancelled").getByText("Connect from your app")).toHaveCount(0);
  expect(requests.downloads).toBe(0);

  // --- No raw status code, and no bare "any" date, anywhere in the table ---
  const tableText = await page.locator(".licenseTable").innerText();
  for (const raw of ["disabled", "revoked", "not_started", "not started"]) expect(tableText).not.toContain(raw);
  expect(tableText).not.toMatch(/\bany\b/);

  // Each date is a <time>, and it never breaks at a hyphen however narrow its column.
  await expect(cell(page, "lapsed", "Status").locator("time")).toHaveAttribute("datetime", "2025-06-15");
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const wrappedDates = await page.locator(".licenseTable time").evaluateAll((dates) => dates.filter((date) => date.getClientRects().length !== 1).map((date) => date.textContent));
    expect(wrappedDates, `dates split across lines at ${width}px`).toEqual([]);
    // In the stacked phone layout a cell is a label | value grid; a date belongs in the value, never
    // pushed under the label at the cell's left edge.
    const datesUnderLabels = await page.locator(".licenseTable time").evaluateAll((dates) => dates.filter((date) => date.getBoundingClientRect().left <= date.closest("td").getBoundingClientRect().left).map((date) => date.textContent));
    expect(datesUnderLabels, `dates under a cell label at ${width}px`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`license-lifecycle-${width}.png`), fullPage: true });
  }
});

test("license lifecycle: with no support contact configured, the next step names the administrator", async ({ page }) => {
  await setup(page);
  await page.goto("/#/apps/ALPHA");
  await expect(cell(page, "paused", "Status")).toHaveText("Suspended. Contact your administrator.");
  await expect(cell(page, "lapsed", "Status")).toHaveText("Expired on 2025-06-15. Contact your administrator to renew.");
  await expect(cell(page, "lapsed", "Status").getByRole("link")).toHaveCount(0);
});
