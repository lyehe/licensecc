import { expect, test } from "@playwright/test";

// D2: "show each result next to the control that produced it, and make seat state visible." Each
// seat card and device row that has its own action now gets its own role="status" line, populated
// instead of the single page-level StatusLine, and that line must stay reachable at phone width
// without scrolling -- the whole point of moving it next to the control that produced it.
const VALID_CODE = "80315426";
let requestCounter = 0;
function envelope(code, data) {
  requestCounter += 1;
  return { ok: true, code, request_id: `devices-results-${requestCounter}`, data };
}

function jsonBody(request) {
  try {
    return JSON.parse(request.postData() ?? "{}");
  } catch {
    return {};
  }
}

const NOW = Math.floor(Date.now() / 1000);

const ENT_ALPHA = { id: "ent_alpha", project: "DEFAULT", feature: "alpha", status: "active", license_fingerprint: "a".repeat(64), valid_from: NOW - 10000, valid_until: null, license_mode: "floating", pool_size: 2, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: "pol_alpha" };
const ENT_BETA = { id: "ent_beta", project: "DEFAULT", feature: "beta", status: "active", license_fingerprint: "b".repeat(64), valid_from: NOW - 10000, valid_until: null, license_mode: "floating", pool_size: 3, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: "pol_beta" };
const ENT_NODE = { id: "ent_node", project: "DEFAULT", feature: "solo", status: "active", license_fingerprint: "c".repeat(64), valid_from: null, valid_until: null, license_mode: "node_locked", pool_size: 0, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: "pol_node" };

function setup(page, { entitlements, support, checkoutResponse } = {}) {
  let authed = false;
  const requests = { checkouts: 0, releases: 0, downloads: 0 };
  const handler = (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const fulfill = (status, body, contentType = "application/json") => route.fulfill({ status, contentType, body: typeof body === "string" ? body : JSON.stringify(body) });

    if (path === "/portal/v1/auth/providers") return fulfill(200, envelope("auth_providers", { google: false, github: false, email: true, password: false, ...(support !== undefined ? { support } : {}) }));
    if (method === "POST" && path === "/portal/v1/auth/request") return fulfill(200, envelope("otp_requested"));
    if (method === "POST" && path === "/portal/v1/auth/verify") {
      const body = jsonBody(request);
      if (body.code !== VALID_CODE) return fulfill(401, { ok: false, code: "invalid_otp", request_id: "devices-results-bad" });
      authed = true;
      return fulfill(200, envelope("signed_in", { customer_id: "cus_results" }));
    }
    if (method === "GET" && path === "/api/portal/me") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "devices-results-401" });
      return fulfill(200, envelope("me", { customer_id: "cus_results", email: null }));
    }
    if (method === "GET" && path === "/api/portal/entitlements") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "devices-results-401" });
      return fulfill(200, envelope("entitlements", { items: entitlements.map((item) => ({ ...item })) }));
    }
    if (method === "GET" && path === "/api/portal/devices") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "devices-results-401" });
      return fulfill(200, envelope("devices", { items: [] }));
    }
    if (method === "GET" && path === "/api/portal/usage") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "devices-results-401" });
      return fulfill(200, envelope("usage", { items: [] }));
    }
    if (method === "GET" && path === "/api/portal/device-bindings") {
      return fulfill(200, envelope("device_bindings", { customer_id: "cus_results", items: [], has_more: false, next_cursor: null }));
    }
    if (method === "POST" && path === "/api/portal/checkout") {
      requests.checkouts += 1;
      const body = jsonBody(request);
      if (checkoutResponse) {
        const response = checkoutResponse(body, requests.checkouts);
        if (response) return fulfill(response.status ?? 200, response.body);
      }
      return fulfill(200, envelope("checkout_ok", { seat_id: `seat-${body.entitlement_id}`, expires_at: NOW + 3600 }));
    }
    if (method === "POST" && path === "/api/portal/release") {
      requests.releases += 1;
      const body = jsonBody(request);
      return fulfill(200, envelope("release_ok", { seat_id: body.seat_id }));
    }
    if (method === "POST" && path === "/api/portal/download") {
      requests.downloads += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "content-disposition": "attachment; filename=\"DEFAULT-solo.lic\"" },
        body: "[license]\nsigned-license-bytes-not-a-key\n",
      });
    }
    return fulfill(404, { ok: false, code: "not_found", request_id: "devices-results-unhandled" });
  };
  page.route("**/portal/v1/auth/**", handler);
  page.route("**/api/portal/**", handler);
  return requests;
}

