import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

test("admin UI workflow builds plan projection paths and payloads", async () => {
  const workflow = await loadWorkflowModule("features/catalog/workflow.ts");
  assert.equal(workflow.planProjectionPreviewPath(), "/api/admin/license-plans/preview");
  assert.equal(workflow.planProjectionApplyPath(), "/api/admin/license-plans/apply");
  assert.deepEqual(workflow.planProjectionApplyBody("ppv_server_bound"), { preview_id: "ppv_server_bound" });
  assert.throws(() => workflow.planProjectionApplyBody("not-a-preview"), /preview_id_required_or_invalid/);
  assert.throws(() => workflow.planProjectionApplyBody("ppv_not=safe"), /preview_id_required_or_invalid/);
  assert.throws(() => workflow.planProjectionApplyBody("ppv_line\nbreak"), /preview_id_required_or_invalid/);
  assert.throws(() => workflow.planProjectionApplyBody("ppv_"), /preview_id_required_or_invalid/);

  const body = workflow.normalizePlanProjectionForm({
    ...workflow.emptyPlanProjectionForm,
    license_id: "lic_123",
    license_fingerprint: "c".repeat(64),
    customer_id: "cus_123",
    plan_key: "pro",
    support_until: "2026-07-05",
    addons: "team_seats, export, team_seats",
    notes: "annual renewal",
  });
  assert.deepEqual(body, {
    project: "DEFAULT",
    license_id: "lic_123",
    license_fingerprint: "c".repeat(64),
    customer_id: "cus_123",
    plan_key: "pro",
    support_until: 1783209600,
    addons: ["team_seats", "export"],
    notes: "annual renewal",
  });
  assert.throws(() => workflow.normalizePlanProjectionForm({
    ...workflow.emptyPlanProjectionForm,
    license_id: "lic_123",
    license_fingerprint: "c".repeat(64),
  }), /plan_id_or_plan_key_required/);
  assert.throws(() => workflow.normalizePlanProjectionForm({
    ...workflow.emptyPlanProjectionForm,
    plan_key: "pro",
    license_fingerprint: "c".repeat(64),
  }), /license_id_required/);
});

test("admin UI workflow binds every editable plan projection field to a stable snapshot", async () => {
  const workflow = await loadWorkflowModule("features/catalog/workflow.ts");
  const body = workflow.normalizePlanProjectionForm({
    ...workflow.emptyPlanProjectionForm,
    project: "ACME",
    license_id: "lic_123",
    license_fingerprint: "d".repeat(64),
    customer_id: "cus_123",
    plan_id: "plan_pro",
    plan_key: "pro",
    support_until: "2026-07-05",
    addons: "team_seats, export, team_seats",
    notes: "annual renewal",
  });
  assert.deepEqual(body, {
    project: "ACME",
    license_id: "lic_123",
    license_fingerprint: "d".repeat(64),
    customer_id: "cus_123",
    addons: ["team_seats", "export"],
    notes: "annual renewal",
    plan_id: "plan_pro",
    plan_key: "pro",
    support_until: 1783209600,
  });
  assert.equal(
    workflow.planProjectionInputSnapshot(body),
    JSON.stringify({
      project: "ACME",
      license_id: "lic_123",
      license_fingerprint: "d".repeat(64),
      customer_id: "cus_123",
      plan_id: "plan_pro",
      plan_key: "pro",
      support_until: 1783209600,
      support_until_provided: true,
      addons: ["team_seats", "export"],
      notes: "annual renewal",
    }),
  );
  const digest = await workflow.planProjectionInputDigest(body);
  assert.match(digest, /^[0-9a-f]{64}$/);
  const omittedSupportUntil = { ...body };
  delete omittedSupportUntil.support_until;
  const explicitNullSupportUntil = { ...body, support_until: null };
  assert.notEqual(
    workflow.planProjectionInputSnapshot(omittedSupportUntil),
    workflow.planProjectionInputSnapshot(explicitNullSupportUntil),
  );
  assert.notEqual(
    await workflow.planProjectionInputDigest(omittedSupportUntil),
    await workflow.planProjectionInputDigest(explicitNullSupportUntil),
  );
});

