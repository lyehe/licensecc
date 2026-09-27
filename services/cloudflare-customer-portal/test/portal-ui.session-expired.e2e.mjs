import { expect, test } from "@playwright/test";

// C3: a mid-session 401 (the server's `unauthorized` code, never a credential failure like
// `invalid_otp`) must return the customer to sign-in on every api() path -- a background data read,
// a seat action, or the download's raw fetch -- via one global onUnauthorized hook (api.tsx) that
// App wires to auth.retrySession(). These tests pin the five scenarios from the dispatch: mid-download,
// mid-seat-action, a consent mutation surviving the same kind of 401, a wrong OTP code NOT tripping the
// hook, and exactly one /me retry for a single expired-session event.
const VALID_CODE = "80315426";
const SESSION_ENDED_COPY = "Your session ended. Sign in again.";
const INVALID_OTP_COPY = "That code is wrong or expired — request a new one.";

function makeEnvelope(code, data) {
  return { ok: true, code, request_id: "session-e2e", data };
}
function unauthorizedBody() {
  return { ok: false, code: "unauthorized", request_id: "session-e2e-401" };
}
function jsonBody(request) {
  try {
    return JSON.parse(request.postData() ?? "{}");
  } catch {
    return {};
  }
}

const ENTITLEMENTS = [
  { id: "ent_floating", project: "DEFAULT", feature: "pro", status: "active", license_fingerprint: "a".repeat(64), valid_from: 1_710_000_000, valid_until: null, license_mode: "floating", pool_size: 5, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: "pol_float" },
  { id: "ent_node", project: "DEFAULT", feature: "solo", status: "active", license_fingerprint: "b".repeat(64), valid_from: null, valid_until: 2_100_000_000, license_mode: "node_locked", pool_size: 0, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: "pol_node" },
];

// `failPath` is the exact pathname that flips the session dead (authed=false) and answers 401
// `unauthorized` the moment it is called; every other route behaves normally so the rest of the app
// stays usable right up to that one call.
function setup(page, failPath) {
  let authed = false;
  const meCalls = [];
  const handler = (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const fulfill = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/portal/v1/auth/providers") return fulfill(200, makeEnvelope("auth_providers", { google: false, github: false, email: true, password: false }));
    if (method === "POST" && path === "/portal/v1/auth/request") return fulfill(200, makeEnvelope("otp_requested"));
    if (method === "POST" && path === "/portal/v1/auth/verify") {
      const body = jsonBody(request);
      if (body.code !== VALID_CODE) return fulfill(401, { ok: false, code: "invalid_otp", request_id: "session-e2e-bad" });
      authed = true;
      return fulfill(200, makeEnvelope("signed_in", { customer_id: "cus_session" }));
    }
    if (method === "GET" && path === "/api/portal/me") {
      meCalls.push(authed);
      if (!authed) return fulfill(401, unauthorizedBody());
      return fulfill(200, makeEnvelope("me", { customer_id: "cus_session", email: null }));
    }
    if (method === "GET" && path === "/api/portal/entitlements") {
      if (!authed) return fulfill(401, unauthorizedBody());
      return fulfill(200, makeEnvelope("entitlements", { items: ENTITLEMENTS.map((item) => ({ ...item })) }));
    }
    if (method === "GET" && path === "/api/portal/devices") {
      if (!authed) return fulfill(401, unauthorizedBody());
      return fulfill(200, makeEnvelope("devices", { items: [] }));
    }
    if (method === "GET" && path === "/api/portal/usage") {
      if (!authed) return fulfill(401, unauthorizedBody());
      return fulfill(200, makeEnvelope("usage", { items: [] }));
    }
    if (method === "POST" && path === "/api/portal/checkout") {
      if (failPath === path) { authed = false; return fulfill(401, unauthorizedBody()); }
      return fulfill(200, makeEnvelope("checkout_ok", { seat_id: "seat-session", expires_at: 0 }));
    }
    if (method === "POST" && path === "/api/portal/download") {
      if (failPath === path) { authed = false; return fulfill(401, unauthorizedBody()); }
      return route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { "content-disposition": "attachment; filename=\"DEFAULT-solo.lic\"" },
        body: "[license]\nsigned-license-bytes-not-a-key\n",
      });
    }
    return fulfill(404, { ok: false, code: "not_found", request_id: "session-e2e-unhandled" });
  };
  page.route("**/portal/v1/auth/**", handler);
  page.route("**/api/portal/**", handler);
  return { meCalls };
}

async function signInThroughCode(page) {
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.getByLabel("8-digit code").fill(VALID_CODE);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
}

