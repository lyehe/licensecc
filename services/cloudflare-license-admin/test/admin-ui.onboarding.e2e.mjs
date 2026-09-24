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

async function openProtectedCreate(page, project = "APP") {
  await page.goto("/#/entitlements");
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const form = page.getByRole("form", { name: "New entitlement", exact: true });
  await form.getByLabel("Protection", { exact: true }).selectOption("device_bound_v1");
  await form.getByLabel("Project", { exact: true }).fill(project);
  await relationship(form, "Customer").selectOption("cus_acme");
  return form;
}

const licenseRow = (id, project, label = null) => ({ id, customer_id: "cus_acme", project, label, created_at: 1_760_000_000, updated_at: 1_760_000_000 });

test("the protected license picker hides other projects' licenses and offers creation only while none is listed", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.licenseRows = [licenseRow("lic_other_app", "OTHER", "Other app")];
  await page.route("**/api/admin/**", api.route);
  const form = await openProtectedCreate(page);
  const offer = form.getByRole("button", { name: "Create license for APP", exact: true });
  await expect(offer).toBeVisible();
  await expect(relationship(form, "License").locator("option")).toHaveText(["No license"]);
  // A search that matches nothing says nothing about the customer's licenses, so it offers none.
  const lookup = form.getByRole("region", { name: "License relationship", exact: true });
  await lookup.getByLabel("Search licenses", { exact: true }).fill("seat pack");
  await lookup.getByRole("button", { name: "Find licenses", exact: true }).click();
  await expect(lookup.getByText("No licenses match. Try another search or enter the full ID below.", { exact: true })).toBeVisible();
  await expect(offer).toHaveCount(0);
  await lookup.getByLabel("Search licenses", { exact: true }).fill("");
  await lookup.getByRole("button", { name: "Find licenses", exact: true }).click();
  await expect(offer).toBeVisible();
  // A legacy grant is neither narrowed to its project nor offered a new license.
  await form.getByLabel("Protection", { exact: true }).selectOption("legacy");
  await expect(relationship(form, "License").locator("option")).toHaveText(["No license", "Other app · lic_other_app"]);
  await expect(form.getByRole("button", { name: /^Create license for/ })).toHaveCount(0);
});

test("the protected license picker offers no creation when this project already has a license", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.licenseRows = [licenseRow("lic_app", "APP"), licenseRow("lic_other_app", "OTHER", "Other app")];
  await page.route("**/api/admin/**", api.route);
  const form = await openProtectedCreate(page);
  await expect(relationship(form, "License").locator("option")).toHaveText(["No license", "APP · lic_app"]);
  await expect(form.getByRole("button", { name: /^Create license for/ })).toHaveCount(0);
});

test("the protected license picker offers no creation when its license read fails", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.route(/\/api\/admin\/licenses(?:\?|$)/, route => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, code: "unavailable", request_id: "licenses-down" }),
  }));
  const form = await openProtectedCreate(page);
  const lookup = form.getByRole("region", { name: "License relationship", exact: true });
  await expect(lookup.getByRole("alert")).toContainText("Could not load license options.");
  await expect(form.getByRole("button", { name: /^Create license for/ })).toHaveCount(0);
});

// B2: the device limit is visible and settable, policies say what they grant, and the customer
// field reads one bounded page per pause in typing.
async function newEntitlement(page) {
  await page.goto("/#/entitlements");
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  return page.getByRole("form", { name: "New entitlement", exact: true });
}

