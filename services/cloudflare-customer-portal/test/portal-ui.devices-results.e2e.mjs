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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// D3: `customers` maps an OTP code to its own { customerId, entitlements } account, so a test can sign
// in as more than one customer on the SAME browser (e.g. an explicit sign-out, then a different
// customer's sign-in). The single-account tests below never pass it -- they keep signing in as
// VALID_CODE / "cus_results" exactly as before.
function setup(page, { entitlements, support, checkoutResponse, checkoutDelayMs, downloadDelayMs, releaseResponse, customers } = {}) {
  const accounts = customers ?? { [VALID_CODE]: { customerId: "cus_results", entitlements: entitlements ?? [] } };
  let authedCode = null;
  const requests = { checkouts: 0, releases: 0, downloads: 0 };
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const fulfill = (status, body, contentType = "application/json") => route.fulfill({ status, contentType, body: typeof body === "string" ? body : JSON.stringify(body) });

    if (path === "/portal/v1/auth/providers") return fulfill(200, envelope("auth_providers", { google: false, github: false, email: true, password: false, ...(support !== undefined ? { support } : {}) }));
    if (method === "POST" && path === "/portal/v1/auth/request") return fulfill(200, envelope("otp_requested"));
    if (method === "POST" && path === "/portal/v1/auth/verify") {
      const body = jsonBody(request);
      const account = accounts[body.code];
      if (!account) return fulfill(401, { ok: false, code: "invalid_otp", request_id: "devices-results-bad" });
      authedCode = body.code;
      return fulfill(200, envelope("signed_in", { customer_id: account.customerId }));
    }
    // D3: sign-out itself. Every fixture here now accepts it so decision 5's sign-out tests can share
    // this same setup() as the checkout/release tests above.
    if (method === "POST" && path === "/portal/v1/auth/logout") {
      if (authedCode === null) return fulfill(401, { ok: false, code: "unauthorized", request_id: "devices-results-401" });
      authedCode = null;
      return fulfill(200, envelope("logged_out"));
    }
    if (method === "GET" && path === "/api/portal/me") {
      if (authedCode === null) return fulfill(401, { ok: false, code: "unauthorized", request_id: "devices-results-401" });
      return fulfill(200, envelope("me", { customer_id: accounts[authedCode].customerId, email: null }));
    }
    if (method === "GET" && path === "/api/portal/entitlements") {
      if (authedCode === null) return fulfill(401, { ok: false, code: "unauthorized", request_id: "devices-results-401" });
      return fulfill(200, envelope("entitlements", { items: accounts[authedCode].entitlements.map((item) => ({ ...item })) }));
    }
    if (method === "GET" && path === "/api/portal/devices") {
      if (authedCode === null) return fulfill(401, { ok: false, code: "unauthorized", request_id: "devices-results-401" });
      return fulfill(200, envelope("devices", { items: [] }));
    }
    if (method === "GET" && path === "/api/portal/usage") {
      if (authedCode === null) return fulfill(401, { ok: false, code: "unauthorized", request_id: "devices-results-401" });
      return fulfill(200, envelope("usage", { items: [] }));
    }
    if (method === "GET" && path === "/api/portal/device-bindings") {
      return fulfill(200, envelope("device_bindings", { customer_id: authedCode === null ? null : accounts[authedCode].customerId, items: [], has_more: false, next_cursor: null }));
    }
    if (method === "POST" && path === "/api/portal/checkout") {
      requests.checkouts += 1;
      const body = jsonBody(request);
      if (checkoutDelayMs) await delay(checkoutDelayMs);
      if (checkoutResponse) {
        const response = checkoutResponse(body, requests.checkouts);
        if (response) return fulfill(response.status ?? 200, response.body);
      }
      return fulfill(200, envelope("checkout_ok", { seat_id: `seat-${body.entitlement_id}`, expires_at: NOW + 3600 }));
    }
    if (method === "POST" && path === "/api/portal/release") {
      requests.releases += 1;
      const body = jsonBody(request);
      if (releaseResponse) {
        const response = releaseResponse(body, requests.releases);
        if (response) return fulfill(response.status ?? 200, response.body);
      }
      return fulfill(200, envelope("release_ok", { seat_id: body.seat_id }));
    }
    if (method === "POST" && path === "/api/portal/download") {
      requests.downloads += 1;
      if (downloadDelayMs) await delay(downloadDelayMs);
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
  // to what this test is checking; the sign-out tests further down cover what happens once seats are
  // released at sign-out (D3).
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

// Fix round 2 (Important): clearMessages() (fix round 1) only wipes what is ALREADY showing at the
// moment a page is left. It does nothing about a response that is still in flight at that moment and
// arrives later -- possibly after the customer has come back. This is a real race, not a theoretical
// one: the SPA never aborts an in-flight fetch on a hash-route change, so the delayed response's
// `.then` still runs and would otherwise write straight back into the (already-cleared) map.
const RACE_DELAY_MS = 1000;
const RACE_WAIT_MS = 1500;

test("a delayed seat-start response that arrives after leaving Devices does not show a stale result, and the real session still exists", async ({ page }) => {
  setup(page, { entitlements: [ENT_ALPHA], checkoutDelayMs: RACE_DELAY_MS });
  await signIn(page);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByText("Browser seats", { exact: true }).click();
  const alphaCard = page.locator(".seatCard").filter({ hasText: "alpha" });

  // Click Start seat, then leave for Apps immediately -- well before the delayed response arrives.
  await alphaCard.getByRole("button", { name: "Start seat" }).click();
  await page.getByRole("link", { name: "Apps", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await page.waitForTimeout(RACE_WAIT_MS); // past the delayed response, still on Apps

  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByText("Browser seats", { exact: true }).click();
  // No stale "Seat started." line...
  await expect(alphaCard.getByRole("status")).toHaveCount(0);
  // ...but the checkout genuinely completed: a real session exists (Renew/Release are enabled, Start
  // is disabled), so the guard drops only the shown RESULT, never the real state it describes.
  await expect(alphaCard.getByRole("button", { name: "Start seat" })).toBeDisabled();
  await expect(alphaCard.getByRole("button", { name: "Release seat" })).toBeEnabled();
});

test("a delayed, FAILING seat-start response that arrives after leaving Devices shows no error line, and the panel stays collapsed since there is no session", async ({ page }) => {
  setup(page, {
    entitlements: [ENT_ALPHA],
    checkoutDelayMs: RACE_DELAY_MS,
    checkoutResponse: () => ({ status: 503, body: { ok: false, code: "seat_signing_unavailable", request_id: "devices-results-race-fail" } }),
  });
  await signIn(page);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByText("Browser seats", { exact: true }).click();
  const alphaCard = page.locator(".seatCard").filter({ hasText: "alpha" });

  await alphaCard.getByRole("button", { name: "Start seat" }).click();
  await page.getByRole("link", { name: "Apps", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await page.waitForTimeout(RACE_WAIT_MS);

  await page.getByRole("link", { name: "Devices", exact: true }).click();
  // No session was ever created (the checkout failed) and no message survived the visit, so the panel
  // is genuinely collapsed -- not left artificially expanded by a leftover error result.
  await expect(page.locator("details.browserSessions")).toHaveCount(1);
  await expect(page.locator("section.browserSessions")).toHaveCount(0);
  await page.getByText("Browser seats", { exact: true }).click();
  await expect(alphaCard.getByRole("status")).toHaveCount(0);
  await expect(page.getByText("seat_signing_unavailable", { exact: false })).not.toBeVisible();
});

test("a delayed download response that arrives after leaving Apps does not show a stale result", async ({ page }) => {
  setup(page, { entitlements: [ENT_NODE], downloadDelayMs: RACE_DELAY_MS });
  await signIn(page);
  await page.getByRole("link", { name: "View licenses for DEFAULT" }).click();
  await page.locator("tr").filter({ has: page.getByLabel("Device key for DEFAULT solo") }).getByText("Activate and download", { exact: true }).click();
  await page.getByLabel("Device key for DEFAULT solo").fill("device-e2e");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Activate and download .lic" }).click();

  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
  // The real download still completes in the background regardless of which page is showing -- an
  // SPA hash-route change never aborts an in-flight fetch.
  await downloadPromise;
  await page.waitForTimeout(RACE_WAIT_MS);

  await page.getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("link", { name: "View licenses for DEFAULT" }).click();
  await page.locator("tr").filter({ has: page.getByLabel("Device key for DEFAULT solo") }).getByText("Activate and download", { exact: true }).click();
  await expect(page.locator(".licenseDownload").getByRole("status")).toHaveCount(0);
});

// D3: "Signing out doesn't orphan browser seats." Sign-out releases every seat this browser holds,
// best-effort, before the actual sign-out request, and the sign-in screen says how many.
test("signing out with a live seat releases it and the sign-in screen shows the release count", async ({ page }) => {
  const requests = setup(page, { entitlements: [ENT_ALPHA] });
  await signIn(page);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByText("Browser seats", { exact: true }).click();
  const alphaCard = page.locator(".seatCard").filter({ hasText: "alpha" });
  await alphaCard.getByRole("button", { name: "Start seat" }).click();
  await expect(alphaCard.getByRole("status")).toContainText("Seat started.");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => requests.releases).toBe(1);
  await expect(page.getByRole("button", { name: "Send code" })).toBeVisible();
  await expect(page.getByText("Released 1 browser seat.", { exact: true })).toBeVisible();
  // The released seat is gone from this customer's storage, not just the in-memory session.
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1:cus_results"))).toBe("{}");
});

// D3 (decision 5): a seat whose release fails at sign-out stays stored under the customer id, is
// listed again after the next sign-in, and can still be released once the server accepts it.
test("a seat whose release fails at sign-out is listed again after signing in and can be released", async ({ page }) => {
  let releaseAttempts = 0;
  const requests = setup(page, {
    entitlements: [ENT_ALPHA],
    // Fail only the FIRST release attempt (sign-out); a later manual release succeeds normally.
    releaseResponse: () => {
      releaseAttempts += 1;
      if (releaseAttempts > 1) return null;
      return { status: 503, body: { ok: false, code: "verification_error", request_id: "devices-results-signout-fail" } };
    },
  });
  await signIn(page);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByText("Browser seats", { exact: true }).click();
  const alphaCard = page.locator(".seatCard").filter({ hasText: "alpha" });
  await alphaCard.getByRole("button", { name: "Start seat" }).click();
  await expect(alphaCard.getByRole("status")).toContainText("Seat started.");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => requests.releases).toBe(1);
  await expect(page.getByRole("button", { name: "Send code" })).toBeVisible();
  await expect(page.getByText("1 seat couldn't be released; they'll be listed after you sign in again.", { exact: true })).toBeVisible();
  // The failed seat stays under this customer's key -- never silently dropped.
  const storedAfterFailedSignOut = await page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1:cus_results"));
  expect(storedAfterFailedSignOut).toContain("ent_alpha");

  // Sign back in as the SAME customer: the failed seat is listed under Browser seats again, pre-
  // expanded (a live/failed seat makes the panel a <section>, never the collapsed <details>).
  await signIn(page);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Browser seats" })).toBeVisible();
  const alphaCardAgain = page.locator(".seatCard").filter({ hasText: "alpha" });
  await expect(alphaCardAgain.getByRole("button", { name: "Start seat" })).toBeDisabled();
  await expect(alphaCardAgain.getByRole("button", { name: "Release seat" })).toBeEnabled();

  // And releasing it now works (the server accepts this second attempt).
  await alphaCardAgain.getByRole("button", { name: "Release seat" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm release" }).click();
  await expect(alphaCardAgain.getByRole("status")).toContainText("Seat released.");
  await expect.poll(() => requests.releases).toBe(2);
});

// D3 (decision 5): a different customer signing in on the same browser, after an explicit sign-out,
// never sees the first customer's (even failed/unreleased) browser seats.
test("a different customer signing in after an explicit sign-out never sees the first customer's browser seats", async ({ page }) => {
  const CODE_B = "19283746";
  const ENT_A = { ...ENT_ALPHA, id: "ent_switch_a", project: "ALPHACORP", feature: "widget" };
  const ENT_B = { ...ENT_ALPHA, id: "ent_switch_b", project: "BETAWORKS", feature: "gadget" };
  const requests = setup(page, {
    customers: {
      [VALID_CODE]: { customerId: "cus_signout_a", entitlements: [ENT_A] },
      [CODE_B]: { customerId: "cus_signout_b", entitlements: [ENT_B] },
    },
    // Every release fails, so A's seat stays stored under A's customer key through the sign-out.
    releaseResponse: () => ({ status: 503, body: { ok: false, code: "verification_error", request_id: "devices-results-signout-b" } }),
  });
  await signIn(page);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByText("Browser seats", { exact: true }).click();
  const widgetCard = page.locator(".seatCard").filter({ hasText: "widget" });
  await widgetCard.getByRole("button", { name: "Start seat" }).click();
  await expect(widgetCard.getByRole("status")).toContainText("Seat started.");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => requests.releases).toBe(1);
  await expect(page.getByRole("button", { name: "Send code" })).toBeVisible();

  // Sign in as a DIFFERENT customer: their own floating entitlement renders the section, but
  // collapsed -- never pre-expanded with A's leftover seat, and A's project name is nowhere on screen.
  await page.getByLabel("Email").fill("bob@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("8-digit code").fill(CODE_B);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Browser seats" })).toHaveCount(0);
  await page.getByText("Browser seats", { exact: true }).click();
  const gadgetCard = page.locator(".seatCard").filter({ hasText: "gadget" });
  await expect(gadgetCard.getByRole("button", { name: "Start seat" })).toBeEnabled();
  await expect(gadgetCard.getByRole("button", { name: "Release seat" })).toBeDisabled();
  await expect(page.getByText("widget", { exact: false })).toHaveCount(0);

  // B's own storage key holds nothing; A's failed seat remains only under A's key.
  const storedForB = await page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1:cus_signout_b"));
  expect(storedForB).toBeNull();
  const storedForA = await page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1:cus_signout_a"));
  expect(storedForA).toContain("ent_switch_a");
});
