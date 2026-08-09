import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

test("admin UI workflow builds plan projection paths and payloads", async () => {
  const workflow = await loadWorkflowModule("features/catalog/workflow.ts");
  assert.equal(workflow.planProjectionPreviewPath(), "/api/admin/license-plans/preview");
  assert.equal(workflow.planProjectionApplyPath(), "/api/admin/license-plans/apply");

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
