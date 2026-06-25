import { expect, test } from "@playwright/test";

function makeEnvelope(code, data) {
  makeEnvelope.nextRequestId += 1;
  return {
    ok: true,
    code,
    request_id: `ui-e2e-${makeEnvelope.nextRequestId}`,
    data,
  };
}
makeEnvelope.nextRequestId = 0;

function makeAdminApiFixture() {
  let nextEntitlementId = 1;
  let nextEventId = 1;
  let now = 1_760_000_000;
  const entitlements = [];
  const events = [];
  const requests = {
    creates: 0,
    patches: [],
    transitions: [],
  };

  function publicRecord(row) {
    return { ...row };
  }

  function addEvent(eventType, row, reason = "") {
    events.unshift({
      id: nextEventId,
      event_type: eventType,
      project: row.project,
      feature: row.feature,
      license_fingerprint: row.license_fingerprint,
      source: "admin",
      actor: "admin@example.com",
      actor_type: "access",
      revocation_seq: row.revocation_seq,
      created_at: now,
      reason,
    });
    nextEventId += 1;
  }

  function summary() {
    return {
      entitlements: {
        total: entitlements.length,
        active: entitlements.filter((item) => item.status === "active").length,
        disabled: entitlements.filter((item) => item.status === "disabled").length,
        revoked: entitlements.filter((item) => item.status === "revoked").length,
      },
    };
  }

  function findById(id) {
    return entitlements.find((item) => item.id === id);
  }

  async function jsonBody(request) {
    const text = request.postData() ?? "{}";
    return JSON.parse(text);
  }

  async function route(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const fulfill = (status, body) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

    if (method === "GET" && path === "/api/admin/summary") {
      return fulfill(200, makeEnvelope("summary", summary()));
    }
    if (method === "GET" && path === "/api/admin/events") {
      return fulfill(200, makeEnvelope("events", { items: events.map((item) => ({ ...item })) }));
    }
    if (method === "GET" && path === "/api/admin/entitlements") {
      return fulfill(200, makeEnvelope("entitlements", { items: entitlements.map(publicRecord) }));
    }
    if (method === "POST" && path === "/api/admin/entitlements") {
      requests.creates += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const body = await jsonBody(request);
      now += 1;
      const row = {
        id: `ent-${nextEntitlementId}`,
        project: body.project,
        feature: body.feature,
        license_fingerprint: body.license_fingerprint,
        device_hash: body.device_hash ?? "",
        status: body.status ?? "active",
        assertion_ttl_seconds: body.assertion_ttl_seconds ?? 300,
        revocation_seq: 1,
        valid_from: body.valid_from ?? null,
        valid_until: body.valid_until ?? null,
        notes: body.notes ?? "",
        customer_id: body.customer_id ?? null,
        license_id: body.license_id ?? null,
        created_at: now,
        updated_at: now,
      };
      nextEntitlementId += 1;
      entitlements.push(row);
      addEvent("create", row);
      return fulfill(200, makeEnvelope("entitlement_saved", publicRecord(row)));
    }

    const match = /^\/api\/admin\/entitlements\/([^/]+)(?:\/(disable|reenable|revoke))?$/.exec(path);
    if (match !== null) {
      const row = findById(match[1]);
      if (row === undefined) {
        return fulfill(404, { ok: false, code: "not_found", request_id: "ui-e2e-not-found" });
      }
      if (method === "PATCH" && match[2] === undefined) {
        const body = await jsonBody(request);
        requests.patches.push(body);
        now += 1;
        Object.assign(row, {
          device_hash: body.device_hash ?? row.device_hash,
          assertion_ttl_seconds: body.assertion_ttl_seconds ?? row.assertion_ttl_seconds,
          valid_from: body.valid_from === undefined ? row.valid_from : body.valid_from,
          valid_until: body.valid_until === undefined ? row.valid_until : body.valid_until,
          notes: body.notes ?? row.notes,
          customer_id: body.customer_id === undefined ? row.customer_id : body.customer_id,
          license_id: body.license_id === undefined ? row.license_id : body.license_id,
          revocation_seq: row.revocation_seq + 1,
          updated_at: now,
        });
        addEvent("update", row);
        return fulfill(200, makeEnvelope("entitlement_patched", publicRecord(row)));
      }
      if (method === "POST" && match[2] !== undefined) {
        const body = await jsonBody(request);
        const action = match[2];
        requests.transitions.push({ action, reason: body.reason ?? "" });
        now += 1;
        row.status = action === "reenable" ? "active" : action === "disable" ? "disabled" : "revoked";
        row.revocation_seq += 1;
        row.updated_at = now;
        addEvent(action, row, body.reason ?? "");
        return fulfill(200, makeEnvelope(`entitlement_${action}d`, publicRecord(row)));
      }
    }

    return fulfill(404, { ok: false, code: "not_found", request_id: "ui-e2e-unhandled" });
  }

  return {
    route,
    requests,
  };
}