test("a create without a policy sends its device limit, and a chosen policy shows and owns its own", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.policy("pol_pro", "Pro", { project: "APP", type: "node_locked", max_active_devices: 3 });
  api.seed.policy("pol_other", "Other app", { project: "OTHER", type: "node_locked", max_active_devices: 9 });
  api.seed.policy("pol_team", "Team", { project: "APP", type: "floating", pool_size: 5, max_active_devices: 1 });
  await page.route("**/api/admin/**", api.route);
  const writes = [];
  await page.route("**/api/admin/entitlements", async route => {
    if (route.request().method() === "POST") writes.push(route.request().postDataJSON());
    return route.fallback();
  });
  const form = await newEntitlement(page);
  await form.getByLabel("Project", { exact: true }).fill("APP");
  await form.getByLabel("Feature", { exact: true }).fill("PRO");
  await form.getByLabel("License fingerprint", { exact: true }).fill("a".repeat(64));
  const policy = form.getByLabel("Policy (optional)", { exact: true });
  // Only this project's policies are offered, each with what it grants.
  await expect(policy.locator("option")).toHaveText(["No policy · use fields below", "Pro · 3 devices · APP", "Team · 5 seats · APP"]);
  // Blank sends nothing (ruling R26): a new grant gets 1, and an existing one keeps its limit.
  const own = form.getByLabel("Device limit", { exact: true });
  await expect(own).toHaveValue("");
  await expect(own).toHaveAttribute("placeholder", "1");
  await expect(form.getByText("Blank: a new license (entitlement) gets 1; an existing one keeps its limit.", { exact: true })).toBeVisible();
  await own.fill("4");
  // A floating policy grants seats, and says so in the read-only field too.
  await policy.selectOption("pol_team");
  await expect(form.getByLabel("Seats (from policy Team)", { exact: true })).toHaveValue("5");
  await policy.selectOption("pol_pro");
  await expect(policy.locator("option:checked")).toHaveText("Pro · 3 devices · APP");
  const inherited = form.getByLabel("Device limit (from policy Pro)", { exact: true });
  await expect(inherited).toHaveValue("3");
  await expect(inherited).toHaveAttribute("readonly", "");
  await expect(own).toHaveCount(0);
  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ policy_id: "pol_pro", project: "APP", feature: "PRO" });
  expect(Object.hasOwn(writes[0], "max_active_devices")).toBe(false);

  await form.getByLabel("Project", { exact: true }).fill("APP");
  await form.getByLabel("Feature", { exact: true }).fill("PLUS");
  await form.getByLabel("License fingerprint", { exact: true }).fill("b".repeat(64));
  await form.getByLabel("Device limit", { exact: true }).fill("0");
  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await expect(form.getByText("Enter a whole number of devices from 1 to 1,000,000.", { exact: true })).toBeVisible();
  await expect(form.getByLabel("Device limit", { exact: true })).toBeFocused();
  await form.getByLabel("Device limit", { exact: true }).fill("4");
  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({ project: "APP", feature: "PLUS", max_active_devices: 4 });
  expect(Object.hasOwn(writes[1], "policy_id")).toBe(false);

  // An untouched field sends no limit at all.
  await expect(form.getByLabel("Device limit", { exact: true })).toHaveValue("");
  await form.getByLabel("Project", { exact: true }).fill("APP");
  await form.getByLabel("Feature", { exact: true }).fill("BASIC");
  await form.getByLabel("License fingerprint", { exact: true }).fill("c".repeat(64));
  await form.getByRole("button", { name: "Create entitlement", exact: true }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[2]).toMatchObject({ project: "APP", feature: "BASIC" });
  expect(Object.hasOwn(writes[2], "max_active_devices")).toBe(false);
});