async function signIn(page) {
  await page.goto("/");
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("8-digit code").fill(VALID_CODE);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
}

test("seat start, seat release and a license download each show their own result in the mobile viewport, with expiry visible", async ({ page }) => {
  setup(page, { entitlements: [ENT_ALPHA, ENT_BETA, ENT_NODE] });
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByText("Browser seats", { exact: true }).click();
  const alphaCard = page.locator(".seatCard").filter({ hasText: "alpha" });
  const betaCard = page.locator(".seatCard").filter({ hasText: "beta" });

  // Before checkout: the pool sentence, not a bare "pool 2".
  await expect(alphaCard).toContainText("Uses 1 of 2 shared seats until released or it expires.");

  // Start seat A: its own local result line shows the result, in the viewport, with the expiry.
  await alphaCard.getByRole("button", { name: "Start seat" }).click();
  const alphaResult = alphaCard.getByRole("status");
  await expect(alphaResult).toContainText("Seat started.");
  await expect(alphaResult).toBeInViewport();
  const alphaExpiry = alphaCard.getByText(/Active until/);
  await expect(alphaExpiry).toBeVisible();
  await expect(alphaExpiry).toBeInViewport();

  // Start a second seat so releasing the first below does not leave zero live sessions -- unrelated
  // to what this test is checking, and D3 (a later task) covers what happens once the LAST seat is
  // released at sign-out.
  await betaCard.getByRole("button", { name: "Start seat" }).click();
  await expect(betaCard.getByRole("status")).toContainText("Seat started.");

  // The release dialog's own-browser row now reads "This browser", not "Device" (D2).
  await alphaCard.getByRole("button", { name: "Release seat" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("This browser", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Device", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Confirm release" }).click();
  await expect(dialog).toHaveCount(0);

  // Release seat A: its own local result line shows the result, still in the viewport.
  await expect(alphaResult).toContainText("Seat released.");
  await expect(alphaResult).toBeInViewport();

  // A license download's own local result also stays in the viewport, next to its own control.
  await page.getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("link", { name: "View licenses for DEFAULT" }).click();
  await page.locator("tr").filter({ has: page.getByLabel("Device key for DEFAULT solo") }).getByText("Activate and download", { exact: true }).click();
  await page.getByLabel("Device key for DEFAULT solo").fill("device-e2e");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Activate and download .lic" }).click();
  await downloadPromise;
  const downloadResult = page.locator(".licenseDownload").getByRole("status");
  await expect(downloadResult).toContainText("Download started.");
  await expect(downloadResult).toBeInViewport();
});

test("a seat action's own result never reaches the page-level status line", async ({ page }) => {
  setup(page, { entitlements: [ENT_ALPHA] });
  await signIn(page);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByText("Browser seats", { exact: true }).click();
  const alphaCard = page.locator(".seatCard").filter({ hasText: "alpha" });
  await alphaCard.getByRole("button", { name: "Start seat" }).click();
  await expect(alphaCard.getByRole("status")).toContainText("Seat started.");
  // The page-level line (App.tsx's .feedback) is reserved for refresh/account-level results (D2).
  await expect(page.locator('.feedback [role="status"]')).toHaveText("");
});

test("pool_exhausted names the actual problem and links to support, never the raw code", async ({ page }) => {
  setup(page, {
    entitlements: [ENT_ALPHA],
    support: "mailto:help@example.com",
    checkoutResponse: () => ({ status: 409, body: { ok: false, code: "pool_exhausted", request_id: "devices-results-pool" } }),
  });
  await signIn(page);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByText("Browser seats", { exact: true }).click();
  const alphaCard = page.locator(".seatCard").filter({ hasText: "alpha" });
  await alphaCard.getByRole("button", { name: "Start seat" }).click();
  const result = alphaCard.getByRole("status");
  await expect(result).toContainText("All seats are in use.");
  await expect(result.getByRole("link", { name: "Contact support" })).toHaveAttribute("href", "mailto:help@example.com");
  await expect(page.getByText("pool_exhausted", { exact: false })).not.toBeVisible();
});

test("an expired or not-yet-valid floating license disables Start seat even while the wire status still says active", async ({ page }) => {
  const expired = { ...ENT_ALPHA, id: "ent_expired", feature: "expired-feature", valid_from: NOW - 20000, valid_until: NOW - 10000 };
  const notStarted = { ...ENT_ALPHA, id: "ent_not_started", feature: "future-feature", valid_from: NOW + 10000, valid_until: null };
  setup(page, { entitlements: [expired, notStarted] });
  await signIn(page);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByText("Browser seats", { exact: true }).click();
  await expect(page.locator(".seatCard").filter({ hasText: "expired-feature" }).getByRole("button", { name: "Start seat" })).toBeDisabled();
  await expect(page.locator(".seatCard").filter({ hasText: "future-feature" }).getByRole("button", { name: "Start seat" })).toBeDisabled();
});

// Fix round 1 (Important): seatMessages/deviceMessages/downloads.messages live one level ABOVE the
// components that only render while their own page is showing, so nothing used to reset them when
// that page was left and revisited -- a stale "Seat started." would reappear in a freshly mounted
// role="status" node, and (because BrowserSeats' hasBrowserSession also reads seatMessages) the panel
// could never collapse again for the rest of the session even once every real session was gone.
test("leaving and returning to Devices clears the seat's stale local result, and the panel follows real session state again", async ({ page }) => {
  setup(page, { entitlements: [ENT_ALPHA] });
  await signIn(page);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByText("Browser seats", { exact: true }).click();
  const alphaCard = page.locator(".seatCard").filter({ hasText: "alpha" });
  await alphaCard.getByRole("button", { name: "Start seat" }).click();
  await expect(alphaCard.getByRole("status")).toContainText("Seat started.");
  // Expanded on real-session grounds (a live seat), not a leftover result.
  await expect(page.locator("section.browserSessions")).toHaveCount(1);

  // Leave Devices (Apps) and come back.
  await page.getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("link", { name: "Devices", exact: true }).click();

  // The seat is still genuinely checked out (sessions persist across navigation, by design), so the
  // panel is still expanded -- but the STALE "Seat started." result must be gone, and the buttons
  // must reflect the real (still-checked-out) session, not a remembered result.
  await expect(page.locator("section.browserSessions")).toHaveCount(1);
  await expect(alphaCard.getByRole("status")).toHaveCount(0);
  await expect(alphaCard.getByRole("button", { name: "Start seat" })).toBeDisabled();
  await expect(alphaCard.getByRole("button", { name: "Release seat" })).toBeEnabled();

  // Release the seat (its own result shows and keeps the panel open for this same visit), then leave
  // and return again: now there is neither a session nor a message, so the panel must collapse back
  // to its plain <details> -- it must not stay expanded forever just because a result was once shown.
  await alphaCard.getByRole("button", { name: "Release seat" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm release" }).click();
  await expect(alphaCard.getByRole("status")).toContainText("Seat released.");
  await expect(page.locator("section.browserSessions")).toHaveCount(1);

  await page.getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.locator("details.browserSessions")).toHaveCount(1);
  await expect(page.locator("section.browserSessions")).toHaveCount(0);
  await expect(page.locator(".seatCard").getByRole("status")).toHaveCount(0);
});

test("leaving and returning to Apps clears a stale license-download result", async ({ page }) => {
  setup(page, { entitlements: [ENT_NODE] });
  await signIn(page);
  await page.getByRole("link", { name: "View licenses for DEFAULT" }).click();
  await page.locator("tr").filter({ has: page.getByLabel("Device key for DEFAULT solo") }).getByText("Activate and download", { exact: true }).click();
  await page.getByLabel("Device key for DEFAULT solo").fill("device-e2e");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Activate and download .lic" }).click();
  await downloadPromise;
  await expect(page.locator(".licenseDownload").getByRole("status")).toContainText("Download started.");

  // Leave Apps (Devices) and come back to the same app's license list.
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("link", { name: "View licenses for DEFAULT" }).click();
  await page.locator("tr").filter({ has: page.getByLabel("Device key for DEFAULT solo") }).getByText("Activate and download", { exact: true }).click();
  await expect(page.locator(".licenseDownload").getByRole("status")).toHaveCount(0);
});