test("admin UI completes entitlement lifecycle and blocks duplicate create submissions", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "licensecc admin" })).toBeVisible();
  await page.getByRole("button", { name: "Entitlements" }).click();

  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("DEFAULT");
  await createForm.getByLabel("Feature").fill("pro");
  await createForm.getByLabel("Fingerprint").fill("a".repeat(64));
  await createForm.getByLabel("Assertion TTL").fill("120");
  await createForm.getByLabel("Valid from").fill("1710000000");
  await createForm.getByLabel("Valid until").fill("");
  await createForm.getByLabel("Customer ID").fill("cus_e2e");
  await createForm.getByLabel("License ID").fill("lic_e2e");
  await createForm.getByLabel("Notes").fill("created from browser e2e");
  await page.evaluate(() => {
    const form = document.querySelector("aside form");
    form.requestSubmit();
    form.requestSubmit();
  });

  await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  await expect.poll(() => api.requests.creates).toBe(1);
  await expect(page.getByText("TTL 120s")).toBeVisible();
  await expect(page.getByText("Customer cus_e2e")).toBeVisible();
  await expect(page.getByText("License lic_e2e")).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  const editForm = page.locator(".editForm");
  await editForm.getByLabel("Assertion TTL").fill("900");
  await editForm.getByLabel("Valid until").fill("1720000000");
  await editForm.getByLabel("Customer ID").fill("");
  await editForm.getByLabel("Notes").fill("");
  await editForm.getByRole("button", { name: "Update" }).click();

  await expect(page.getByText(/entitlement_patched/)).toBeVisible();
  await expect.poll(() => api.requests.patches.length).toBe(1);
  expect(api.requests.patches[0]).toMatchObject({
    assertion_ttl_seconds: 900,
    valid_from: 1710000000,
    valid_until: 1720000000,
    notes: "",
    customer_id: null,
    license_id: "lic_e2e",
  });
  await expect(page.getByText("TTL 900s")).toBeVisible();
  await expect(page.getByText("Customer -")).toBeVisible();

  await page.locator(".reason").getByLabel("Reason").fill("operator pause");
  await page.getByRole("button", { name: "Disable" }).click();
  await expect(page.locator(".status.disabled")).toHaveText("disabled");

  await page.getByRole("button", { name: "Reenable" }).click();
  await expect(page.locator(".status.active")).toHaveText("active");

  await page.locator(".reason").getByLabel("Reason", { exact: true }).fill("chargeback");
  // Revoke is irreversible -> it now opens a typed-confirm modal; the action fires only on Confirm.
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".status.revoked")).toHaveCount(0); // not revoked until confirmed
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".status.revoked")).toHaveText("revoked");
  await expect(page.getByRole("button", { name: "Edit" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reenable" })).toBeDisabled();

  await page.getByRole("button", { name: "Events" }).click();
  for (const eventType of ["create", "update", "disable", "reenable", "revoke"]) {
    await expect(page.getByText(eventType, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("admin@example.com").first()).toBeVisible();
  await expect(page.getByText("(access)").first()).toBeVisible();

  const pageText = await page.locator("body").innerText();
  expect(pageText).not.toContain("PRIVATE KEY");
  expect(pageText).not.toContain("BEGIN");
  expect(pageText).not.toContain("Bearer ");
  expect(pageText).not.toContain("Cf-Access-Jwt-Assertion");
});
