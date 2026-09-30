import { expect, test as base } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { catalogImportManifestSnapshot } from "@licensecc/licensing-domain/catalog/import_preview";

/**
 * Every result code a scenario could leak: the codes the console has copy for and the codes this
 * fixture answers with. A visible line that is exactly one of them is a code shown as text.
 */
const KNOWN_RESULT_CODES = (() => {
  const codes = new Set();
  const messages = readFileSync(new URL("../src/ui/shared/messages.ts", import.meta.url), "utf8");
  for (const match of messages.matchAll(/^ {2}([a-z][a-z0-9_]*): (?:failed|done)\(/gm)) codes.add(match[1]);
  const fixture = readFileSync(new URL(import.meta.url), "utf8");
  for (const match of fixture.matchAll(/(?:makeEnvelope\(|code: )"([a-z][a-z0-9_]*)"/g)) codes.add(match[1]);
  return [...codes].filter((code) => code.includes("_"));
})();

/**
 * No visible text outside a <details> disclosure may read as a raw result code: neither the old
 * `code (request_id)` shape nor a bare snake_case code on its own line. Form controls are hidden
 * for the scan too, since an option or a typed value is data, not a message (a label's text would
 * otherwise include its select's chosen option).
 */
export async function expectNoRawResultCodes(page) {
  if (page.isClosed()) return;
  const offenders = await page.evaluate((known) => {
    const codes = new Set(known);
    const hidden = [...document.querySelectorAll("details, select, textarea, datalist")].map((element) => [element, element.style.display]);
    for (const [details] of hidden) details.style.display = "none";
    try {
      const found = new Set();
      for (const element of document.body.querySelectorAll("*")) {
        if (element.closest("details, script, style, template, select, option, textarea, datalist")) continue;
        if (!(element instanceof HTMLElement) || !element.checkVisibility()) continue;
        for (const line of element.innerText.split("\n").map((text) => text.trim()).filter(Boolean)) {
          if (/^[a-z_]+ \(/.test(line) || codes.has(line)) found.add(line);
        }
      }
      return [...found];
    } finally {
      for (const [details, display] of hidden) details.style.display = display;
    }
  }, KNOWN_RESULT_CODES);
  expect(offenders, "a result code is shown outside Technical details").toEqual([]);
}

/** Every admin browser scenario ends with the raw-code check above. */
export const test = base.extend({
  page: async ({ page }, use) => {
    await use(page);
    await expectNoRawResultCodes(page);
  },
});

/** The fields a policy PATCH may name; a create adds project, name and type. Mirrors the Worker. */
const POLICY_PATCHABLE_FIELDS = ["valid_from_offset_sec", "duration_sec", "max_active_devices", "expiry_strategy", "trial_expiration_basis", "trial_duration_sec", "trial_one_per_device", "notes"];
/** Each entitlement route reads exactly its own fields and refuses a body naming any other. The lists
 * are derived from the Worker's own (rather than hand-copied) so the two can never drift. The scrape
 * only understands double-quoted string literals and a spread of another list, so each parsed list
 * is checked against the exact expected value: a reformatted Worker source (single quotes, a renamed
 * field, a different literal shape) fails loudly here instead of silently producing a wrong list. */
function workerEntitlementFields(name, expected) {
  const source = readFileSync(new URL("../src/worker/groups/entitlements/validation.ts", import.meta.url), "utf8");
  const match = new RegExp(`\\b${name}(?:: ReadonlySet<string>)? = (?:new Set\\()?\\[([^\\]]+)\\]`).exec(source);
  if (match === null) throw new Error(`could not find ${name} in validation.ts`);
  const parsed = match[1].split(",").map((field) => field.trim().replace(/^"|"$/g, "")).filter(Boolean);
  if (parsed.length !== expected.length || parsed.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} scrape produced ${JSON.stringify(parsed)}; expected exactly ${JSON.stringify(expected)}. Update this expectation only after confirming the scrape still parses the Worker's real list correctly.`);
  }
  return parsed;
}
const ENTITLEMENT_INPUT_FIELDS = workerEntitlementFields("ENTITLEMENT_INPUT_FIELDS",
  ["project", "feature", "license_fingerprint", "status", "valid_from", "valid_until", "notes", "customer_id", "license_id"]);
const ENTITLEMENT_CREATE_FIELDS = workerEntitlementFields("ENTITLEMENT_CREATE_FIELDS",
  ["...ENTITLEMENT_INPUT_FIELDS", "policy_id", "max_active_devices"])
  .flatMap((field) => field === "...ENTITLEMENT_INPUT_FIELDS" ? ENTITLEMENT_INPUT_FIELDS : [field]);
const ENTITLEMENT_POLICY_CREATE_FIELDS = workerEntitlementFields("ENTITLEMENT_POLICY_CREATE_FIELDS",
  ["project", "feature", "license_fingerprint", "valid_from", "valid_until", "notes", "customer_id", "license_id", "policy_id"]);
const ENTITLEMENT_PATCH_FIELDS = workerEntitlementFields("ENTITLEMENT_PATCH_FIELDS",
  ["valid_from", "valid_until", "notes", "customer_id", "license_id", "max_active_devices", "expected_customer_id", "expected_revocation_seq"]);
const namesOnly = (body, allowed) => Object.keys(body).every((field) => allowed.includes(field));

export function makeEnvelope(code, data) {
  makeEnvelope.nextRequestId += 1;
  return {
    ok: true,
    code,
    request_id: `ui-e2e-${makeEnvelope.nextRequestId}`,
    data,
  };
}
makeEnvelope.nextRequestId = 0;

/**
 * The create form defaults to a protected grant, which needs its owner: type the customer and
 * license IDs by hand (opening each disclosure only when it is still closed).
 */
export async function fillProtectedOwner(form, { customerId = "cus_e2e", licenseId = "lic_e2e" } = {}) {
  for (const [kind, id] of [["customer", customerId], ["license", licenseId]]) {
    const disclosure = form.getByText(`Enter ${kind} ID manually`, { exact: true });
    if (await disclosure.locator("..").getAttribute("open") === null) await disclosure.click();
    await form.getByLabel(`${kind === "customer" ? "Customer" : "License"} ID`, { exact: true }).fill(id);
  }
}

export function makeAdminApiFixture() {
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
    // Workstream F — refused-connection and fulfillment reports.
    timeseries: [],
    expiring: [],
    expiringCursors: [],
    planPreviews: [],
    planApplies: [],
    catalogFeatures: [],
    catalogFeaturePatches: [],
    catalogFeatureTransitions: [],
    catalogPlans: [],
    catalogPlanPatches: [],
    catalogPlanTransitions: [],
    catalogPlanExports: [],
    catalogPlanReads: [],
    catalogPlanFeatures: [],
    catalogPlanFeatureTransitions: [],
    catalogImports: [],
    customerWorkspaceReads: [],
    policyCreates: [],
    policyPatches: [],
    webhookCreates: [],
    webhookCreateAttempts: [],
    webhookPatches: [],
    webhookReads: [],
    webhookRedrives: [],
    webhookTests: [],
    customerTransitions: [],
    policyTransitions: [],
    webhookTransitions: [],
    deliveryReads: [],
    deliveryCursors: [],
    reportReads: [],
    orderReads: [],
    orderCursors: [],
    entitlementReads: [],
    customerReads: [],
    customerCursors: [],
    // A filter-driven list reload must never fan out to the cross-feature
    // summary/events core refresh; these count every GET regardless of which feature triggers it.
    summaryReads: [],
    eventsReads: [],
    policyReads: [],
    licenseReads: [],
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
    transitionFailure: null,
    abortTransition: false,
    dropTransitionRow: false,
    refreshFailure: null,
    refreshFailures: [],
    deferRefresh: false,
    releaseRefresh: null,
    customerDetailFailure: null,
    customerTransitionEmptyName: false,
    webhookCreateResponses: [],
    webhookRefreshFailures: [],
    // Scripted { status, body } answers for POST /api/admin/webhooks/{id}/test, in call order.
    webhookTestResponses: [],
    catalogPlanPagination: false,
    catalogPlanRepeatCursor: false,
    catalogPlanDuplicatePage: false,
    catalogPlanCursorCycle: false,
    catalogPlanAppendResponses: [],
    // Queued raw responses for GET /catalog/plans/{id}, served before the fixture's own answer.
    catalogPlanReadResponses: [],
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
    reportVersioned: false,
    activePolicyPagination: false,
    // A number here pages the entitlements list for real (offset cursor), so Load More can be
    // exercised across a genuine tab switch.
    entitlementsPageSize: null,
    // A number here pages the events list for real (keyset cursor), so Next page can be exercised.
    eventsPageSize: null,
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
    // Test-only response transforms let the browser contract distinguish a
    // syntactically valid Apply replay from the exact persisted Preview it
    // must echo.
    catalogImportApplyResponseTransforms: [],
    catalogImportAbortAfterApply: false,
    // Optional list fixture controls. Defaults preserve the compact two-row
    // customer fixture used by the existing browser suite.
    customerRows: null,
    customerPageSize: null,
    settingsFailure: null,
    settingsResponse: null,
    // Protected devices holding a slot on every grant; a PATCH below it models the capacity trigger.
    devicesInUse: 0,
  };
  let nextProjectionPreviewId = 1;
  let nextCatalogImportPreviewId = 1;

  function seedPolicy(id = "pol_confirm", name = "Confirm policy", overrides = {}) {
    const policy = {
      id, project: "DEFAULT", name, type: "trial", status: "active",
      valid_from_offset_sec: null, duration_sec: null, max_active_devices: 1,
      expiry_strategy: "fixed_window", trial_expiration_basis: "from_issue", trial_duration_sec: 0,
      trial_one_per_device: 0, notes: "", created_at: now, updated_at: now,
      ...overrides,
    };
    policies.push(policy);
    return policy;
  }

  function seedWebhook(id = "wh_confirm", url = "https://hooks.example.test/confirm", overrides = {}) {
    const endpoint = {
      id, url, event_types: "", status: "active",
      description: "", scope_kind: "global", scope_project: null, scope_customer_id: null, created_at: now, updated_at: now,
      ...overrides,
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
      max_active_devices: nullable(feature.max_active_devices),
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
          max_active_devices: feature.max_active_devices,
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

  function catalogImportApplyResponse(preview) {
    const transform = behavior.catalogImportApplyResponseTransforms.shift();
    const response = JSON.parse(JSON.stringify(preview));
    return transform === undefined ? response : transform(response);
  }

  // A couple of customers so the Customers tab + a global-search customer deep-link have rows.
  const customers = [
    { id: "cus_acme", name: "Acme Corp", email: "ops@acme.test", status: "active", external_ref: "ext_1", created_at: 1_700_000_000, updated_at: 1_700_000_000, entitlement_count: 2, active_entitlement_count: 1 },
    { id: "cus_globex", name: "Globex", email: "billing@globex.test", status: "disabled", external_ref: "", created_at: 1_700_000_500, updated_at: 1_700_000_900, entitlement_count: 0, active_entitlement_count: 0 },
  ];

  /**
   * Opt-in layout data helpers. `seed.customers(50)` adds ordinary customer
   * rows; `seed.realistic()` adds 50 customers and 50 entitlements containing
   * long identifiers/names, blank names, lifecycle states, and validity edge
   * cases. Set `behavior.customerPageSize` (for example, 25) to exercise the
   * normal cursor append flow without changing the production-like default.
   */
  function seedCustomer(overrides = {}) {
    const index = customers.length + 1;
    const row = {
      id: `cus_seed_${String(index).padStart(3, "0")}`,
      name: `Seed customer ${index}`,
      email: `customer-${index}@example.test`,
      status: index % 4 === 0 ? "disabled" : "active",
      external_ref: `seed-${index}`,
      created_at: now - index * 60,
      updated_at: now - index * 30,
      entitlement_count: 0,
      active_entitlement_count: 0,
      ...overrides,
    };
    customers.push(row);
    return row;
  }

  function seedCustomers(countOrRows = 50) {
    if (Array.isArray(countOrRows)) return countOrRows.map((row) => seedCustomer(row));
    const count = Number.isInteger(countOrRows) && countOrRows >= 0 ? countOrRows : 50;
    return Array.from({ length: count }, () => seedCustomer());
  }

  function seedEntitlement(overrides = {}) {
    const index = nextEntitlementId;
    const status = overrides.status ?? "active";
    const row = {
      id: `ent-${index}`,
      project: "DEFAULT",
      feature: `seed-${index}`,
      license_fingerprint: index.toString(16).padStart(64, "0"),
      status,
      revocation_seq: 1,
      valid_from: null,
      valid_until: null,
      notes: "",
      // Every grant has an owner, as the Worker's records guarantee.
      customer_id: "cus_owner",
      license_id: null,
      policy_id: null,
      is_trial: 0,
      trial_expiration_basis: null,
      trial_duration_sec: 0,
      trial_one_per_device: 0,
      trial_started_at: null,
      trial_device_key_id: null,
      max_active_devices: 1,
      lease_seconds: 0,
      license_mode: "node_locked",
      created_at: now,
      updated_at: now,
      ...overrides,
    };
    nextEntitlementId += 1;
    entitlements.push(row);
    return row;
  }

  function seedEntitlements(countOrRows = 50) {
    if (Array.isArray(countOrRows)) return countOrRows.map((row) => seedEntitlement(row));
    const count = Number.isInteger(countOrRows) && countOrRows >= 0 ? countOrRows : 50;
    return Array.from({ length: count }, () => seedEntitlement());
  }

  function seedRealisticRecords({ customerCount = 50, entitlementCount = 50 } = {}) {
    const seededCustomers = Array.from({ length: customerCount }, (_unused, index) => seedCustomer({
      id: index === 0 ? "cus_enterprise_northwind_global_licensing_operations_0001" : `cus_layout_${String(index + 1).padStart(3, "0")}`,
      name: index === 0
        ? "Northwind Global Infrastructure and Licensing Operations for Distributed Manufacturing"
        : index === 1 ? "" : `Layout customer ${index + 1}`,
      email: `layout-${index + 1}@example.test`,
      status: index % 4 === 0 ? "disabled" : "active",
      external_ref: `layout-${index + 1}`,
    }));
    const seededEntitlements = Array.from({ length: entitlementCount }, (_unused, index) => {
      const validity = index % 5;
      const status = ["active", "active", "active", "active", "disabled", "revoked"][index % 6];
      return seedEntitlement({
        id: index === 0 ? "ent_enterprise_northwind_global_licensing_operations_0001" : `ent-layout-${String(index + 1).padStart(3, "0")}`,
        feature: index === 0 ? "distributed-manufacturing-enterprise" : `layout-feature-${index + 1}`,
        license_fingerprint: (index + 1000).toString(16).padStart(64, "0"),
        customer_id: seededCustomers[index % seededCustomers.length]?.id ?? null,
        status,
        valid_from: validity === 1 ? now + 7 * 86_400 : null,
        valid_until: validity === 2 ? now - 86_400 : validity === 3 ? now + 7 * 86_400 : null,
        max_active_devices: index % 4 === 0 ? 5 : 1,
        license_mode: index % 4 === 0 ? "trial" : "node_locked",
      });
    });
    for (const customer of seededCustomers) {
      const linked = seededEntitlements.filter((item) => item.customer_id === customer.id);
      customer.entitlement_count = linked.length;
      customer.active_entitlement_count = linked.filter((item) => item.status === "active").length;
    }
    return { customers: seededCustomers, entitlements: seededEntitlements };
  }

  function customerDetail(id) {
    const customer = customers.find((item) => item.id === id);
    return {
      customer: { ...customer, metadata_json: "{}" },
      entitlements: entitlements.filter((item) => item.customer_id === id).map((item) => ({
        project: item.project,
        feature: item.feature,
        license_fingerprint: item.license_fingerprint,
        status: item.status,
        valid_from: item.valid_from,
        valid_until: item.valid_until,
        revocation_seq: item.revocation_seq,
        updated_at: item.updated_at,
      })),
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
      requests.summaryReads.push(true);
      return fulfill(200, makeEnvelope("summary", summary()));
    }
    if (method === "GET" && path === "/api/admin/settings") {
      if (behavior.settingsResponse !== null) {
        const response = behavior.settingsResponse;
        return fulfill(response.status ?? 200, fixtureResponseBody(response));
      }
      if (behavior.settingsFailure === "malformed") {
        return route.fulfill({ status: 200, contentType: "application/json", body: "not-json" });
      }
      if (behavior.settingsFailure === "response-error") {
        return fulfill(503, { ok: false, code: "settings_unavailable", request_id: "ui-e2e-settings-unavailable" });
      }
      return fulfill(200, makeEnvelope("settings", {
        environment: "staging",
        public_verifier_url: "https://verifier.example.test",
        auth: "cloudflare-access",
      }));
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
    // Workstream F — refused-connection and fulfillment time-series. Deterministic buckets so the
    // inline-SVG charts have a visible (non-empty) line/area/bar to render.
    if (method === "GET" && path === "/api/admin/report/timeseries") {
      requests.timeseries.push(url.search);
      await deferRead("timeseries");
      const from = Number(url.searchParams.get("from")) || 0;
      const to = Number(url.searchParams.get("to")) || from + 4;
      const rangeDays = Math.max(1, Math.round((to - from) / 86_400));
      const buckets = rangeDays <= 7
        ? [{ start: from, denials: 1, fulfillment_events: 1 }]
        : [
          { start: from, denials: 0, fulfillment_events: 1 },
          { start: from + 1, denials: 2, fulfillment_events: 3 },
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
      // The id/customer_id a real deep link needs come from a seeded entitlement sharing the row's
      // fingerprint when one exists (so a click resolves to exactly that record); otherwise a
      // synthetic id is used that matches nothing, same as this fixture's other unlinked rows.
      const linkToRealEntitlement = (spec) => {
        const real = entitlements.find((item) => item.license_fingerprint === spec.license_fingerprint);
        return { ...spec, id: real ? real.id : spec.id, customer_id: real ? real.customer_id : spec.customer_id };
      };
      const items = [
        linkToRealEntitlement({ id: "exp-1", project: "DEFAULT", feature: `pro-${withinDays}`, license_fingerprint: "a".repeat(64), customer_id: "cus_acme", customer_name: "Acme Corp", valid_until: 1_760_500_000, days_left: 3 }),
        linkToRealEntitlement({ id: "exp-2", project: "DEFAULT", feature: "ent", license_fingerprint: "b".repeat(64), customer_id: "cus_unnamed", customer_name: null, valid_until: 1_762_000_000, days_left: 21 }),
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
        customers: { total: customers.length, active: customers.filter((item) => item.status === "active").length, disabled: customers.filter((item) => item.status === "disabled").length },
        licenses: { total: 0 },
        fulfillment: { accepted: 0, processed: 0, superseded: 0, rejected: 0, stale_accepted: 0, events_24h: 0, events_7d: 0 },
        customer_suspensions_7d: 0,
      }));
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
      const cursor = url.searchParams.get("cursor");
      const limitParam = url.searchParams.get("limit");
      const start = cursor === null || cursor === "" ? 0 : Number(cursor);
      const requestedLimit = limitParam === null || limitParam === "" ? null : Number(limitParam);
      const pageSize = behavior.customerPageSize ?? requestedLimit ?? 50;
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        return fulfill(400, { ok: false, code: "invalid_request", request_id: "ui-e2e-customers-invalid-page" });
      }
      const status = url.searchParams.get("status");
      const query = url.searchParams.get("q")?.toLowerCase() ?? "";
      const rows = (behavior.customerRows ?? customers).filter((item) =>
        (status === null || item.status === status) &&
        (query === "" || item.id.toLowerCase().includes(query) || (item.login_email ?? "").toLowerCase().includes(query) || item.email.toLowerCase().includes(query) || item.name.toLowerCase().includes(query)),
      );
      requests.customerReads.push(url.search);
      requests.customerCursors.push(cursor);
      const items = rows.slice(start, start + pageSize).map((item) => ({ ...item }));
      return fulfill(200, makeEnvelope("customers_listed", {
        items,
        next_cursor: start + pageSize < rows.length ? String(start + pageSize) : null,
      }));
    }
    if (method === "GET" && path === "/api/admin/licenses") {
      requests.licenseReads.push(url.search);
      return fulfill(200, makeEnvelope("licenses_listed", { items: behavior.licenseRows.map((item) => ({ ...item })), next_cursor: null }));
    }
    if (method === "GET" && path === "/api/admin/catalog/projects") {
      const projects = [...new Set([...entitlements, ...catalogFeatures, ...catalogPlans].map(item => item.project))].sort();
      return fulfill(200, makeEnvelope("projects_listed", { items: projects.map(project => ({ project })), next_cursor: null }));
    }
    const protectedListMatch = /^\/api\/admin\/customers\/([^/]+)\/bindings$/.exec(path);
    if(method === "GET" && protectedListMatch) return fulfill(200,makeEnvelope("customer_bindings",{
      customer:{id:decodeURIComponent(protectedListMatch[1]),status:"active"},operator:{subject:"test-admin",actor_type:"access",role:"admin"},server_time:now,capacity:[],denied:[],items:[],next_cursor:null,
    }));
    const workspaceMatch = /^\/api\/admin\/customers\/([^/]+)\/(apps|access)$/.exec(path);
    if (method === "GET" && workspaceMatch) {
      const customerId = decodeURIComponent(workspaceMatch[1]);
      const detail = customerDetail(customerId);
      if (!detail) return fulfill(404, makeEnvelope("not_found", undefined, false));
      const owned = entitlements.filter(item => item.customer_id === customerId && (!url.searchParams.has("project") || item.project === url.searchParams.get("project")));
      const view = workspaceMatch[2];
      requests.customerWorkspaceReads.push(`${view}${url.search}`);
      const items = view === "access" ? owned.map(publicRecord) : [...new Set(owned.map(item => item.project))].sort().map(project => {
        const grants = owned.filter(item => item.project === project);
        const expiries = grants.map(item => item.valid_until).filter(value => value !== null);
        return { project, grant_count: grants.length, enabled_count: grants.filter(item => item.status === "active").length,
          in_date_count: grants.filter(item => item.status === "active" && (item.valid_from === null || item.valid_from <= now) && (item.valid_until === null || item.valid_until > now)).length,
          earliest_expiry: expiries.length ? Math.min(...expiries) : null, latest_expiry: expiries.length ? Math.max(...expiries) : null, no_expiry_count: grants.length - expiries.length };
      });
      const offset = Number(url.searchParams.get("cursor") || 0);
      const limit = Number(url.searchParams.get("limit") || 100);
      return fulfill(200, makeEnvelope(view === "apps" ? "customer_apps" : "entitlements_listed", {
        items: items.slice(offset, offset + limit), next_cursor: items.length > offset + limit ? String(offset + limit) : null,
        ...(view === "access" ? {} : { customer: detail.customer, server_time: now }),
      }));
    }
    const customerDetailMatch = /^\/api\/admin\/customers\/([^/]+)$/.exec(path);
    if (method === "GET" && customerDetailMatch !== null) {
      const detail = customerDetail(decodeURIComponent(customerDetailMatch[1]));
      if (behavior.customerDetailFailure === "nested-null") {
        behavior.customerDetailFailure = null;
        detail.licenses = [null];
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
    // Workstream C — bulk transitions. One POST carries action/reason/rows (each an id plus the
    // owner/revocation-sequence precondition observed for it); returns per-row results.
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
      for (const { id, expected_customer_id: expectedCustomerId, expected_revocation_seq: expectedRevocationSeq } of body.rows) {
        const row = findById(id);
        if (row === undefined) {
          results.push({ id, ok: false, code: "not_found" });
          continue;
        }
        if (row.customer_id !== expectedCustomerId || row.revocation_seq !== expectedRevocationSeq) {
          results.push({ id, ok: false, code: "stale_transition" });
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
      requests.eventsReads.push(true);
      // Mirrors the real worker's filters + keyset cursor closely enough for e2e purposes: exact
      // match on project/feature/event_type/actor, entitlement_id decoded to project/feature/
      // license_fingerprint, since/until bound created_at, and "<created_at>:<id>" pages forward
      // (the `events` array is already newest-first, matching ORDER BY created_at DESC, id DESC).
      let matches = events;
      for (const [param, field] of [["project", "project"], ["feature", "feature"], ["event_type", "event_type"], ["actor", "actor"]]) {
        const value = url.searchParams.get(param);
        if (value) matches = matches.filter((item) => item[field] === value);
      }
      // The real worker decodes entitlement_id to a project/feature/license_fingerprint triple;
      // this fixture's rows carry an opaque "ent-N" id instead (see findById), so it resolves the
      // SAME triple by looking the row up directly rather than reimplementing that encoding here.
      const entitlementIdParam = url.searchParams.get("entitlement_id");
      if (entitlementIdParam) {
        const target = findById(entitlementIdParam);
        matches = target === undefined ? [] : matches.filter((item) =>
          item.project === target.project && item.feature === target.feature && item.license_fingerprint === target.license_fingerprint);
      }
      const since = url.searchParams.get("since");
      if (since) matches = matches.filter((item) => item.created_at >= Number(since));
      const until = url.searchParams.get("until");
      if (until) matches = matches.filter((item) => item.created_at <= Number(until));
      const cursor = url.searchParams.get("cursor");
      if (cursor) {
        const [afterCreatedAt, afterId] = cursor.split(":").map(Number);
        matches = matches.filter((item) => item.created_at < afterCreatedAt || (item.created_at === afterCreatedAt && item.id < afterId));
      }
      const pageSize = behavior.eventsPageSize ?? matches.length;
      const page = matches.slice(0, pageSize);
      const last = page.at(-1);
      const nextCursor = page.length < matches.length && last !== undefined ? `${last.created_at}:${last.id}` : null;
      return fulfill(200, makeEnvelope("events_listed", { items: page.map((item) => ({ ...item })), next_cursor: nextCursor }));
    }
    const entitlementDetailMatch = /^\/api\/admin\/entitlements\/([^/]+)$/.exec(path);
    if (method === "GET" && entitlementDetailMatch !== null) {
      const id = decodeURIComponent(entitlementDetailMatch[1]);
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
        (!url.searchParams.has("id") || item.id === url.searchParams.get("id")) &&
        (!url.searchParams.has("customer_id") || item.customer_id === url.searchParams.get("customer_id")) &&
        (!url.searchParams.has("license_id") || item.license_id === url.searchParams.get("license_id")) &&
        (project === null || item.project === project) &&
        (feature === null || item.feature === feature) &&
        (status === null || item.status === status),
      );
      if (behavior.entitlementsPageSize !== null) {
        const offset = Number(url.searchParams.get("cursor") ?? "0");
        const page = filteredEntitlements.slice(offset, offset + behavior.entitlementsPageSize).map(publicRecord);
        const nextOffset = offset + behavior.entitlementsPageSize;
        const nextCursor = nextOffset < filteredEntitlements.length ? String(nextOffset) : null;
        return fulfill(200, makeEnvelope("entitlements_listed", { items: page, next_cursor: nextCursor }));
      }
      return fulfill(200, makeEnvelope("entitlements_listed", { items: filteredEntitlements.map(publicRecord), next_cursor: null }));
    }
    // The Entitlements and Plans tabs load active policies for policy selectors.
    if (method === "GET" && path === "/api/admin/policies") {
      requests.policyReads.push(url.search);
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
      if (!namesOnly(body, ["project", "name", "type", ...POLICY_PATCHABLE_FIELDS]) || !["trial", "node_locked", "subscription"].includes(body.type)) {
        return fulfill(400, { ok: false, code: "invalid_request", request_id: "ui-e2e-policy-invalid" });
      }
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
        max_active_devices: body.max_active_devices ?? 1,
        expiry_strategy: body.expiry_strategy ?? "fixed_window",
        trial_expiration_basis: body.trial_expiration_basis ?? "from_issue",
        trial_duration_sec: body.trial_duration_sec ?? 0,
        trial_one_per_device: body.trial_one_per_device ?? 0,
        notes: body.notes ?? "",
        created_at: now,
        updated_at: now,
      };
      policies.push(row);
      return fulfill(200, makeEnvelope("policy_created", { ...row }));
    }
    const policyDetailMatch = /^\/api\/admin\/policies\/([^/]+)$/.exec(path);
    if (method === "PATCH" && policyDetailMatch !== null) {
      const body = await jsonBody(request);
      requests.policyPatches.push({ id: decodeURIComponent(policyDetailMatch[1]), body, idempotencyKey: request.headers()["idempotency-key"] ?? null });
      const policy = policies.find((item) => item.id === decodeURIComponent(policyDetailMatch[1]));
      if (policy === undefined) return fulfill(404, { ok: false, code: "not_found", request_id: "ui-e2e-policy-missing" });
      if (!namesOnly(body, POLICY_PATCHABLE_FIELDS)) return fulfill(400, { ok: false, code: "invalid_request", request_id: "ui-e2e-policy-identity" });
      now += 1;
      Object.assign(policy, body, { updated_at: now });
      return fulfill(200, makeEnvelope("policy_patched", { ...policy }));
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
        scope_kind: body.scope_kind,
        scope_project: body.scope_project ? body.scope_project : null,
        scope_customer_id: body.scope_customer_id ? body.scope_customer_id : null,
        created_at: now,
        updated_at: now,
      };
      webhooks.push(row);
      return fulfill(200, makeEnvelope("webhook_created", { ...row }));
    }
    const webhookDetailMatch = /^\/api\/admin\/webhooks\/([^/]+)$/.exec(path);
    if (method === "PATCH" && webhookDetailMatch !== null) {
      const id = decodeURIComponent(webhookDetailMatch[1]);
      const body = await jsonBody(request);
      requests.webhookPatches.push({ id, body, idempotencyKey: request.headers()["idempotency-key"] ?? null });
      const endpoint = webhooks.find((item) => item.id === id);
      if (endpoint === undefined) return fulfill(404, { ok: false, code: "not_found", request_id: "ui-e2e-webhook-missing" });
      now += 1;
      if ("url" in body) endpoint.url = body.url;
      if ("event_types" in body) endpoint.event_types = body.event_types;
      if ("description" in body) endpoint.description = body.description;
      if ("scope_kind" in body) endpoint.scope_kind = body.scope_kind;
      if ("scope_project" in body) endpoint.scope_project = body.scope_project === "" ? null : body.scope_project;
      if ("scope_customer_id" in body) endpoint.scope_customer_id = body.scope_customer_id === "" ? null : body.scope_customer_id;
      endpoint.updated_at = now;
      return fulfill(200, makeEnvelope("webhook_patched", { ...endpoint }));
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
    const webhookTestMatch = /^\/api\/admin\/webhooks\/([^/]+)\/test$/.exec(path);
    if (method === "POST" && webhookTestMatch !== null) {
      const id = decodeURIComponent(webhookTestMatch[1]);
      requests.webhookTests.push(id);
      const scripted = behavior.webhookTestResponses.shift();
      if (scripted !== undefined) return fulfill(scripted.status, scripted.body);
      const endpoint = webhooks.find((item) => item.id === id && item.status === "active");
      if (endpoint === undefined) return fulfill(404, { ok: false, code: "not_found", request_id: "ui-e2e-webhook-test-missing" });
      return fulfill(200, makeEnvelope("webhook_test_sent", { status_class: "2xx" }));
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
        return fulfill(200, makeEnvelope("catalog_import_applied", catalogImportApplyResponse(replay)));
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
      return fulfill(200, makeEnvelope("catalog_import_applied", catalogImportApplyResponse(stored.preview)));
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
          features: rows.map(({ project, feature_key, feature_inclusion, addon_key, policy_id, status, display_order, max_active_devices }) => ({
            project,
            feature_key,
            feature_inclusion,
            addon_key,
            policy_id,
            status,
            display_order,
            max_active_devices,
          })),
        }],
      }));
    }
    const catalogPlanDetailMatch = /^\/api\/admin\/catalog\/plans\/([^/]+)$/.exec(path);
    if (method === "GET" && catalogPlanDetailMatch !== null) {
      const id = decodeURIComponent(catalogPlanDetailMatch[1]);
      requests.catalogPlanReads.push(id);
      await deferRead(`catalog-plan:${id}`);
      if (behavior.catalogPlanReadResponses.length > 0) {
        const response = behavior.catalogPlanReadResponses.shift();
        return fulfill(response.status ?? 200, fixtureResponseBody(response));
      }
      const row = catalogPlans.find((item) => item.id === id);
      if (row === undefined) {
        return fulfill(404, { ok: false, code: "catalog_plan_not_found", request_id: "ui-e2e-plan-read-missing" });
      }
      return fulfill(200, makeEnvelope("catalog_plan", { ...row }));
    }
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
        if (!namesOnly(body, ["project", "feature_key", "feature_inclusion", "addon_key", "policy_id", "status", "display_order", "max_active_devices"])) {
          return fulfill(400, { ok: false, code: "invalid_request", request_id: "ui-e2e-plan-feature-invalid" });
        }
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
          max_active_devices: body.max_active_devices ?? null,
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
      };
      const selectedAddons = new Set(body.addons ?? []);
      const planRows = catalogPlanFeatures
        .filter((item) => item.plan_id === plan.id && item.status === "active")
        .filter((item) => item.feature_inclusion === "included" || selectedAddons.has(item.addon_key));
      const willCreate = planRows.map((row) => {
        const policy = policies.find((item) => item.id === row.policy_id);
        return {
          ...base,
          feature: row.feature_key,
          policy_id: row.policy_id,
          source: row.feature_inclusion,
          addon_key: row.addon_key,
          license_mode: policy?.type === "trial" ? "trial" : "node_locked",
          max_active_devices: row.max_active_devices ?? policy?.max_active_devices ?? 1,
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
          status: "active",
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
          trial_started_at: null,
          trial_device_key_id: null,
          max_active_devices: item.max_active_devices,
          lease_seconds: 0,
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
      const selectsPolicy = body.policy_id !== undefined && body.policy_id !== null && body.policy_id !== "";
      if (!namesOnly(body, ENTITLEMENT_CREATE_FIELDS) || (selectsPolicy && !namesOnly(body, ENTITLEMENT_POLICY_CREATE_FIELDS))) {
        return fulfill(400, { ok: false, code: "invalid_request", request_id: "ui-e2e-entitlement-refused-field" });
      }
      now += 1;
      const row = {
        id: `ent-${nextEntitlementId}`,
        project: body.project,
        feature: body.feature,
        license_fingerprint: body.license_fingerprint,
        status: body.status ?? "active",
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
        trial_started_at: null,
        trial_device_key_id: null,
        max_active_devices: body.max_active_devices ?? 1,
        lease_seconds: 0,
        license_mode: "node_locked",
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
        if (!namesOnly(body, ENTITLEMENT_PATCH_FIELDS)) {
          return fulfill(400, { ok: false, code: "invalid_request", request_id: "ui-e2e-entitlement-refused-field" });
        }
        // The device limit is patched alone, and a protected grant keeps room for its connected devices.
        if (body.max_active_devices !== undefined) {
          if (Object.keys(body).some((field) => !["max_active_devices", "expected_customer_id", "expected_revocation_seq"].includes(field))) {
            return fulfill(400, { ok: false, code: "invalid_request", request_id: "ui-e2e-limit-combined" });
          }
          if (body.max_active_devices < behavior.devicesInUse) {
            return fulfill(409, { ok: false, code: "capacity_in_use", request_id: "ui-e2e-capacity-in-use", data: { devices_in_use: behavior.devicesInUse } });
          }
          now += 1;
          Object.assign(row, { max_active_devices: body.max_active_devices, revocation_seq: row.revocation_seq + 1, updated_at: now });
          addEvent("update", row);
          return fulfill(200, makeEnvelope("entitlement_patched", publicRecord(row)));
        }
        now += 1;
        Object.assign(row, {
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
    seed: {
      policy: seedPolicy,
      webhook: seedWebhook,
      catalogFeature: seedCatalogFeature,
      catalogPlan: seedCatalogPlan,
      customer: seedCustomer,
      customers: seedCustomers,
      entitlement: seedEntitlement,
      entitlements: seedEntitlements,
      realistic: seedRealisticRecords,
    },
  };
}

export function makeProtectedConnectionsFixture(){
  const base=makeAdminApiFixture(),id=Buffer.alloc(16,1).toString('base64url'),posts=[];
  const behavior={drop:false,failRead:false,malformed:false,role:'admin',subject:'operator-one',status:'active',postFailure:null,reviewGate:null,detailFailure:false,
    capacity:[{project:'COLMAP',feature:'PRO',license_fingerprint:'a'.repeat(64),in_use:1,limit:2}],
    denied:[{project:'COLMAP',feature:'PRO',license_fingerprint:'a'.repeat(64),device_key_id:`sha256:${'d'.repeat(64)}`,ts:1750000000}]};
  const row={binding_id:id,label:'Design workstation',project:'COLMAP',feature:'PRO',license_fingerprint:'a'.repeat(64),state:'active',generation:1,revision:0,hold_until:1900000000,last_proof_at:1760000000,created_at:1750000000};
  const context=()=>({customer:{id:'cus_acme',status:behavior.status},operator:{subject:behavior.subject,actor_type:'access',role:behavior.role},server_time:1760000000});
  return {behavior,posts,row,async route(route){
    const request=route.request(),url=new URL(request.url());
    if(behavior.detailFailure && url.pathname==='/api/admin/customers/cus_acme')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,code:'temporarily_unavailable',request_id:'detail-failure'})});
    if(!url.pathname.includes('/customers/cus_acme/bindings'))return base.route(route);
    const send=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(request.method()==='POST'){
      posts.push({body:request.postData(),key:request.headers()['idempotency-key'],operator:request.headers()['x-expected-operator']});
      if(behavior.postFailure)return send(404,{ok:false,code:behavior.postFailure,request_id:'post-failure'});
      row.state='retiring';row.revision=1;row.generation=2;
      if(behavior.drop){behavior.drop=false;return route.abort();}
      return send(200,makeEnvelope('binding_retired',{binding_id:id,state:'retiring',revision:1,generation:2,effective_release_at:row.hold_until}));
    }
    if(behavior.failRead)return send(503,{ok:false,code:'temporarily_unavailable',request_id:'read-failure'});
    if(url.searchParams.has('binding_id') && behavior.reviewGate)await behavior.reviewGate;
    if(url.pathname.endsWith('/events'))return send(200,makeEnvelope('binding_events',{...context(),binding_id:id,items:posts.length?[{id:1,event_type:'retire',actor:'operator:access:operator-one',occurred_at:1760000000}]:[],next_cursor:null}));
    return send(200,makeEnvelope('customer_bindings',{...context(),capacity:behavior.capacity,denied:behavior.denied,items:behavior.malformed===true?[null]:behavior.malformed==='array-state'?[{...row,state:['active']}]:[{...row}],next_cursor:null}));
  }};
}
