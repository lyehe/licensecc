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
    batches: [],
    searches: [],
    csvExports: [],
    // Workstream F — usage-analytics reports + force-release.
    timeseries: [],
    expiring: [],
    releaseSeats: [],
  };

  // A couple of customers so the Customers tab + a global-search customer deep-link have rows.
  const customers = [
    { id: "cus_acme", name: "Acme Corp", email: "ops@acme.test", status: "active", external_ref: "ext_1", created_at: 1_700_000_000, updated_at: 1_700_000_000, entitlement_count: 2, active_entitlement_count: 1 },
    { id: "cus_globex", name: "Globex", email: "billing@globex.test", status: "disabled", external_ref: "", created_at: 1_700_000_500, updated_at: 1_700_000_900, entitlement_count: 0, active_entitlement_count: 0 },
  ];

  function customerDetail(id) {
    const customer = customers.find((item) => item.id === id);
    return {
      customer: { ...customer, metadata_json: "{}" },
      entitlements: [],
      account_tokens: [],
      licenses: [],
      orders: [],
      events: [],
    };
  }

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

    // Workstream C — CSV export rides ?format=csv on the list routes. Record the export and return a
    // tiny text/csv body so the UI's <a download> blob path runs end-to-end.
    if (method === "GET" && url.searchParams.get("format") === "csv") {
      requests.csvExports.push(path);
      return route.fulfill({
        status: 200,
        contentType: "text/csv; charset=utf-8",
        headers: { "content-disposition": `attachment; filename="${path.split("/").pop()}.csv"` },
        body: "id\r\n\"row-1\"\r\n",
      });
    }

    if (method === "GET" && path === "/api/admin/summary") {
      return fulfill(200, makeEnvelope("summary", summary()));
    }
    // Workstream C — global search. Fans out a fixed set keyed off the loaded entitlements + customers.
    if (method === "GET" && path === "/api/admin/search") {
      const q = url.searchParams.get("q") ?? "";
      requests.searches.push(q);
      const results = [];
      for (const customer of customers) {
        if (customer.name.toLowerCase().includes(q.toLowerCase()) || customer.id.includes(q)) {
          results.push({ type: "customer", id: customer.id, label: customer.name, email: customer.email, status: customer.status, external_ref: customer.external_ref });
        }
      }
      for (const ent of entitlements) {
        if (ent.license_fingerprint.startsWith(q)) {
          results.push({ type: "entitlement", id: ent.id, label: ent.license_fingerprint, project: ent.project, feature: ent.feature, status: ent.status, customer_id: ent.customer_id });
        }
      }
      return fulfill(200, makeEnvelope("search_results", { results }));
    }
    // Workstream F — usage-analytics time-series. Deterministic buckets so the inline-SVG charts have
    // a visible (non-empty) line/area/bar to render.
    if (method === "GET" && path === "/api/admin/report/timeseries") {
      requests.timeseries.push(url.search);
      const from = Number(url.searchParams.get("from")) || 0;
      const to = Number(url.searchParams.get("to")) || from + 4;
      const buckets = [
        { start: from, checkouts: 2, releases: 1, denials: 0, denial_rate: 0, fulfillment_events: 1 },
        { start: from + 1, checkouts: 4, releases: 2, denials: 1, denial_rate: 0.2, fulfillment_events: 3 },
        { start: from + 2, checkouts: 1, releases: 0, denials: 3, denial_rate: 0.75, fulfillment_events: 0 },
      ];
      return fulfill(200, makeEnvelope("report_timeseries", { from, to, bucket_seconds: 1, buckets }));
    }
    // Workstream F — expiring-soon list.
    if (method === "GET" && path === "/api/admin/report/expiring") {
      requests.expiring.push(url.searchParams.get("within_days"));
      const items = [
        { project: "DEFAULT", feature: "pro", license_fingerprint: "a".repeat(64), customer_id: "cus_acme", valid_until: 1_760_500_000, days_left: 3 },
        { project: "DEFAULT", feature: "ent", license_fingerprint: "b".repeat(64), customer_id: null, valid_until: 1_762_000_000, days_left: 21 },
      ];
      return fulfill(200, makeEnvelope("report_expiring", { items, next_cursor: null }));
    }
    if (method === "GET" && path === "/api/admin/report") {
      return fulfill(200, makeEnvelope("report", {
        generated_at: now,
        entitlements: summary().entitlements,
        customers: { total: customers.length, active: 1, disabled: 1 },
        account_tokens: { active: 0 },
        licenses: { total: 0 },
        fulfillment: { accepted: 0, processed: 0, superseded: 0, rejected: 0, stale_accepted: 0, events_24h: 0, events_7d: 0 },
        customer_suspensions_7d: 0,
      }));
    }
    // Workstream F — force-release the live seats on a dead machine (admin-only WRITE).
    const releaseMatch = /^\/api\/admin\/entitlements\/([^/]+)\/release-seats$/.exec(path);
    if (method === "POST" && releaseMatch !== null) {
      const body = await jsonBody(request);
      requests.releaseSeats.push({ id: releaseMatch[1], reason: body.reason ?? "" });
      return fulfill(200, makeEnvelope("seats_released", { released: 2, seat_ids: ["seat_1", "seat_2"] }));
    }
    // Fulfillment tab's order list (the bar spark reuses the timeseries; this feeds the table/cards).
    if (method === "GET" && path === "/api/admin/orders") {
      return fulfill(200, makeEnvelope("orders_listed", {
        items: [],
        summary: { accepted: 0, processed: 0, superseded: 0, rejected: 0, stale_accepted: 0 },
        stale_secs: 300,
        next_cursor: null,
      }));
    }
    if (method === "GET" && path === "/api/admin/customers") {
      return fulfill(200, makeEnvelope("customers_listed", { items: customers.map((item) => ({ ...item })), next_cursor: null }));
    }
    const customerDetailMatch = /^\/api\/admin\/customers\/([^/]+)$/.exec(path);
    if (method === "GET" && customerDetailMatch !== null) {
      return fulfill(200, makeEnvelope("customer", customerDetail(decodeURIComponent(customerDetailMatch[1]))));
    }
    // Workstream C — bulk transitions. One POST carries action/reason/ids; returns per-row results.
    if (method === "POST" && path === "/api/admin/entitlements/batch") {
      const body = await jsonBody(request);
      requests.batches.push(body);
      now += 1;
      const results = [];
      for (const id of body.ids) {
        const row = findById(id);
        if (row === undefined) {
          results.push({ id, ok: false, code: "not_found" });
          continue;
        }
        if (body.action === "revoke" && row.status === "revoked") {
          results.push({ id, ok: false, code: "revoked_entitlement_is_terminal" });
          continue;
        }
        row.status = body.action === "reenable" ? "active" : body.action === "disable" ? "disabled" : "revoked";
        row.revocation_seq += 1;
        row.updated_at = now;
        addEvent(body.action, row, body.reason ?? "");
        results.push({ id, ok: true, code: `entitlement_${body.action}d` });
      }
      return fulfill(200, makeEnvelope("batch_done", { results }));
    }
    if (method === "GET" && path === "/api/admin/events") {
      return fulfill(200, makeEnvelope("events", { items: events.map((item) => ({ ...item })) }));
    }
    if (method === "GET" && path === "/api/admin/entitlements") {
      return fulfill(200, makeEnvelope("entitlements", { items: entitlements.map(publicRecord) }));
    }
    // The Entitlements tab loads active policies for the optional create-from-policy <select>.
    if (method === "GET" && path === "/api/admin/policies") {
      return fulfill(200, makeEnvelope("policies_listed", { items: [], next_cursor: null }));
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
  // Valid from / until are <input type="date"> (YYYY-MM-DD -> UTC-midnight epoch).
  await createForm.getByLabel("Valid from").fill("2024-03-09");
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
  await editForm.getByLabel("Valid until").fill("2024-07-03");
  await editForm.getByLabel("Customer ID").fill("");
  await editForm.getByLabel("Notes").fill("");
  await editForm.getByRole("button", { name: "Update" }).click();

  await expect(page.getByText(/entitlement_patched/)).toBeVisible();
  await expect.poll(() => api.requests.patches.length).toBe(1);
  expect(api.requests.patches[0]).toMatchObject({
    assertion_ttl_seconds: 900,
    valid_from: 1709942400,
    valid_until: 1719964800,
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

test("admin UI runs bulk transitions, global search deep-link, and CSV export", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);

  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();

  // Seed two entitlements via the create form (the fixture stores them so bulk/search can act).
  async function createEntitlement(feature, fingerprint) {
    const createForm = page.locator("aside form");
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("Fingerprint").fill(fingerprint);
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }
  await createEntitlement("pro", "a".repeat(64));
  await createEntitlement("ent", "b".repeat(64));
  await expect(page.locator("tbody .checkCol input[type=checkbox]")).toHaveCount(2);

  // BULK: select all loaded rows -> the bulk bar appears -> Disable -> typed-confirm (reason) -> Confirm.
  await page.getByLabel("Select all loaded rows").check();
  await expect(page.locator(".bulkBar")).toContainText("2 selected");
  await page.locator(".bulkBar").getByRole("button", { name: "Disable" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByLabel(/Reason/).fill("quarterly audit");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.batches.length).toBe(1);
  expect(api.requests.batches[0]).toMatchObject({ action: "disable", reason: "quarterly audit" });
  expect(api.requests.batches[0].ids).toHaveLength(2);
  // The per-row roll-up renders in the status line, and the rows refreshed to disabled.
  await expect(page.getByText(/disable: 2 ok/)).toBeVisible();
  await expect(page.locator(".status.disabled")).toHaveCount(2);
  // Selection cleared after the batch (the bulk bar is gone).
  await expect(page.locator(".bulkBar")).toHaveCount(0);

  // GLOBAL SEARCH: search a customer name -> results dropdown -> click -> deep-link to Customers tab.
  await page.getByLabel("Global search").fill("Acme");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".searchResults")).toBeVisible();
  await expect.poll(() => api.requests.searches.at(-1)).toBe("Acme");
  await page.locator(".searchResult").filter({ hasText: "Acme Corp" }).click();
  // Deep-linked: Customers tab is active and the searched customer's detail pane is open.
  await expect(page.locator("nav button.active")).toHaveText("Customers");
  await expect(page.getByRole("heading", { name: "Acme Corp" })).toBeVisible();
  await expect(page.locator(".searchResults")).toHaveCount(0);

  // CSV EXPORT: the Customers pane Export CSV button hits ?format=csv with the active filter.
  await page.locator(".tablePane .filters").getByRole("button", { name: "Export CSV" }).click();
  await expect.poll(() => api.requests.csvExports.length).toBeGreaterThan(0);
  expect(api.requests.csvExports.at(-1)).toBe("/api/admin/customers");
  await expect(page.getByText(/exported customers\.csv/)).toBeVisible();
});

