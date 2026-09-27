import { expect, test } from "@playwright/test";

// C2: network failures are visible. Each test below aborts exactly ONE request the same way the main
// fixture already does for a seat release / status refresh (route.abort("failed"), simulating offline
// or a DNS failure) and checks that the customer sees a plain-language message -- never a stuck
// screen, a raw code, or a silent failure -- with zero pageerror escaping to the page (a rejected
// fetch that nobody catches becomes an unhandled promise rejection, which Playwright reports as one).
const VALID_CODE = "80315426";
const NETWORK_UNAVAILABLE_COPY = "Couldn't reach the portal. Check your connection and try again.";
const LOGOUT_FAILED_COPY = "Sign-out didn't complete. You're still signed in — try again.";

function makeEnvelope(code, data) {
  return { ok: true, code, request_id: "network-e2e", data };
}

const ENTITLEMENTS = [
  { id: "ent_floating", project: "DEFAULT", feature: "pro", status: "active", license_fingerprint: "a".repeat(64), valid_from: 1_710_000_000, valid_until: null, license_mode: "floating", pool_size: 5, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: "pol_float" },
  { id: "ent_node", project: "DEFAULT", feature: "solo", status: "active", license_fingerprint: "b".repeat(64), valid_from: null, valid_until: 2_100_000_000, license_mode: "node_locked", pool_size: 0, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: "pol_node" },
];

function jsonBody(request) {
  try {
    return JSON.parse(request.postData() ?? "{}");
  } catch {
    return {};
  }
}

// `abortPath` is the exact pathname of the ONE request this test aborts; every other route resolves
// normally so the rest of the app stays fully usable while that single call fails.
function setup(page, abortPath) {
  let authed = false;
  const handler = (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === abortPath) return route.abort("failed");
    const fulfill = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/portal/v1/auth/providers") return fulfill(200, makeEnvelope("auth_providers", { google: false, github: false, email: true, password: false }));
    if (method === "POST" && path === "/portal/v1/auth/request") return fulfill(200, makeEnvelope("otp_requested"));
    if (method === "POST" && path === "/portal/v1/auth/verify") {
      const body = jsonBody(request);
      if (body.code !== VALID_CODE) return fulfill(401, { ok: false, code: "invalid_otp", request_id: "network-e2e-bad" });
      authed = true;
      return fulfill(200, makeEnvelope("signed_in", { customer_id: "cus_net" }));
    }
    if (method === "POST" && path === "/portal/v1/auth/logout") {
      authed = false;
      return fulfill(200, makeEnvelope("logged_out"));
    }
    if (method === "GET" && path === "/api/portal/me") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "network-e2e-401" });
      return fulfill(200, makeEnvelope("me", { customer_id: "cus_net", email: null }));
    }
    if (method === "GET" && path === "/api/portal/entitlements") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "network-e2e-401" });
      return fulfill(200, makeEnvelope("entitlements", { items: ENTITLEMENTS.map((item) => ({ ...item })) }));
    }
    if (method === "GET" && path === "/api/portal/devices") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "network-e2e-401" });
      return fulfill(200, makeEnvelope("devices", { items: [] }));
    }
    if (method === "GET" && path === "/api/portal/usage") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "network-e2e-401" });
      return fulfill(200, makeEnvelope("usage", { items: [] }));
    }
    if (method === "POST" && path === "/api/portal/checkout") {
      return fulfill(200, makeEnvelope("checkout_ok", { seat_id: "seat-net", expires_at: 0 }));
    }
    if (method === "POST" && path === "/api/portal/release") {
      return fulfill(200, makeEnvelope("release_ok", { seat_id: "seat-net" }));
    }
    if (method === "POST" && path === "/api/portal/download") {
      return route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "content-disposition": "attachment; filename=\"DEFAULT-solo.lic\"" },
        body: "[license]\nsigned-license-bytes-not-a-key\n",
      });
    }
    return fulfill(404, { ok: false, code: "not_found", request_id: "network-e2e-unhandled" });
  };
  page.route("**/portal/v1/auth/**", handler);
  page.route("**/api/portal/**", handler);
}

async function signInThroughCode(page) {
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.getByLabel("8-digit code").fill(VALID_CODE);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
}

test("an aborted request-code call shows the network message, not a stuck sign-in form", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  setup(page, "/portal/v1/auth/request");
  await page.goto("/");
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText(NETWORK_UNAVAILABLE_COPY, { exact: true })).toBeVisible();
  // Never silently promoted to the verify screen on a request it never actually sent.
  await expect(page.getByRole("button", { name: "Send code", exact: true })).toBeVisible();
  await expect(page.getByText("network_unavailable", { exact: false })).not.toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("an aborted verify call shows the network message and stays on the verify screen", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  setup(page, "/portal/v1/auth/verify");
  await page.goto("/");
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.getByLabel("8-digit code").fill(VALID_CODE);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByText(NETWORK_UNAVAILABLE_COPY, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText("network_unavailable", { exact: false })).not.toBeVisible();
  expect(pageErrors).toEqual([]);
});