test("an expired session mid-download returns to sign-in with the session-ended message", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  setup(page, "/api/portal/download");
  await page.goto("/");
  await signInThroughCode(page);
  await page.getByRole("link", { name: "View licenses for DEFAULT" }).click();
  await page.locator("tr").filter({ has: page.getByLabel("Device key for DEFAULT solo") }).getByText("Activate and download", { exact: true }).click();
  await page.getByLabel("Device key for DEFAULT solo").fill("device-e2e");
  await page.getByRole("button", { name: "Activate and download .lic" }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText(SESSION_ENDED_COPY, { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("an expired session after a seat action returns to sign-in with the session-ended message", async ({ page }) => {
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
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText(SESSION_ENDED_COPY, { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("a wrong email code does not trigger the session-ended flow", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  const { meCalls } = setup(page);
  await page.goto("/");
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.getByLabel("8-digit code").fill("00000000");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByText(INVALID_OTP_COPY, { exact: true })).toBeVisible();
  // Still on the verify screen -- never promoted to sign-in, and never shown the session-ended
  // sentence a real mid-session 401 would produce.
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText(SESSION_ENDED_COPY, { exact: false })).toHaveCount(0);
  // Only the one pre-sign-in /me check that fires on every page load -- the hook never started a retry.
  expect(meCalls).toEqual([false]);
  expect(pageErrors).toEqual([]);
});

test("an expired session produces exactly one /me retry request", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  // A session that dies the instant it is confirmed: the one post-verify /me succeeds, and then
  // entitlements/devices/usage all answer 401 `unauthorized` at once (usePortalData fetches all
  // three concurrently), which must collapse into exactly one retrySession() /me call -- not three.
  let authed = false;
  let meServedAuthed = false;
  const meCalls = [];
  const handler = (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const fulfill = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/portal/v1/auth/providers") return fulfill(200, makeEnvelope("auth_providers", { google: false, github: false, email: true, password: false }));
    if (method === "POST" && path === "/portal/v1/auth/request") return fulfill(200, makeEnvelope("otp_requested"));
    if (method === "POST" && path === "/portal/v1/auth/verify") {
      const body = jsonBody(request);
      if (body.code !== VALID_CODE) return fulfill(401, { ok: false, code: "invalid_otp", request_id: "session-e2e-bad" });
      authed = true;
      return fulfill(200, makeEnvelope("signed_in", { customer_id: "cus_retry" }));
    }
    if (method === "GET" && path === "/api/portal/me") {
      const servesAuthed = authed && !meServedAuthed;
      meCalls.push(servesAuthed);
      if (servesAuthed) {
        meServedAuthed = true;
        authed = false; // the session dies right after this one confirmed-good check
        return fulfill(200, makeEnvelope("me", { customer_id: "cus_retry", email: null }));
      }
      return fulfill(401, unauthorizedBody());
    }
    if (method === "GET" && (path === "/api/portal/entitlements" || path === "/api/portal/devices" || path === "/api/portal/usage")) {
      return fulfill(401, unauthorizedBody());
    }
    return fulfill(404, { ok: false, code: "not_found", request_id: "session-e2e-unhandled" });
  };
  page.route("**/portal/v1/auth/**", handler);
  page.route("**/api/portal/**", handler);

  await page.goto("/");
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("8-digit code").fill(VALID_CODE);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText(SESSION_ENDED_COPY, { exact: true })).toBeVisible();
  // [false, true, false]: the initial pre-sign-in check, the one post-verify success, and exactly one
  // retry -- never two or three, even though three reads 401'd at once.
  expect(meCalls).toEqual([false, true, false]);
  expect(pageErrors).toEqual([]);
});

// ---- Consent: the existing raw-fetch 401 handling (consentApi.ts, unchanged by C3) must keep working
// side by side with the new global hook, which never touches it. ------------------------------------

const consentHandle = "F".repeat(42) + "A";
const consentEntry = `/connect#attempt_handle=${consentHandle}`;
const consentCallback = `http://127.0.0.1:44899/callback?code=${"I".repeat(42)}A&state=${"M".repeat(42)}A`;
const consentEnvelope = (code, data) => ({ ok: true, code, data, request_id: "session-e2e-consent" });
const consentInspection = (overrides = {}) => ({
  app: { name: "Colmap", project: "COLMAP" }, device: { label: "My workstation" },
  status: "pending", revision: 0, expires_at: Math.floor(Date.now() / 1000) + 300,
  entitlements: [
    { id: "license-pro", feature: "PRO", valid_until: null, device_limit: 2, devices_in_use: 0, slot_free_at: null, device_connected: false },
  ], has_more: false, next_page_cursor: null, comparison_code: "0000-1111-2222", ...overrides,
});

function setupConsent(page) {
  // Starts already signed in: App only mounts ConsentFeature once auth.phase is "authed", so a
  // consent test needs a session in place before the attempt is even inspected. It flips to false
  // inside the first /approve call below, simulating the session dying mid-mutation.
  let signedIn = true;
  const customer = "customer-session";
  let approveAttempts = 0;
  page.route("**/portal/v1/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/providers")) return route.fulfill({ json: consentEnvelope("auth_providers", { password: true, github: false, google: false, email: false }) });
    if (path.endsWith("/password/login")) { signedIn = true; return route.fulfill({ json: consentEnvelope("signed_in", { customer_id: customer }) }); }
    throw new Error(`Unexpected consent auth route: ${path}`);
  });
  page.route("**/api/portal/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!signedIn) return route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } });
    if (path.endsWith("/me")) return route.fulfill({ json: consentEnvelope("ok", { customer_id: customer, email: null }) });
    if (path.endsWith("/inspect")) return route.fulfill({ json: consentEnvelope("authorization_inspected", consentInspection(approveAttempts > 0 ? { status: "approved", revision: 1, entitlements: [] } : {})) });
    if (path.endsWith("/approve")) {
      approveAttempts += 1;
      if (approveAttempts === 1) { signedIn = false; return route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }); }
      return route.fulfill({ json: consentEnvelope("authorization_approved", { callback_url: consentCallback, expires_at: Math.floor(Date.now() / 1000) + 60, revision: 1 }) });
    }
    return route.fulfill({ json: consentEnvelope("ok", { items: [] }) });
  });
}

