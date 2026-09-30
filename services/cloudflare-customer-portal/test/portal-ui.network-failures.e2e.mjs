import { expect, test } from "@playwright/test";

// Network failures are visible. Each test below aborts exactly ONE request the same way the main
// fixture already does for an account refresh (route.abort("failed"), simulating offline or a DNS
// failure) and checks that the customer sees a plain-language message -- never a stuck screen, a
// raw code, or a silent failure -- with zero pageerror escaping to the page (a rejected fetch that
// nobody catches becomes an unhandled promise rejection, which Playwright reports as one).
const VALID_CODE = "80315426";
const NETWORK_UNAVAILABLE_COPY = "Couldn't reach the portal. Check your connection and try again.";
const LOGOUT_FAILED_COPY = "Sign-out didn't complete. You're still signed in — try again.";

function makeEnvelope(code, data) {
  return { ok: true, code, request_id: "network-e2e", data };
}

const ENTITLEMENTS = [
  { id: "ent_pro", project: "DEFAULT", feature: "pro", status: "active", license_fingerprint: "a".repeat(64), valid_from: 1_710_000_000, valid_until: null, enforcement_mode: "device_bound_v1", license_mode: "trial", max_active_devices: 1, policy_id: "pol_pro", trial_ends_at: null, trial_starts_on_activation: false },
  { id: "ent_node", project: "DEFAULT", feature: "solo", status: "active", license_fingerprint: "b".repeat(64), valid_from: null, valid_until: 2_100_000_000, enforcement_mode: "device_bound_v1", license_mode: "node_locked", max_active_devices: 1, policy_id: "pol_node", trial_ends_at: null, trial_starts_on_activation: false },
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

// api()'s own network_unavailable now reaches passwordMessage() too (PasswordSignIn,
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

test("an aborted account refresh shows the failure message with exactly one retry button", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  let entitlementsRequestCount = 0;
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
      entitlementsRequestCount += 1;
      // First two requests fail; third and onwards succeed.
      if (entitlementsRequestCount <= 2) {
        return route.abort("failed");
      } else {
        return fulfill(200, makeEnvelope("entitlements", { items: ENTITLEMENTS.map((item) => ({ ...item })) }));
      }
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
  // Click Retry: this second entitlements request fails too (entitlementsRequestCount === 2), so the
  // failure copy shows with exactly one retry control.
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Account refresh failed")).toBeVisible();
  // Exactly one button should match the retry patterns.
  await expect(page.getByRole("button", { name: /Retry|Refresh account/ })).toHaveCount(1);
  await expect(page.getByText("account_refresh_failed", { exact: false })).not.toBeVisible();
  expect(pageErrors).toEqual([]);
});