// Carried from C2: api()'s own network_unavailable now reaches passwordMessage() too (PasswordSignIn,
// PasswordAction, PasswordSettings), which previously had no copy for it and fell through to the
// generic "Unable to complete the request" fallback.
test("an aborted password login shows the network message and leaves the form usable", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.route("**/api/portal/me", (route) => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", (route) => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, email: false, password: true }) }));
  await page.route("**/portal/v1/auth/password/login", (route) => route.abort("failed"));
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("user@example.com");
  await page.getByLabel("Password", { exact: true }).fill("A testing passphrase 1!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(NETWORK_UNAVAILABLE_COPY, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(page.getByText("network_unavailable", { exact: false })).not.toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("an aborted logout call keeps the customer signed in and explains the failure", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  setup(page, "/portal/v1/auth/logout");
  await page.goto("/");
  await signInThroughCode(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText(LOGOUT_FAILED_COPY, { exact: true })).toBeVisible();
  // Still signed in: the dashboard (and its Sign out control) remains, the sign-in form does not
  // reappear, and the failure is never blamed on a code like "unauthorized" that would (wrongly)
  // suggest the session was already gone.
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send code" })).toHaveCount(0);
  await expect(page.getByText("logout_failed", { exact: false })).not.toBeVisible();
  expect(pageErrors).toEqual([]);
});

// D3 fix round 1 (Minor 5): the seat-release POSTs sign-out sends are independent of the sign-out POST
// itself -- a seat can genuinely be released even though the final sign-out request then fails. The
// customer must be told BOTH facts, not just "logout_failed" (which would wrongly imply nothing at all
// happened).
test("an aborted logout call after a successful seat release explains both the release and the failure", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  setup(page, "/portal/v1/auth/logout");
  await page.goto("/");
  await signInThroughCode(page);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByText("Browser seats", { exact: true }).click();
  const seatCard = page.locator(".seatCard").filter({ hasText: "pro" }).first();
  await seatCard.getByRole("button", { name: "Start seat" }).click();
  await expect(seatCard.getByRole("status")).toContainText("Seat started.");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText(`${LOGOUT_FAILED_COPY} Released 1 browser seat.`, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByText("logout_failed", { exact: false })).not.toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("an aborted download call shows the network message with no page error", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  setup(page, "/api/portal/download");
  await page.goto("/");
  await signInThroughCode(page);
  await page.getByRole("link", { name: "View licenses for DEFAULT" }).click();
  await page.locator("tr").filter({ has: page.getByLabel("Device key for DEFAULT solo") }).getByText("Activate and download", { exact: true }).click();
  await page.getByLabel("Device key for DEFAULT solo").fill("device-e2e");
  await page.getByRole("button", { name: "Activate and download .lic" }).click();
  await expect(page.getByText(NETWORK_UNAVAILABLE_COPY, { exact: true })).toBeVisible();
  await expect(page.getByText("network_unavailable", { exact: false })).not.toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("an aborted seat-start call shows the network message and leaves the seat startable again", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  setup(page, "/api/portal/checkout");
  await page.goto("/");
  await signInThroughCode(page);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByText("Browser seats", { exact: true }).click();
  const seatCard = page.locator(".seatCard").filter({ hasText: "pro" }).first();
  await expect(seatCard.getByRole("button", { name: "Start seat" })).toBeEnabled();
  await seatCard.getByRole("button", { name: "Start seat" }).click();
  await expect(page.getByText(NETWORK_UNAVAILABLE_COPY, { exact: true })).toBeVisible();
  await expect(seatCard.getByRole("button", { name: "Start seat" })).toBeEnabled();
  await expect(page.getByText("network_unavailable", { exact: false })).not.toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("an aborted account refresh shows the failure message with exactly one retry button", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  let deviceRequestCount = 0;
  let authed = false;
  const handler = (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const fulfill = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/portal/v1/auth/providers") return fulfill(200, makeEnvelope("auth_providers", { google: false, github: false, email: true, password: false }));
    if (method === "POST" && path === "/portal/v1/auth/request") return fulfill(200, makeEnvelope("otp_requested"));
    if (method === "POST" && path === "/portal/v1/auth/verify") {
      const body = jsonBody(request);
      if (body.code !== VALID_CODE) return fulfill(401, { ok: false, code: "invalid_otp", request_id: "refresh-e2e-bad" });
      authed = true;
      return fulfill(200, makeEnvelope("signed_in", { customer_id: "cus_refresh" }));
    }
    if (method === "GET" && path === "/api/portal/me") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "refresh-e2e-401" });
      return fulfill(200, makeEnvelope("me", { customer_id: "cus_refresh", email: null }));
    }
    if (method === "GET" && path === "/api/portal/entitlements") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "refresh-e2e-401" });
      return fulfill(200, makeEnvelope("entitlements", { items: ENTITLEMENTS.map((item) => ({ ...item })) }));
    }
    if (method === "GET" && path === "/api/portal/devices") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "refresh-e2e-401" });
      deviceRequestCount += 1;
      // First two requests fail; third and onwards succeed.
      if (deviceRequestCount <= 2) {
        return route.abort("failed");
      } else {
        return fulfill(200, makeEnvelope("devices", { items: [] }));
      }
    }
    if (method === "GET" && path === "/api/portal/usage") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "refresh-e2e-401" });
      return fulfill(200, makeEnvelope("usage", { items: [] }));
    }
    return fulfill(404, { ok: false, code: "not_found", request_id: "refresh-e2e-unhandled" });
  };
  page.route("**/portal/v1/auth/**", handler);
  page.route("**/api/portal/**", handler);
  await page.goto("/");
  // Sign in manually without waiting for Apps heading (since initial load will fail).
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.getByLabel("8-digit code").fill(VALID_CODE);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  // Initial load fails; shows error state with Retry button.
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  // Click Retry; this will fail again (deviceRequestCount === 1).
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Account refresh failed")).toBeVisible();
  // Exactly one button should match the retry patterns.
  await expect(page.getByRole("button", { name: /Retry|Refresh account|Refresh status/ })).toHaveCount(1);
  await expect(page.getByText("account_refresh_failed", { exact: false })).not.toBeVisible();
  expect(pageErrors).toEqual([]);
});
