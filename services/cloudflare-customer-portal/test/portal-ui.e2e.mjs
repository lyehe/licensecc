import { expect, test } from "@playwright/test";
import "./portal-ui.consent.e2e.mjs";
import "./portal-ui.nodes.e2e.mjs";

function makeEnvelope(code, data) {
  makeEnvelope.nextRequestId += 1;
  return {
    ok: true,
    code,
    request_id: `portal-e2e-${makeEnvelope.nextRequestId}`,
    data,
  };
}
makeEnvelope.nextRequestId = 0;

test("email/password registration opens an empty account and does not request an email code", async ({ page }) => {
  let authed = false;
  const submissions = [];
  await page.route("**/portal/v1/auth/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/providers")) return route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: false, password: true }) });
    if (path.endsWith("/password/register")) { submissions.push(route.request().postDataJSON()); authed = true; return route.fulfill({ json: makeEnvelope("signed_in", { customer_id: "new-customer" }) }); }
    throw new Error(`Unexpected auth route ${path}`);
  });
  await page.route("**/api/portal/**", (route) => {
    if (!authed) return route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } });
    return route.fulfill({ json: makeEnvelope("ok", route.request().url().endsWith("/me") ? { customer_id: "new-customer" } : { items: [] }) });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Send code" })).toHaveCount(0);
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("new@example.com");
  await page.getByLabel("Password", { exact: true }).fill("A long testing passphrase 1!");
  await expect(page.getByText(/your email is not verified/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  expect(submissions).toEqual([{ email: "new@example.com", password: "A long testing passphrase 1!" }]);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test("password login errors clear the secret and explain recovery", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: true, github: true, email: false, password: true }) }));
  await page.route("**/portal/v1/auth/password/login", (route) => route.fulfill({ status: 401, json: { ok: false, code: "invalid_credentials" } }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeHidden();
  await page.getByText("Other sign-in options", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill("new@example.com");
  await page.getByLabel("Password", { exact: true }).fill("A wrong testing passphrase");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Email or password is incorrect.");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await page.getByText("Forgot your password?", { exact: true }).click();
  await expect(page.getByText(/contact your administrator for recovery/)).toBeVisible();
});

test("Account password change requires the current password and confirms session rotation", async ({ page }) => {
  let submitted;
  await page.route("**/api/portal/**", (route) => route.fulfill({ json: makeEnvelope("ok", route.request().url().endsWith("/me") ? { customer_id: "cus_self" } : { items: [] }) }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: false, password: true }) }));
  await page.route("**/portal/v1/auth/identities", (route) => route.fulfill({ json: makeEnvelope("identities", { items: [] }) }));
  await page.route("**/portal/v1/auth/password", (route) => {
    if (route.request().method() === "POST") { submitted = route.request().postDataJSON(); return route.fulfill({ json: makeEnvelope("signed_in") }); }
    return route.fulfill({ json: makeEnvelope("password_settings", { has_password: true, can_reset: false, email_verified: false, email: "new@example.com" }) });
  });
  await page.goto("/#/account");
  await expect(page.getByRole("heading", { name: "Connected accounts" })).toHaveCount(0);
  await expect(page.getByLabel("Current password", { exact: true })).toBeHidden();
  await page.locator("summary").filter({ hasText: /^Change password$/ }).click();
  await page.getByLabel("Current password", { exact: true }).fill("A long testing passphrase 1!");
  await page.getByLabel("New password", { exact: true }).fill("A replacement passphrase 2!");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await expect(page.getByText("Password saved. Other browser sessions have been signed out.")).toBeVisible();
  expect(submitted).toEqual({ current_password: "A long testing passphrase 1!", password: "A replacement passphrase 2!" });
  await expect(page.getByLabel("New password", { exact: true })).toHaveValue("");
});

test("social sign-in buttons submit to their own start routes and hide unavailable email", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: true, github: true, email: false }) }));
  await page.goto("/?auth_error=sign_in_cancelled");
  await expect(page.getByText("Sign-in was cancelled. You can try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send code", exact: true })).toHaveCount(0);
  for (const [provider, label] of [["google", "Google"], ["github", "GitHub"]]) {
    await expect(page.getByRole("button", { name: `Continue with ${label}` })).toBeVisible();
    await expect(page.locator(`form[action="/portal/v1/auth/${provider}/start"]`)).toHaveAttribute("method", "post");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const navigation = page.waitForRequest((request) => request.url().endsWith("/portal/v1/auth/github/start") && request.method() === "POST");
  await page.route("**/portal/v1/auth/github/start", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Provider redirect boundary</h1>" }));
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await navigation;
  await expect(page.getByRole("heading", { name: "Provider redirect boundary" })).toBeVisible();
});

