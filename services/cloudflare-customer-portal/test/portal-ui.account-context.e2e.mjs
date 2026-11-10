import { expect, test } from "@playwright/test";

const envelope = (code, data) => ({ ok: true, code, data, request_id: "account-context-e2e" });

async function accountFixture(page, { switchDuringInventory = false } = {}) {
  const state = { customer: "A", unlink: [], passwords: [], linked: { A: true, B: true }, me: 0 };
  await page.route("**/api/portal/**", route => {
    if (new URL(route.request().url()).pathname === "/api/portal/me") {
      state.me++;
      return route.fulfill({ json: envelope("me", { customer_id: state.customer, email: `${state.customer.toLowerCase()}@example.test` }) });
    }
    return route.fulfill({ json: envelope("entitlements", { items: [] }) });
  });
  await page.route("**/portal/v1/auth/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith("/providers")) return route.fulfill({ json: envelope("auth_providers", { google: true, github: true, password: true, email: false }) });
    const expected = request.headers()["x-expected-customer-id"];
    if (path.endsWith("/identities") && switchDuringInventory) { state.customer = "B"; switchDuringInventory = false; }
    if (request.method() === "POST" && path.endsWith("/unlink")) state.unlink.push({ expected, body: request.postDataJSON() });
    if (request.method() === "POST" && path.endsWith("/password")) state.passwords.push({ expected });
    if (expected !== encodeURIComponent(state.customer)) return route.fulfill({ status: 409, json: { ok: false, code: "account_changed", request_id: "switched" } });
    if (path.endsWith("/identities")) return route.fulfill({ json: envelope("identities", { items: state.linked[state.customer] ? [{ provider: "google", email: `${state.customer.toLowerCase()}@example.test` }] : [] }) });
    if (path.endsWith("/unlink")) { state.linked[state.customer] = false; return route.fulfill({ json: envelope("identity_unlinked", { provider: "google" }) }); }
    if (path.endsWith("/password") && request.method() === "GET") return route.fulfill({ json: envelope("password_settings", { email: `${state.customer.toLowerCase()}@example.test`, has_password: true, can_reset: false, email_verified: true, recovery_available: true }) });
    return route.fulfill({ json: envelope("signed_in", { customer_id: state.customer }) });
  });
  await page.goto("/#/account");
  return state;
}

test("an account inventory mismatch rechecks the session before showing the other customer's methods", async ({ page }) => {
  const state = await accountFixture(page, { switchDuringInventory: true });
  await expect(page.getByText("Signed in as b@example.test", { exact: true })).toBeVisible();
  await expect(page.getByText("Google · b@example.test", { exact: true })).toBeVisible();
  await expect(page.getByText("Google · a@example.test", { exact: true })).toHaveCount(0);
  expect(state.me).toBe(2); expect(state.unlink).toEqual([]);
});

for (const width of [1440, 390]) for (const action of ["unlink", "password"]) test(`account ${action} refuses a switched cookie and requires a new action at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  const state = await accountFixture(page);
  await expect(page.getByText("Google · a@example.test", { exact: true })).toBeVisible();
  if (action === "unlink") {
    await page.getByRole("button", { name: "Disconnect Google", exact: true }).click();
    await expect(page.getByRole("group", { name: /^Disconnect Google\?/ })).toBeVisible();
    state.customer = "B";
    await page.getByRole("button", { name: "Disconnect Google", exact: true }).click();
  } else {
    await page.locator(".passwordEditor summary").click();
    await page.getByLabel("Current password", { exact: true }).fill("Current testing password 123!");
    await page.getByLabel("New password", { exact: true }).fill("Replacement testing password 123!");
    state.customer = "B";
    await page.getByRole("button", { name: "Change password", exact: true }).click();
  }
  await expect(page.getByText("Signed in as b@example.test", { exact: true })).toBeVisible();
  await expect(page.getByText(/The signed-in account changed in another tab/)).toBeVisible();
  await expect(page.getByText("Google · b@example.test", { exact: true })).toBeVisible();
  expect(state.linked).toEqual({ A: true, B: true });
  expect(action === "unlink" ? state.unlink : state.passwords).toHaveLength(1);
  expect((action === "unlink" ? state.unlink : state.passwords)[0].expected).toBe("A");
  await expect(page.getByRole("group", { name: /^Disconnect Google\?/ })).toHaveCount(0);
  await expect(page.getByLabel("New password", { exact: true })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`account-${action}-switched-${width}.png`), fullPage: true });
  if (action === "unlink") {
    await page.getByRole("button", { name: "Disconnect Google", exact: true }).click();
    await page.getByRole("button", { name: "Disconnect Google", exact: true }).click();
    await expect(page.getByText("Google disconnected.", { exact: true })).toBeVisible();
    expect(state.linked).toEqual({ A: true, B: false });
    expect(state.unlink.map(item => item.expected)).toEqual(["A", "B"]);
  } else {
    await page.locator(".passwordEditor summary").click();
    await expect(page.getByLabel("Current password", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("New password", { exact: true })).toHaveValue("");
    await page.getByLabel("Current password", { exact: true }).fill("Current testing password 123!");
    await page.getByLabel("New password", { exact: true }).fill("A new customer B password 123!");
    await page.getByRole("button", { name: "Change password", exact: true }).click();
    await expect(page.getByText("Password saved. Other browser sessions have been signed out.", { exact: true })).toBeVisible();
    expect(state.passwords.map(item => item.expected)).toEqual(["A", "B"]);
  }
});

test("native provider linking submits the displayed customer privately and reloads context after refusal", async ({ page }) => {
  const state = await accountFixture(page);
  await expect(page.getByText("Google · a@example.test", { exact: true })).toBeVisible();
  const requests = [];
  await page.route("**/portal/v1/auth/github/start?mode=link", route => {
    requests.push(new URLSearchParams(route.request().postData()).get("expected_customer_id"));
    return route.fulfill({ status: 303, headers: { location: "/?auth_error=account_changed#/account" } });
  });
  state.customer = "B";
  await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
  await expect(page.getByText("Signed in as b@example.test", { exact: true })).toBeVisible();
  await expect(page.getByText(/Review this account before connecting a provider again/)).toBeVisible();
  expect(requests).toEqual(["A"]);
  expect(page.url()).not.toContain("expected_customer_id");
});
