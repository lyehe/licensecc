import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { catalogImportManifestSnapshot } from "@licensecc/licensing-domain/catalog/import_preview";

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
    expiringCursors: [],
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
    policyCreates: [],
    webhookCreates: [],
    webhookCreateAttempts: [],
    webhookReads: [],
    webhookRedrives: [],
    customerTransitions: [],
    policyTransitions: [],
    webhookTransitions: [],
    deviceTransitions: [],
    deviceReads: [],
    meterReads: [],
    deliveryReads: [],
    deliveryCursors: [],
    reportReads: [],
    orderReads: [],
    orderCursors: [],
    entitlementReads: [],
    entitlementDetailReads: [],
  };
  const catalogFeatures = [];
  const catalogPlans = [];
  const catalogPlanFeatures = [];
  const policies = [];
  const webhooks = [];
  const projectionPreviews = new Map();
  const catalogImportPreviews = new Map();
  const catalogImportApplications = new Map();
  const projectionState = { staleNextPlanApply: false, nextPlanApplyError: null };
  const catalogImportState = {
    latestPreviewId() {
      return Array.from(catalogImportPreviews.keys()).at(-1) ?? null;
    },
    /** Models ownership binding: a different operator must see a stale 409 before any write. */
    claimAsOtherOperator(previewId) {
      const stored = catalogImportPreviews.get(previewId);
      if (stored !== undefined) stored.actor = "operator-b";
    },
    expire(previewId) {
      const stored = catalogImportPreviews.get(previewId);
      if (stored !== undefined) stored.expires_at = now;
    },
    claim(previewId) {
      const stored = catalogImportPreviews.get(previewId);
      if (stored !== undefined) stored.claimed = true;
    },
  };
  const behavior = {
    deferTransition: false,
    releaseTransition: null,
    transitionResponse: null,
    transitionResponses: [],
    transitionStatus: 200,
    transitionResponseOnce: false,
    batchResponse: null,
    releaseSeatsResponse: null,
    releaseSeatsResponses: [],
    releaseSeatTargetOnSecondPage: false,
    releaseSeatTargetId: null,
    transitionFailure: null,
    abortTransition: false,
    dropTransitionRow: false,
    refreshFailure: null,
    refreshFailures: [],
    deferRefresh: false,
    releaseRefresh: null,
    deviceRefreshFailure: null,
    deviceRefreshFailures: [],
    deferDeviceRefresh: false,
    releaseDeviceRefresh: null,
    customerDetailFailure: null,
    customerTransitionEmptyName: false,
    webhookCreateResponses: [],
    webhookRefreshFailures: [],
    catalogPlanPagination: false,
    catalogPlanRepeatCursor: false,
    catalogPlanDuplicatePage: false,
    catalogPlanCursorCycle: false,
    catalogPlanAppendResponses: [],
    deliveryRepeatCursor: false,
    deliveryDuplicatePage: false,
    deliveryCursorCycle: false,
    deliveryAppendResponses: [],
    // One-shot route holds let the browser tests prove that an old A response
    // cannot overwrite B (including an A -> B -> A return).  The route removes
    // the key before waiting, so the later request is deliberately live.
    deferReads: new Set(),
    releaseReads: new Map(),
    // Mutation holds exercise the post-success refresh fence.  The mutation
    // itself still completes; only a superseded screen is prevented from
    // publishing its old filter/selection response afterwards.
    deferMutations: new Set(),
    releaseMutations: new Map(),
    completedMutations: new Set(),
    deviceTransitionResponse: null,
    reportVersioned: false,
    activePolicyPagination: false,
    deliveryPagination: false,
    ordersPagination: false,
    expiringPagination: false,
    orderAppendResponses: [],
    expiringAppendResponses: [],
    deliveryRows: null,
    licenseRows: [],
    orderRows: [],
    catalogImportReadFailures: [],
    catalogImportApplyErrors: [],
    catalogImportAbortAfterApply: false,
  };
  let nextProjectionPreviewId = 1;
  let nextCatalogImportPreviewId = 1;

  function seedPolicy(id = "pol_confirm", name = "Confirm policy") {
    const policy = {
      id, project: "DEFAULT", name, type: "trial", status: "active",
      valid_from_offset_sec: null, duration_sec: null, assertion_ttl_seconds: 300, pool_size: 0,
      max_active_devices: 1, max_borrow_sec: 0, meter_quota: 0, meter_period_sec: 2592000,
      expiry_strategy: "fixed_window", trial_expiration_basis: "from_issue", trial_duration_sec: 0,
      trial_one_per_device: 0, trial_require_device_proof: 0, notes: "", created_at: now, updated_at: now,
    };
    policies.push(policy);
    return policy;
  }

  function seedWebhook(id = "wh_confirm", url = "https://hooks.example.test/confirm") {
    const endpoint = {
      id, url, event_types: "", status: "active",
      description: "", scope_project: null, scope_customer_id: null, created_at: now, updated_at: now,
    };
    webhooks.push(endpoint);
    return endpoint;
  }

  function seedCatalogFeature() {
    const feature = {
      id: "feat_confirm", project: "DEFAULT", feature_key: "confirm", name: "Confirm feature",
      description: "", category: "", status: "active", created_at: now, updated_at: now,
    };
    catalogFeatures.push(feature);
    return feature;
  }

  function seedCatalogPlan(id = "plan_confirm", project = "DEFAULT", planKey = "confirm") {
    const plan = {
      id, project, plan_key: planKey, name: `Plan ${planKey}`, status: "active", version: 1,
      description: "", created_at: now, updated_at: now,
    };
    catalogPlans.push(plan);
    return plan;
  }

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

  function catalogImportEffectKind(existing, next) {
    if (existing === undefined) return "create";
    if (Object.entries(next).every(([key, value]) => existing[key] === value)) return "unchanged";
    if (existing.status === "active" && next.status === "disabled") return "disable";
    if (existing.status === "disabled" && next.status === "active") return "reenable";
    return "update";
  }

  function emptyCatalogImportEffects() {
    const counter = () => ({ create: 0, update: 0, disable: 0, reenable: 0, unchanged: 0 });
    return {
      features: [],
      plans: [],
      plan_features: [],
      summary: { features: counter(), plans: counter(), plan_features: counter() },
    };
  }

  function appendCatalogImportEffect(effects, collection, target, existing, next, after) {
    const effect = catalogImportEffectKind(existing, next);
    effects[collection].push({ target, effect, before: existing === undefined ? null : { ...existing }, after });
    effects.summary[collection][effect] += 1;
  }

  /**
   * The browser fixture models the same persisted protocol as the Worker:
   * normalized preview + digest + complete, server-derived effects are saved
   * before Apply, and Apply only receives that preview capability.
   */
  function previewCatalogImportManifest(manifest) {
    const snapshot = catalogImportManifestSnapshot(manifest);
    const normalized = JSON.parse(snapshot);
    const effectiveAt = now;
    const effects = emptyCatalogImportEffects();
    const plannedRows = new Map();

    for (const feature of normalized.features) {
      const existing = catalogFeatures.find((item) => item.project === feature.project && item.feature_key === feature.feature_key);
      const next = {
        project: feature.project,
        feature_key: feature.feature_key,
        name: feature.name,
        description: feature.description,
        category: feature.category,
        status: feature.status,
      };
      const after = catalogImportEffectKind(existing, next) === "unchanged"
        ? { ...existing }
        : {
          id: existing?.id ?? `feat_${feature.feature_key}`,
          ...next,
          created_at: existing?.created_at ?? effectiveAt,
          updated_at: effectiveAt,
        };
      appendCatalogImportEffect(effects, "features", {
        entity: "feature", project: feature.project, feature_key: feature.feature_key,
      }, existing, next, after);
    }

    for (const plan of normalized.plans) {
      const existing = catalogPlans.find((item) => item.project === plan.project && item.plan_key === plan.plan_key);
      const next = {
        project: plan.project,
        plan_key: plan.plan_key,
        name: plan.name,
        description: plan.description,
        status: plan.status,
        version: plan.version,
      };
      const after = catalogImportEffectKind(existing, next) === "unchanged"
        ? { ...existing }
        : {
          id: existing?.id ?? `plan_${plan.plan_key}`,
          ...next,
          created_at: existing?.created_at ?? effectiveAt,
          updated_at: effectiveAt,
        };
      plannedRows.set(JSON.stringify([plan.project, plan.plan_key]), after);
      appendCatalogImportEffect(effects, "plans", {
        entity: "plan", project: plan.project, plan_key: plan.plan_key, plan_id: after.id,
      }, existing, next, after);
    }

    for (const plan of normalized.plans) {
      const planRow = plannedRows.get(JSON.stringify([plan.project, plan.plan_key]));
      for (const feature of plan.features) {
        const existing = catalogPlanFeatures.find((item) => item.plan_id === planRow.id && item.feature_key === feature.feature_key);
        const next = {
          project: feature.project,
          plan_id: planRow.id,
          feature_key: feature.feature_key,
          feature_inclusion: feature.feature_inclusion,
          addon_key: feature.addon_key,
          policy_id: feature.policy_id,
          status: feature.status,
          display_order: feature.display_order,
          assertion_ttl_seconds: feature.assertion_ttl_seconds,
          pool_size: feature.pool_size,
          max_active_devices: feature.max_active_devices,
          max_borrow_sec: feature.max_borrow_sec,
          meter_quota: feature.meter_quota,
          meter_period_sec: feature.meter_period_sec,
        };
        const after = catalogImportEffectKind(existing, next) === "unchanged"
          ? { ...existing }
          : {
            ...next,
            created_at: existing?.created_at ?? effectiveAt,
            updated_at: effectiveAt,
          };
        appendCatalogImportEffect(effects, "plan_features", {
          entity: "plan_feature", project: feature.project, plan_key: plan.plan_key, plan_id: planRow.id, feature_key: feature.feature_key,
        }, existing, next, after);
      }
    }

    const preview = {
      preview_id: `civ_ui_${nextCatalogImportPreviewId++}`,
      manifest_digest: createHash("sha256").update(snapshot).digest("hex"),
      manifest: normalized,
      effects,
      effective_at: effectiveAt,
      expires_at: effectiveAt + 300,
      source_generation: 0,
    };
    catalogImportPreviews.set(preview.preview_id, {
      manifest: normalized,
      preview,
      actor: "operator-a",
      expires_at: preview.expires_at,
      claimed: false,
      consumed: false,
    });
    return preview;
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
      request_id: `ui-e2e-event-${nextEventId}`,
      status: row.status,
      source: "admin",
      actor: "admin@example.com",
      actor_type: "access",
      revocation_seq: row.revocation_seq,
      detail: "",
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

  // `null` and scalar JSON are meaningful malformed-response fixtures. Test
  // overrides must therefore distinguish an explicit `body: null` from an
  // absent `body` property that means "use the response object itself".
  function fixtureResponseBody(response) {
    return response !== null && typeof response === "object" && Object.prototype.hasOwnProperty.call(response, "body")
      ? response.body
      : response;
  }

  async function deferRead(key) {
    if (!behavior.deferReads.delete(key)) return;
    await new Promise((resolve) => { behavior.releaseReads.set(key, resolve); });
    behavior.releaseReads.delete(key);
  }

  async function deferMutation(key) {
    if (!behavior.deferMutations.delete(key)) return;
    await new Promise((resolve) => { behavior.releaseMutations.set(key, resolve); });
    behavior.releaseMutations.delete(key);
    behavior.completedMutations.add(key);
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
      await deferRead("timeseries");
      const from = Number(url.searchParams.get("from")) || 0;
      const to = Number(url.searchParams.get("to")) || from + 4;
      const rangeDays = Math.max(1, Math.round((to - from) / 86_400));
      const buckets = rangeDays <= 7
        ? [{ start: from, checkouts: 2, releases: 1, denials: 1, denial_rate: 0.5, fulfillment_events: 1 }]
        : [
          { start: from, checkouts: 2, releases: 1, denials: 0, denial_rate: 0, fulfillment_events: 1 },
          { start: from + 1, checkouts: 4, releases: 2, denials: 1, denial_rate: 0.2, fulfillment_events: 3 },
        ];
      return fulfill(200, makeEnvelope("report_timeseries", { from, to, bucket_seconds: 1, buckets }));
    }
    // Workstream F — expiring-soon list.
    if (method === "GET" && path === "/api/admin/report/expiring") {
      const withinDays = url.searchParams.get("within_days") ?? "";
      const cursor = url.searchParams.get("cursor");
      requests.expiring.push(withinDays);
      requests.expiringCursors.push(cursor);
      await deferRead(`expiring:${withinDays}:${cursor ?? "page-1"}`);
      await deferRead(`expiring:${withinDays}`);
      if (cursor !== null && behavior.expiringAppendResponses.length > 0) {
        const response = behavior.expiringAppendResponses.shift();
        return fulfill(response.status ?? 200, fixtureResponseBody(response));
      }
      const items = [
        { project: "DEFAULT", feature: `pro-${withinDays}`, license_fingerprint: "a".repeat(64), customer_id: "cus_acme", valid_until: 1_760_500_000, days_left: 3 },
        { project: "DEFAULT", feature: "ent", license_fingerprint: "b".repeat(64), customer_id: null, valid_until: 1_762_000_000, days_left: 21 },
      ];
      const page = behavior.expiringPagination ? (cursor === null ? items.slice(0, 1) : items.slice(1)) : items;
      return fulfill(200, makeEnvelope("report_expiring", {
        items: page,
        next_cursor: behavior.expiringPagination && cursor === null ? "expiring-next" : null,
      }));
    }
    if (method === "GET" && path === "/api/admin/report") {
      requests.reportReads.push("report");
      const reportReadVersion = requests.reportReads.length;
      await deferRead("report");
      const reportEntitlements = behavior.reportVersioned
        ? { total: reportReadVersion, active: reportReadVersion, disabled: 0, revoked: 0 }
        : summary().entitlements;
      return fulfill(200, makeEnvelope("report", {
        generated_at: now,
        entitlements: reportEntitlements,
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
      requests.releaseSeats.push({
        id: releaseMatch[1],
        reason: body.reason ?? "",
        rawBody: request.postData() ?? "",
        idempotencyKey: request.headers()["idempotency-key"] ?? null,
      });
      behavior.releaseSeatTargetId = releaseMatch[1];
      if (behavior.releaseSeatsResponses.length > 0) {
        const response = behavior.releaseSeatsResponses.shift();
        return fulfill(response.status ?? 200, fixtureResponseBody(response));
      }
      if (behavior.releaseSeatsResponse !== null) {
        const response = behavior.releaseSeatsResponse;
        behavior.releaseSeatsResponse = null;
        return fulfill(200, response);
      }
      return fulfill(200, makeEnvelope("seats_released", { released: 2, seat_ids: ["seat_1", "seat_2"] }));
    }
    // Fulfillment tab's order list (the bar spark reuses the timeseries; this feeds the table/cards).
    if (method === "GET" && path === "/api/admin/orders") {
      const cursor = url.searchParams.get("cursor");
      requests.orderReads.push(url.search);
      requests.orderCursors.push(cursor);
      await deferRead(`orders:${cursor ?? "page-1"}`);
      await deferRead("orders");
      if (cursor !== null && behavior.orderAppendResponses.length > 0) {
        const response = behavior.orderAppendResponses.shift();
        return fulfill(response.status ?? 200, fixtureResponseBody(response));
      }
      const filteredRows = behavior.orderRows
        .filter((item) => {
          const status = url.searchParams.get("status");
          const subscriptionId = url.searchParams.get("subscription_id");
          return (status === null || item.status === status) && (subscriptionId === null || item.subscription_id === subscriptionId);
        })
        .map((item) => ({ ...item }));
      const page = behavior.ordersPagination ? (cursor === null ? filteredRows.slice(0, 1) : filteredRows.slice(1)) : filteredRows;
      return fulfill(200, makeEnvelope("orders_listed", {
        items: page,
        summary: { accepted: 0, processed: 0, superseded: 0, rejected: 0, stale_accepted: 0 },
        stale_secs: 300,
        next_cursor: behavior.ordersPagination && cursor === null && filteredRows.length > 1 ? "orders-next" : null,
      }));
    }
    if (method === "GET" && path === "/api/admin/customers") {
      return fulfill(200, makeEnvelope("customers_listed", { items: customers.map((item) => ({ ...item })), next_cursor: null }));
    }
    if (method === "GET" && path === "/api/admin/licenses") {
      return fulfill(200, makeEnvelope("licenses_listed", { items: behavior.licenseRows.map((item) => ({ ...item })), next_cursor: null }));
    }
    const customerDetailMatch = /^\/api\/admin\/customers\/([^/]+)$/.exec(path);
    if (method === "GET" && customerDetailMatch !== null) {
      const detail = customerDetail(decodeURIComponent(customerDetailMatch[1]));
      if (behavior.customerDetailFailure === "nested-null") {
        behavior.customerDetailFailure = null;
        detail.account_tokens = [null];
      }
      return fulfill(200, makeEnvelope("customer", detail));
    }
    const customerActionMatch = /^\/api\/admin\/customers\/([^/]+)\/(disable|reenable)$/.exec(path);
    if (method === "POST" && customerActionMatch !== null) {
      const id = decodeURIComponent(customerActionMatch[1]);
      const action = customerActionMatch[2];
      const body = await jsonBody(request);
      requests.customerTransitions.push({ id, action, reason: body.reason ?? "" });
      const customer = customers.find((item) => item.id === id);
      if (customer === undefined) return fulfill(404, { ok: false, code: "not_found", request_id: "ui-e2e-customer-missing" });
      if (behavior.customerTransitionEmptyName) customer.name = "";
      customer.status = action === "disable" ? "disabled" : "active";
      // transitionWithGuard RETURNING uses the customer table projection, not
      // the list-only correlated entitlement counts.
      const { entitlement_count: _entitlementCount, active_entitlement_count: _activeEntitlementCount, ...transitionRow } = customer;
      return fulfill(200, makeEnvelope(`customer_${action}d`, transitionRow));
    }
    // Workstream C — bulk transitions. One POST carries action/reason/ids; returns per-row results.
    if (method === "POST" && path === "/api/admin/entitlements/batch") {
      const body = await jsonBody(request);
      requests.batches.push(body);
      if (behavior.batchResponse !== null) {
        const response = behavior.batchResponse;
        behavior.batchResponse = null;
        return fulfill(200, response);
      }
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
      return fulfill(200, makeEnvelope("events_listed", { items: events.map((item) => ({ ...item })) }));
    }
    const entitlementDetailMatch = /^\/api\/admin\/entitlements\/([^/]+)$/.exec(path);
    if (method === "GET" && entitlementDetailMatch !== null) {
      const id = decodeURIComponent(entitlementDetailMatch[1]);
      requests.entitlementDetailReads.push(id);
      const row = findById(id);
      if (row === undefined) return fulfill(404, { ok: false, code: "not_found", request_id: "ui-e2e-entitlement-missing" });
      return fulfill(200, makeEnvelope("entitlement", publicRecord(row)));
    }
    if (method === "GET" && path === "/api/admin/entitlements") {
      requests.entitlementReads.push(url.searchParams.get("project") ?? "");
      const refreshFailure = behavior.refreshFailures.shift() ?? behavior.refreshFailure;
      behavior.refreshFailure = null;
      if (behavior.deferRefresh) {
        behavior.deferRefresh = false;
        await new Promise((resolve) => { behavior.releaseRefresh = resolve; });
      }
      if (refreshFailure === "abort") {
        return route.abort("failed");
      }
      if (refreshFailure === "malformed") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "not-json" });
      }
      if (refreshFailure === "response-error") {
        return fulfill(503, { ok: false, code: "refresh_unavailable", request_id: "ui-e2e-refresh-unavailable" });
      }
      if (refreshFailure === "http-success") {
        return fulfill(503, makeEnvelope("entitlements_listed", { items: entitlements.map(publicRecord), next_cursor: null }));
      }
      if (refreshFailure === "missing-data") {
        return fulfill(200, { ok: true, code: "entitlements_listed", request_id: "ui-e2e-refresh-missing-data" });
      }
      if (refreshFailure === "truncated") {
        const items = entitlements.map(publicRecord);
        if (items[0] !== undefined) delete items[0].license_mode;
        return fulfill(200, makeEnvelope("entitlements_listed", { items, next_cursor: null }));
      }
      if (refreshFailure === "wrong-enum") {
        const items = entitlements.map(publicRecord);
        if (items[0] !== undefined) items[0].status = "corrupted";
        return fulfill(200, makeEnvelope("entitlements_listed", { items, next_cursor: null }));
      }
      const project = url.searchParams.get("project");
      const feature = url.searchParams.get("feature");
      const status = url.searchParams.get("status");
      const filteredEntitlements = entitlements.filter((item) =>
        (project === null || item.project === project) &&
        (feature === null || item.feature === feature) &&
        (status === null || item.status === status),
      );
      const releaseTargetOnSecondPage = behavior.releaseSeatTargetOnSecondPage && behavior.releaseSeatTargetId !== null;
      const items = releaseTargetOnSecondPage
        ? filteredEntitlements.filter((item) => item.id !== behavior.releaseSeatTargetId).map(publicRecord)
        : filteredEntitlements.map(publicRecord);
      return fulfill(200, makeEnvelope("entitlements_listed", { items, next_cursor: releaseTargetOnSecondPage ? "release-target-page-2" : null }));
    }
    // The Entitlements and Plans tabs load active policies for policy selectors.
    if (method === "GET" && path === "/api/admin/policies") {
      const status = url.searchParams.get("status");
      const project = url.searchParams.get("project");
      const type = url.searchParams.get("type");
      const items = policies.filter((policy) =>
        (status === null || policy.status === status) &&
        (project === null || policy.project === project) &&
        (type === null || policy.type === type),
      );
      if (behavior.activePolicyPagination && status === "active") {
        const cursor = url.searchParams.get("cursor");
        const page = cursor === null ? items.slice(0, 1) : items.slice(1);
        return fulfill(200, makeEnvelope("policies_listed", { items: page.map((policy) => ({ ...policy })), next_cursor: cursor === null && items.length > 1 ? "active-next" : null }));
      }
      return fulfill(200, makeEnvelope("policies_listed", { items: items.map((policy) => ({ ...policy })), next_cursor: null }));
    }
    if (method === "POST" && path === "/api/admin/policies") {
      const body = await jsonBody(request);
      requests.policyCreates.push(body);
      await deferMutation("policy-create");
      if (policies.some((policy) => policy.project === body.project && policy.name === body.name)) {
        return fulfill(409, { ok: false, code: "policy_name_conflict", request_id: "ui-e2e-policy-conflict" });
      }
      now += 1;
      const row = {
        id: `pol_${policies.length + 1}`,
        project: body.project,
        name: body.name,
        type: body.type,
        status: "active",
        valid_from_offset_sec: body.valid_from_offset_sec ?? null,
        duration_sec: body.duration_sec ?? null,
        assertion_ttl_seconds: body.assertion_ttl_seconds,
        pool_size: body.pool_size,
        max_active_devices: body.max_active_devices,
        max_borrow_sec: body.max_borrow_sec,
        meter_quota: body.meter_quota,
        meter_period_sec: body.meter_period_sec,
        expiry_strategy: body.expiry_strategy,
        trial_expiration_basis: body.trial_expiration_basis,
        trial_duration_sec: body.trial_duration_sec,
        trial_one_per_device: body.trial_one_per_device,
        trial_require_device_proof: body.trial_require_device_proof,
        notes: body.notes,
        created_at: now,
        updated_at: now,
      };
      policies.push(row);
      return fulfill(200, makeEnvelope("policy_created", { ...row }));
    }
    const policyActionMatch = /^\/api\/admin\/policies\/([^/]+)\/(disable|reenable)$/.exec(path);
    if (method === "POST" && policyActionMatch !== null) {
      const id = decodeURIComponent(policyActionMatch[1]);
      const action = policyActionMatch[2];
      const body = await jsonBody(request);
      requests.policyTransitions.push({ id, action, reason: body.reason ?? "" });
      const policy = policies.find((item) => item.id === id);
      if (policy === undefined) return fulfill(404, { ok: false, code: "not_found", request_id: "ui-e2e-policy-missing" });
      policy.status = action === "disable" ? "disabled" : "active";
      return fulfill(200, makeEnvelope(`policy_${action}d`, { ...policy }));
    }
    if (method === "GET" && path === "/api/admin/webhooks") {
      const refreshFailure = behavior.webhookRefreshFailures.shift() ?? null;
      if (refreshFailure === "malformed") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "not-json" });
      }
      if (refreshFailure === "response-error") {
        return fulfill(503, { ok: false, code: "refresh_unavailable", request_id: "ui-e2e-webhook-refresh-unavailable" });
      }
      const status = url.searchParams.get("status");
      requests.webhookReads.push(url.search);
      await deferRead(`webhooks:${status ?? ""}`);
      const items = webhooks.filter((endpoint) => status === null || endpoint.status === status);
      return fulfill(200, makeEnvelope("webhooks_listed", { items: items.map((endpoint) => ({ ...endpoint })), next_cursor: null }));
    }
    if (method === "POST" && path === "/api/admin/webhooks") {
      const body = await jsonBody(request);
      requests.webhookCreates.push(body);
      requests.webhookCreateAttempts.push({
        body: request.postData() ?? "",
        idempotencyKey: request.headers()["idempotency-key"] ?? null,
      });
      await deferMutation("webhook-create");
      if (behavior.webhookCreateResponses?.length > 0) {
        const response = behavior.webhookCreateResponses.shift();
        return fulfill(response.status ?? 200, fixtureResponseBody(response));
      }
      now += 1;
      const row = {
        id: `wh_${webhooks.length + 1}`,
        url: body.url,
        event_types: body.event_types ?? "",
        status: "active",
        description: body.description ?? "",
        scope_project: body.scope_project === "" ? null : body.scope_project,
        scope_customer_id: body.scope_customer_id === "" ? null : body.scope_customer_id,
        created_at: now,
        updated_at: now,
      };
      webhooks.push(row);
      return fulfill(200, makeEnvelope("webhook_created", { ...row }));
    }
    if (method === "GET" && path === "/api/admin/webhooks/deliveries") {
      const endpointId = url.searchParams.get("endpoint_id") ?? "";
      const status = url.searchParams.get("status");
      const cursor = url.searchParams.get("cursor");
      requests.deliveryReads.push(endpointId);
      requests.deliveryCursors.push(cursor);
      await deferRead(`deliveries:${endpointId}:${cursor ?? "page-1"}`);
      await deferRead(`deliveries:${endpointId}`);
      if (cursor !== null && behavior.deliveryAppendResponses.length > 0) {
        const response = behavior.deliveryAppendResponses.shift();
        return fulfill(response.status ?? 200, fixtureResponseBody(response));
      }
      const defaultItems = endpointId === "" ? [] : [{
        id: (endpointId === "wh_confirm" ? 1 : 2) + (cursor === null ? 0 : 10),
        endpoint_id: endpointId,
        event_id: endpointId === "wh_confirm" ? 11 : 22,
        event_source: "entitlement",
        event_type: "disabled",
        status: "delivered",
        attempts: 1,
        last_status: 200,
        last_error: "",
        next_attempt_at: now,
        created_at: now,
        delivered_at: now,
      }];
      const explicitRows = Array.isArray(behavior.deliveryRows);
      const source = explicitRows ? behavior.deliveryRows : defaultItems;
      const items = source
        .filter((delivery) => endpointId === "" || delivery.endpoint_id === endpointId)
        .filter((delivery) => status === null || delivery.status === status)
        .map((delivery) => ({ ...delivery }));
      let page = behavior.deliveryPagination && endpointId !== "" && explicitRows ? (cursor === null ? items.slice(0, 1) : items.slice(1)) : items;
      if (behavior.deliveryDuplicatePage && cursor !== null) page = items.slice(0, 1);
      const shouldPage = behavior.deliveryPagination && endpointId !== "" && (!explicitRows || items.length > 1);
      if (behavior.deliveryCursorCycle && cursor === "deliveries-next") page = items.slice(1, 2);
      if (behavior.deliveryCursorCycle && cursor === "deliveries-cycle-b") page = items.slice(2, 3);
      const nextCursor = behavior.deliveryCursorCycle && shouldPage && cursor === null
        ? "deliveries-next"
        : behavior.deliveryCursorCycle && shouldPage && cursor === "deliveries-next"
          ? "deliveries-cycle-b"
          : behavior.deliveryCursorCycle && shouldPage && cursor === "deliveries-cycle-b"
            ? "deliveries-next"
        : shouldPage && cursor === null
        ? "deliveries-next"
        : shouldPage && cursor !== null && behavior.deliveryRepeatCursor
          ? "deliveries-next"
          : null;
      return fulfill(200, makeEnvelope("webhook_deliveries_listed", { items: page, next_cursor: nextCursor }));
    }
    const webhookRedriveMatch = /^\/api\/admin\/webhooks\/deliveries\/(\d+)\/redrive$/.exec(path);
    if (method === "POST" && webhookRedriveMatch !== null) {
      const deliveryId = Number(webhookRedriveMatch[1]);
      requests.webhookRedrives.push(deliveryId);
      await deferMutation("webhook-redrive");
      const rows = Array.isArray(behavior.deliveryRows) ? behavior.deliveryRows : [];
      const row = rows.find((delivery) => delivery.id === deliveryId);
      if (row === undefined) return fulfill(404, { ok: false, code: "not_found", request_id: "ui-e2e-delivery-missing" });
      if (row.status !== "failed") return fulfill(409, { ok: false, code: "webhook_delivery_not_failed", request_id: "ui-e2e-delivery-not-failed" });
      row.status = "pending";
      row.attempts = 0;
      row.last_error = "";
      row.next_attempt_at = now;
      row.delivered_at = null;
      return fulfill(200, makeEnvelope("webhook_delivery_redriven", { ...row }));
    }
    const webhookActionMatch = /^\/api\/admin\/webhooks\/([^/]+)\/(disable|reenable)$/.exec(path);
    if (method === "POST" && webhookActionMatch !== null) {
      const id = decodeURIComponent(webhookActionMatch[1]);
      const action = webhookActionMatch[2];
      const body = await jsonBody(request);
      requests.webhookTransitions.push({ id, action, reason: body.reason ?? "" });
      const endpoint = webhooks.find((item) => item.id === id);
      if (endpoint === undefined) return fulfill(404, { ok: false, code: "not_found", request_id: "ui-e2e-webhook-missing" });
      endpoint.status = action === "disable" ? "disabled" : "active";
      return fulfill(200, makeEnvelope(`webhook_${action}d`, { ...endpoint }));
    }
    if (method === "GET" && path === "/api/admin/catalog/features") {
      const readFailure = behavior.catalogImportReadFailures.shift() ?? null;
      if (readFailure === "response-error") {
        return fulfill(503, { ok: false, code: "catalog_refresh_unavailable", request_id: "ui-e2e-catalog-refresh-unavailable" });
      }
      if (readFailure === "malformed") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "not-json" });
      }
      const project = url.searchParams.get("project");
      const status = url.searchParams.get("status");
      const items = catalogFeatures.filter((item) =>
        (project === null || item.project === project) &&
        (status === null || item.status === status),
      );
      return fulfill(200, makeEnvelope("catalog_features_listed", { items: items.map((item) => ({ ...item })), next_cursor: null }));
    }
    if (method === "POST" && path === "/api/admin/catalog/features") {
      const body = await jsonBody(request);
      requests.catalogFeatures.push(body);
      await deferMutation("catalog-feature-create");
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
      await deferMutation("catalog-feature-patch");
      const row = catalogFeatures.find((item) => item.id === id);
      if (row === undefined) {
        return fulfill(404, { ok: false, code: "catalog_feature_not_found", request_id: "ui-e2e-feature-missing" });
      }
      now += 1;
      Object.assign(row, { ...body, updated_at: now });
      return fulfill(200, makeEnvelope("catalog_feature_patched", { ...row }));
    }
    if (method === "GET" && path === "/api/admin/catalog/plans") {
      const project = url.searchParams.get("project");
      const status = url.searchParams.get("status");
      const items = catalogPlans.filter((item) =>
        (project === null || item.project === project) &&
        (status === null || item.status === status),
      );
      const cursor = url.searchParams.get("cursor");
      await deferRead(`catalog-plans:${project ?? ""}:${status ?? ""}:${cursor ?? "page-1"}`);
      if (cursor !== null && behavior.catalogPlanAppendResponses.length > 0) {
        const response = behavior.catalogPlanAppendResponses.shift();
        return fulfill(response.status ?? 200, fixtureResponseBody(response));
      }
      let page = behavior.catalogPlanPagination ? (cursor === null ? items.slice(0, 1) : items.slice(1)) : items;
      if (behavior.catalogPlanDuplicatePage && cursor !== null) page = items.slice(0, 1);
      const shouldPage = behavior.catalogPlanPagination && items.length > 1;
      if (behavior.catalogPlanCursorCycle && cursor === "catalog-plans-next") page = items.slice(1, 2);
      if (behavior.catalogPlanCursorCycle && cursor === "catalog-plans-cycle-b") page = items.slice(2, 3);
      const nextCursor = behavior.catalogPlanCursorCycle && shouldPage && cursor === null
        ? "catalog-plans-next"
        : behavior.catalogPlanCursorCycle && shouldPage && cursor === "catalog-plans-next"
          ? "catalog-plans-cycle-b"
          : behavior.catalogPlanCursorCycle && shouldPage && cursor === "catalog-plans-cycle-b"
            ? "catalog-plans-next"
        : shouldPage && cursor === null
        ? "catalog-plans-next"
        : shouldPage && cursor !== null && behavior.catalogPlanRepeatCursor
          ? "catalog-plans-next"
          : null;
      return fulfill(200, makeEnvelope("catalog_plans_listed", { items: page.map((item) => ({ ...item })), next_cursor: nextCursor }));
    }
    if (method === "POST" && path === "/api/admin/catalog/plans") {
      const body = await jsonBody(request);
      requests.catalogPlans.push(body);
      await deferMutation("catalog-plan-create");
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
      if (dryRun) {
        await deferMutation("catalog-import-preview");
        return fulfill(200, makeEnvelope("catalog_import_previewed", previewCatalogImportManifest(body)));
      }
      if (Object.keys(body).length !== 1 || typeof body.preview_id !== "string") {
        return fulfill(400, { ok: false, code: "invalid_request", request_id: "ui-e2e-import-body" });
      }
      const idempotencyKey = request.headers()["idempotency-key"] ?? null;
      if (idempotencyKey === null) {
        return fulfill(400, { ok: false, code: "idempotency_key_required", request_id: "ui-e2e-import-key" });
      }
      const replay = catalogImportApplications.get(idempotencyKey);
      if (replay !== undefined) {
        return fulfill(200, makeEnvelope("catalog_import_applied", replay));
      }
      const forcedError = behavior.catalogImportApplyErrors.shift() ?? null;
      if (forcedError !== null) {
        return fulfill(409, { ok: false, code: forcedError, request_id: "ui-e2e-import-forced" });
      }
      const stored = catalogImportPreviews.get(body.preview_id);
      if (stored === undefined || stored.actor !== "operator-a") {
        return fulfill(409, { ok: false, code: "stale_catalog_import_preview", request_id: "ui-e2e-import-stale" });
      }
      if (stored.expires_at <= now) {
        return fulfill(409, { ok: false, code: "expired_catalog_import_preview", request_id: "ui-e2e-import-expired" });
      }
      if (stored.claimed || stored.consumed) {
        return fulfill(409, { ok: false, code: "claimed_catalog_import_preview", request_id: "ui-e2e-import-claimed" });
      }
      await deferMutation("catalog-import");
      // Re-check after an intentionally held request: a competing operator can
      // consume the persisted capability while the local dialog is waiting.
      if (stored.actor !== "operator-a" || stored.claimed || stored.consumed) {
        return fulfill(409, { ok: false, code: "stale_catalog_import_preview", request_id: "ui-e2e-import-stale-after-hold" });
      }
      stored.claimed = true;
      importCatalogManifest(stored.manifest, false);
      stored.consumed = true;
      catalogImportApplications.set(idempotencyKey, stored.preview);
      if (behavior.catalogImportAbortAfterApply) {
        behavior.catalogImportAbortAfterApply = false;
        return route.abort("failed");
      }
      return fulfill(200, makeEnvelope("catalog_import_applied", stored.preview));
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
      await deferMutation("catalog-plan-patch");
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
        await deferMutation("catalog-plan-feature-save");
        const plan = catalogPlans.find((item) => item.id === planId);
        const feature = catalogFeatures.find((item) => item.project === body.project && item.feature_key === body.feature_key);
        if (plan === undefined || feature === undefined) {
          return fulfill(404, { ok: false, code: plan === undefined ? "catalog_plan_not_found" : "catalog_feature_not_found", request_id: "ui-e2e-catalog-missing" });
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
      const preview = {
        ...planProjection(body),
        preview_id: `ppv_ui_${nextProjectionPreviewId}`,
        effective_at: now,
        expires_at: now + 300,
        source_generation: 1,
      };
      nextProjectionPreviewId += 1;
      projectionPreviews.set(preview.preview_id, { input: body, preview });
      return fulfill(200, makeEnvelope("license_plan_projection_previewed", preview));
    }
    if (method === "POST" && path === "/api/admin/license-plans/apply") {
      const body = await jsonBody(request);
      requests.planApplies.push(body);
      if (projectionState.staleNextPlanApply) {
        projectionState.staleNextPlanApply = false;
        return fulfill(409, { ok: false, code: "stale_projection_preview", request_id: "ui-e2e-projection-stale" });
      }
      if (projectionState.nextPlanApplyError !== null) {
        const code = projectionState.nextPlanApplyError;
        projectionState.nextPlanApplyError = null;
        return fulfill(409, { ok: false, code, request_id: "ui-e2e-projection-conflict" });
      }
      const stored = projectionPreviews.get(body.preview_id);
      if (stored === undefined) {
        return fulfill(409, { ok: false, code: "stale_projection_preview", request_id: "ui-e2e-projection-missing" });
      }
      const { input, preview } = stored;
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
          notes: input.notes ?? "",
          customer_id: input.customer_id ?? null,
          license_id: input.license_id,
          policy_id: item.policy_id,
          is_trial: 0,
          trial_expiration_basis: null,
          trial_duration_sec: 0,
          trial_one_per_device: 0,
          trial_require_device_proof: 0,
          trial_started_at: null,
          trial_device_hash: null,
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
        trial_started_at: null,
        trial_device_hash: null,
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

    const meterMatch = /^\/api\/admin\/entitlements\/([^/]+)\/meter$/.exec(path);
    if (method === "GET" && meterMatch !== null) {
      const entitlementId = decodeURIComponent(meterMatch[1]);
      const parent = findById(entitlementId);
      requests.meterReads.push(entitlementId);
      await deferRead(`meter:${entitlementId}`);
      if (parent === undefined) {
        return fulfill(404, { ok: false, code: "not_found", request_id: "ui-e2e-meter-missing" });
      }
      const periodSeconds = parent.meter_period_sec > 0 ? parent.meter_period_sec : 2_592_000;
      const consumed = Number(entitlementId.replace(/\D/g, "")) * 10;
      return fulfill(200, makeEnvelope("meter_status", {
        meter_quota: parent.meter_quota,
        meter_period_sec: periodSeconds,
        period_start: now,
        period_end: now + periodSeconds,
        units_consumed: consumed,
        server_time: now,
      }));
    }

    const devicesMatch = /^\/api\/admin\/entitlements\/([^/]+)\/devices(?:\/([^/]+)\/(disable|reenable|revoke))?$/.exec(path);
    if (devicesMatch !== null) {
      const entitlementId = decodeURIComponent(devicesMatch[1]);
      const parent = findById(entitlementId);
      const deviceHash = entitlementId === "ent-1" ? "b" : "c";
      const defaultDevice = {
        project: parent?.project ?? "DEFAULT",
        feature: parent?.feature ?? "float",
        license_fingerprint: parent?.license_fingerprint ?? "d".repeat(64),
        device_key_id: `sha256:${deviceHash.repeat(64)}`,
        status: "active", created_at: now, updated_at: now, last_seen_at: now, notes: "",
      };
      if (method === "GET" && devicesMatch[2] === undefined) {
        requests.deviceReads.push(entitlementId);
        await deferRead(`devices:${entitlementId}`);
        const deviceRefreshFailure = behavior.deviceRefreshFailures.shift() ?? behavior.deviceRefreshFailure;
        behavior.deviceRefreshFailure = null;
        if (behavior.deferDeviceRefresh) {
          await new Promise((resolve) => { behavior.releaseDeviceRefresh = resolve; });
        }
        if (deviceRefreshFailure === "abort") {
          return route.abort("failed");
        }
        if (deviceRefreshFailure === "malformed") {
          return route.fulfill({ status: 200, contentType: "application/json", body: "not-json" });
        }
        if (deviceRefreshFailure === "response-error") {
          return fulfill(503, { ok: false, code: "devices_unavailable", request_id: "ui-e2e-devices-unavailable" });
        }
        if (deviceRefreshFailure === "missing-data") {
          return fulfill(200, { ok: true, code: "devices_listed", request_id: "ui-e2e-devices-missing-data" });
        }
        return fulfill(200, makeEnvelope("devices_listed", { items: [defaultDevice] }));
      }
      if (method === "POST" && devicesMatch[2] !== undefined && devicesMatch[3] !== undefined) {
        const body = await jsonBody(request);
        requests.deviceTransitions.push({ entitlement_id: entitlementId, device_key_id: decodeURIComponent(devicesMatch[2]), action: devicesMatch[3], reason: body.reason ?? "" });
        if (parent !== undefined) {
          if (typeof behavior.deviceTransitionResponse === "function") {
            const response = behavior.deviceTransitionResponse(parent, devicesMatch[3]);
            behavior.deviceTransitionResponse = null;
            return fulfill(200, response);
          }
          now += 1;
          parent.revocation_seq += 1;
          parent.updated_at = now;
          addEvent(`device_${devicesMatch[3]}`, parent, body.reason ?? "");
          return fulfill(200, makeEnvelope(`device_${devicesMatch[3]}d`, publicRecord(parent)));
        }
        return fulfill(200, makeEnvelope(`device_${devicesMatch[3]}d`, {}));
      }
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
        requests.transitions.push({ action, reason: body.reason ?? "", body: { ...body }, rawBody: request.postData() ?? "", idempotencyKey: request.headers()["idempotency-key"] ?? null });
        if (behavior.deferTransition) {
          await new Promise((resolve) => { behavior.releaseTransition = resolve; });
        }
        if (behavior.abortTransition) {
          return route.abort("failed");
        }
        if (behavior.transitionFailure === "malformed") {
          behavior.transitionFailure = null;
          return route.fulfill({ status: 200, contentType: "application/json", body: "not-json" });
        }
        if (behavior.transitionResponses.length > 0) {
          const response = behavior.transitionResponses.shift();
          return fulfill(response.status ?? 200, fixtureResponseBody(response));
        }
        if (behavior.transitionResponse !== null) {
          const response = behavior.transitionResponse;
          const status = behavior.transitionStatus;
          if (behavior.transitionResponseOnce) {
            behavior.transitionResponse = null;
            behavior.transitionResponseOnce = false;
            behavior.transitionStatus = 200;
          }
          return fulfill(status, response);
        }
        now += 1;
        row.status = action === "reenable" ? "active" : action === "disable" ? "disabled" : "revoked";
        row.revocation_seq += 1;
        row.updated_at = now;
        addEvent(action, row, body.reason ?? "");
        if (behavior.dropTransitionRow) {
          entitlements.splice(entitlements.indexOf(row), 1);
        }
        return fulfill(200, makeEnvelope(`entitlement_${action}d`, publicRecord(row)));
      }
    }

    return fulfill(404, { ok: false, code: "not_found", request_id: "ui-e2e-unhandled" });
  }

  return {
    route,
    requests,
    behavior,
    projectionState,
    catalogImportState,
    seed: { policy: seedPolicy, webhook: seedWebhook, catalogFeature: seedCatalogFeature, catalogPlan: seedCatalogPlan },
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

test("admin UI retains the server-owned four-entitlement batch limit", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  for (const [index, fingerprint] of ["a", "b", "c", "d", "e"].entries()) {
    await createForm.getByLabel("Feature").fill(`batch-${index}`);
    await createForm.getByLabel("Fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => api.requests.creates).toBe(index + 1);
  }
  const rowChecks = page.locator("tbody .checkCol input[type=checkbox]");
  await expect(rowChecks).toHaveCount(5);
  await page.getByLabel("Select all loaded rows").check();
  await expect(page.locator(".bulkBar")).toContainText("4 selected (maximum 4 per batch)");
  await expect(page.getByText("Select up to 4 entitlements per batch.", { exact: true })).toBeVisible();
  await expect(rowChecks.nth(4)).toBeDisabled();
  await page.locator(".bulkBar").getByRole("button", { name: "Disable" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("four-row free tier proof");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.batches.length).toBe(1);
  expect(api.requests.batches[0].ids).toHaveLength(4);
  expect(api.requests.batches[0].ids).not.toContain("ent-5");
});

test("admin UI previews and applies a license plan projection", async ({ page }) => {
  const api = makeAdminApiFixture();
  // Plan-feature policy IDs must resolve against the complete active-policy
  // selector, just as they do in the Worker contract.
  api.seed.policy("pol_node", "Node policy");
  api.seed.policy("pol_float", "Capacity policy");
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
  // Editing the manifest invalidates the previous persisted capability. Apply
  // cannot re-read the textarea or bypass a fresh Preview.
  await expect(importForm.getByRole("button", { name: "Apply import" })).toBeDisabled();
  await importForm.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(2);
  expect(api.requests.catalogImports[1]).toMatchObject({ dry_run: true, body: importedManifest, idempotency_key: null });
  await expect(page.getByText(/Server preview civ_ui_/)).toBeVisible();
  await expect(page.getByText(/Local manifest digest [0-9a-f]{64}/)).toBeVisible();
  const importDelta = page.locator("details").filter({ hasText: "Before → after" }).first();
  await expect(importDelta).toBeVisible();
  await importDelta.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(importDelta).toContainText("status");
  await importForm.getByRole("button", { name: "Apply import" }).click();
  const importDialog = page.getByRole("dialog");
  await expect(importDialog).toContainText("Apply catalog import");
  await expect(importDialog).toContainText("Features: 1 create, 0 update, 0 disable, 0 reenable, 0 unchanged");
  await expect(importDialog).toContainText("Server preview civ_ui_");
  expect(api.requests.catalogImports).toHaveLength(2);
  await importDialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(3);
  expect(api.requests.catalogImports[2]).toMatchObject({ dry_run: false, body: { preview_id: expect.stringMatching(/^civ_ui_/) } });
  expect(api.requests.catalogImports[2].idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  expect(Object.keys(api.requests.catalogImports[2].body)).toEqual(["preview_id"]);
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

  const applyButton = form.getByRole("button", { name: "Apply" });
  await expect(applyButton).toBeEnabled();
  await expect(page.getByText(/Server preview ppv_ui_/)).toBeVisible();
  await expect(page.getByText(/Local form digest [0-9a-f]{64}/)).toBeVisible();

  // Any projection-form edit invalidates the bound preview until the operator previews again.
  await form.getByLabel("Notes").fill("changed after preview");
  await expect(applyButton).toBeDisabled();
  await expect.poll(() => api.requests.planApplies.length).toBe(0);

  let expectedPreviews = 1;
  async function freshPreview() {
    await form.getByRole("button", { name: "Preview" }).click();
    expectedPreviews += 1;
    await expect.poll(() => api.requests.planPreviews.length).toBe(expectedPreviews);
    await expect(applyButton).toBeEnabled();
  }

  await freshPreview();
  expect(api.requests.planPreviews[1]).toMatchObject({
    notes: "changed after preview",
  });

  // Each successful catalog dependency mutation invalidates the projection binding.
  const coreFeatureRow = page.getByRole("row", { name: /Core Runtime core/ });
  await coreFeatureRow.getByRole("button", { name: "Edit" }).click();
  await featureForm.getByLabel("Name").fill("Core Runtime v2");
  await featureForm.getByRole("button", { name: "Update feature" }).click();
  await expect.poll(() => api.requests.catalogFeaturePatches.length).toBe(2);
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  await page.getByRole("row", { name: /Core Runtime v2 core/ }).getByRole("button", { name: "Disable" }).click();
  await page.getByLabel("Reason (required)").fill("invalidate projection feature");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogFeatureTransitions.length).toBe(3);
  await expect(applyButton).toBeDisabled();
  await page.getByRole("row", { name: /Core Runtime v2 core/ }).getByRole("button", { name: "Reenable" }).click();
  await expect.poll(() => api.requests.catalogFeatureTransitions.length).toBe(4);
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  const proPlanRow = page.getByRole("row", { name: /Pro Annual pro/ });
  await proPlanRow.getByRole("button", { name: "Edit" }).click();
  await catalogPlanForm.getByLabel("Description").fill("Annual plan v2");
  await catalogPlanForm.getByRole("button", { name: "Update plan" }).click();
  await expect.poll(() => api.requests.catalogPlanPatches.length).toBe(2);
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  await page.getByRole("row", { name: /Pro Annual pro/ }).getByRole("button", { name: "Disable" }).click();
  await page.getByLabel("Reason (required)").fill("invalidate projection plan");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogPlanTransitions.length).toBe(3);
  await expect(applyButton).toBeDisabled();
  await page.getByRole("row", { name: /Pro Annual pro/ }).getByRole("button", { name: "Reenable" }).click();
  await expect.poll(() => api.requests.catalogPlanTransitions.length).toBe(4);
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  await planFeatureForm.getByLabel("Feature key").fill("analytics");
  await planFeatureForm.getByLabel("Policy ID").fill("pol_node");
  await planFeatureForm.getByRole("button", { name: "Save plan feature" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatures.length).toBe(3);
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  const analyticsRow = page.getByRole("row", { name: /Analytics analytics included - pol_node/ });
  await analyticsRow.getByRole("button", { name: "Disable" }).click();
  await page.getByLabel("Reason (required)").fill("invalidate projection row");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatureTransitions.length).toBe(3);
  await expect(applyButton).toBeDisabled();
  await analyticsRow.getByRole("button", { name: "Reenable" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatureTransitions.length).toBe(4);
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  await importForm.getByLabel("Manifest JSON").fill(JSON.stringify(importedManifest));
  await expect(importForm.getByRole("button", { name: "Apply import" })).toBeDisabled();
  await importForm.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(4);
  await importForm.getByRole("button", { name: "Apply import" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(5);
  await expect(applyButton).toBeDisabled();
  await page.getByRole("row", { name: /Growth growth/ }).getByRole("button", { name: "Use" }).click();
  await form.getByLabel("Plan ID").fill("");
  await form.getByLabel("Plan key").fill("pro");
  await freshPreview();

  // Returning to the pane and refreshing its catalog data both require a new preview.
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  await page.getByRole("button", { name: "Plans", exact: true }).click();
  await expect(applyButton).toBeDisabled();
  await freshPreview();
  await page.locator(".tablePane .filters").first().locator("input").fill("DEFAULT");
  await expect(applyButton).toBeDisabled();
  await freshPreview();

  await applyButton.click();
  await expect.poll(() => api.requests.planApplies.length).toBe(1);
  expect(api.requests.planApplies[0]).toEqual({ preview_id: expect.stringMatching(/^ppv_ui_/) });
  await expect(applyButton).toBeDisabled();
  await expect(page.getByText(/Execution result; re-preview required before another Apply/)).toBeVisible();
  await expect(page.getByText(/license_plan_projection_applied/)).toBeVisible();

  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  await expect(page.getByRole("cell", { name: "core", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "team", exact: true })).toBeVisible();
  await expect(page.getByText("Mode floating")).toBeVisible();
  await expect(page.getByText("License lic_plan").first()).toBeVisible();
});

test("admin UI makes catalog-import Apply a modal, preview-bound, single-submit consequence", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();

  const form = page.getByRole("form", { name: "Catalog import" });
  const apply = form.getByRole("button", { name: "Apply import" });
  await expect(apply).toBeDisabled();
  const featureKey = `catalog_${"long_target_".repeat(7)}x`;
  const manifest = {
    format_version: 1,
    features: [{ project: "DEFAULT", feature_key: featureKey, name: "Long catalog target", description: "Consequence modal reflow proof" }],
    plans: [],
  };
  await form.getByLabel("Manifest JSON").fill(JSON.stringify(manifest));
  await form.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(1);
  await expect(apply).toBeEnabled();

  await apply.focus();
  await apply.click();
  let dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Apply this exact server-bound Preview");
  await expect(dialog).toContainText(featureKey);
  await expect(dialog.locator(".modalDetails")).toBeVisible();
  expect(api.requests.catalogImports).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const actionsBox = await dialog.locator(".actions").boundingBox();
  const viewport = page.viewportSize();
  expect(actionsBox).not.toBeNull();
  expect(actionsBox.y).toBeGreaterThanOrEqual(0);
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(viewport.height);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(apply).toBeFocused();
  expect(api.requests.catalogImports).toHaveLength(1);

  await apply.click();
  dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(apply).toBeFocused();
  expect(api.requests.catalogImports).toHaveLength(1);

  await apply.click();
  dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "Confirm" });
  api.behavior.deferMutations.add("catalog-import");
  await confirm.evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect.poll(() => api.requests.catalogImports.length).toBe(2);
  const applyRequest = api.requests.catalogImports[1];
  expect(applyRequest).toMatchObject({ dry_run: false, body: { preview_id: expect.stringMatching(/^civ_ui_/) } });
  expect(Object.keys(applyRequest.body)).toEqual(["preview_id"]);
  expect(applyRequest.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-import")).toBe(true);
  api.behavior.releaseMutations.get("catalog-import")();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-focus-section="catalog-import"] h2')).toBeFocused();
  expect(api.requests.catalogImports).toHaveLength(2);
});

test("admin UI reconciles an unknown catalog-import Apply with the original preview body and dialog key", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();

  const form = page.getByRole("form", { name: "Catalog import" });
  await form.getByLabel("Manifest JSON").fill(JSON.stringify({
    format_version: 1,
    features: [{ project: "DEFAULT", feature_key: "replay", name: "Replay" }],
    plans: [],
  }));
  await form.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(1);
  api.behavior.catalogImportAbortAfterApply = true;
  await form.getByRole("button", { name: "Apply import" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(2);
  const first = api.requests.catalogImports[1];
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(page.getByRole("button", { name: "Reconcile catalog import" })).toBeVisible();

  // The modal remains a true modal while the error is announced. Closing it
  // performs no second write and exposes the universal retained-attempt runner.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Reconcile catalog import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(3);
  const replay = api.requests.catalogImports[2];
  expect(replay.idempotency_key).toBe(first.idempotency_key);
  expect(replay.body).toEqual(first.body);
  expect(Object.keys(replay.body)).toEqual(["preview_id"]);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Replay replay/ })).toHaveCount(1);
});