test("unconfigured providers show a clear unavailable state", async ({ page }) => {
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: false }) }));
  await page.goto("/");
  await expect(page.getByText("Sign-in is not configured yet. Contact your administrator.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue with|Send code/ })).toHaveCount(0);
});

test("Account shows connected methods and keeps linking failures visible", async ({ page }) => {
  await page.route("**/api/portal/**", (route) => route.fulfill({ json: makeEnvelope("ok", route.request().url().endsWith("/me") ? { customer_id: "cus_self" } : { items: [] }) }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: true, github: true, email: false }) }));
  await page.route("**/portal/v1/auth/identities", (route) => route.fulfill({ json: makeEnvelope("identities", { items: [{ provider: "google", email: "customer@example.com" }] }) }));
  await page.goto("/?auth_error=link_failed#/account");
  await expect(page.getByText("Unable to connect this provider. Sign in again and retry from Account.")).toBeVisible();
  await expect(page.getByText("Google · customer@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Google" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
  await expect(page.locator('form[action="/portal/v1/auth/github/start?mode=link"]')).toHaveAttribute("method", "post");
});

// In-memory portal backend. The fixture mints NO real session: a successful verify simply flips an
// `authed` flag (the SPA gates on me() succeeding, exactly as it would behind the HttpOnly cookie).
// Crucially the fixtures NEVER return a bearer/token/private-key/another-customer's id — the leak
// guard asserts the rendered page never surfaces such material.
function makePortalApiFixture() {
  const VALID_CODE = "80315426";
  let authed = false;
  const controls = { rejectUsage: false, failMe: false, failNextRelease: false, deferNextRelease: false, rejectNextRelease: false, rejectRefreshes: 0, resolveRelease: null };
  const requests = { authRequests: 0, verifies: 0, checkouts: 0, heartbeats: 0, releases: 0, refreshRejects: 0, downloads: 0, logouts: 0, seatActions: [] };

  const entitlements = [
    { id: "ent_floating", project: "DEFAULT", feature: "pro", status: "active", license_fingerprint: "a".repeat(64), valid_from: 1_710_000_000, valid_until: null, license_mode: "floating", pool_size: 5, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: "pol_float" },
    { id: "ent_node", project: "DEFAULT", feature: "solo", status: "active", license_fingerprint: "b".repeat(64), valid_from: null, valid_until: 1_760_000_000, license_mode: "node_locked", pool_size: 0, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: "pol_node" },
  ];
  const devices = [
    { project: "DEFAULT", feature: "pro", license_fingerprint: "a".repeat(64), device_key_id: "d".repeat(40), created_at: 1_710_000_500 },
  ];
  const usage = [
    { project: "DEFAULT", feature: "pro", event_type: "checkout", count: 12 },
    { project: "DEFAULT", feature: "pro", event_type: "heartbeat", count: 87 },
  ];

  async function jsonBody(request) {
    const text = request.postData() ?? "{}";
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  async function route(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const fulfill = (status, body, contentType = "application/json") => route.fulfill({
      status,
      contentType,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

    // ---- Auth ----
    if (path === "/portal/v1/auth/providers") return fulfill(200, makeEnvelope("auth_providers", { google: true, github: true, email: true }));
    if (path === "/portal/v1/auth/identities") return fulfill(200, makeEnvelope("identities", { items: [] }));
    if (method === "POST" && path === "/portal/v1/auth/request") {
      requests.authRequests += 1;
      return fulfill(200, makeEnvelope("otp_requested"));
    }
    if (method === "POST" && path === "/portal/v1/auth/verify") {
      requests.verifies += 1;
      const body = await jsonBody(request);
      if (body.code === VALID_CODE) {
        authed = true;
        return fulfill(200, makeEnvelope("signed_in", { customer_id: "cus_self" }));
      }
      return fulfill(401, { ok: false, code: "invalid_otp", request_id: "portal-e2e-bad" });
    }
    if (method === "POST" && path === "/portal/v1/auth/logout") {
      requests.logouts += 1;
      authed = false;
      return fulfill(200, makeEnvelope("logged_out"));
    }

    // ---- Session-scoped reads ----
    if (method === "GET" && path === "/api/portal/me") {
      if (controls.failMe) return fulfill(503, { ok: false, code: "unavailable", request_id: "session-check" });
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "portal-e2e-401" });
      return fulfill(200, makeEnvelope("me", { customer_id: "cus_self" }));
    }
    if (method === "GET" && path === "/api/portal/entitlements") {
      if (controls.rejectRefreshes > 0) {
        controls.rejectRefreshes -= 1;
        requests.refreshRejects += 1;
        return route.abort("failed");
      }
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "portal-e2e-401" });
      return fulfill(200, makeEnvelope("entitlements", { items: entitlements.map((item) => ({ ...item })) }));
    }
    if (method === "GET" && path === "/api/portal/devices") {
      if (controls.rejectRefreshes > 0) {
        controls.rejectRefreshes -= 1;
        requests.refreshRejects += 1;
        return route.abort("failed");
      }
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "portal-e2e-401" });
      return fulfill(200, makeEnvelope("devices", { items: devices.map((item) => ({ ...item })) }));
    }
    if (method === "GET" && path === "/api/portal/usage") {
      if (controls.rejectUsage) return route.abort("failed");
      if (controls.rejectRefreshes > 0) {
        controls.rejectRefreshes -= 1;
        requests.refreshRejects += 1;
        return route.abort("failed");
      }
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "portal-e2e-401" });
      return fulfill(200, makeEnvelope("usage", { items: usage.map((item) => ({ ...item })) }));
    }

    if (method === "POST" && path === "/api/portal/devices/release") {
      const body = await jsonBody(request);
      const index = devices.findIndex((item) => item.device_key_id === body.device_key_id);
      if (index >= 0) devices.splice(index, 1);
      return fulfill(200, makeEnvelope("device_released"));
    }

    // ---- Per-seat actions: body MUST target an entitlement id, never a raw fingerprint. ----
    if (method === "POST" && (path === "/api/portal/checkout" || path === "/api/portal/heartbeat" || path === "/api/portal/release")) {
      const body = await jsonBody(request);
      // Assert the client never supplies the fingerprint (invariant 4: server-resolved).
      if ("license_fingerprint" in body || body.entitlement_id !== "ent_floating" || typeof body.client_instance_id !== "string" || typeof body.nonce !== "string") {
        return fulfill(400, { ok: false, code: "fingerprint_must_not_be_client_supplied", request_id: "portal-e2e-leak" });
      }
      const op = path.split("/").pop();
      if ((op === "heartbeat" || op === "release") && body.seat_id !== "seat-e2e") {
        return fulfill(400, { ok: false, code: "seat_id_required", request_id: "portal-e2e-seat" });
      }
      requests[`${op}s`] += 1;
      requests.seatActions.push({ op, body });
      if (op === "release" && controls.deferNextRelease) {
        controls.deferNextRelease = false;
        await new Promise((resolve) => { controls.resolveRelease = resolve; });
        controls.resolveRelease = null;
      }
      if (op === "release" && controls.rejectNextRelease) {
        controls.rejectNextRelease = false;
        return route.abort("failed");
      }
      if (op === "release" && controls.failNextRelease) {
        controls.failNextRelease = false;
        return fulfill(503, { ok: false, code: "verification_error", request_id: "portal-e2e-release-failure" });
      }
      return fulfill(200, makeEnvelope(`${op}_ok`, { seat_id: "seat-e2e", mode: "live" }));
    }

    // ---- Download: stream a signed-looking attachment (NOT a private key) ----
    if (method === "POST" && path === "/api/portal/download") {
      requests.downloads += 1;
      const body = await jsonBody(request);
      if ("license_fingerprint" in body || body.entitlement_id !== "ent_node" || typeof body.device_key_id !== "string" || body.device_key_id === "") {
        return fulfill(400, { ok: false, code: "fingerprint_must_not_be_client_supplied", request_id: "portal-e2e-leak" });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "content-disposition": "attachment; filename=\"DEFAULT-solo.lic\"" },
        body: "[license]\nsigned-license-bytes-not-a-key\n",
      });
    }

    return fulfill(404, { ok: false, code: "not_found", request_id: "portal-e2e-unhandled" });
  }

  return { route, requests, VALID_CODE, controls, entitlements, devices };
}

