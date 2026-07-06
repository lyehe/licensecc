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
    planPreviews: [],
    planApplies: [],
    catalogFeatures: [],
    catalogFeaturePatches: [],
    catalogFeatureTransitions: [],
    catalogPlans: [],
    catalogPlanPatches: [],
    catalogPlanTransitions: [],
    catalogPlanExports: [],
    catalogPlanFeatures: [],
    catalogPlanFeatureTransitions: [],
    catalogImports: [],
  };
  const catalogFeatures = [];
  const catalogPlans = [];
  const catalogPlanFeatures = [];

  function importCounts() {
    return {
      features: { created: 0, updated: 0, unchanged: 0 },
      plans: { created: 0, updated: 0, unchanged: 0 },
      plan_features: { created: 0, updated: 0, unchanged: 0 },
    };
  }

  function nullable(value) {
    return value === undefined ? null : value;
  }

  function catalogImportKind(existing, next) {
    if (existing === undefined) {
      return "created";
    }
    for (const [key, value] of Object.entries(next)) {
      if (existing[key] !== value) {
        return "updated";
      }
    }
    return "unchanged";
  }

  function upsertCatalogFeatureFromManifest(feature, dryRun) {
    const existing = catalogFeatures.find((item) => item.project === feature.project && item.feature_key === feature.feature_key);
    const next = {
      project: feature.project,
      feature_key: feature.feature_key,
      name: feature.name,
      description: feature.description ?? "",
      category: feature.category ?? "",
      status: feature.status ?? "active",
    };
    const kind = catalogImportKind(existing, next);
    if (!dryRun && kind !== "unchanged") {
      now += 1;
      if (existing === undefined) {
        catalogFeatures.push({ id: `feat_${feature.feature_key}`, ...next, created_at: now, updated_at: now });
      } else {
        Object.assign(existing, next, { updated_at: now });
      }
    }
    return kind;
  }

  function upsertCatalogPlanFromManifest(plan, dryRun) {
    const version = plan.version ?? 1;
    const existing = catalogPlans.find((item) => item.project === plan.project && item.plan_key === plan.plan_key && item.version === version);
    const next = {
      project: plan.project,
      plan_key: plan.plan_key,
      name: plan.name,
      description: plan.description ?? "",
      status: plan.status ?? "active",
      version,
    };
    const kind = catalogImportKind(existing, next);
    if (!dryRun && kind !== "unchanged") {
      now += 1;
      if (existing === undefined) {
        catalogPlans.push({ id: `plan_${plan.plan_key}`, ...next, created_at: now, updated_at: now });
      } else {
        Object.assign(existing, next, { updated_at: now });
      }
    }
    return { kind, plan: existing ?? { id: `plan_${plan.plan_key}`, ...next } };
  }

  function planFeatureNext(planRow, feature) {
    const catalogFeature = catalogFeatures.find((item) => item.project === feature.project && item.feature_key === feature.feature_key);
    return {
      project: feature.project,
      plan_id: planRow.id,
      plan_key: planRow.plan_key,
      feature_key: feature.feature_key,
      feature_name: catalogFeature?.name ?? feature.feature_key,
      feature_inclusion: feature.feature_inclusion ?? "included",
      addon_key: feature.feature_inclusion === "addon" ? nullable(feature.addon_key) : null,
      policy_id: nullable(feature.policy_id),
      status: feature.status ?? "active",
      display_order: feature.display_order ?? 0,
      assertion_ttl_seconds: nullable(feature.assertion_ttl_seconds),
      pool_size: nullable(feature.pool_size),
      max_active_devices: nullable(feature.max_active_devices),
      max_borrow_sec: nullable(feature.max_borrow_sec),
      meter_quota: nullable(feature.meter_quota),
      meter_period_sec: nullable(feature.meter_period_sec),
    };
  }

  function upsertCatalogPlanFeatureFromManifest(planRow, feature, dryRun) {
    const existing = catalogPlanFeatures.find((item) => item.plan_id === planRow.id && item.feature_key === feature.feature_key);
    const next = planFeatureNext(planRow, feature);
    const kind = catalogImportKind(existing, next);
    if (!dryRun && kind !== "unchanged") {
      now += 1;
      if (existing === undefined) {
        catalogPlanFeatures.push({ ...next, created_at: now, updated_at: now });
      } else {
        Object.assign(existing, next, { updated_at: now });
      }
    }
    return kind;
  }

  function importCatalogManifest(manifest, dryRun) {
    const counts = importCounts();
    for (const feature of manifest.features ?? []) {
      counts.features[upsertCatalogFeatureFromManifest(feature, dryRun)] += 1;
    }
    for (const plan of manifest.plans ?? []) {
      const appliedPlan = upsertCatalogPlanFromManifest(plan, dryRun);
      counts.plans[appliedPlan.kind] += 1;
      for (const feature of plan.features ?? []) {
        counts.plan_features[upsertCatalogPlanFeatureFromManifest(appliedPlan.plan, feature, dryRun)] += 1;
      }
    }
    return counts;
  }

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
    // The Entitlements and Plans tabs load active policies for policy selectors.
    if (method === "GET" && path === "/api/admin/policies") {
      return fulfill(200, makeEnvelope("policies_listed", { items: [], next_cursor: null }));
    }
    if (method === "GET" && path === "/api/admin/catalog/features") {
      return fulfill(200, makeEnvelope("catalog_features_listed", { items: catalogFeatures.map((item) => ({ ...item })), next_cursor: null }));
    }
    if (method === "POST" && path === "/api/admin/catalog/features") {
      const body = await jsonBody(request);
      requests.catalogFeatures.push(body);
      if (catalogFeatures.some((item) => item.project === body.project && item.feature_key === body.feature_key)) {
        return fulfill(409, { ok: false, code: "catalog_feature_conflict", request_id: "ui-e2e-feature-conflict" });
      }
      now += 1;
      const row = {
        id: `feat_${body.feature_key}`,
        project: body.project,
        feature_key: body.feature_key,
        name: body.name,
        description: body.description ?? "",
        category: body.category ?? "",
        status: body.status ?? "active",
        created_at: now,
        updated_at: now,
      };
      catalogFeatures.push(row);
      return fulfill(200, makeEnvelope("catalog_feature_created", { ...row }));
    }
    const catalogFeatureActionMatch = /^\/api\/admin\/catalog\/features\/([^/]+)\/(disable|reenable)$/.exec(path);
    if (method === "POST" && catalogFeatureActionMatch !== null) {
      const id = decodeURIComponent(catalogFeatureActionMatch[1]);
      const action = catalogFeatureActionMatch[2];
      const body = await jsonBody(request);
      requests.catalogFeatureTransitions.push({ id, action, reason: body.reason ?? "" });
      const row = catalogFeatures.find((item) => item.id === id);
      if (row === undefined) {
        return fulfill(404, { ok: false, code: "catalog_feature_not_found", request_id: "ui-e2e-feature-missing" });
      }
      now += 1;
      row.status = action === "disable" ? "disabled" : "active";
      row.updated_at = now;
      return fulfill(200, makeEnvelope(`catalog_feature_${action}d`, { ...row }));
    }
    const catalogFeatureDetailMatch = /^\/api\/admin\/catalog\/features\/([^/]+)$/.exec(path);
    if (method === "PATCH" && catalogFeatureDetailMatch !== null) {
      const id = decodeURIComponent(catalogFeatureDetailMatch[1]);
      const body = await jsonBody(request);
      requests.catalogFeaturePatches.push({ id, ...body });
      const row = catalogFeatures.find((item) => item.id === id);
      if (row === undefined) {
        return fulfill(404, { ok: false, code: "catalog_feature_not_found", request_id: "ui-e2e-feature-missing" });
      }
      now += 1;
      Object.assign(row, { ...body, updated_at: now });
      return fulfill(200, makeEnvelope("catalog_feature_patched", { ...row }));
    }
    if (method === "GET" && path === "/api/admin/catalog/plans") {
      return fulfill(200, makeEnvelope("catalog_plans_listed", { items: catalogPlans.map((item) => ({ ...item })), next_cursor: null }));
    }
    if (method === "POST" && path === "/api/admin/catalog/plans") {
      const body = await jsonBody(request);
      requests.catalogPlans.push(body);
      if (catalogPlans.some((item) => item.project === body.project && item.plan_key === body.plan_key && item.version === body.version)) {
        return fulfill(409, { ok: false, code: "catalog_plan_conflict", request_id: "ui-e2e-plan-conflict" });
      }
      now += 1;
      const row = {
        id: `plan_${body.plan_key}`,
        project: body.project,
        plan_key: body.plan_key,
        name: body.name,
        status: body.status ?? "active",
        version: body.version ?? 1,
        description: body.description ?? "",
        created_at: now,
        updated_at: now,
      };
      catalogPlans.push(row);
      return fulfill(200, makeEnvelope("catalog_plan_created", { ...row }));
    }
    if (method === "POST" && path === "/api/admin/catalog/import") {
      const body = await jsonBody(request);
      const dryRun = url.searchParams.get("dry_run") === "1";
      requests.catalogImports.push({ dry_run: dryRun, idempotency_key: request.headers()["idempotency-key"] ?? null, body });
      const counts = importCatalogManifest(body, dryRun);
      return fulfill(200, makeEnvelope(dryRun ? "catalog_import_previewed" : "catalog_import_applied", counts));
    }
    const catalogPlanActionMatch = /^\/api\/admin\/catalog\/plans\/([^/]+)\/(disable|reenable)$/.exec(path);
    if (method === "POST" && catalogPlanActionMatch !== null) {
      const id = decodeURIComponent(catalogPlanActionMatch[1]);
      const action = catalogPlanActionMatch[2];
      const body = await jsonBody(request);
      requests.catalogPlanTransitions.push({ id, action, reason: body.reason ?? "" });
      const row = catalogPlans.find((item) => item.id === id);
      if (row === undefined) {
        return fulfill(404, { ok: false, code: "catalog_plan_not_found", request_id: "ui-e2e-plan-missing" });
      }
      now += 1;
      row.status = action === "disable" ? "disabled" : "active";
      row.updated_at = now;
      return fulfill(200, makeEnvelope(`catalog_plan_${action}d`, { ...row }));
    }
    const catalogPlanExportMatch = /^\/api\/admin\/catalog\/plans\/([^/]+)\/export$/.exec(path);
    if (method === "GET" && catalogPlanExportMatch !== null) {
      const id = decodeURIComponent(catalogPlanExportMatch[1]);
      requests.catalogPlanExports.push(id);
      const plan = catalogPlans.find((item) => item.id === id);
      if (plan === undefined) {
        return fulfill(404, { ok: false, code: "catalog_plan_not_found", request_id: "ui-e2e-plan-missing" });
      }
      const rows = catalogPlanFeatures.filter((item) => item.plan_id === id);
      const featureKeys = new Set(rows.map((item) => `${item.project}:${item.feature_key}`));
      const features = catalogFeatures
        .filter((item) => featureKeys.has(`${item.project}:${item.feature_key}`))
        .map(({ project, feature_key, name, description, category, status }) => ({ project, feature_key, name, description, category, status }));
      return fulfill(200, makeEnvelope("catalog_plan_exported", {
        format_version: 1,
        features,
        plans: [{
          project: plan.project,
          plan_key: plan.plan_key,
          name: plan.name,
          description: plan.description,
          status: plan.status,
          version: plan.version,
          features: rows.map(({ project, feature_key, feature_inclusion, addon_key, policy_id, status, display_order, assertion_ttl_seconds, pool_size, max_active_devices, max_borrow_sec, meter_quota, meter_period_sec }) => ({
            project,
            feature_key,
            feature_inclusion,
            addon_key,
            policy_id,
            status,
            display_order,
            assertion_ttl_seconds,
            pool_size,
            max_active_devices,
            max_borrow_sec,
            meter_quota,
            meter_period_sec,
          })),
        }],
      }));
    }
    const catalogPlanDetailMatch = /^\/api\/admin\/catalog\/plans\/([^/]+)$/.exec(path);
    if (method === "PATCH" && catalogPlanDetailMatch !== null) {
      const id = decodeURIComponent(catalogPlanDetailMatch[1]);
      const body = await jsonBody(request);
      requests.catalogPlanPatches.push({ id, ...body });
      const row = catalogPlans.find((item) => item.id === id);
      if (row === undefined) {
        return fulfill(404, { ok: false, code: "catalog_plan_not_found", request_id: "ui-e2e-plan-missing" });
      }
      now += 1;
      Object.assign(row, { ...body, updated_at: now });
      return fulfill(200, makeEnvelope("catalog_plan_patched", { ...row }));
    }
    const catalogPlanFeatureActionMatch = /^\/api\/admin\/catalog\/plans\/([^/]+)\/features\/([^/]+)\/(disable|reenable)$/.exec(path);
    if (method === "POST" && catalogPlanFeatureActionMatch !== null) {
      const planId = decodeURIComponent(catalogPlanFeatureActionMatch[1]);
      const featureKey = decodeURIComponent(catalogPlanFeatureActionMatch[2]);
      const action = catalogPlanFeatureActionMatch[3];
      const body = await jsonBody(request);
      requests.catalogPlanFeatureTransitions.push({ plan_id: planId, feature_key: featureKey, action, reason: body.reason ?? "" });
      const row = catalogPlanFeatures.find((item) => item.plan_id === planId && item.feature_key === featureKey);
      if (row === undefined) {
        return fulfill(404, { ok: false, code: "catalog_plan_feature_not_found", request_id: "ui-e2e-plan-feature-missing" });
      }
      now += 1;
      row.status = action === "disable" ? "disabled" : "active";
      row.updated_at = now;
      return fulfill(200, makeEnvelope(`catalog_plan_feature_${action}d`, { ...row }));
    }
    const catalogPlanFeatureMatch = /^\/api\/admin\/catalog\/plans\/([^/]+)\/features$/.exec(path);
    if (catalogPlanFeatureMatch !== null) {
      const planId = decodeURIComponent(catalogPlanFeatureMatch[1]);
      if (method === "GET") {
        return fulfill(200, makeEnvelope("catalog_plan_features_listed", {
          items: catalogPlanFeatures.filter((item) => item.plan_id === planId).map((item) => ({ ...item })),
        }));
      }
      if (method === "POST") {
        const body = await jsonBody(request);
        requests.catalogPlanFeatures.push({ plan_id: planId, ...body });
        const plan = catalogPlans.find((item) => item.id === planId);
        const feature = catalogFeatures.find((item) => item.project === body.project && item.feature_key === body.feature_key);
        if (plan === undefined || feature === undefined) {
          return fulfill(404, { ok: false, code: "catalog_not_found", request_id: "ui-e2e-catalog-missing" });
        }
        now += 1;
        const row = {
          project: body.project,
          plan_id: planId,
          plan_key: plan.plan_key,
          feature_key: body.feature_key,
          feature_name: feature.name,
          feature_inclusion: body.feature_inclusion ?? "included",
          addon_key: body.feature_inclusion === "addon" ? body.addon_key : null,
          policy_id: body.policy_id ?? null,
          status: body.status ?? "active",
          display_order: body.display_order ?? 0,
          assertion_ttl_seconds: body.assertion_ttl_seconds ?? null,
          pool_size: body.pool_size ?? null,
          max_active_devices: body.max_active_devices ?? null,
          max_borrow_sec: body.max_borrow_sec ?? null,
          meter_quota: body.meter_quota ?? null,
          meter_period_sec: body.meter_period_sec ?? null,
          created_at: now,
          updated_at: now,
        };
        const existing = catalogPlanFeatures.findIndex((item) => item.plan_id === planId && item.feature_key === row.feature_key);
        if (existing >= 0) {
          catalogPlanFeatures[existing] = row;
        } else {
          catalogPlanFeatures.push(row);
        }
        return fulfill(200, makeEnvelope("catalog_plan_feature_saved", { ...row }));
      }
    }
    function planProjection(body) {
      const plan = catalogPlans.find((item) => item.id === body.plan_id || item.plan_key === body.plan_key) ?? {
        id: "plan_pro",
        project: body.project,
        plan_key: body.plan_key ?? "pro",
        name: "Pro",
        status: "active",
        version: 1,
      };
      const base = {
        project: body.project,
        license_fingerprint: body.license_fingerprint,
        status: "active",
        valid_from: null,
        valid_until: body.support_until ?? null,
        assertion_ttl_seconds: 600,
        max_borrow_sec: 0,
        meter_quota: 0,
        meter_period_sec: 2592000,
      };
      const selectedAddons = new Set(body.addons ?? []);
      const planRows = catalogPlanFeatures
        .filter((item) => item.plan_id === plan.id && item.status === "active")
        .filter((item) => item.feature_inclusion === "included" || selectedAddons.has(item.addon_key));
      const willCreate = planRows.map((row) => {
        const poolSize = row.pool_size ?? 0;
        const maxActiveDevices = row.max_active_devices ?? (poolSize > 0 ? poolSize : 1);
        return {
          ...base,
          feature: row.feature_key,
          policy_id: row.policy_id,
          source: row.feature_inclusion,
          addon_key: row.addon_key,
          license_mode: poolSize > 0 ? "floating" : "node_locked",
          pool_size: poolSize,
          max_active_devices: maxActiveDevices,
          max_borrow_sec: row.max_borrow_sec ?? 0,
          assertion_ttl_seconds: row.assertion_ttl_seconds ?? base.assertion_ttl_seconds,
          meter_quota: row.meter_quota ?? base.meter_quota,
          meter_period_sec: row.meter_period_sec ?? base.meter_period_sec,
        };
      });
      return {
        plan: { id: plan.id, project: plan.project, plan_key: plan.plan_key, name: plan.name, status: plan.status, version: plan.version },
        assignment: {
          project: body.project,
          license_id: body.license_id,
          license_fingerprint: body.license_fingerprint,
          customer_id: body.customer_id ?? null,
          plan_id: plan.id,
          plan_key: plan.plan_key,
          support_until: body.support_until ?? null,
          addons: body.addons ?? [],
        },
        desired: willCreate,
        will_create: willCreate,
        will_update: [],
        will_disable: [],
        blocked: [],
        unchanged: [],
        summary: { create: willCreate.length, update: 0, disable: 0, blocked: 0, unchanged: 0 },
      };
    }
    if (method === "POST" && path === "/api/admin/license-plans/preview") {
      const body = await jsonBody(request);
      requests.planPreviews.push(body);
      return fulfill(200, makeEnvelope("license_plan_projection_previewed", planProjection(body)));
    }
    if (method === "POST" && path === "/api/admin/license-plans/apply") {
      const body = await jsonBody(request);
      requests.planApplies.push(body);
      const preview = planProjection(body);
      const created = preview.will_create.map((item) => {
        now += 1;
        const row = {
          id: `ent-${nextEntitlementId}`,
          project: item.project,
          feature: item.feature,
          license_fingerprint: item.license_fingerprint,
          device_hash: "",
          status: "active",
          assertion_ttl_seconds: item.assertion_ttl_seconds,
          revocation_seq: 1,
          valid_from: item.valid_from,
          valid_until: item.valid_until,
          notes: body.notes ?? "",
          customer_id: body.customer_id ?? null,
          license_id: body.license_id,
          policy_id: item.policy_id,
          is_trial: 0,
          trial_expiration_basis: null,
          trial_duration_sec: 0,
          trial_one_per_device: 0,
          trial_require_device_proof: 0,
          max_active_devices: item.max_active_devices,
          lease_seconds: 0,
          rebind_window_sec: 0,
          pool_size: item.pool_size,
          heartbeat_grace_sec: 300,
          max_borrow_sec: item.max_borrow_sec,
          allow_overdraft: 0,
          meter_quota: item.meter_quota,
          meter_period_sec: item.meter_period_sec,
          license_mode: item.license_mode,
          created_at: now,
          updated_at: now,
        };
        nextEntitlementId += 1;
        entitlements.push(row);
        addEvent("create", row);
        return publicRecord(row);
      });
      return fulfill(200, makeEnvelope("license_plan_projection_applied", {
        ...preview,
        applied: { created, updated: [], disabled: [], assignment: { ...preview.assignment, status: "active" } },
      }));
    }
    if (method === "POST" && path === "/api/admin/entitlements") {
      requests.creates += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const body = await jsonBody(request);
      now += 1;
      const floating = body.feature === "float" || (body.pool_size ?? 0) > 0;
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
        policy_id: body.policy_id ?? null,
        is_trial: 0,
        trial_expiration_basis: null,
        trial_duration_sec: 0,
        trial_one_per_device: 0,
        trial_require_device_proof: 0,
        max_active_devices: body.max_active_devices ?? 1,
        lease_seconds: body.lease_seconds ?? 0,
        rebind_window_sec: body.rebind_window_sec ?? 0,
        pool_size: body.pool_size ?? (floating ? 5 : 0),
        heartbeat_grace_sec: body.heartbeat_grace_sec ?? 300,
        max_borrow_sec: body.max_borrow_sec ?? 0,
        allow_overdraft: body.allow_overdraft ?? 0,
        meter_quota: body.meter_quota ?? 0,
        meter_period_sec: body.meter_period_sec ?? 2592000,
        license_mode: floating ? "floating" : "node_locked",
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
  await page.getByRole("dialog").getByLabel(/Reason/).fill("operator pause");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".status.disabled")).toHaveText("disabled");

  await page.getByRole("button", { name: "Reenable" }).click();
  await expect(page.locator(".status.active")).toHaveText("active");

  await page.locator(".reason").getByLabel("Reason", { exact: true }).fill("chargeback");
  // Revoke is irreversible -> it now opens a typed-confirm modal; the action fires only on Confirm.
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".status.revoked")).toHaveCount(0); // not revoked until confirmed
  await page.getByRole("dialog").getByLabel(/Reason/).fill("chargeback");
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