test("admin UI surfaces catalog-import capability failures exactly and recovers known success with a current read", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const form = page.getByRole("form", { name: "Catalog import" });
  const manifest = JSON.stringify({
    format_version: 1,
    features: [{ project: "DEFAULT", feature_key: "capability", name: "Capability" }],
    plans: [],
  });
  const preview = async () => {
    await form.getByLabel("Manifest JSON").fill(manifest);
    await form.getByRole("button", { name: "Preview import" }).click();
    await expect.poll(() => api.requests.catalogImports.at(-1)?.dry_run).toBe(true);
  };
  const attempt = async () => {
    await form.getByRole("button", { name: "Apply import" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Confirm" }).click();
    return dialog;
  };

  await preview();
  api.catalogImportState.claimAsOtherOperator(api.catalogImportState.latestPreviewId());
  let dialog = await attempt();
  await expect(dialog.locator(".modalError")).toContainText("stale_catalog_import_preview — preview again");
  await expect(page.getByRole("row", { name: /Capability capability/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(form.getByRole("button", { name: "Apply import" })).toBeDisabled();

  await preview();
  api.catalogImportState.expire(api.catalogImportState.latestPreviewId());
  dialog = await attempt();
  await expect(dialog.locator(".modalError")).toContainText("expired_catalog_import_preview — preview again");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await preview();
  api.catalogImportState.claim(api.catalogImportState.latestPreviewId());
  dialog = await attempt();
  await expect(dialog.locator(".modalError")).toContainText("claimed_catalog_import_preview — preview again");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await preview();
  api.behavior.catalogImportApplyErrors.push("catalog_import_too_large");
  dialog = await attempt();
  await expect(dialog.locator(".modalError")).toContainText("catalog_import_too_large — preview again");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await preview();
  api.behavior.catalogImportReadFailures.push("response-error");
  dialog = await attempt();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(form.getByRole("button", { name: "Apply import" })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(page.locator('[data-focus-section="catalog-import"] h2')).toBeFocused();
  await expect(page.getByRole("row", { name: /Capability capability/ })).toHaveCount(1);
});

test("admin UI clears its bound preview for stale and fingerprint-conflict Apply responses", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans" }).click();

  const featureForm = page.getByRole("form", { name: "Catalog feature" });
  await featureForm.getByLabel("Feature key").fill("core");
  await featureForm.getByLabel("Name").fill("Core");
  await featureForm.getByRole("button", { name: "Create feature" }).click();
  const planForm = page.getByRole("form", { name: "Catalog plan" });
  await planForm.getByLabel("Plan key").fill("pro");
  await planForm.getByLabel("Name").fill("Pro");
  await planForm.getByRole("button", { name: "Create plan" }).click();
  const planFeatureForm = page.getByRole("form", { name: "Plan feature" });
  await planFeatureForm.getByLabel("Feature key").fill("core");
  await planFeatureForm.getByRole("button", { name: "Save plan feature" }).click();

  const projectionForm = page.getByRole("form", { name: "Plan projection" });
  await projectionForm.getByLabel("License ID").fill("lic_stale");
  await projectionForm.getByLabel("Fingerprint").fill("d".repeat(64));
  await projectionForm.getByLabel("Plan key").fill("pro");
  await projectionForm.getByRole("button", { name: "Preview" }).click();
  const applyButton = projectionForm.getByRole("button", { name: "Apply" });
  await expect(applyButton).toBeEnabled();

  api.projectionState.staleNextPlanApply = true;
  await applyButton.click();
  await expect(page.getByText(/stale_projection_preview.*preview again/)).toBeVisible();
  await expect(applyButton).toBeDisabled();
  await projectionForm.getByRole("button", { name: "Preview" }).click();
  await expect(applyButton).toBeEnabled();

  api.projectionState.nextPlanApplyError = "license_fingerprint_conflict";
  await applyButton.click();
  await expect(page.getByText(/license_fingerprint_conflict.*preview again/)).toBeVisible();
  await expect(applyButton).toBeDisabled();
  // Both simulated 409s return before the fixture's entitlement/event/assignment
  // mutation path; the UI has only sent the server-bound preview_id.
  expect(api.requests.planApplies).toHaveLength(2);
  expect(api.requests.planApplies.every((body) => Object.keys(body).length === 1 && typeof body.preview_id === "string")).toBe(true);
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
  await expect.poll(() => api.requests.releaseSeats.length).toBe(2);
  expect(api.requests.releaseSeats[0].reason).toBe("dead machine");
  expect(api.requests.releaseSeats[1].idempotencyKey).toBe(api.requests.releaseSeats[0].idempotencyKey);
  expect(api.requests.releaseSeats[1].rawBody).toBe(api.requests.releaseSeats[0].rawBody);
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
  await expect(page.locator(".fulfillmentSpark .rangeSelector button.active")).toHaveText("last 30d");

  // No secret material ever leaks into the rendered DOM.
  const pageText = await page.locator("body").innerText();
  expect(pageText).not.toContain("PRIVATE KEY");
  expect(pageText).not.toContain("Bearer ");
});

test("admin UI keeps destructive operator actions consequence-led, reason-gated, and cancellable", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.policy();
  api.seed.webhook();
  api.seed.catalogFeature();
  await page.route("**/api/admin/**", api.route);

  async function assertConfirmation(button, consequence, dismissWithEscape = false) {
    await button.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(consequence);
    const confirm = dialog.getByRole("button", { name: "Confirm" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Reason (required)").fill("operator review");
    await expect(confirm).toBeEnabled();
    if (dismissWithEscape) {
      await page.keyboard.press("Escape");
    } else {
      await dialog.getByRole("button", { name: "Cancel" }).click();
    }
    await expect(dialog).toHaveCount(0);
  }

  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const entitlementRow = page.locator(".tablePane > table tbody tr").first();
  await assertConfirmation(entitlementRow.getByRole("button", { name: "Disable", exact: true }), "Verification and downloads stop until it is re-enabled", true);
  await assertConfirmation(entitlementRow.getByRole("button", { name: "Revoke", exact: true }), "TERMINAL and cannot be undone");
  await assertConfirmation(entitlementRow.getByRole("button", { name: "Release seats", exact: true }), "dead/unreachable machine");
  expect(api.requests.transitions).toHaveLength(0);
  expect(api.requests.releaseSeats).toHaveLength(0);

  await entitlementRow.getByRole("button", { name: "Devices", exact: true }).click();
  const devicePane = page.locator('[aria-label="Registered devices"]');
  await expect(devicePane).toBeVisible();
  await assertConfirmation(devicePane.getByRole("button", { name: "Disable", exact: true }), "refused on its next online check");
  await assertConfirmation(devicePane.getByRole("button", { name: "Revoke", exact: true }), "TERMINAL");
  expect(api.requests.deviceTransitions).toHaveLength(0);

  await page.getByRole("button", { name: "Customers", exact: true }).click();
  await page.getByRole("button", { name: "cus_acme", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Acme Corp" })).toBeVisible();
  await assertConfirmation(page.getByRole("button", { name: "Disable", exact: true }), "customer-portal access");
  expect(api.requests.customerTransitions).toHaveLength(0);

  await page.getByRole("button", { name: "Policies", exact: true }).click();
  const policyRow = page.locator("tr").filter({ hasText: "Confirm policy" });
  await expect(policyRow).toBeVisible();
  await assertConfirmation(policyRow.getByRole("button", { name: "Disable", exact: true }), "already-stamped entitlements are frozen and unaffected");
  expect(api.requests.policyTransitions).toHaveLength(0);

  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const catalogFeatureRow = page.locator("tr").filter({ hasText: "Confirm feature" });
  await expect(catalogFeatureRow).toBeVisible();
  await assertConfirmation(catalogFeatureRow.getByRole("button", { name: "Disable", exact: true }), "New plan projections skip disabled feature definitions");
  expect(api.requests.catalogFeatureTransitions).toHaveLength(0);

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const webhookRow = page.locator("tr").filter({ hasText: "https://hooks.example.test/confirm" });
  await expect(webhookRow).toBeVisible();
  await assertConfirmation(webhookRow.getByRole("button", { name: "Disable", exact: true }), "queued or failed deliveries already recorded are unaffected");
  expect(api.requests.webhookTransitions).toHaveLength(0);
});

test("admin UI consequence dialogs contain focus, isolate the background, and reflow long targets", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();

  const project = `project-${"long-segment-".repeat(8)}`;
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill(project);
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  const trigger = row.getByRole("button", { name: "Disable", exact: true });
  await trigger.focus();
  await trigger.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-labelledby", /confirm-title-/);
  await expect(dialog).toHaveAttribute("aria-describedby", /confirm-description-/);
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await expect(page.locator("main")).toHaveAttribute("aria-hidden", "true");
  await expect(dialog).toContainText(project);
  await dialog.locator(".modalSurface").evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(dialog).toBeVisible();

  const reason = dialog.getByLabel("Reason (required)");
  const confirm = dialog.getByRole("button", { name: "Confirm" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(reason).toBeFocused();
  await reason.fill("operator review");
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(reason).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await dialog.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const actionsBox = await dialog.locator(".actions").boundingBox();
  const viewport = page.viewportSize();
  expect(actionsBox).not.toBeNull();
  expect(actionsBox.y).toBeGreaterThanOrEqual(0);
  expect(actionsBox.y + actionsBox.height).toBeLessThanOrEqual(viewport.height);

  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await expect(page.locator("main")).not.toHaveAttribute("aria-hidden", "true");

  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(dialog).toBeVisible();
  await reason.fill("operator review");
  api.behavior.deferTransition = true;
  await confirm.evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByRole("status")).toContainText("Working");
  await expect(cancel).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await cancel.evaluate((element) => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await expect.poll(() => api.behavior.releaseTransition).not.toBeNull();
  api.behavior.releaseTransition();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI fallback consequence dialogs keep the background inert", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: undefined });
    } catch {
      HTMLDialogElement.prototype.showModal = undefined;
    }
  });
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("fallback");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const trigger = page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Disable", exact: true });
  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(page.locator(".modalOverlay")).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await expect(dialog.getByLabel("Reason (required)")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
});

test("admin UI typed failures keep consequence dialogs open and restore focus", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("typed-failure");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const trigger = page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Disable", exact: true });
  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  const reason = dialog.getByLabel("Reason (required)");
  await reason.fill("operator review");
  api.behavior.transitionStatus = 400;
  // This is a documented pre-mutation rejection.  An arbitrary 4xx code
  // would be indeterminate and must instead keep the original attempt.
  api.behavior.transitionResponse = { ok: false, code: "reason_required", request_id: "ui-e2e-transition-failed" };
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  const retryableKey = api.requests.transitions[0].idempotencyKey;
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-busy", "false");
  await expect(dialog.locator(".modalError")).toContainText("reason_required");
  await expect(dialog.locator(".modalError")).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(2);
  // A definitive pre-mutation failure ends the attempt.  A subsequent
  // editable retry therefore receives a new key rather than reusing it.
  expect(api.requests.transitions[1].idempotencyKey).not.toBe(retryableKey);
  const secondRetryableKey = api.requests.transitions[1].idempotencyKey;
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

  api.behavior.transitionResponse = null;
  api.behavior.transitionStatus = 200;
  api.behavior.abortTransition = true;
  await trigger.click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(3);
  expect(api.requests.transitions[2].idempotencyKey).not.toBe(secondRetryableKey);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".modalError")).toBeVisible();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.locator(".modalError")).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  await expect.poll(() => api.requests.transitions.length).toBe(3);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  // The unresolved owner deliberately disables the original destructive
  // trigger; focus must still remain in a usable in-app target, never BODY.
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(page.locator(".operatorNotice")).toContainText("Other actions are unavailable until reconciliation completes.");
  await expect(createForm.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reconcile status" })).toBeVisible();
  const unknownKey = api.requests.transitions[2].idempotencyKey;
  // An unresolved owner exposes the recovery path and disables the source
  // action; it must not silently accept a second destructive submission.
  await expect(trigger).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(api.requests.transitions.filter((item) => item.action === "disable").length).toBe(3);
  expect(api.requests.transitions[2].idempotencyKey).toBe(unknownKey);

  api.behavior.abortTransition = false;
  const beforeReplay = api.requests.transitions.length;
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect.poll(() => api.requests.transitions.length).toBe(beforeReplay + 1);
  expect(api.requests.transitions[3].idempotencyKey).toBe(unknownKey);
  expect(api.requests.transitions[3].body).toEqual(api.requests.transitions[2].body);
  await expect(page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
});

test("admin UI direct re-enable replays an unknown mutation with the same key", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("direct-reenable-unknown");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("e".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.abortTransition = true;
  const reenable = row.getByRole("button", { name: "Reenable", exact: true });
  await reenable.focus();
  await reenable.click();
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(1);
  await expect(reenable).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await expect(page.getByRole("button", { name: "Reconcile status" })).toBeVisible();
  api.behavior.abortTransition = false;
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(row.locator(".status")).toBeFocused();
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(2);
  const reenableRequests = api.requests.transitions.filter((item) => item.action === "reenable");
  expect(reenableRequests[1].idempotencyKey).toBe(reenableRequests[0].idempotencyKey);
  expect(reenableRequests[1].body).toEqual(reenableRequests[0].body);
});

test("admin UI keeps a wrong-action reason_required rejection indeterminate", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("wrong-action-reason");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("r".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.transitionStatus = 400;
  api.behavior.transitionResponse = { ok: false, code: "reason_required", request_id: "ui-e2e-wrong-action-reason" };
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
  const attempts = () => api.requests.transitions.filter((item) => item.action === "reenable");
  await expect.poll(() => attempts().length).toBe(1);
  const key = attempts()[0].idempotencyKey;
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

  api.behavior.transitionStatus = 200;
  api.behavior.transitionResponse = null;
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect.poll(() => attempts().length).toBe(2);
  expect(attempts()[1].idempotencyKey).toBe(key);
  expect(attempts()[1].body).toEqual(attempts()[0].body);
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
});

test("admin UI keeps every same-key replay failure indeterminate until exact success", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("replay-outcomes");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("o".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.abortTransition = true;
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  const attempts = () => api.requests.transitions.filter((item) => item.action === "reenable");
  const first = attempts()[0];

  // Network/response loss on the replay is indeterminate: the notice and key remain.
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect.poll(() => attempts().length).toBe(2);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  expect(attempts()[1].idempotencyKey).toBe(first.idempotencyKey);
  expect(attempts()[1].body).toEqual(first.body);

  // A replay conflict cannot prove that the original ambiguous request did
  // not commit. It remains retained with the exact original key/body; only
  // a replay exact success may settle this attempt.
  api.behavior.abortTransition = false;
  api.behavior.transitionStatus = 409;
  api.behavior.transitionResponse = { ok: false, code: "revoked_entitlement_is_terminal", request_id: "ui-e2e-replay-conflict" };
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect.poll(() => attempts().length).toBe(3);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  expect(attempts()[2].idempotencyKey).toBe(first.idempotencyKey);
  expect(attempts()[2].body).toEqual(first.body);

  api.behavior.transitionResponse = null;
  api.behavior.transitionStatus = 200;
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect.poll(() => attempts().length).toBe(4);
  expect(attempts()[3].idempotencyKey).toBe(first.idempotencyKey);
  expect(attempts()[3].body).toEqual(first.body);
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
});

test("admin UI rejects a partial successful mutation envelope as unknown", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("partial-mutation");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("p".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const trigger = page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.transitionResponse = {
    ok: true,
    code: "entitlement_disabled",
    request_id: "ui-e2e-partial",
    data: {
      project: "partial-mutation",
      feature: "float",
      license_fingerprint: "p".repeat(64),
      status: "disabled",
      revocation_seq: 2,
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI rejects a non-2xx response carrying a successful mutation envelope", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("http-status");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("h".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const trigger = page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.transitionStatus = 500;
  api.behavior.transitionResponseOnce = true;
  api.behavior.transitionResponse = {
    ok: true,
    code: "entitlement_disabled",
    request_id: "ui-e2e-http-status",
    data: {
      id: "ent-1",
      project: "http-status",
      feature: "float",
      license_fingerprint: "h".repeat(64),
      status: "disabled",
      revocation_seq: 2,
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
});

test("admin UI treats a well-formed 5xx rejection envelope as an unknown mutation", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("five-hundred-rejection");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("v".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const trigger = page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.transitionStatus = 503;
  api.behavior.transitionResponse = { ok: false, code: "mutation_failed", request_id: "ui-e2e-five-hundred" };
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
});

test("admin UI rejects duplicate batch result identities as unknown", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();

  async function createEntitlement(feature, fingerprint) {
    const createForm = page.locator("aside form");
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("Fingerprint").fill(fingerprint);
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }
  await createEntitlement("batch-one", "a".repeat(64));
  await createEntitlement("batch-two", "b".repeat(64));
  await page.getByLabel("Select all loaded rows").check();
  await page.locator(".bulkBar").getByRole("button", { name: "Disable" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("operator review");
  api.behavior.batchResponse = {
    ok: true,
    code: "batch_done",
    request_id: "ui-e2e-batch-duplicate",
    data: {
      results: [
        { id: "ent-1", ok: true, code: "entitlement_disabled" },
        { id: "ent-1", ok: true, code: "entitlement_disabled" },
      ],
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.batches.length).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI rejects substituted batch result identities as unknown", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();

  async function createEntitlement(feature, fingerprint) {
    const createForm = page.locator("aside form");
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("Fingerprint").fill(fingerprint);
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }
  await createEntitlement("batch-one", "a".repeat(64));
  await createEntitlement("batch-two", "b".repeat(64));
  await page.getByLabel("Select all loaded rows").check();
  await page.locator(".bulkBar").getByRole("button", { name: "Disable" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("operator review");
  api.behavior.batchResponse = {
    ok: true,
    code: "batch_done",
    request_id: "ui-e2e-batch-substitution",
    data: {
      results: [
        { id: "ent-1", ok: true, code: "entitlement_disabled" },
        { id: "ent-3", ok: true, code: "entitlement_disabled" },
      ],
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.batches.length).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI reports a known partial batch outcome when every row identity and code are exact", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();

  const createForm = page.locator("aside form");
  for (const [index, [feature, fingerprint]] of [["batch-exact-one", "u"], ["batch-exact-two", "v"]].entries()) {
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("Fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => api.requests.creates).toBe(index + 1);
    await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(index + 1);
  }
  await page.getByLabel("Select all loaded rows").check();
  await page.locator(".bulkBar").getByRole("button", { name: "Disable" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("operator review");
  api.behavior.batchResponse = {
    ok: true,
    code: "batch_done",
    request_id: "ui-e2e-batch-partial-row",
    data: {
      results: [
        { id: "ent-1", ok: true, code: "entitlement_disabled" },
        { id: "ent-2", ok: false, code: "not_found" },
      ],
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.batches.length).toBe(1);
  expect(api.requests.batches[0].ids).toEqual(["ent-1", "ent-2"]);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/disable: 1 ok, 1 not-found/)).toBeVisible();
});

test("admin UI rejects an unknown per-row batch failure code as ambiguous", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  for (const [feature, fingerprint] of [["batch-code-one", "c"], ["batch-code-two", "d"]]) {
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("Fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }
  await page.getByLabel("Select all loaded rows").check();
  await page.locator(".bulkBar").getByRole("button", { name: "Disable" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("operator review");
  api.behavior.batchResponse = {
    ok: true,
    code: "batch_done",
    request_id: "ui-e2e-batch-unknown-row-code",
    data: {
      results: [
        { id: "ent-1", ok: true, code: "entitlement_disabled" },
        { id: "ent-2", ok: false, code: "undocumented_batch_failure" },
      ],
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
});

test("admin UI rejects reordered batch proof rows as an unknown outcome", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();

  const createForm = page.locator("aside form");
  for (const [index, [feature, fingerprint]] of [["batch-order-one", "w"], ["batch-order-two", "x"]].entries()) {
    await createForm.getByLabel("Feature").fill(feature);
    await createForm.getByLabel("Fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => api.requests.creates).toBe(index + 1);
    await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(index + 1);
  }
  await page.getByLabel("Select all loaded rows").check();
  await page.locator(".bulkBar").getByRole("button", { name: "Disable" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("operator review");
  api.behavior.batchResponse = {
    ok: true,
    code: "batch_done",
    request_id: "ui-e2e-batch-reordered",
    data: {
      results: [
        { id: "ent-2", ok: true, code: "entitlement_disabled" },
        { id: "ent-1", ok: true, code: "entitlement_disabled" },
      ],
    },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.batches.length).toBe(1);
  expect(api.requests.batches[0].ids).toEqual(["ent-1", "ent-2"]);
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
});

test("admin UI rejects duplicate release-seat identities as unknown", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("r".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  await page.locator(".reason").getByLabel("Reason", { exact: true }).fill("dead machine");
  await page.getByRole("button", { name: "Release seats" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/Reason/).fill("dead machine");
  api.behavior.releaseSeatsResponse = {
    ok: true,
    code: "seats_released",
    request_id: "ui-e2e-release-duplicate",
    data: { released: 2, seat_ids: ["seat_1", "seat_1"] },
  };
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.releaseSeats.length).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI rejects a device transition that proves a different entitlement", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("device-evidence");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("e".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Devices", exact: true }).click();
  const devices = page.getByRole("region", { name: "Registered devices" });
  await expect(devices.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
  await devices.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.deviceTransitionResponse = (parent, action) => makeEnvelope(`device_${action}d`, {
    ...parent,
    id: "ent-not-selected",
    status: "disabled",
    revocation_seq: parent.revocation_seq + 1,
  });
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.deviceTransitions.length).toBe(1);
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
});

test("admin UI gates ordinary mutations while consequence recovery is pending", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("recovery-gate");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("q".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.refreshFailures = ["response-error"];
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh status" })).toBeVisible();
  api.behavior.deferRefresh = true;
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await refreshButton.click();
  await expect.poll(() => api.behavior.releaseRefresh).not.toBeNull();
  const createsBefore = api.requests.creates;
  // The unresolved owner makes the lock explicit instead of accepting a
  // silent no-op from an otherwise editable form.
  await expect(createForm.getByLabel("Project")).toBeDisabled();
  await expect(createForm.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(api.requests.creates).toBe(createsBefore);
  api.behavior.deferRefresh = false;
  api.behavior.releaseRefresh();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
});

test("admin UI gates ordinary mutations through the post-success refresh", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("post-success-gate");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("y".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.deferRefresh = true;
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
  await expect.poll(() => api.behavior.releaseRefresh).not.toBeNull();
  const createsBefore = api.requests.creates;
  await createForm.getByLabel("Project").fill("must-not-overlap");
  await expect(createForm.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(api.requests.creates).toBe(createsBefore);
  api.behavior.releaseRefresh();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeDisabled();
});

test("admin UI direct re-enable treats a malformed mutation response as unknown", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("direct-reenable-malformed");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("h".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.transitionFailure = "malformed";
  const reenable = row.getByRole("button", { name: "Reenable", exact: true });
  await reenable.click();
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(1);
  await expect(reenable).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI direct re-enable keeps parsed refresh recovery visible", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("direct-reenable-refresh");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("g".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.refreshFailures = ["response-error", "response-error"];
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
  await expect.poll(() => api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeDisabled();
  await expect(row.locator(".status")).toBeFocused();
});

test("admin UI settles a same-key reconciliation across a stale filter context without stealing focus", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("stale-unknown");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("s".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const filter = page.locator('input[placeholder="project"]');
  await filter.fill("stale-unknown");
  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.abortTransition = true;
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reconcile status" })).toBeVisible();
  const unknownAttempt = api.requests.transitions.at(-1);
  api.behavior.deferTransition = true;
  api.behavior.abortTransition = false;
  const reconcile = page.locator(".operatorNotice button");
  await reconcile.click();
  await expect.poll(() => api.behavior.releaseTransition).not.toBeNull();
  await filter.fill("no-such-project");
  api.behavior.deferTransition = false;
  api.behavior.releaseTransition();
  await expect(filter).toBeFocused();
  // An exact same-key success resolves the global owner even when the source
  // list has since been superseded.  The stale source must not reclaim focus.
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  const replay = api.requests.transitions.at(-1);
  expect(api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(2);
  expect(replay.idempotencyKey).toBe(unknownAttempt.idempotencyKey);
  expect(replay.body).toEqual(unknownAttempt.body);

  await filter.fill("stale-unknown");
  await expect(page.locator(".tablePane > table tbody tr").first()).toBeVisible();
  await expect(page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Reenable", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI settles an ABA filter switch after an exact same-key replay", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("aba-replay");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("z".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const filter = page.locator('input[placeholder="project"]');
  await filter.fill("aba-replay");
  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.abortTransition = true;
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reconcile status" })).toBeVisible();
  const firstReplayCandidate = api.requests.transitions.at(-1);

  api.behavior.abortTransition = false;
  api.behavior.deferRefresh = true;
  const reconcile = page.locator(".operatorNotice button");
  await reconcile.click();
  await expect.poll(() => api.behavior.releaseRefresh).not.toBeNull();
  await expect(reconcile).toHaveText("Refreshing…");
  await filter.fill("not-aba-replay");
  await expect.poll(() => api.requests.entitlementReads.at(-1)).toBe("not-aba-replay");
  await filter.fill("aba-replay");
  await expect.poll(() => api.requests.entitlementReads.at(-1)).toBe("aba-replay");
  api.behavior.deferRefresh = false;
  api.behavior.releaseRefresh();

  await expect(filter).toBeFocused();
  // The replay's original strict GET started before the A → B → A switch, so
  // it cannot prove the final A view. A current-context GET-only recovery can.
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  const replay = api.requests.transitions.at(-1);
  expect(replay.idempotencyKey).toBe(firstReplayCandidate.idempotencyKey);
  expect(replay.rawBody).toBe(firstReplayCandidate.rawBody);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI keeps unresolved recovery exclusive without stealing focus after a filter change", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("context-bound");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("i".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();

  api.behavior.refreshFailures = ["response-error"];
  await row.getByRole("button", { name: "Reenable", exact: true }).click();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  const transitionCount = api.requests.transitions.filter((item) => item.action === "reenable").length;
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  expect(api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(transitionCount);

  api.behavior.deferRefresh = true;
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await refreshButton.click();
  await expect.poll(() => api.behavior.releaseRefresh).not.toBeNull();
  api.behavior.deferRefresh = false;
  const filter = page.locator('input[placeholder="project"]');
  await filter.fill("no-such-project");
  api.behavior.releaseRefresh();
  await expect(filter).toBeFocused();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  expect(api.requests.transitions.filter((item) => item.action === "reenable").length).toBe(transitionCount);
  await filter.fill("");
  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI discards stale device recovery after filter supersession while actions are locked", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  for (const [project, fingerprint] of [["device-one", "j"], ["device-two", "k"]]) {
    await createForm.getByLabel("Project").fill(project);
    await createForm.getByLabel("Feature").fill("float");
    await createForm.getByLabel("Fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }

  await page.getByRole("button", { name: "Devices", exact: true }).nth(0).click();
  const devices = page.getByRole("region", { name: "Registered devices" });
  await expect(devices).toBeVisible();
  await expect.poll(() => api.requests.deviceReads.at(-1)).toBe("ent-1");
  await expect(devices.locator(".mono")).toContainText("sha256:bbbbbbbb");

  api.behavior.deviceRefreshFailures = ["response-error"];
  await devices.getByRole("button", { name: "Disable", exact: true }).click();
  const disableDialog = page.getByRole("dialog");
  await disableDialog.getByLabel("Reason (required)").fill("operator review");
  await disableDialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.deviceTransitions.length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");

  // The retained recovery owns the operation gate, so switching device rows
  // is visibly unavailable. A still-editable filter can supersede the source
  // context without granting an overlapping mutation.
  await expect(page.getByRole("button", { name: "Devices", exact: true }).nth(1)).toBeDisabled();
  api.behavior.deferDeviceRefresh = true;
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await refreshButton.click();
  await expect.poll(() => api.behavior.releaseDeviceRefresh).not.toBeNull();
  const filter = page.locator('input[placeholder="project"]');
  await filter.fill("device-two");
  await expect.poll(() => api.requests.entitlementReads.at(-1)).toBe("device-two");
  api.behavior.deferDeviceRefresh = false;
  api.behavior.releaseDeviceRefresh();
  await expect(filter).toBeFocused();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await filter.fill("");
  await expect.poll(() => api.requests.entitlementReads.at(-1)).toBe("");
  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(devices.locator(".mono")).toContainText("sha256:bbbbbbbb");
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI loads every active-policy selector page and accepts production nullable read fields", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.policy("pol_first", "First policy");
  api.seed.policy("pol_second", "Second policy");
  api.seed.webhook();
  api.behavior.activePolicyPagination = true;
  api.behavior.deliveryPagination = true;
  api.behavior.licenseRows = [{ id: "lic_null", customer_id: null, project: "DEFAULT", label: null, created_at: 1_760_000_000, updated_at: 1_760_000_000 }];
  api.behavior.orderRows = [{ event_id: "evt-string-id", subscription_id: "sub_string", project: "DEFAULT", feature: "pro", order_epoch: 1, seq: 1, intent: "upsert", key_id: null, status: "accepted", received_at: 1_760_000_000, processed_at: null, stale: false }];
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const policySelect = page.locator("aside form").getByLabel("Policy (optional)");
  await expect(policySelect.locator("option")).toHaveCount(3);
  await expect(policySelect).toContainText("First policy");
  await expect(policySelect).toContainText("Second policy");

  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const policyOptions = page.locator("#active-policy-ids option");
  await expect(policyOptions).toHaveCount(2);
  await expect(policyOptions.nth(1)).toHaveAttribute("value", "pol_second");

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const endpointRow = page.locator(".tablePane > table tbody tr").first();
  await endpointRow.getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  const deliveriesMore = deliveries.getByRole("button", { name: "Load more" });
  await expect(deliveriesMore).toBeVisible();
  await deliveriesMore.click();
  await expect(deliveries.locator("tbody tr")).toHaveCount(2);

  await page.getByRole("button", { name: "Licenses", exact: true }).click();
  await expect(page.locator(".tablePane tbody tr")).toContainText("lic_null");
  await expect(page.locator(".tablePane tbody tr")).toContainText("-");

  await page.getByRole("button", { name: "Fulfillment", exact: true }).click();
  await expect(page.locator(".tablePane tbody tr")).toContainText("sub_string");
});

test("admin UI fences duplicate and stale load-more appends for deliveries, orders, and expiring rows", async ({ page }) => {
  const api = makeAdminApiFixture();
  const endpoint = api.seed.webhook("wh_pagination", "https://hooks.example.test/pagination");
  api.behavior.deliveryPagination = true;
  api.behavior.deliveryRows = [
    { id: 101, endpoint_id: endpoint.id, event_id: 101, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
    { id: 102, endpoint_id: endpoint.id, event_id: 102, event_source: "entitlement", event_type: "disabled", status: "failed", attempts: 2, last_status: 503, last_error: "retry", next_attempt_at: 1_760_000_010, created_at: 1_760_000_010, delivered_at: null },
  ];
  api.behavior.ordersPagination = true;
  api.behavior.orderRows = [
    { event_id: "evt_accept", subscription_id: "sub_page", project: "DEFAULT", feature: "pro", order_epoch: 1, seq: 1, intent: "upsert", key_id: null, status: "accepted", received_at: 1_760_000_000, processed_at: null, stale: false },
    { event_id: "evt_reject", subscription_id: "sub_page", project: "DEFAULT", feature: "pro", order_epoch: 1, seq: 2, intent: "upsert", key_id: null, status: "rejected", received_at: 1_760_000_001, processed_at: null, stale: false },
  ];
  api.behavior.expiringPagination = true;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  await page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  const deliveriesMore = deliveries.getByRole("button", { name: "Load more", exact: true });
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  api.behavior.deferReads.add(`deliveries:${endpoint.id}:deliveries-next`);
  await deliveriesMore.click({ noWaitAfter: true });
  await deliveriesMore.click({ noWaitAfter: true });
  await expect.poll(() => api.requests.deliveryCursors.filter((cursor) => cursor === "deliveries-next").length).toBe(1);
  await expect.poll(() => api.behavior.releaseReads.has(`deliveries:${endpoint.id}:deliveries-next`)).toBe(true);
  await deliveries.getByRole("combobox").selectOption("delivered");
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  api.behavior.releaseReads.get(`deliveries:${endpoint.id}:deliveries-next`)();
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await expect(deliveries).not.toContainText("retry");

  await page.getByRole("button", { name: "Fulfillment", exact: true }).click();
  const fulfillment = page.locator("section.tablePane.full").filter({ has: page.locator('input[placeholder="subscription_id"]') });
  const ordersMore = fulfillment.getByRole("button", { name: "Load more", exact: true });
  await expect(fulfillment.locator("tbody tr")).toHaveCount(1);
  api.behavior.deferReads.add("orders:orders-next");
  await ordersMore.click({ noWaitAfter: true });
  await ordersMore.click({ noWaitAfter: true });
  await expect.poll(() => api.requests.orderCursors.filter((cursor) => cursor === "orders-next").length).toBe(1);
  await expect.poll(() => api.behavior.releaseReads.has("orders:orders-next")).toBe(true);
  await fulfillment.getByRole("combobox").selectOption("accepted");
  await expect(fulfillment.locator("tbody tr")).toHaveCount(1);
  api.behavior.releaseReads.get("orders:orders-next")();
  await expect(fulfillment.locator("tbody tr")).toHaveCount(1);
  await expect(fulfillment).not.toContainText("evt_reject");

  await page.getByRole("button", { name: "Reports", exact: true }).click();
  const expiring = page.locator(".expiringPanel");
  const expiringMore = expiring.getByRole("button", { name: "Load more", exact: true });
  await expect(expiring.locator("tbody tr")).toHaveCount(1);
  api.behavior.deferReads.add("expiring:30:expiring-next");
  await expiringMore.click({ noWaitAfter: true });
  await expiringMore.click({ noWaitAfter: true });
  await expect.poll(() => api.requests.expiringCursors.filter((cursor) => cursor === "expiring-next").length).toBe(1);
  await expect.poll(() => api.behavior.releaseReads.has("expiring:30:expiring-next")).toBe(true);
  await page.getByRole("group", { name: "Expiring horizon" }).getByRole("button", { name: "7d", exact: true }).click();
  await expect(expiring).toContainText("pro-7");
  api.behavior.releaseReads.get("expiring:30:expiring-next")();
  await expect(expiring).toContainText("pro-7");
  await expect(expiring).not.toContainText("pro-30");
});

test("admin UI retires contract-invalid null, scalar, and envelope append cursors across shared and custom pagers", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan("plan_invalid_one", "DEFAULT", "invalid-one");
  api.seed.catalogPlan("plan_invalid_two", "DEFAULT", "invalid-two");
  api.behavior.catalogPlanPagination = true;
  api.behavior.catalogPlanAppendResponses.push({
    status: 200,
    // Explicit JSON null must not silently fall back to the fixture object.
    body: null,
  });
  const endpoint = api.seed.webhook("wh_invalid_append", "https://hooks.example.test/invalid-append");
  api.behavior.deliveryPagination = true;
  api.behavior.deliveryRows = [
    { id: 501, endpoint_id: endpoint.id, event_id: 1, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
    { id: 502, endpoint_id: endpoint.id, event_id: 2, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
  ];
  api.behavior.deliveryAppendResponses.push({
    status: 200,
    body: "not-an-envelope",
  });
  api.behavior.ordersPagination = true;
  api.behavior.orderRows = [
    { event_id: "evt_invalid_one", subscription_id: "sub_invalid", project: "DEFAULT", feature: "pro", order_epoch: 1, seq: 1, intent: "upsert", key_id: null, status: "accepted", received_at: 1_760_000_000, processed_at: null, stale: false },
    { event_id: "evt_invalid_two", subscription_id: "sub_invalid", project: "DEFAULT", feature: "pro", order_epoch: 1, seq: 2, intent: "upsert", key_id: null, status: "accepted", received_at: 1_760_000_001, processed_at: null, stale: false },
  ];
  api.behavior.orderAppendResponses.push({
    status: 200,
    body: { ok: true, code: "orders_listed", request_id: "ui-e2e-invalid-order-append", data: { items: [], summary: { accepted: 0 }, stale_secs: 300, next_cursor: null } },
  });
  api.behavior.expiringPagination = true;
  api.behavior.expiringAppendResponses.push({
    status: 200,
    body: false,
  });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const plansPane = page.getByRole("heading", { name: "Catalog plans" }).locator("..");
  const plansMore = plansPane.getByRole("button", { name: "Load more", exact: true });
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await plansMore.click();
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await expect(plansMore).toHaveCount(0);

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  await page.locator(".tablePane > table tbody tr").filter({ hasText: endpoint.url }).getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  const deliveriesMore = deliveries.getByRole("button", { name: "Load more", exact: true });
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await deliveriesMore.click();
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await expect(deliveriesMore).toHaveCount(0);

  await page.getByRole("button", { name: "Fulfillment", exact: true }).click();
  const fulfillment = page.locator("section.tablePane.full").filter({ has: page.locator('input[placeholder="subscription_id"]') });
  const ordersMore = fulfillment.getByRole("button", { name: "Load more", exact: true });
  await expect(fulfillment.locator("tbody tr")).toHaveCount(1);
  await ordersMore.click();
  await expect(fulfillment.locator("tbody tr")).toHaveCount(1);
  await expect(ordersMore).toHaveCount(0);

  await page.getByRole("button", { name: "Reports", exact: true }).click();
  const expiring = page.locator(".expiringPanel");
  const expiringMore = expiring.getByRole("button", { name: "Load more", exact: true });
  await expect(expiring.locator("tbody tr")).toHaveCount(1);
  await expiringMore.click();
  await expect(expiring.locator("tbody tr")).toHaveCount(1);
  await expect(expiringMore).toHaveCount(0);
});

test("admin UI keeps 5xx null and scalar append cursors retryable", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan("plan_retry_one", "DEFAULT", "retry-one");
  api.seed.catalogPlan("plan_retry_two", "DEFAULT", "retry-two");
  api.behavior.catalogPlanPagination = true;
  api.behavior.catalogPlanAppendResponses.push({
    status: 503,
    body: null,
  });
  const endpoint = api.seed.webhook("wh_retry_append", "https://hooks.example.test/retry-append");
  api.behavior.deliveryPagination = true;
  api.behavior.deliveryRows = [
    { id: 601, endpoint_id: endpoint.id, event_id: 1, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
    { id: 602, endpoint_id: endpoint.id, event_id: 2, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
  ];
  api.behavior.deliveryAppendResponses.push({ status: 503, body: "upstream unavailable" });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const plansPane = page.getByRole("heading", { name: "Catalog plans" }).locator("..");
  const plansMore = plansPane.getByRole("button", { name: "Load more", exact: true });
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await plansMore.click();
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByText("invalid_api_response (missing_request_id)")).toBeVisible();
  await expect(plansMore).toBeVisible();
  await plansMore.click();
  await expect(plansPane.locator("tbody tr")).toHaveCount(2);
  await expect(plansMore).toHaveCount(0);

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  await page.locator(".tablePane > table tbody tr").filter({ hasText: endpoint.url }).getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  const deliveriesMore = deliveries.getByRole("button", { name: "Load more", exact: true });
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await deliveriesMore.click();
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await expect(deliveriesMore).toBeVisible();
  await deliveriesMore.click();
  await expect(deliveries.locator("tbody tr")).toHaveCount(2);
  await expect(deliveriesMore).toHaveCount(0);
});

test("admin UI invalidates a batch selection when its entitlement filter context changes", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("selection-context");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("u".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  const row = page.locator(".tablePane > table tbody tr").first();
  const selectRow = row.getByLabel("Select selection-context/float");
  await selectRow.check();
  await expect(page.locator(".bulkBar")).toContainText("1 selected");

  const projectFilter = page.locator('input[placeholder="project"]');
  await projectFilter.fill("no-such-project");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  await expect(page.locator(".bulkBar")).toHaveCount(0);
  expect(api.requests.batches).toHaveLength(0);

  await projectFilter.fill("selection-context");
  await expect(selectRow).not.toBeChecked();
});

test("admin UI fences ordinary device and meter reads across an ABA selection", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  for (const [project, fingerprint] of [["fence-device-one", "a"], ["fence-device-two", "b"]]) {
    await createForm.getByLabel("Project").fill(project);
    await createForm.getByLabel("Feature").fill("float");
    await createForm.getByLabel("Fingerprint").fill(fingerprint.repeat(64));
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();
  }

  const rows = page.locator(".tablePane > table tbody tr");
  const devicePane = page.getByRole("region", { name: "Registered devices" });
  api.behavior.deferReads.add("devices:ent-1");
  await rows.nth(0).getByRole("button", { name: "Devices", exact: true }).click();
  await expect.poll(() => api.behavior.releaseReads.has("devices:ent-1")).toBe(true);
  await rows.nth(1).getByRole("button", { name: "Devices", exact: true }).click();
  await expect(devicePane.locator(".mono")).toContainText("sha256:cccccccc");
  await rows.nth(0).getByRole("button", { name: "Devices", exact: true }).click();
  await expect(devicePane.locator(".mono")).toContainText("sha256:bbbbbbbb");
  api.behavior.releaseReads.get("devices:ent-1")();
  await expect(devicePane.locator(".mono")).toContainText("sha256:bbbbbbbb");

  const meterPane = page.getByRole("region", { name: "Metering status" });
  api.behavior.deferReads.add("meter:ent-1");
  await rows.nth(0).getByRole("button", { name: "Meter", exact: true }).click();
  await expect.poll(() => api.behavior.releaseReads.has("meter:ent-1")).toBe(true);
  await rows.nth(1).getByRole("button", { name: "Meter", exact: true }).click();
  await expect(meterPane).toContainText("Consumed this period: 20");
  await rows.nth(0).getByRole("button", { name: "Meter", exact: true }).click();
  await expect(meterPane).toContainText("Consumed this period: 10");
  api.behavior.releaseReads.get("meter:ent-1")();
  await expect(meterPane).toContainText("Consumed this period: 10");
});

test("admin UI fences webhook deliveries and report reads after a superseded context", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.webhook();
  api.seed.webhook("wh_second", "https://hooks.example.test/second");
  api.behavior.reportVersioned = true;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const endpointRows = page.locator(".tablePane > table tbody tr");
  await expect(endpointRows).toHaveCount(2);
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  api.behavior.deferReads.add("deliveries:wh_confirm");
  await endpointRows.nth(0).getByRole("button", { name: "Deliveries", exact: true }).click();
  await expect.poll(() => api.behavior.releaseReads.has("deliveries:wh_confirm")).toBe(true);
  await endpointRows.nth(1).getByRole("button", { name: "Deliveries", exact: true }).click();
  await expect(deliveries.locator(".mono")).toContainText("wh_second");
  await endpointRows.nth(0).getByRole("button", { name: "Deliveries", exact: true }).click();
  await expect(deliveries.locator(".mono")).toContainText("wh_confirm");
  api.behavior.releaseReads.get("deliveries:wh_confirm")();
  await expect(deliveries.locator(".mono")).toContainText("wh_confirm");

  api.behavior.deferReads.add("report");
  api.behavior.deferReads.add("timeseries");
  api.behavior.deferReads.add("expiring:30");
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  await expect.poll(() => api.behavior.releaseReads.has("report")).toBe(true);
  await expect.poll(() => api.behavior.releaseReads.has("timeseries")).toBe(true);
  await expect.poll(() => api.behavior.releaseReads.has("expiring:30")).toBe(true);

  await page.locator(".chartPanels .rangeSelector").getByRole("button", { name: "last 30d" }).click();
  const checkoutLine = page.locator(".checkoutsLine");
  await expect(checkoutLine).toBeVisible();
  const currentLine = await checkoutLine.getAttribute("d");
  await page.getByRole("group", { name: "Expiring horizon" }).getByRole("button", { name: "7d" }).click();
  await expect(page.locator(".expiringPanel")).toContainText("pro-7");

  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Reports", exact: true }).click();
  const reportTotal = page.locator(".reportsTab .reportCards > div").first().locator("strong");
  await expect(reportTotal).toHaveText("2");

  api.behavior.releaseReads.get("timeseries")();
  api.behavior.releaseReads.get("expiring:30")();
  api.behavior.releaseReads.get("report")();
  await expect(checkoutLine).toHaveAttribute("d", currentLine ?? "");
  await expect(page.locator(".expiringPanel")).toContainText("pro-7");
  await expect(reportTotal).toHaveText("2");
});

test("admin UI treats accepted mutation plus aborted refresh as success with manual recovery", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("refresh-abort");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("a".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  const trigger = row.getByRole("button", { name: "Disable", exact: true });
  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.refreshFailure = "abort";
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(page.getByRole("button", { name: "Refresh status" })).toBeVisible();
  await expect(row.locator(".status")).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
});

test("admin UI treats malformed post-success refresh as success with manual recovery", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("refresh-malformed");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("b".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  const trigger = row.getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.refreshFailure = "malformed";
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(page.getByRole("button", { name: "Refresh status" })).toBeVisible();
  await expect(row.locator(".status")).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
});

for (const refreshFailure of ["truncated", "wrong-enum"]) {
  test(`admin UI rejects a ${refreshFailure} entitlement refresh before clearing a successful consequence`, async ({ page }) => {
    const api = makeAdminApiFixture();
    await page.route("**/api/admin/**", api.route);
    await page.goto("/");
    await page.getByRole("button", { name: "Entitlements", exact: true }).click();
    const createForm = page.locator("aside form");
    await createForm.getByLabel("Project").fill(`refresh-${refreshFailure}`);
    await createForm.getByLabel("Feature").fill("float");
    await createForm.getByLabel("Fingerprint").fill((refreshFailure === "truncated" ? "t" : "u").repeat(64));
    await createForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/entitlement_saved/)).toBeVisible();

    const row = page.locator(".tablePane > table tbody tr").first();
    await row.getByRole("button", { name: "Disable", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Reason (required)").fill("operator review");
    api.behavior.refreshFailure = refreshFailure;
    await dialog.getByRole("button", { name: "Confirm" }).click();

    await expect.poll(() => api.requests.transitions.length).toBe(1);
    await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
    const refreshButton = page.getByRole("button", { name: "Refresh status" });
    await refreshButton.click();
    await expect(page.locator(".operatorNotice")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
  });
}

test("admin UI rejects a nested-null customer detail refresh before clearing a successful consequence", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Customers", exact: true }).click();
  await page.getByRole("button", { name: "cus_acme", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Acme Corp" })).toBeVisible();

  const disable = page.getByRole("button", { name: "Disable", exact: true });
  await disable.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.customerDetailFailure = "nested-null";
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => api.requests.customerTransitions.length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
});

test("admin UI rejects a non-2xx refresh carrying an ok response", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("refresh-http-status");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("e".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.refreshFailure = "http-success";
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(page.getByRole("button", { name: "Refresh status" })).toBeVisible();
  await expect(row.locator(".status")).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI keeps the success warning after a parsed refresh error and clears it after recovery", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("refresh-error");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("c".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  const trigger = row.getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.refreshFailures = ["response-error", "response-error"];
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await expect(refreshButton).toBeVisible();
  await expect(row.locator(".status")).toBeFocused();

  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(row.locator(".status")).toBeFocused();
  await expect.poll(() => api.requests.transitions.length).toBe(1);

  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI treats missing refresh data as success with manual recovery", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("refresh-missing-data");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("d".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const row = page.locator(".tablePane > table tbody tr").first();
  const trigger = row.getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  api.behavior.refreshFailures = ["missing-data"];
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  const refreshButton = page.getByRole("button", { name: "Refresh status" });
  await expect(row.locator(".status")).toBeFocused();
  await refreshButton.click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reenable", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI falls back to a stable section when a successful row disappears", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.dropTransitionRow = true;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("missing-focus-row");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("f".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/entitlement_saved/)).toBeVisible();

  const trigger = page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Disable", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-focus-section="entitlements"]')).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

test("admin UI discards stale create/import follow-ups after filter, selection, and form supersession", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  // A form edit and a list-filter change while the POST is in flight make the
  // original webhook result stale.  It must neither reset the draft nor
  // republish the old active list after the disabled filter is current.
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const webhookForm = page.locator("aside form");
  await webhookForm.getByLabel("URL").fill("https://hooks.example.test/stale-create");
  api.behavior.deferMutations.add("webhook-create");
  await webhookForm.getByRole("button", { name: "Create endpoint" }).click();
  await expect.poll(() => api.requests.webhookCreates.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("webhook-create")).toBe(true);
  await webhookForm.getByLabel("URL").fill("https://hooks.example.test/new-draft");
  await page.getByLabel("Filter endpoints by status").selectOption("disabled");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  api.behavior.releaseMutations.get("webhook-create")();
  await expect.poll(() => api.behavior.completedMutations.has("webhook-create")).toBe(true);
  await expect(webhookForm.getByLabel("URL")).toHaveValue("https://hooks.example.test/new-draft");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  await expect(page.getByText(/webhook_created/)).toHaveCount(0);

  // The policy editor follows the same contract independently of webhooks.
  await page.getByRole("button", { name: "Policies", exact: true }).click();
  const policyForm = page.locator("aside form");
  await policyForm.getByLabel("Name").fill("stale policy");
  api.behavior.deferMutations.add("policy-create");
  await policyForm.getByRole("button", { name: "Create policy" }).click();
  await expect.poll(() => api.requests.policyCreates.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("policy-create")).toBe(true);
  await policyForm.getByLabel("Name").fill("replacement policy draft");
  const policyFilters = page.locator(".tablePane .filters").first();
  await policyFilters.locator("select").last().selectOption("disabled");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  api.behavior.releaseMutations.get("policy-create")();
  await expect.poll(() => api.behavior.completedMutations.has("policy-create")).toBe(true);
  await expect(policyForm.getByLabel("Name")).toHaveValue("replacement policy draft");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  await expect(page.getByText(/policy_created/)).toHaveCount(0);

  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const featureForm = page.getByRole("form", { name: "Catalog feature" });
  await featureForm.getByLabel("Feature key").fill("stale_feature");
  await featureForm.getByLabel("Name").fill("Stale feature");
  api.behavior.deferMutations.add("catalog-feature-create");
  await featureForm.getByRole("button", { name: "Create feature" }).click();
  await expect.poll(() => api.requests.catalogFeatures.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-feature-create")).toBe(true);
  await featureForm.getByLabel("Name").fill("Feature draft after save");
  const featurePane = page.getByRole("heading", { name: "Catalog features" }).locator("..");
  await featurePane.locator(".filters select").selectOption("disabled");
  await expect(featurePane.locator("tbody tr")).toHaveCount(0);
  api.behavior.releaseMutations.get("catalog-feature-create")();
  await expect.poll(() => api.behavior.completedMutations.has("catalog-feature-create")).toBe(true);
  await expect(featureForm.getByLabel("Name")).toHaveValue("Feature draft after save");
  await expect(featurePane.locator("tbody tr")).toHaveCount(0);
  await expect(page.getByText(/catalog_feature_created/)).toHaveCount(0);

  const planForm = page.getByRole("form", { name: "Catalog plan" });
  await planForm.getByLabel("Plan key").fill("staleplan");
  await planForm.getByLabel("Name").fill("Stale plan");
  api.behavior.deferMutations.add("catalog-plan-create");
  await planForm.getByRole("button", { name: "Create plan" }).click();
  await expect.poll(() => api.requests.catalogPlans.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-plan-create")).toBe(true);
  await planForm.getByLabel("Name").fill("Plan draft after save");
  const planPane = page.getByRole("heading", { name: "Catalog plans" }).locator("..");
  await planPane.locator(".filters select").selectOption("disabled");
  await expect(planPane.locator("tbody tr")).toHaveCount(0);
  api.behavior.releaseMutations.get("catalog-plan-create")();
  await expect.poll(() => api.behavior.completedMutations.has("catalog-plan-create")).toBe(true);
  await expect(planForm.getByLabel("Name")).toHaveValue("Plan draft after save");
  await expect(planPane.locator("tbody tr")).toHaveCount(0);
  await expect(page.getByText(/catalog_plan_created/)).toHaveCount(0);

  // Create current catalog dependencies, then supersede the selected plan
  // while its plan-feature write is pending.
  await featurePane.locator(".filters select").selectOption("");
  await planPane.locator(".filters select").selectOption("");
  await featureForm.getByLabel("Feature key").fill("attachedfeat");
  await featureForm.getByLabel("Name").fill("Attached feature");
  await featureForm.getByRole("button", { name: "Create feature" }).click();
  await expect.poll(() => api.requests.catalogFeatures.length).toBe(2);
  await planForm.getByLabel("Plan key").fill("attachedplan");
  await planForm.getByLabel("Name").fill("Attached plan");
  await planForm.getByRole("button", { name: "Create plan" }).click();
  await expect.poll(() => api.requests.catalogPlans.length).toBe(2);

  // Feature and plan update paths use the same form/list fence as create;
  // verify a superseded edit cannot publish its old refresh either.
  const attachedFeatureRow = featurePane.locator("tbody tr").filter({ hasText: "attachedfeat" });
  await attachedFeatureRow.getByRole("button", { name: "Edit", exact: true }).click();
  await featureForm.getByLabel("Name").fill("Attached feature edited");
  api.behavior.deferMutations.add("catalog-feature-patch");
  await featureForm.getByRole("button", { name: "Update feature" }).click();
  await expect.poll(() => api.requests.catalogFeaturePatches.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-feature-patch")).toBe(true);
  await featureForm.getByLabel("Name").fill("Feature patch draft");
  await featurePane.locator(".filters select").selectOption("disabled");
  api.behavior.releaseMutations.get("catalog-feature-patch")();
  await expect.poll(() => api.behavior.completedMutations.has("catalog-feature-patch")).toBe(true);
  await expect(featureForm.getByLabel("Name")).toHaveValue("Feature patch draft");
  await expect(featurePane.locator("tbody tr")).toHaveCount(0);
  await expect(page.getByText(/catalog_feature_patched/)).toHaveCount(0);
  await featurePane.locator(".filters select").selectOption("");

  const attachedPlanRow = planPane.locator("tbody tr").filter({ hasText: "attachedplan" });
  await attachedPlanRow.getByRole("button", { name: "Edit", exact: true }).click();
  await planForm.getByLabel("Name").fill("Attached plan edited");
  api.behavior.deferMutations.add("catalog-plan-patch");
  await planForm.getByRole("button", { name: "Update plan" }).click();
  await expect.poll(() => api.requests.catalogPlanPatches.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-plan-patch")).toBe(true);
  await planForm.getByLabel("Name").fill("Plan patch draft");
  await planPane.locator(".filters select").selectOption("disabled");
  api.behavior.releaseMutations.get("catalog-plan-patch")();
  await expect.poll(() => api.behavior.completedMutations.has("catalog-plan-patch")).toBe(true);
  await expect(planForm.getByLabel("Name")).toHaveValue("Plan patch draft");
  await expect(planPane.locator("tbody tr")).toHaveCount(0);
  await expect(page.getByText(/catalog_plan_patched/)).toHaveCount(0);
  await planPane.locator(".filters select").selectOption("");

  const planFeatureForm = page.getByRole("form", { name: "Plan feature" });
  await planFeatureForm.getByLabel("Feature key").fill("attachedfeat");
  api.behavior.deferMutations.add("catalog-plan-feature-save");
  await planFeatureForm.getByRole("button", { name: "Save plan feature" }).click();
  await expect.poll(() => api.requests.catalogPlanFeatures.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-plan-feature-save")).toBe(true);
  await planFeatureForm.getByLabel("Selected plan").selectOption("");
  await expect(page.getByText("No rows for the selected plan.")).toBeVisible();
  api.behavior.releaseMutations.get("catalog-plan-feature-save")();
  await expect.poll(() => api.behavior.completedMutations.has("catalog-plan-feature-save")).toBe(true);
  await expect(planFeatureForm.getByLabel("Feature key")).toHaveValue("attachedfeat");
  await expect(page.getByText("No rows for the selected plan.")).toBeVisible();
  await expect(page.getByText(/catalog_plan_feature_saved/)).toHaveCount(0);

  // Import has its own form generation. A replacement manifest must not be
  // overwritten by a late Preview response or retain its old capability.
  const importForm = page.getByRole("form", { name: "Catalog import" });
  const oldManifest = JSON.stringify({
    format_version: 1,
    features: [{ project: "DEFAULT", feature_key: "imported_old", name: "Imported old", description: "", category: "", status: "active" }],
    plans: [],
  });
  const replacementManifest = JSON.stringify({ format_version: 1, features: [], plans: [] });
  await importForm.getByLabel("Manifest JSON").fill(oldManifest);
  api.behavior.deferMutations.add("catalog-import-preview");
  await importForm.getByRole("button", { name: "Preview import" }).click();
  await expect.poll(() => api.requests.catalogImports.length).toBe(1);
  await expect.poll(() => api.behavior.releaseMutations.has("catalog-import-preview")).toBe(true);
  await importForm.getByLabel("Manifest JSON").fill(replacementManifest);
  await expect(importForm.getByRole("button", { name: "Apply import" })).toBeDisabled();
  api.behavior.releaseMutations.get("catalog-import-preview")();
  await expect.poll(() => api.behavior.completedMutations.has("catalog-import-preview")).toBe(true);
  await expect(importForm.getByLabel("Manifest JSON")).toHaveValue(replacementManifest);
  await expect(importForm.getByRole("button", { name: "Apply import" })).toBeDisabled();
  await expect(page.getByText("Imported old")).toHaveCount(0);
  await expect(page.getByText(/catalog_import_previewed/)).toHaveCount(0);
});

test("admin UI discards a stale webhook redrive follow-up after delivery-filter supersession", async ({ page }) => {
  const api = makeAdminApiFixture();
  const endpoint = api.seed.webhook("wh_redrive", "https://hooks.example.test/redrive");
  api.behavior.deliveryRows = [{
    id: 88,
    endpoint_id: endpoint.id,
    event_id: 9,
    event_source: "entitlement",
    event_type: "disabled",
    status: "failed",
    attempts: 3,
    last_status: 503,
    last_error: "upstream unavailable",
    next_attempt_at: 1_760_000_000,
    created_at: 1_760_000_000,
    delivered_at: null,
  }];
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  await page.locator(".tablePane > table tbody tr").first().getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  await expect(deliveries.getByRole("button", { name: "Redrive", exact: true })).toBeEnabled();
  api.behavior.deferMutations.add("webhook-redrive");
  await deliveries.getByRole("button", { name: "Redrive", exact: true }).click();
  await expect.poll(() => api.requests.webhookRedrives).toEqual([88]);
  await expect.poll(() => api.behavior.releaseMutations.has("webhook-redrive")).toBe(true);
  await page.getByLabel("Filter deliveries by status").selectOption("delivered");
  await expect(deliveries.locator("tbody tr")).toHaveCount(0);
  api.behavior.releaseMutations.get("webhook-redrive")();
  await expect.poll(() => api.behavior.completedMutations.has("webhook-redrive")).toBe(true);
  await expect(deliveries.locator("tbody tr")).toHaveCount(0);
  await expect(page.getByText(/webhook_delivery_redriven/)).toHaveCount(0);
});

test("admin UI retains an ambiguous keyed ordinary mutation and replays its immutable request", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.webhookCreateResponses.push(
    { status: 500, body: { ok: false, code: "mutation_failed", request_id: "ui-e2e-webhook-post-commit" } },
    {
      status: 200,
      body: makeEnvelope("webhook_created", {
        id: "wh_recovered", url: "https://hooks.example.test/recovered", event_types: "", status: "active", description: "",
        scope_project: null, scope_customer_id: null, created_at: 1_760_000_001, updated_at: 1_760_000_001,
      }),
    },
  );
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const form = page.locator("aside form");
  await form.getByLabel("URL").fill("https://hooks.example.test/recovered");
  await form.getByRole("button", { name: "Create endpoint" }).click();
  await expect.poll(() => api.requests.webhookCreateAttempts.length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(form.getByLabel("URL")).toBeDisabled();
  await expect(form.getByRole("button", { name: "Create endpoint" })).toBeDisabled();

  // A replay may prove the POST while its required strict GET is malformed.
  // That must release the immutable replay owner and leave only GET recovery.
  api.behavior.webhookRefreshFailures.push("malformed");
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect.poll(() => api.requests.webhookCreateAttempts.length).toBe(2);
  expect(api.requests.webhookCreateAttempts[1].idempotencyKey).toBe(api.requests.webhookCreateAttempts[0].idempotencyKey);
  expect(api.requests.webhookCreateAttempts[1].body).toBe(api.requests.webhookCreateAttempts[0].body);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(page.locator(".operatorNotice")).not.toContainText("Other actions are unavailable until reconciliation completes.");
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  expect(api.requests.webhookCreateAttempts).toHaveLength(2);
  await expect(form.getByLabel("URL")).toBeEnabled();
});

test("admin UI keeps an exact ordinary success in GET-only recovery after a 5xx refresh", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.webhookCreateResponses.push({
    status: 200,
    body: makeEnvelope("webhook_created", {
      id: "wh_exact_refresh", url: "https://hooks.example.test/exact-refresh", event_types: "", status: "active", description: "",
      scope_project: null, scope_customer_id: null, created_at: 1_760_000_001, updated_at: 1_760_000_001,
    }),
  });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const form = page.locator("aside form");
  await form.getByLabel("URL").fill("https://hooks.example.test/exact-refresh");
  api.behavior.webhookRefreshFailures.push("response-error");
  await form.getByRole("button", { name: "Create endpoint" }).click();
  await expect.poll(() => api.requests.webhookCreateAttempts.length).toBe(1);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  await expect(form.getByRole("button", { name: "Create endpoint" })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh status" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  expect(api.requests.webhookCreateAttempts).toHaveLength(1);
});

test("admin UI disables hidden catalog-plan controls while its filtered page one is unsettled", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan("plan_old", "OLD", "old");
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const plansPane = page.getByRole("heading", { name: "Catalog plans" }).locator("..");
  await expect(plansPane.getByText("Plan old")).toBeVisible();
  await plansPane.getByRole("button", { name: "Use", exact: true }).click();
  const planFeatureForm = page.getByRole("form", { name: "Plan feature" });
  await expect(planFeatureForm.getByLabel("Selected plan")).toHaveValue("plan_old");

  const deferredRead = "catalog-plans:HIDDEN::page-1";
  api.behavior.deferReads.add(deferredRead);
  await plansPane.getByPlaceholder("project").fill("HIDDEN");
  await expect.poll(() => api.behavior.releaseReads.has(deferredRead)).toBe(true);
  await expect(planFeatureForm.getByLabel("Selected plan")).toBeDisabled();
  await expect(planFeatureForm.getByRole("button", { name: "Save plan feature" })).toBeDisabled();
  expect(api.requests.catalogPlanFeatures).toHaveLength(0);

  api.behavior.releaseReads.get(deferredRead)();
  await expect(plansPane.locator("tbody tr")).toHaveCount(0);
  await expect(planFeatureForm.getByRole("button", { name: "Save plan feature" })).toBeDisabled();
  expect(api.requests.catalogPlanFeatures).toHaveLength(0);
});

test("admin UI rejects repeated cursors and duplicate rows from shared and custom pagers", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan("plan_one", "DEFAULT", "one");
  api.seed.catalogPlan("plan_two", "DEFAULT", "two");
  api.behavior.catalogPlanPagination = true;
  const endpoint = api.seed.webhook("wh_pager", "https://hooks.example.test/pager");
  api.behavior.deliveryRows = [
    { id: 301, endpoint_id: endpoint.id, event_id: 1, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
    { id: 302, endpoint_id: endpoint.id, event_id: 2, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
  ];
  api.behavior.deliveryPagination = true;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const plansPane = page.getByRole("heading", { name: "Catalog plans" }).locator("..");
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  api.behavior.catalogPlanRepeatCursor = true;
  await plansPane.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("invalid_api_response (repeated_cursor)")).toBeVisible();
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await expect(plansPane.getByRole("button", { name: "Load more" })).toHaveCount(0);

  // A bad cursor is retired, so give the duplicate-row branch a new settled
  // page-one snapshot instead of expecting a second unsafe append from it.
  api.behavior.catalogPlanRepeatCursor = false;
  api.behavior.catalogPlanDuplicatePage = true;
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  await page.getByRole("button", { name: "Plans", exact: true }).click();
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await plansPane.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("invalid_api_response (duplicate_page_item)")).toBeVisible();
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await expect(plansPane.getByRole("button", { name: "Load more" })).toHaveCount(0);

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const webhookRow = page.locator(".tablePane > table tbody tr").filter({ hasText: "https://hooks.example.test/pager" });
  await webhookRow.getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  api.behavior.deliveryDuplicatePage = true;
  await deliveries.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("invalid_api_response (duplicate_page_item)")).toBeVisible();
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await expect(deliveries.getByRole("button", { name: "Load more" })).toHaveCount(0);

  // Re-entering the feature establishes a new delivery page-one snapshot.
  api.behavior.deliveryDuplicatePage = false;
  api.behavior.deliveryRepeatCursor = true;
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await deliveries.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("invalid_api_response (repeated_cursor)")).toBeVisible();
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
});

test("admin UI clears a definitive pre-mutation attempt so the next ordinary retry receives a new key", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.webhookCreateResponses.push({
    // A missing/expired operator credential is a real pre-mutation rejection
    // for this route. The locally bounded webhook form cannot produce the
    // Worker body's 8KiB rejection.
    status: 401,
    body: { ok: false, code: "missing_access_jwt", request_id: "ui-e2e-webhook-auth" },
  });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const form = page.locator("aside form");
  await form.getByLabel("URL").fill("https://hooks.example.test/new-key");
  await form.getByRole("button", { name: "Create endpoint" }).click();
  await expect.poll(() => api.requests.webhookCreateAttempts.length).toBe(1);
  await expect(page.getByText(/missing_access_jwt/)).toBeVisible();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(form.getByLabel("URL")).toBeEnabled();

  await form.getByRole("button", { name: "Create endpoint" }).click();
  await expect.poll(() => api.requests.webhookCreateAttempts.length).toBe(2);
  expect(api.requests.webhookCreateAttempts[1].idempotencyKey).not.toBe(api.requests.webhookCreateAttempts[0].idempotencyKey);
});

test("admin UI keeps a same-key replay conflict indeterminate after a post-commit failure", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.transitionResponses.push(
    { status: 500, body: { ok: false, code: "mutation_failed", request_id: "ui-e2e-transition-post-commit" } },
    { status: 409, body: { ok: false, code: "revoked_entitlement_is_terminal", request_id: "ui-e2e-transition-replay-conflict" } },
  );
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("replay-conflict");
  await createForm.getByLabel("Feature").fill("pro");
  await createForm.getByLabel("Fingerprint").fill("1".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("operator review");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Reconcile status" }).click();
  await expect.poll(() => api.requests.transitions.length).toBe(2);
  expect(api.requests.transitions[1].idempotencyKey).toBe(api.requests.transitions[0].idempotencyKey);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(page.getByRole("button", { name: "Reconcile status" })).toBeEnabled();
});

test("admin UI accepts a legitimate empty customer name in a transition RETURNING record", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.customerTransitionEmptyName = true;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Customers", exact: true }).click();
  await page.getByRole("button", { name: "cus_acme", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("empty name is valid");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  await expect(page.locator(".modalError")).toHaveCount(0);
  await expect(page.locator(".details .status")).toContainText("disabled");
});

test("admin UI reconciles release seats through the exact entitlement GET even when the target is off page one", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("release-page-two");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("2".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  const row = page.locator(".tablePane > table tbody tr").first();
  api.behavior.releaseSeatTargetOnSecondPage = true;
  await row.getByRole("button", { name: "Release seats", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("stuck host");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.releaseSeats.length).toBe(2);
  await expect.poll(() => api.requests.entitlementDetailReads.length).toBe(1);
  expect(api.requests.entitlementDetailReads[0]).toBe(api.requests.releaseSeats[0].id);
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
});

test("admin UI keeps a release-seat result unknown when same-key replay evidence differs", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.releaseSeatsResponses.push(
    { status: 200, body: makeEnvelope("seats_released", { released: 2, seat_ids: ["seat_1", "seat_2"] }) },
    { status: 200, body: makeEnvelope("seats_released", { released: 2, seat_ids: ["seat_2", "seat_1"] }) },
  );
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("release-evidence");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("3".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Release seats", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("compare replay proof");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => api.requests.releaseSeats.length).toBe(2);
  await expect(page.locator(".operatorNotice")).toContainText("Mutation outcome unknown; do not retry.");
});

test("admin UI keeps an undocumented release-seat 4xx indeterminate", async ({ page }) => {
  const api = makeAdminApiFixture();
  // `invalid_request` is documented for other mutation routes, but never for
  // release-seats. It must not clear this keyed attempt merely because it is a
  // well-formed 400 envelope.
  api.behavior.releaseSeatsResponses.push({
    status: 400,
    body: { ok: false, code: "invalid_request", request_id: "ui-e2e-release-wrong-route-400" },
  });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Entitlements", exact: true }).click();
  const createForm = page.locator("aside form");
  await createForm.getByLabel("Project").fill("release-wrong-route");
  await createForm.getByLabel("Feature").fill("float");
  await createForm.getByLabel("Fingerprint").fill("4".repeat(64));
  await createForm.getByRole("button", { name: "Save" }).click();
  const row = page.locator(".tablePane > table tbody tr").first();
  await row.getByRole("button", { name: "Release seats", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason (required)").fill("unexpected response");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog.locator(".modalError")).toContainText("Mutation outcome unknown; do not retry.");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeDisabled();
  await expect(page.locator(".operatorNotice")).toContainText("Other actions are unavailable until reconciliation completes.");
  expect(api.requests.releaseSeats).toHaveLength(1);
});

test("admin UI clears known webhook recovery only after an additional current-context GET", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.webhookCreateResponses.push({
    status: 200,
    body: makeEnvelope("webhook_created", {
      id: "wh_stale_refresh", url: "https://hooks.example.test/stale-refresh", event_types: "", status: "active", description: "",
      scope_project: null, scope_customer_id: null, created_at: 1_760_000_001, updated_at: 1_760_000_001,
    }),
  });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const form = page.locator("aside form");
  await form.getByLabel("URL").fill("https://hooks.example.test/stale-refresh");
  api.behavior.webhookRefreshFailures.push("response-error");
  await form.getByRole("button", { name: "Create endpoint" }).click();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");

  // This changes the list's read context after the known-success POST. The
  // saved recovery callback may not clear solely because its old closure is a
  // no-op: it needs a new exact GET for the visible context, or must retain
  // the recovery notice.
  await page.getByLabel("Filter endpoints by status").selectOption("disabled");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  await expect.poll(() => api.requests.webhookReads.some((search) => new URLSearchParams(search).get("status") === "disabled")).toBe(true);
  const readsBeforeRecovery = api.requests.webhookReads.length;
  api.behavior.deferReads.add("webhooks:disabled");
  await page.getByRole("button", { name: "Refresh status" }).click({ noWaitAfter: true });
  await expect.poll(() => api.requests.webhookReads.length).toBe(readsBeforeRecovery + 1);
  expect(new URLSearchParams(api.requests.webhookReads.at(-1)).get("status")).toBe("disabled");
  await expect.poll(() => api.behavior.releaseReads.has("webhooks:disabled")).toBe(true);
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  api.behavior.releaseReads.get("webhooks:disabled")();
  await expect(page.locator(".operatorNotice")).toHaveCount(0);
  expect(api.requests.webhookCreateAttempts).toHaveLength(1);
});

test("admin UI retains known webhook recovery after its current read becomes stale", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.behavior.webhookCreateResponses.push({
    status: 200,
    body: makeEnvelope("webhook_created", {
      id: "wh_noop_refresh", url: "https://hooks.example.test/noop-refresh", event_types: "", status: "active", description: "",
      scope_project: null, scope_customer_id: null, created_at: 1_760_000_002, updated_at: 1_760_000_002,
    }),
  });
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");
  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const form = page.locator("aside form");
  await form.getByLabel("URL").fill("https://hooks.example.test/noop-refresh");
  api.behavior.webhookRefreshFailures.push("response-error");
  await form.getByRole("button", { name: "Create endpoint" }).click();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");

  const filter = page.getByLabel("Filter endpoints by status");
  await filter.selectOption("disabled");
  await expect(page.locator(".tablePane > table tbody tr")).toHaveCount(0);
  const readsBeforeRecovery = api.requests.webhookReads.length;
  api.behavior.deferReads.add("webhooks:disabled");
  await page.getByRole("button", { name: "Refresh status" }).click({ noWaitAfter: true });
  await expect.poll(() => api.requests.webhookReads.length).toBe(readsBeforeRecovery + 1);
  await expect.poll(() => api.behavior.releaseReads.has("webhooks:disabled")).toBe(true);

  // The deferred recovery read is no longer current once the filter changes.
  // Releasing it must be a no-op, not proof that clears the notice.
  await filter.selectOption("active");
  await expect.poll(() => api.requests.webhookReads.some((search) => new URLSearchParams(search).get("status") === "active")).toBe(true);
  api.behavior.releaseReads.get("webhooks:disabled")();
  // The deferred stale attempt must settle before inspecting the retained
  // recovery notice; otherwise this assertion can pass before its no-op
  // callback has actually run.
  await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toBeEnabled();
  await expect(page.locator(".operatorNotice")).toContainText("Action succeeded; status refresh failed");
  expect(api.requests.webhookCreateAttempts).toHaveLength(1);
});

test("admin UI rejects A-to-B-to-A cursor cycles before shared or custom pagers commit a third page", async ({ page }) => {
  const api = makeAdminApiFixture();
  api.seed.catalogPlan("plan_cycle_one", "DEFAULT", "cycle-one");
  api.seed.catalogPlan("plan_cycle_two", "DEFAULT", "cycle-two");
  api.seed.catalogPlan("plan_cycle_three", "DEFAULT", "cycle-three");
  api.behavior.catalogPlanPagination = true;
  api.behavior.catalogPlanCursorCycle = true;
  const endpoint = api.seed.webhook("wh_cycle", "https://hooks.example.test/cycle");
  api.behavior.deliveryRows = [
    { id: 401, endpoint_id: endpoint.id, event_id: 1, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
    { id: 402, endpoint_id: endpoint.id, event_id: 2, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
    { id: 403, endpoint_id: endpoint.id, event_id: 3, event_source: "entitlement", event_type: "disabled", status: "delivered", attempts: 1, last_status: 200, last_error: "", next_attempt_at: 1_760_000_000, created_at: 1_760_000_000, delivered_at: 1_760_000_000 },
  ];
  api.behavior.deliveryPagination = true;
  api.behavior.deliveryCursorCycle = true;
  await page.route("**/api/admin/**", api.route);
  await page.goto("/");

  await page.getByRole("button", { name: "Plans", exact: true }).click();
  const plansPane = page.getByRole("heading", { name: "Catalog plans" }).locator("..");
  await expect(plansPane.locator("tbody tr")).toHaveCount(1);
  await plansPane.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(plansPane.locator("tbody tr")).toHaveCount(2);
  await plansPane.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.getByText("invalid_api_response (repeated_cursor)")).toBeVisible();
  await expect(plansPane.locator("tbody tr")).toHaveCount(2);
  await expect(plansPane.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Webhooks", exact: true }).click();
  const endpointRow = page.locator(".tablePane > table tbody tr").filter({ hasText: "https://hooks.example.test/cycle" });
  await endpointRow.getByRole("button", { name: "Deliveries", exact: true }).click();
  const deliveries = page.getByRole("region", { name: "Recent webhook deliveries" });
  await expect(deliveries.locator("tbody tr")).toHaveCount(1);
  await deliveries.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(deliveries.locator("tbody tr")).toHaveCount(2);
  await deliveries.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(page.getByText("invalid_api_response (repeated_cursor)")).toBeVisible();
  await expect(deliveries.locator("tbody tr")).toHaveCount(2);
  await expect(deliveries.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
});