test("admin UI workflow builds catalog paths and payloads", async () => {
  const workflow = await loadWorkflowModule("features/catalog/workflow.ts");
  assert.equal(workflow.catalogFeaturesPath({ project: "", status: "" }), "/api/admin/catalog/features");
  assert.equal(
    workflow.catalogFeaturesPath({ project: "DEFAULT", status: "active" }),
    "/api/admin/catalog/features?project=DEFAULT&status=active",
  );
  assert.equal(workflow.catalogPlansPath({ project: "", status: "" }), "/api/admin/catalog/plans");
  assert.equal(
    workflow.catalogPlansPath({ project: "DEFAULT", status: "disabled" }),
    "/api/admin/catalog/plans?project=DEFAULT&status=disabled",
  );
  assert.equal(
    workflow.catalogPlanFeaturesPath("plan/with space"),
    "/api/admin/catalog/plans/plan%2Fwith%20space/features",
  );
  assert.equal(workflow.catalogFeaturePath("feat/with space"), "/api/admin/catalog/features/feat%2Fwith%20space");
  assert.equal(workflow.catalogPlanPath("plan/with space"), "/api/admin/catalog/plans/plan%2Fwith%20space");
  assert.equal(workflow.catalogFeatureTransitionPath("feat/with space", "disable"), "/api/admin/catalog/features/feat%2Fwith%20space/disable");
  assert.equal(workflow.catalogPlanTransitionPath("plan/with space", "reenable"), "/api/admin/catalog/plans/plan%2Fwith%20space/reenable");
  assert.equal(
    workflow.catalogPlanFeatureTransitionPath("plan/with space", "core/seat", "disable"),
    "/api/admin/catalog/plans/plan%2Fwith%20space/features/core%2Fseat/disable",
  );
  assert.equal(workflow.catalogPlanExportPath("plan/with space"), "/api/admin/catalog/plans/plan%2Fwith%20space/export");
  assert.equal(workflow.catalogImportPath(), "/api/admin/catalog/import");
  assert.equal(workflow.catalogImportPath(true), "/api/admin/catalog/import?dry_run=1");
  assert.deepEqual(workflow.catalogImportApplyBody("civ_server_bound"), { preview_id: "civ_server_bound" });
  assert.throws(() => workflow.catalogImportApplyBody("civ_not=safe"), /catalog_import_preview_id_required_or_invalid/);
  assert.throws(() => workflow.catalogImportApplyBody("manifest-instead-of-preview"), /catalog_import_preview_id_required_or_invalid/);
  assert.equal(workflow.canRunCatalogAction("active", "disable"), true);
  assert.equal(workflow.canRunCatalogAction("disabled", "disable"), false);
  assert.equal(workflow.canRunCatalogAction("disabled", "reenable"), true);

  assert.deepEqual(workflow.normalizeCatalogFeatureForm({
    ...workflow.emptyCatalogFeatureForm,
    feature_key: "core",
    name: "Core",
    description: "",
    category: "",
  }), {
    project: "DEFAULT",
    feature_key: "core",
    name: "Core",
    status: "active",
  });
  const featureRecord = {
    id: "feat_core",
    project: "DEFAULT",
    feature_key: "core",
    name: "Core",
    description: "Runtime",
    category: "",
    status: "active",
    created_at: 1,
    updated_at: 2,
  };
  assert.deepEqual(workflow.catalogFeatureFormFromRecord(featureRecord), {
    project: "DEFAULT",
    feature_key: "core",
    name: "Core",
    description: "Runtime",
    category: "",
    status: "active",
  });
  assert.deepEqual(workflow.normalizeCatalogFeaturePatch(workflow.catalogFeatureFormFromRecord(featureRecord)), {
    name: "Core",
    description: "Runtime",
    category: "",
  });

  assert.deepEqual(workflow.normalizeCatalogPlanForm({
    ...workflow.emptyCatalogPlanForm,
    plan_key: "pro",
    name: "Pro",
    description: "Professional",
    version: 2,
  }), {
    project: "DEFAULT",
    plan_key: "pro",
    name: "Pro",
    description: "Professional",
    status: "active",
    version: 2,
  });
  const planRecord = {
    id: "plan_pro",
    project: "DEFAULT",
    plan_key: "pro",
    name: "Pro",
    description: "",
    status: "disabled",
    version: 2,
    created_at: 1,
    updated_at: 2,
  };
  assert.deepEqual(workflow.catalogPlanFormFromRecord(planRecord), {
    project: "DEFAULT",
    plan_key: "pro",
    name: "Pro",
    description: "",
    status: "disabled",
    version: 2,
  });
  assert.deepEqual(workflow.normalizeCatalogPlanPatch(workflow.catalogPlanFormFromRecord(planRecord)), {
    name: "Pro",
    description: "",
  });

  const planFeature = workflow.normalizeCatalogPlanFeatureForm({
    ...workflow.emptyCatalogPlanFeatureForm,
    feature_key: "team",
    feature_inclusion: "addon",
    addon_key: "team_seats",
    policy_id: "pol_float",
    display_order: 3,
    pool_size: "6",
    max_active_devices: "6",
    max_borrow_sec: "172800",
  });
  assert.deepEqual(planFeature, {
    project: "DEFAULT",
    feature_key: "team",
    feature_inclusion: "addon",
    addon_key: "team_seats",
    policy_id: "pol_float",
    status: "active",
    display_order: 3,
    assertion_ttl_seconds: null,
    pool_size: 6,
    max_active_devices: 6,
    max_borrow_sec: 172800,
    meter_quota: null,
    meter_period_sec: null,
  });

  assert.throws(() => workflow.normalizeCatalogFeatureForm({
    ...workflow.emptyCatalogFeatureForm,
    feature_key: "feature-key-too-long",
    name: "Core",
  }), /feature_key_required_or_too_long/);
  assert.throws(() => workflow.normalizeCatalogPlanFeatureForm({
    ...workflow.emptyCatalogPlanFeatureForm,
    feature_key: "team",
    feature_inclusion: "addon",
  }), /addon_key_required/);
});