test("admin UI previews and applies a license plan projection", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);

  await page.goto("/");
  await page.getByRole("button", { name: "Plans" }).click();
  await expect(page.locator("nav button.active")).toHaveText("Plans");

  const featureForm = page.getByRole("form", { name: "Catalog feature" });
  await featureForm.getByLabel("Feature key").fill("core");
  await featureForm.getByLabel("Name").fill("Core");
  await featureForm.getByRole("button", { name: "Create feature" }).click();
  await expect.poll(() => api.requests.catalogFeatures.length).toBe(1);
  await expect(page.getByText(/catalog_feature_created/)).toBeVisible();
  await featureForm.getByLabel("Feature key").fill("team");
  await featureForm.getByLabel("Name").fill("Team Seats");
  await featureForm.getByRole("button", { name: "Create feature" }).click();
  await expect.poll(() => api.requests.catalogFeatures.length).toBe(2);

  const catalogPlanForm = page.getByRole("form", { name: "Catalog plan" });
  await catalogPlanForm.getByLabel("Plan key").fill("pro");
  await catalogPlanForm.getByLabel("Name").fill("Pro");
  await catalogPlanForm.getByRole("button", { name: "Create plan" }).click();
  await expect.poll(() => api.requests.catalogPlans.length).toBe(1);
  await expect(page.getByText(/catalog_plan_created/)).toBeVisible();

  const planFeatureForm = page.getByRole("form", { name: "Plan feature" });
  await planFeatureForm.getByLabel("Feature key").fill("core");
  await planFeatureForm.getByLabel("Policy ID").fill("pol_node");
  await planFeatureForm.getByRole("button", { name: "Save plan feature" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatures.length).toBe(1);
  await expect(page.getByText(/catalog_plan_feature_saved/)).toBeVisible();

  await planFeatureForm.getByLabel("Feature key").fill("team");
  await planFeatureForm.getByLabel("Inclusion").selectOption("addon");
  await planFeatureForm.getByLabel("Add-on key").fill("team_seats");
  await planFeatureForm.getByLabel("Policy ID").fill("pol_float");
  await planFeatureForm.getByLabel("Pool size").fill("6");
  await planFeatureForm.getByLabel("Max devices").fill("6");
  await planFeatureForm.getByLabel("Max borrow").fill("172800");
  await planFeatureForm.getByRole("button", { name: "Save plan feature" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatures.length).toBe(2);
  expect(api.requests.catalogPlanFeatures[1]).toMatchObject({
    plan_id: "plan_pro",
    feature_key: "team",
    feature_inclusion: "addon",
    addon_key: "team_seats",
    policy_id: "pol_float",
    pool_size: 6,
    max_active_devices: 6,
    max_borrow_sec: 172800,
  });
  await expect(page.getByRole("row", { name: /Team Seats team addon team_seats pol_float/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "team_seats", exact: true })).toBeVisible();

  await page.getByRole("row", { name: /Core core/ }).getByRole("button", { name: "Edit" }).click();
  await featureForm.getByLabel("Name").fill("Core Runtime");
  await featureForm.getByLabel("Category").fill("");
  await featureForm.getByRole("button", { name: "Update feature" }).click();
  await expect.poll(() => api.requests.catalogFeaturePatches.length).toBe(1);
  expect(api.requests.catalogFeaturePatches[0]).toMatchObject({ id: "feat_core", name: "Core Runtime", category: "" });
  await expect(page.getByText(/catalog_feature_patched/)).toBeVisible();

  const featureRow = page.getByRole("row", { name: /Core Runtime core/ });
  await featureRow.getByRole("button", { name: "Disable" }).click();
  await page.getByLabel("Reason (required)").fill("catalog lifecycle test");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogFeatureTransitions.length).toBe(1);
  expect(api.requests.catalogFeatureTransitions[0]).toMatchObject({ id: "feat_core", action: "disable", reason: "catalog lifecycle test" });
  await expect(page.getByText(/catalog_feature_disabled/)).toBeVisible();
  await featureRow.getByRole("button", { name: "Reenable" }).click();
  await expect.poll(() => api.requests.catalogFeatureTransitions.length).toBe(2);
  expect(api.requests.catalogFeatureTransitions[1]).toMatchObject({ id: "feat_core", action: "reenable" });

  await page.getByRole("row", { name: /Pro pro/ }).getByRole("button", { name: "Edit" }).click();
  await catalogPlanForm.getByLabel("Name").fill("Pro Annual");
  await catalogPlanForm.getByLabel("Description").fill("Annual plan");
  await catalogPlanForm.getByRole("button", { name: "Update plan" }).click();
  await expect.poll(() => api.requests.catalogPlanPatches.length).toBe(1);
  expect(api.requests.catalogPlanPatches[0]).toMatchObject({ id: "plan_pro", name: "Pro Annual", description: "Annual plan" });
  await expect(page.getByText(/catalog_plan_patched/)).toBeVisible();

  const planFeatureRow = page.getByRole("row", { name: /Team Seats team addon team_seats pol_float/ });
  await planFeatureRow.getByRole("button", { name: "Disable" }).click();
  await page.getByLabel("Reason (required)").fill("hide add-on");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatureTransitions.length).toBe(1);
  expect(api.requests.catalogPlanFeatureTransitions[0]).toMatchObject({ plan_id: "plan_pro", feature_key: "team", action: "disable", reason: "hide add-on" });
  await planFeatureRow.getByRole("button", { name: "Reenable" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatureTransitions.length).toBe(2);

  const planRow = page.getByRole("row", { name: /Pro Annual pro/ });
  await planRow.getByRole("button", { name: "Disable" }).click();
  await page.getByLabel("Reason (required)").fill("pause plan");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogPlanTransitions.length).toBe(1);
  expect(api.requests.catalogPlanTransitions[0]).toMatchObject({ id: "plan_pro", action: "disable", reason: "pause plan" });
  await planRow.getByRole("button", { name: "Reenable" }).click();
  await expect.poll(() => api.requests.catalogPlanTransitions.length).toBe(2);

  await planRow.getByRole("button", { name: "Export" }).click();
  await expect.poll(() => api.requests.catalogPlanExports.length).toBe(1);
  expect(api.requests.catalogPlanExports[0]).toBe("plan_pro");

  const importForm = page.getByRole("form", { name: "Catalog import" });
  await importForm.getByLabel("Manifest JSON").fill(JSON.stringify({ format_version: 1, features: [], plans: [] }));
  await importForm.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(1);
  expect(api.requests.catalogImports[0]).toMatchObject({ dry_run: true, body: { format_version: 1, features: [], plans: [] } });
  await expect(page.getByText(/catalog_import_previewed/)).toBeVisible();

  const importedManifest = {
    format_version: 1,
    features: [
      { project: "DEFAULT", feature_key: "analytics", name: "Analytics", description: "Usage analytics", category: "insights", status: "active" },
    ],
    plans: [
      {
        project: "DEFAULT",
        plan_key: "growth",
        name: "Growth",
        description: "Growth tier",
        version: 1,
        status: "active",
        features: [
          { project: "DEFAULT", feature_key: "analytics", feature_inclusion: "included", addon_key: null, policy_id: "pol_node", status: "active", display_order: 4, assertion_ttl_seconds: null, pool_size: null, max_active_devices: null, max_borrow_sec: null, meter_quota: null, meter_period_sec: null },
        ],
      },
    ],
  };
  await importForm.getByLabel("Manifest JSON").fill(JSON.stringify(importedManifest));
  await importForm.getByRole("button", { name: "Apply import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(2);
  expect(api.requests.catalogImports[1]).toMatchObject({ dry_run: false, body: importedManifest });
  expect(api.requests.catalogImports[1].idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByText(/catalog_import_applied/)).toBeVisible();
  await expect(page.getByRole("row", { name: /Growth growth/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Analytics analytics/ })).toBeVisible();
  await page.getByRole("row", { name: /Growth growth/ }).getByRole("button", { name: "Use" }).click();
  await expect(page.getByRole("heading", { name: "Plan features / growth" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Analytics analytics included - pol_node/ })).toBeVisible();

  const form = page.getByRole("form", { name: "Plan projection" });
  await form.getByLabel("License ID").fill("lic_plan");
  await form.getByLabel("Fingerprint").fill("c".repeat(64));
  await form.getByLabel("Customer ID").fill("cus_plan");
  await form.getByLabel("Plan key").fill("pro");
  await form.getByLabel("Support until").fill("2026-07-05");
  await form.getByLabel("Add-ons (csv)").fill("team_seats");
  await form.getByRole("button", { name: "Preview" }).click();

  await expect.poll(() => api.requests.planPreviews.length).toBe(1);
  expect(api.requests.planPreviews[0]).toMatchObject({
    project: "DEFAULT",
    license_id: "lic_plan",
    plan_key: "pro",
    support_until: 1783209600,
    addons: ["team_seats"],
  });
  await expect(page.getByText(/license_plan_projection_previewed/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "core", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "team", exact: true })).toBeVisible();
  await expect(page.getByText("floating")).toBeVisible();

  await form.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => api.requests.planApplies.length).toBe(1);
  await expect(page.getByText(/license_plan_projection_applied/)).toBeVisible();

  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  await expect(page.getByRole("cell", { name: "core", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "team", exact: true })).toBeVisible();
  await expect(page.getByText("Mode floating")).toBeVisible();
  await expect(page.getByText("License lic_plan").first()).toBeVisible();
});

test("admin UI renders Workstream F charts, expiring panel, health badge, and force-release", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);

  await page.goto("/");

  // Seed one entitlement so the health badge + force-release verb have a row to act on.
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("a".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  // HEALTH BADGE: an active, non-expiring (no valid_until) entitlement reads as "healthy".
  await expect(page.locator(".healthBadge.health-healthy")).toHaveText("healthy");

  // FORCE-RELEASE: the danger verb routes through the typed-confirm modal (reason required).
  await page.locator(".reason").getByLabel("Reason", { exact: true }).fill("dead machine");
  await page.getByRole("button", { name: "Release seats" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByLabel(/Reason/).fill("dead machine");
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
