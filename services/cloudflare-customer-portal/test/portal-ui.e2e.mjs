import { expect, test } from "@playwright/test";

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

// In-memory portal backend. The fixture mints NO real session: a successful verify simply flips an
// `authed` flag (the SPA gates on me() succeeding, exactly as it would behind the HttpOnly cookie).
// Crucially the fixtures NEVER return a bearer/token/private-key/another-customer's id — the leak
// guard asserts the rendered page never surfaces such material.
function makePortalApiFixture() {
  const VALID_CODE = "80315426";
  let authed = false;
  const requests = { authRequests: 0, verifies: 0, checkouts: 0, heartbeats: 0, releases: 0, downloads: 0, logouts: 0 };

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
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "portal-e2e-401" });
      return fulfill(200, makeEnvelope("me", { customer_id: "cus_self" }));
    }
    if (method === "GET" && path === "/api/portal/entitlements") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "portal-e2e-401" });
      return fulfill(200, makeEnvelope("entitlements", { items: entitlements.map((item) => ({ ...item })) }));
    }
    if (method === "GET" && path === "/api/portal/devices") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "portal-e2e-401" });
      return fulfill(200, makeEnvelope("devices", { items: devices.map((item) => ({ ...item })) }));
    }
    if (method === "GET" && path === "/api/portal/usage") {
      if (!authed) return fulfill(401, { ok: false, code: "unauthorized", request_id: "portal-e2e-401" });
      return fulfill(200, makeEnvelope("usage", { items: usage.map((item) => ({ ...item })) }));
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

  return { route, requests, VALID_CODE };
}

test("customer portal signs in with an 8-digit code and walks every screen without leaking secrets", async ({ page }) => {
  const api = makePortalApiFixture();
  await page.route("**/portal/v1/auth/**", api.route);
  await page.route("**/api/portal/**", api.route);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "licensecc customer portal" })).toBeVisible();

  // --- Login: email -> request code ---
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByText(/Check your email/)).toBeVisible();
  await expect.poll(() => api.requests.authRequests).toBe(1);

  // --- Login: enter the 8-digit code -> me() -> dashboard ---
  await page.getByLabel("8-digit code").fill(api.VALID_CODE);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("button", { name: "My entitlements" })).toBeVisible();
  await expect.poll(() => api.requests.verifies).toBe(1);

  // --- My entitlements (read-only) ---
  await expect(page.getByText("pro", { exact: true })).toBeVisible();
  await expect(page.locator(".status.active").first()).toHaveText("active");
  await expect(page.getByText("aaaaaaaa...aaaaaaaa").first()).toBeVisible();

  // --- My devices/seats: floating seat checkout/heartbeat/release ---
  await page.getByRole("button", { name: "My devices" }).click();
  await page.getByRole("button", { name: "Start seat" }).first().click();
  await expect.poll(() => api.requests.checkouts).toBe(1);
  await page.getByRole("button", { name: "Refresh" }).first().click();
  await expect.poll(() => api.requests.heartbeats).toBe(1);
  await page.getByRole("button", { name: "Release" }).first().click();
  await expect.poll(() => api.requests.releases).toBe(1);
  await expect(page.getByText(/release_ok/)).toBeVisible();

  // --- Usage ---
  await page.getByRole("button", { name: "Usage" }).click();
  await expect(page.getByText("Recent usage")).toBeVisible();
  await expect(page.getByText("87", { exact: true })).toBeVisible();

  // --- Download: triggers a browser download of the streamed attachment ---
  await page.getByRole("button", { name: "Download" }).click();
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
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Send code" })).toBeVisible();
  await expect.poll(() => api.requests.logouts).toBe(1);
});