test("the customer field reads one bounded page on open and one more per pause in typing", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.customers(40);
  await page.route("**/api/admin/**", api.route);
  await page.goto("/#/entitlements");
  await expect(page.getByRole("button", { name: "New entitlement", exact: true })).toBeEnabled();
  const before = api.requests.customerReads.length;
  await page.getByRole("button", { name: "New entitlement", exact: true }).click();
  const form = page.getByRole("form", { name: "New entitlement", exact: true });
  const lookup = form.getByRole("region", { name: "Customer relationship", exact: true });
  await expect(relationship(form, "Customer").locator("option")).toHaveCount(21);
  expect(api.requests.customerReads.slice(before)).toEqual(["?limit=20"]);
  await expect(lookup.getByText("Showing the first 20 customers. Type more of a name, email, or ID to narrow the list.", { exact: true })).toBeVisible();

  const search = lookup.getByLabel("Search customers", { exact: true });
  await search.pressSequentially("acme", { delay: 40 });
  await expect.poll(() => api.requests.customerReads.length).toBe(before + 2);
  expect(api.requests.customerReads.at(-1)).toBe("?q=acme&limit=20");
  await expect(relationship(form, "Customer").locator("option")).toHaveText(["No customer", "Acme Corp · cus_acme"]);
  await expect(lookup.getByText(/^Showing the first 20/)).toHaveCount(0);
  // Enter never submits the entitlement form from the search field, and a pause sends nothing new.
  await search.press("Enter");
  await page.waitForTimeout(700);
  expect(api.requests.customerReads.length).toBe(before + 2);
  expect(api.requests.creates).toBe(0);
  await relationship(form, "Customer").selectOption("cus_acme");
  await expect(relationship(form, "Customer")).toHaveValue("cus_acme");
  await search.fill("no such customer");
  await expect(lookup.getByText("No customers match. Try another search or enter the full ID below.", { exact: true })).toBeVisible();
  await expect(relationship(form, "Customer")).toHaveValue("cus_acme");
});

test("Create policy… opens the policy form for the draft's project and returns to the intact draft", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  const dialogs = [];
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  const form = await newEntitlement(page);
  await form.getByLabel("Protection", { exact: true }).selectOption("device_bound_v1");
  await form.getByLabel("Project", { exact: true }).fill("APP");
  await form.getByLabel("Feature", { exact: true }).fill("PRO");
  await form.getByLabel("Notes", { exact: true }).fill("kept across the policy detour");

  await form.getByRole("link", { name: "Create policy…", exact: true }).click();
  const policyForm = page.getByRole("form", { name: "New policy", exact: true });
  await expect(policyForm.getByLabel("Project", { exact: true })).toHaveValue("APP");
  await expect(page.getByText("This policy is for your entitlement draft for APP. Creating it returns you to the draft with the policy chosen.", { exact: true })).toBeVisible();
  // Going back without creating keeps the draft and chooses nothing.
  await page.getByRole("button", { name: "Back to entitlement draft", exact: true }).click();
  await expect(form.getByLabel("Notes", { exact: true })).toHaveValue("kept across the policy detour");
  await expect(form.getByLabel("Policy (optional)", { exact: true })).toHaveValue("");

  await form.getByRole("link", { name: "Create policy…", exact: true }).click();
  await policyForm.getByLabel("Name (required)", { exact: true }).fill("Pro");
  await policyForm.getByLabel("Type", { exact: true }).selectOption("node_locked");
  await policyForm.getByLabel("Device limit", { exact: true }).fill("3");
  await policyForm.getByRole("button", { name: "Create policy", exact: true }).click();

  const policy = form.getByLabel("Policy (optional)", { exact: true });
  await expect(policy).toHaveValue("pol_1");
  await expect(policy.locator("option:checked")).toHaveText("Pro · 3 devices · APP");
  await expect(form.getByLabel("Device limit (from policy Pro)", { exact: true })).toHaveValue("3");
  await expect(form.getByLabel("Protection", { exact: true })).toHaveValue("device_bound_v1");
  await expect(form.getByLabel("Feature", { exact: true })).toHaveValue("PRO");
  await expect(form.getByLabel("Notes", { exact: true })).toHaveValue("kept across the policy detour");
  expect(api.requests.policyCreates).toEqual([expect.objectContaining({ project: "APP", name: "Pro", type: "node_locked", max_active_devices: 3 })]);
  expect(dialogs).toEqual([]);
  // Leaving the draft for anything else still asks before discarding it.
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Customers", exact: true }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  await expect(form.getByLabel("Notes", { exact: true })).toHaveValue("kept across the policy detour");
});