test("consent: a page with a saved mutation survives a 401, then resumes after sign-in", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  setupConsent(page);
  await page.route("http://127.0.0.1:44899/**", (route) => route.fulfill({ status: 204 }));
  await page.goto(consentEntry);
  await page.getByRole("checkbox", { name: "This code matches my app", exact: true }).check();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText("Sign in to approve this device connection.", { exact: true })).toBeVisible();
  // consentApi.ts's own 401 handling (unchanged by C3) drives this screen directly -- the new global
  // hook is never in this call path, so it never shows its own session-ended sentence here.
  await expect(page.getByText(SESSION_ENDED_COPY, { exact: false })).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill("customer@example.com");
  await page.getByLabel("Password", { exact: true }).fill("A test passphrase for session e2e!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Retry approval" }).click();
  await expect(page.getByRole("link", { name: "Open app" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

// ---- Fix round 1 (CRITICAL): the hook's confirmed-session-gone branch must clear all portal-local
// customer data, the same way logout() already does, or a DIFFERENT customer signing in next in the
// same tab can see the previous customer's licenses, devices and usage -- usePortalData skips its own
// loading state when readState is already "ready", so stale data stays visible until (or unless) the
// new fetch happens to overwrite it. --------------------------------------------------------------

const SWITCH_CODE_A = "80315426";
const SWITCH_CODE_B = "19283746";
const SWITCH_ENTITLEMENT_A = { id: "ent_switch_a", project: "ALPHACORP", feature: "widget", status: "active", license_fingerprint: "a".repeat(64), valid_from: null, valid_until: null, license_mode: "floating", pool_size: 5, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: "pol_switch_a" };
const SWITCH_ENTITLEMENT_B = { id: "ent_switch_b", project: "BETAWORKS", feature: "gadget", status: "active", license_fingerprint: "b".repeat(64), valid_from: null, valid_until: null, license_mode: "floating", pool_size: 5, max_active_devices: 1, max_borrow_sec: 0, heartbeat_grace_sec: 900, policy_id: "pol_switch_b" };
const SWITCH_DEVICE_A = { project: "ALPHACORP", feature: "widget", license_fingerprint: "a".repeat(64), device_key_id: "device-alpha-001", created_at: 1_700_000_000 };
const SWITCH_DEVICE_B = { project: "BETAWORKS", feature: "gadget", license_fingerprint: "b".repeat(64), device_key_id: "device-beta-002", created_at: 1_700_000_001 };

test("a customer switch after a session-ending 401 never shows the previous customer's data", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  let customer = null; // "A" | "B" | null
  let authed = false;
  let releaseB;
  const bDataGate = new Promise((resolve) => { releaseB = resolve; });
  const fulfill = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  page.route("**/portal/v1/auth/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/portal/v1/auth/providers") return fulfill(route, 200, makeEnvelope("auth_providers", { google: false, github: false, email: true, password: false }));
    if (method === "POST" && path === "/portal/v1/auth/request") return fulfill(route, 200, makeEnvelope("otp_requested"));
    if (method === "POST" && path === "/portal/v1/auth/verify") {
      const body = jsonBody(request);
      if (body.code === SWITCH_CODE_A) { customer = "A"; authed = true; return fulfill(route, 200, makeEnvelope("signed_in", { customer_id: "cus_switch_a" })); }
      if (body.code === SWITCH_CODE_B) { customer = "B"; authed = true; return fulfill(route, 200, makeEnvelope("signed_in", { customer_id: "cus_switch_b" })); }
      return fulfill(route, 401, { ok: false, code: "invalid_otp", request_id: "switch-e2e-bad" });
    }
    return fulfill(route, 404, { ok: false, code: "not_found", request_id: "switch-e2e-unhandled" });
  });

  page.route("**/api/portal/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (!authed) return fulfill(route, 401, unauthorizedBody());
    if (method === "GET" && path === "/api/portal/me") return fulfill(route, 200, makeEnvelope("me", { customer_id: customer === "A" ? "cus_switch_a" : "cus_switch_b", email: null }));
    if (method === "GET" && path === "/api/portal/entitlements") {
      if (customer === "B") await bDataGate;
      return fulfill(route, 200, makeEnvelope("entitlements", { items: [customer === "A" ? SWITCH_ENTITLEMENT_A : SWITCH_ENTITLEMENT_B] }));
    }
    if (method === "GET" && path === "/api/portal/devices") {
      if (customer === "B") await bDataGate;
      return fulfill(route, 200, makeEnvelope("devices", { items: [customer === "A" ? SWITCH_DEVICE_A : SWITCH_DEVICE_B] }));
    }
    if (method === "GET" && path === "/api/portal/usage") {
      if (customer === "B") await bDataGate;
      return fulfill(route, 200, makeEnvelope("usage", { items: [] }));
    }
    if (method === "POST" && path === "/api/portal/checkout") return fulfill(route, 200, makeEnvelope("checkout_ok", { seat_id: "seat-switch-a", expires_at: 0 }));
    if (method === "POST" && path === "/api/portal/heartbeat") { authed = false; return fulfill(route, 401, unauthorizedBody()); }
    return fulfill(route, 404, { ok: false, code: "not_found", request_id: "switch-e2e-unhandled" });
  });

  await page.goto("/");
  await page.getByLabel("Email").fill("alice@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("8-digit code").fill(SWITCH_CODE_A);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await expect(page.getByText("ALPHACORP", { exact: false })).toBeVisible();

  // Customer A starts a floating seat (so deviceController's in-memory + localStorage-backed seat
  // cache is populated), then renews it -- the renewal 401s and ends the session.
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.getByText("device-alpha-001", { exact: true })).toBeVisible();
  await page.getByText("Browser seats", { exact: true }).click();
  const seatCardA = page.locator(".seatCard").filter({ hasText: "widget" }).first();
  await seatCardA.getByRole("button", { name: "Start seat" }).click();
  await expect(seatCardA.getByRole("button", { name: "Renew seat" })).toBeEnabled();
  await seatCardA.getByRole("button", { name: "Renew seat" }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText(SESSION_ENDED_COPY, { exact: true })).toBeVisible();

  // Reset the location hash (still "#/nodes" from before A's session died) so the next sign-in lands
  // on a clean Apps view with no leftover per-project filter -- not itself under test here.
  await page.evaluate(() => { window.location.hash = "#/apps"; });

  await page.getByLabel("Email").fill("bob@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("8-digit code").fill(SWITCH_CODE_B);
  await page.getByRole("button", { name: "Verify", exact: true }).click();

  // B's own data is deliberately held back -- A's data must already be gone before B's data loads.
  await expect(page.getByText("Loading your account", { exact: false })).toBeVisible();
  await expect(page.getByText("ALPHACORP", { exact: false })).toHaveCount(0);
  expect(await page.locator("body").innerHTML()).not.toContain("device-alpha-001");

  // Release B's data: it shows correctly, and A's data is still nowhere to be found.
  releaseB();
  await expect(page.getByText("BETAWORKS", { exact: false })).toBeVisible();
  await expect(page.getByText("ALPHACORP", { exact: false })).toHaveCount(0);
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.getByText("device-beta-002", { exact: true })).toBeVisible();
  await expect(page.getByText("device-alpha-001", { exact: false })).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