test("admin UI workflow binds catalog import Apply to a canonical manifest snapshot", async () => {
  const workflow = await loadWorkflowModule("features/catalog/workflow.ts");
  const firstOrder = {
    format_version: 1,
    features: [
      { project: "DEFAULT", feature_key: "zeta", name: "Zeta" },
      { project: "DEFAULT", feature_key: "alpha", name: "Alpha", category: "", status: "active" },
    ],
    plans: [{
      project: "DEFAULT",
      plan_key: "pro",
      name: "Pro",
      features: [
        { project: "DEFAULT", feature_key: "zeta", feature_inclusion: "included" },
        { project: "DEFAULT", feature_key: "alpha", feature_inclusion: "included" },
      ],
    }],
  };
  const reorderedDefaults = {
    features: [
      { name: "Alpha", feature_key: "alpha", project: "DEFAULT" },
      { name: "Zeta", feature_key: "zeta", project: "DEFAULT", description: "", category: "", status: "active" },
    ],
    plans: [{
      name: "Pro",
      project: "DEFAULT",
      plan_key: "pro",
      description: "",
      status: "active",
      version: 1,
      features: [
        { project: "DEFAULT", feature_key: "alpha", feature_inclusion: "included" },
        { project: "DEFAULT", feature_key: "zeta", feature_inclusion: "included" },
      ],
    }],
  };
  assert.equal(
    workflow.catalogImportInputSnapshot(firstOrder),
    workflow.catalogImportInputSnapshot(reorderedDefaults),
  );
  assert.equal(
    await workflow.catalogImportInputDigest(firstOrder),
    await workflow.catalogImportInputDigest(reorderedDefaults),
  );
});

test("admin UI workflow preserves catalog-import target tuples and typed delta values", async () => {
  const workflow = await loadWorkflowModule("features/catalog/workflow.ts");
  const first = { entity: "feature", project: "A / B", feature_key: "C" };
  const second = { entity: "feature", project: "A", feature_key: "B / C" };
  assert.notEqual(workflow.catalogImportTargetKey(first), workflow.catalogImportTargetKey(second));
  assert.deepEqual(workflow.catalogImportTargetFields(first), [
    { label: "entity", value: "feature" },
    { label: "project", value: "A / B" },
    { label: "feature_key", value: "C" },
  ]);
  assert.deepEqual(workflow.catalogImportTargetFields(second), [
    { label: "entity", value: "feature" },
    { label: "project", value: "A" },
    { label: "feature_key", value: "B / C" },
  ]);
  assert.equal(workflow.catalogImportEffectValueLabel(undefined), "<absent>");
  assert.equal(workflow.catalogImportEffectValueLabel(null), "<null>");
  assert.equal(workflow.catalogImportEffectValueLabel("null"), '"null"');
  assert.equal(workflow.catalogImportEffectValueLabel("unset"), '"unset"');
});
