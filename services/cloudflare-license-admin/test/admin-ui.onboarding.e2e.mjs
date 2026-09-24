import { expect, test } from "@playwright/test";

import { makeAdminApiFixture, makeEnvelope } from "./admin-ui.fixture.mjs";

// B1: an operator brings a protected application's customer online without SQL -- Add user,
// create that customer's license for the app's project, then grant protected access. This is the
// console path the backend's protected-admin-enrollment e2e drives through the same admin routes.

function relationship(form, name) {
  return form.getByRole("region", { name: `${name} relationship`, exact: true }).getByRole("combobox");
}

test("an operator onboards a protected application from Add user to a protected grant", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  const writes = { customers: [], licenses: [], entitlements: [] };
  await page.route("**/api/admin/customers", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const input = route.request().postDataJSON();
    writes.customers.push(input);
    const row = api.seed.customer({ id: "cust_onboarded", name: input.name, email: "", login_email: input.email, status: "active" });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(makeEnvelope("customer_created", row)) });
  });
  await page.route("**/api/admin/customers/*/licenses", async route => {
    const request = route.request(), body = request.postDataJSON();
    writes.licenses.push({ path: new URL(request.url()).pathname, key: request.headers()["idempotency-key"], body });
    const license = { id: "lic_onboarded", customer_id: "cust_onboarded", project: body.project, label: "", created_at: 1_760_000_100 };
    api.behavior.licenseRows.push({ ...license, updated_at: license.created_at });
    return route.fulfill({ contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(makeEnvelope("license_created", license)) });
  });
  await page.route("**/api/admin/entitlements", async route => {
    if (route.request().method() === "POST") writes.entitlements.push(route.request().postDataJSON());
    return route.fallback();
  });

  await page.goto("/#/customers");
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  const addUser = page.getByRole("form", { name: "Add portal user" });
  await addUser.getByLabel("Name", { exact: true }).fill("Onboarded customer");
  await addUser.getByLabel("Login email", { exact: true }).fill("onboarded@example.test");
  await addUser.getByRole("button", { name: "Add user", exact: true }).click();
  await expect(page.getByRole("heading", { name: "User added", exact: true })).toBeVisible();

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "License access", exact: true }).click();
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const form = page.getByRole("form", { name: "New entitlement", exact: true });
  await form.getByLabel("Protection", { exact: true }).selectOption("device_bound_v1");
  await form.getByLabel("Project", { exact: true }).fill("APP");
  await form.getByLabel("Feature", { exact: true }).fill("PRO");
  await form.getByRole("button", { name: "Generate fingerprint", exact: true }).click();
  await expect(form.getByLabel("License fingerprint", { exact: true })).toHaveValue(/^[0-9a-f]{64}$/);
  await relationship(form, "Customer").selectOption("cust_onboarded");
  const createLicense = form.getByRole("button", { name: "Create license for APP", exact: true });
  await createLicense.click();
  await expect(relationship(form, "License")).toHaveValue("lic_onboarded");
  await expect(relationship(form, "License")).toBeFocused();
  await expect(createLicense).toHaveCount(0);
  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  expect(writes.customers).toEqual([{ name: "Onboarded customer", email: "onboarded@example.test" }]);
  expect(writes.licenses).toHaveLength(1);
  expect(writes.licenses[0]).toMatchObject({ path: "/api/admin/customers/cust_onboarded/licenses", body: { project: "APP" } });
  expect(writes.licenses[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(writes.entitlements).toHaveLength(1);
  expect(writes.entitlements[0]).toMatchObject({ enforcement_mode: "device_bound_v1", project: "APP", feature: "PRO", customer_id: "cust_onboarded", license_id: "lic_onboarded" });
  expect(writes.entitlements[0].license_fingerprint).toMatch(/^[0-9a-f]{64}$/);
});

test("a refused protected grant names the broken rule in words, never as a code", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  const answers = [["req-1", "customer_inactive"], ["req-2", "rule_this_console_predates"]];
  await page.route("**/api/admin/entitlements", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const [requestId, reason] = answers.shift();
    return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, code: "protected_creation_conflict", request_id: requestId, data: { reason } }) });
  });
  await page.goto("/#/entitlements");
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const form = page.getByRole("form", { name: "New entitlement", exact: true });
  await form.getByLabel("Protection", { exact: true }).selectOption("device_bound_v1");
  await form.getByRole("button", { name: "Generate fingerprint", exact: true }).click();
  await form.getByText("Enter customer ID manually", { exact: true }).click();
  await form.getByLabel("Customer ID", { exact: true }).fill("cus_acme");
  await form.getByText("Enter license ID manually", { exact: true }).click();
  await form.getByLabel("License ID", { exact: true }).fill("lic_acme");

  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("The customer is suspended or no longer exists; reenable the customer or choose an active one. Reference req-1.");
  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await expect(alert).toHaveText("This protected license (entitlement) can't be created with these settings. Reference req-2.");
  await expect(page.getByText(/protected_creation_conflict|customer_inactive|rule_this_console_predates/)).toHaveCount(0);
  await expect(form.getByLabel("Protection", { exact: true })).toHaveValue("device_bound_v1");
});