test("admin UI renders Workstream F charts, expiring panel, health badge, and force-release", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);

  await page.goto("/");

  // Seed one entitlement so the health badge + force-release verb have a row to act on.
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Feature").fill("pro");
  await createForm.getByLabel("Fingerprint").fill("a".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  // HEALTH BADGE: an active, non-expiring (no valid_until) entitlement reads as "healthy".
  await expect(page.locator(".healthBadge.health-healthy")).toHaveText("healthy");

  // FORCE-RELEASE: the danger verb routes through the typed-confirm modal (reason required).
  await page.locator(".reason").getByLabel("Reason", { exact: true }).fill("dead machine");
  await page.getByRole("button", { name: "Release seats" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.releaseSeats.length).toBe(1);
  expect(api.requests.releaseSeats[0].reason).toBe("dead machine");
  await expect(page.getByText(/released 2 seats/)).toBeVisible();

  // REPORTS TAB: the inline-SVG charts render (aria-labelled), plus the expiring-soon panel rows.
  await page.getByRole("button", { name: "Reports" }).click();
  await expect.poll(() => api.requests.timeseries.length).toBeGreaterThan(0);
  await expect(page.getByRole("img", { name: /Checkouts .* versus denials/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /Denial rate/ })).toBeVisible();
  // The expiring-soon panel lists the in-window rows; the first deep-links to its entitlement.
  await expect(page.getByRole("heading", { name: "Expiring soon" })).toBeVisible();
  await expect.poll(() => api.requests.expiring.length).toBeGreaterThan(0);
  await expect(page.locator(".expiringPanel tbody tr")).toHaveCount(2);
  await expect(page.locator(".expiringPanel tbody tr").first().locator(".daysLeft")).toHaveText("3");

  // The expiring horizon selector re-queries with the chosen within_days.
  await page.locator(".expiringPanel .rangeSelector").getByRole("button", { name: "90d" }).click();
  await expect.poll(() => api.requests.expiring.at(-1)).toBe("90");

  // The time-series window selector re-queries the timeseries for the chosen look-back.
  const before = api.requests.timeseries.length;
  await page.locator(".chartPanels .rangeSelector").getByRole("button", { name: "last 30d" }).click();
  await expect.poll(() => api.requests.timeseries.length).toBeGreaterThan(before);

  // Deep-link from an expiring row into the Entitlements tab filtered to that project/feature.
  await page.locator(".expiringPanel tbody tr").first().getByRole("button", { name: "View" }).click();
  await expect(page.locator("nav button.active")).toHaveText("Entitlements");

  // FULFILLMENT TAB: the fulfillment-events bar spark renders (aria-labelled).
  await page.getByRole("button", { name: "Fulfillment" }).click();
  await expect(page.getByRole("img", { name: /Fulfillment .* events/ })).toBeVisible();

  // No secret material ever leaks into the rendered DOM.
  const pageText = await page.locator("body").innerText();
  expect(pageText).not.toContain("PRIVATE KEY");
  expect(pageText).not.toContain("Bearer ");
});