test("customer portal signs in with an 8-digit code and walks every screen without leaking secrets", async ({ page }) => {
  const api = makePortalApiFixture();
  await page.route("**/portal/v1/auth/**", api.route);
  await page.route("**/api/portal/**", api.route);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();

  // --- Login: email -> request code ---
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText(/Check your email/)).toBeVisible();
  await expect.poll(() => api.requests.authRequests).toBe(1);

  // --- Login: enter the 8-digit code -> me() -> dashboard ---
  await page.getByLabel("8-digit code").fill(api.VALID_CODE);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("link", { name: "Apps", exact: true })).toBeVisible();
  await expect.poll(() => api.requests.verifies).toBe(1);

  // --- Per-app access (read-only) ---
  await page.getByRole("link", { name: "View app DEFAULT" }).click();
  await expect(page.getByText("pro", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".status.active").first()).toHaveText("active");
  await expect(page.getByText("aaaaaaaa...aaaaaaaa").first()).toBeVisible();

  // --- My devices/seats: floating seat checkout/heartbeat/release ---
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  const seatCard = page.locator(".seatCard").filter({ hasText: "pro" }).first();
  await expect(seatCard.getByRole("button", { name: "Start seat" })).toBeEnabled();
  await expect(seatCard.getByRole("button", { name: "Refresh" })).toBeDisabled();
  await expect(seatCard.getByRole("button", { name: "Release" })).toBeDisabled();

  await seatCard.getByRole("button", { name: "Start seat" }).click();
  await expect.poll(() => api.requests.checkouts).toBe(1);
  const checkout = api.requests.seatActions.at(-1);
  expect(checkout).toMatchObject({ op: "checkout", body: { entitlement_id: "ent_floating" } });
  expect(checkout.body).not.toHaveProperty("seat_id");
  expect(checkout.body.client_instance_id).toMatch(/^[0-9a-f-]{36}$/);
  await expect(seatCard.getByRole("button", { name: "Start seat" })).toBeDisabled();
  await expect(seatCard.getByRole("button", { name: "Refresh" })).toBeEnabled();
  await expect(seatCard.getByRole("button", { name: "Release" })).toBeEnabled();

  await seatCard.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => api.requests.heartbeats).toBe(1);
  const heartbeat = api.requests.seatActions.at(-1);
  expect(heartbeat).toMatchObject({ op: "heartbeat", body: { entitlement_id: "ent_floating", seat_id: "seat-e2e" } });
  expect(heartbeat.body.client_instance_id).toBe(checkout.body.client_instance_id);
  const storedSeatSessionBeforeReleaseConfirm = await page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1"));

  // Release is destructive: opening the confirmation must not send a request or change the live
  // session. The dialog names the exact license, seat, and device plus the availability impact.
  await page.setViewportSize({ width: 320, height: 240 });
  await seatCard.getByRole("button", { name: "Release" }).click();
  const releaseDialog = page.getByRole("dialog");
  await expect(releaseDialog).toBeVisible();
  await expect(releaseDialog).toContainText("DEFAULT");
  await expect(releaseDialog).toContainText("pro");
  await expect(releaseDialog).toContainText("seat-e2e");
  await expect(releaseDialog).toContainText("cannot be undone");
  await expect(releaseDialog).toContainText("available to another user");
  const compactModalLayout = await page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"]');
    const overlay = modal?.parentElement;
    return {
      modalScrollable: modal !== null && modal.scrollHeight > modal.clientHeight,
      modalOverflowY: modal === null ? "" : getComputedStyle(modal).overflowY,
      modalOverflowX: modal === null ? "" : getComputedStyle(modal).overflowX,
      overlayOverflowY: overlay === null ? "" : getComputedStyle(overlay).overflowY,
      overlayOverflowX: overlay === null ? "" : getComputedStyle(overlay).overflowX,
      bodyHasHorizontalOverflow: document.body.scrollWidth > window.innerWidth,
    };
  });
  expect(compactModalLayout.modalScrollable).toBe(true);
  expect(compactModalLayout.modalOverflowY).toBe("auto");
  expect(compactModalLayout.modalOverflowX).toBe("hidden");
  expect(compactModalLayout.overlayOverflowY).toBe("auto");
  expect(compactModalLayout.overlayOverflowX).toBe("hidden");
  expect(compactModalLayout.bodyHasHorizontalOverflow).toBe(false);
  const cancelRelease = releaseDialog.getByRole("button", { name: "Cancel" });
  const confirmRelease = releaseDialog.getByRole("button", { name: "Confirm release" });
  const releaseTitle = releaseDialog.getByRole("heading", { name: "Release floating seat?" });
  await releaseTitle.scrollIntoViewIfNeeded();
  const titleInViewport = await releaseTitle.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  expect(titleInViewport).toBe(true);
  await confirmRelease.scrollIntoViewIfNeeded();
  const actionsInViewport = await confirmRelease.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  expect(actionsInViewport).toBe(true);
  await expect(cancelRelease).toBeFocused();
  await expect(page.locator("main")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await expect(page.locator("main").getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(confirmRelease).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancelRelease).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirmRelease).toBeFocused();
  const backgroundFocused = await page.locator("main").evaluate((main) => {
    const button = Array.from(main.querySelectorAll("button")).find((candidate) => candidate.textContent === "Refresh");
    button?.focus();
    return document.activeElement === button;
  });
  expect(backgroundFocused).toBe(false);
  await expect(confirmRelease).toBeFocused();
  await expect.poll(() => api.requests.releases).toBe(0);

  // Cancel is a no-op for the session and backend.
  await cancelRelease.click();
  await expect(releaseDialog).toHaveCount(0);
  await expect.poll(() => api.requests.releases).toBe(0);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1"))).toBe(storedSeatSessionBeforeReleaseConfirm);
  await expect(seatCard.getByRole("button", { name: "Refresh" })).toBeEnabled();
  await expect(seatCard.getByRole("button", { name: "Release" })).toBeEnabled();
  await expect(seatCard.getByRole("button", { name: "Release" })).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 720 });

  // Escape is the keyboard cancellation path and likewise must not release the seat.
  await seatCard.getByRole("button", { name: "Release" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => api.requests.releases).toBe(0);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1"))).toBe(storedSeatSessionBeforeReleaseConfirm);
  await expect(seatCard.getByRole("button", { name: "Release" })).toBeEnabled();
  await expect(seatCard.getByRole("button", { name: "Release" })).toBeFocused();

  // A deferred failed confirmation keeps focus inside the busy dialog, blocks Escape/Cancel, and
  // then preserves the active seat, leaves the error visible, and restores trigger focus.
  api.controls.failNextRelease = true;
  api.controls.deferNextRelease = true;
  await seatCard.getByRole("button", { name: "Release" }).click();
  const failedReleaseDialog = page.getByRole("dialog");
  await expect(failedReleaseDialog).toBeVisible();
  await failedReleaseDialog.getByRole("button", { name: "Confirm release" }).click();
  await expect.poll(() => api.requests.releases).toBe(1);
  await expect(failedReleaseDialog).toHaveAttribute("aria-busy", "true");
  await expect(failedReleaseDialog.getByText("Releasing…")).toBeVisible();
  await expect(failedReleaseDialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(failedReleaseDialog.getByRole("button", { name: "Confirm release" })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(failedReleaseDialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
  await expect.poll(() => typeof api.controls.resolveRelease).toBe("function");
  api.controls.resolveRelease();
  await expect(failedReleaseDialog).toHaveCount(0);
  await expect(page.getByText(/verification_error/)).toBeVisible();
  await expect(seatCard.getByRole("button", { name: "Release" })).toBeEnabled();
  await expect(seatCard.getByRole("button", { name: "Release" })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1"))).toBe(storedSeatSessionBeforeReleaseConfirm);

  // A rejected fetch keeps the context/modal present with an explicit failure, then Escape closes
  // it through the normal policy path and restores the original Release trigger.
  api.controls.rejectNextRelease = true;
  await seatCard.getByRole("button", { name: "Release" }).click();
  const networkErrorDialog = page.getByRole("dialog");
  await networkErrorDialog.getByRole("button", { name: "Confirm release" }).click();
  await expect(networkErrorDialog).toContainText("service was unreachable");
  await expect(networkErrorDialog).toContainText("outcome is unknown");
  await expect(networkErrorDialog).toContainText(/check the seat status/i);
  await expect(networkErrorDialog).toContainText("seat-e2e");
  await expect(networkErrorDialog.getByRole("alert")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
  await expect(networkErrorDialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
  await expect(networkErrorDialog.getByRole("button", { name: "Confirm release" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(networkErrorDialog).toHaveCount(0);
  await expect(seatCard.getByRole("button", { name: "Release" })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1"))).toBe(storedSeatSessionBeforeReleaseConfirm);

  // Only the explicit confirmation sends the original request, and a double click remains one
  // release while the existing busy guard is active. Success focuses the newly available Start seat.
  await seatCard.getByRole("button", { name: "Release" }).click();
  const confirmReleaseDialog = page.getByRole("dialog");
  await expect(confirmReleaseDialog).toBeVisible();
  await confirmReleaseDialog.getByRole("button", { name: "Confirm release" }).dblclick();
  await expect.poll(() => api.requests.releases).toBe(3);
  const release = api.requests.seatActions.at(-1);
  expect(release).toMatchObject({ op: "release", body: { entitlement_id: "ent_floating", seat_id: "seat-e2e" } });
  expect(release.body).toEqual({
    entitlement_id: "ent_floating",
    client_instance_id: checkout.body.client_instance_id,
    nonce: expect.any(String),
    seat_id: "seat-e2e",
  });
  expect(release.body.client_instance_id).toBe(checkout.body.client_instance_id);
  await expect(page.getByText(/release_ok/)).toBeVisible();
  await expect(seatCard.getByRole("button", { name: "Start seat" })).toBeEnabled();
  await expect(seatCard.getByRole("button", { name: "Start seat" })).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  await expect(seatCard.getByRole("button", { name: "Refresh" })).toBeDisabled();
  await expect(seatCard.getByRole("button", { name: "Release" })).toBeDisabled();

  // A valid release is authoritative even when the follow-up status refresh rejects. The local
  // session is already gone, the dialog closes once, and manual status refresh remains available;
  // no second release POST is offered or sent.
  await seatCard.getByRole("button", { name: "Start seat" }).click();
  await expect.poll(() => api.requests.checkouts).toBe(2);
  await expect(seatCard.getByRole("button", { name: "Start seat" })).toBeDisabled();
  await expect(seatCard.getByRole("button", { name: "Refresh" })).toBeEnabled();
  const refreshFailureReleaseCount = api.requests.releases;
  const refreshFailureStoredSession = await page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1"));
  expect(refreshFailureStoredSession).not.toBeNull();
  api.controls.rejectRefreshes = 3;
  await seatCard.getByRole("button", { name: "Release" }).click();
  const refreshFailedDialog = page.getByRole("dialog");
  await refreshFailedDialog.getByRole("button", { name: "Confirm release" }).click();
  await expect.poll(() => api.requests.releases).toBe(refreshFailureReleaseCount + 1);
  await expect(refreshFailedDialog).toHaveCount(0);
  await expect.poll(() => api.requests.refreshRejects).toBe(3);
  await expect(page.locator('.feedback p[role="status"]')).toContainText(/released; status refresh failed/i);
  await expect(page.getByRole("button", { name: "Refresh status" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("licensecc.portal.seats.v1"))).toBe("{}");
  await expect(seatCard.getByRole("button", { name: "Start seat" })).toBeDisabled();
  await expect(seatCard).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");

  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.getByRole("button", { name: "Refresh status" })).toHaveCount(0);
  await expect(page.locator('.feedback p[role="status"]')).toHaveText("");
  await expect(page.getByRole("link", { name: "Devices", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");

  // --- Usage ---
  await page.getByRole("link", { name: "Apps", exact: true }).click();
  await page.getByRole("link", { name: "View app DEFAULT" }).click();
  await expect(page.getByText("Recorded usage")).toBeVisible();
  await expect(page.getByText("87", { exact: true })).toBeVisible();

  // --- Download: triggers a browser download of the streamed attachment ---
  // License download is part of the app details.
  await page.getByLabel("Device key for DEFAULT solo").fill("device-e2e");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Activate and download .lic" }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("DEFAULT-solo.lic");
  await expect.poll(() => api.requests.downloads).toBe(1);

  // --- Leak guard: the rendered page text must NEVER expose any credential / cross-tenant id. ---
  const pageText = await page.locator("body").innerText();
  for (const needle of ["PRIVATE KEY", "BEGIN", "Bearer ", "lcca_", "lccp_", "token", "cus_other", "other@example.com"]) {
    expect(pageText).not.toContain(needle);
  }

  // --- Logout returns to the sign-in screen ---
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Send code" })).toBeVisible();
  await expect.poll(() => api.requests.logouts).toBe(1);
});

async function signIn(page, api) {
  await page.route("**/portal/v1/auth/**", api.route);
  await page.route("**/api/portal/**", api.route);
  await page.goto("/");
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("8-digit code").fill(api.VALID_CODE);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
}

test("app grouping, browser history and mobile reflow preserve the customer context", async ({ page }) => {
  const api = makePortalApiFixture();
  api.entitlements.push({ ...api.entitlements[0], id: "second_app", project: "SECOND_APP", feature: "second-feature" });
  await signIn(page, api);
  await expect(page.locator(".appRow")).toHaveCount(2);
  await page.getByRole("link", { name: "View app SECOND_APP" }).click();
  await expect(page.getByRole("heading", { name: "SECOND_APP", exact: true })).toBeVisible();
  await expect(page.getByText("solo", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "SECOND_APP", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "SECOND_APP", exact: true })).toBeVisible();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("link", { name: "Account", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.screenshot({ path: "../../build/worker-staging/portal-redesign-nodes-mobile.png", fullPage: true });
  await page.getByRole("searchbox", { name: "Find a node" }).fill("missing");
  await expect(page.getByRole("heading", { name: "No matching nodes" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Find a node" }).fill("");
  await expect(page.getByText("d".repeat(40), { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await expect(page.getByText("cus_self", { exact: true })).toBeHidden();
  await page.getByText("Account details", { exact: true }).click();
  await expect(page.getByText("cus_self", { exact: true })).toBeVisible();
  await expect(page.getByText("Your apps and devices stay connected.")).toBeVisible();
});

test("session and account-read failures do not masquerade as an empty account", async ({ page }) => {
  const api = makePortalApiFixture();
  api.controls.failMe = true;
  await page.route("**/portal/v1/auth/**", api.route);
  await page.route("**/api/portal/**", api.route);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Unable to check your session" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  api.controls.failMe = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("8-digit code").fill(api.VALID_CODE);
  api.controls.rejectRefreshes = 3;
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Account data unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No apps assigned yet" })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("link", { name: "View app DEFAULT" })).toBeVisible();
});

test("usage failure stays local and removing a filtered registration keeps the selected app truthful", async ({ page }) => {
  const api = makePortalApiFixture();
  api.controls.rejectUsage = true;
  api.entitlements.push({ ...api.entitlements[1], id: "second_app", project: "SECOND_APP" });
  api.devices.push({ ...api.devices[0], project: "SECOND_APP", device_key_id: "second-node" });
  await signIn(page, api);
  await page.getByRole("link", { name: "View app DEFAULT" }).click();
  await expect(page.getByText(/Usage is unavailable/)).toBeVisible();
  await page.getByLabel("Device key for DEFAULT solo").fill("device-e2e");
  await expect(page.getByRole("button", { name: "Activate and download .lic" })).toBeEnabled();
  api.controls.rejectUsage = false;
  await page.getByRole("button", { name: "Retry usage" }).click();
  await expect(page.getByText("87", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByRole("combobox", { name: "App", exact: true }).selectOption("DEFAULT");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".registrations").getByRole("button", { name: "Release", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No matching nodes" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "App", exact: true })).toHaveValue("DEFAULT");
  await expect(page.getByRole("option", { name: "DEFAULT", exact: true })).toHaveCount(1);
  await page.getByRole("combobox", { name: "App", exact: true }).selectOption("");
  await expect(page.getByText("second-node", { exact: true })).toBeVisible();
});
