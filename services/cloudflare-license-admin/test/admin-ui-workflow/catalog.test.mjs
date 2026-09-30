import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule, loadWorkflowModules } from "./helpers.mjs";

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
    policy_id: "pol_team",
    display_order: 3,
    max_active_devices: "6",
  });
  // A plan feature grants a device limit and nothing else: the Worker refuses a body naming a seat,
  // borrowing, meter or TTL field.
  assert.deepEqual(planFeature, {
    project: "DEFAULT",
    feature_key: "team",
    feature_inclusion: "addon",
    addon_key: "team_seats",
    policy_id: "pol_team",
    status: "active",
    display_order: 3,
    max_active_devices: 6,
  });
  assert.deepEqual(Object.keys(workflow.emptyCatalogPlanFeatureForm).sort(),
    ["addon_key", "display_order", "feature_inclusion", "feature_key", "max_active_devices", "policy_id", "project", "status"]);

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

test("admin UI workflow accepts an Apply response only when it exactly echoes the confirmed catalog preview", async () => {
  const workflow = await loadWorkflowModule("features/catalog/workflow.ts");
  const manifest = {
    format_version: 1,
    features: [
      { project: "DEFAULT", feature_key: "first", name: "First" },
      { project: "DEFAULT", feature_key: "second", name: "Second" },
    ],
    plans: [],
  };
  const snapshot = workflow.catalogImportInputSnapshot(manifest);
  const normalized = JSON.parse(snapshot);
  const digest = await workflow.catalogImportInputDigest(manifest);
  const preview = {
    preview_id: "civ_confirmed_preview",
    manifest_digest: digest,
    manifest: normalized,
    effects: {
      features: normalized.features.map((feature, index) => ({
        target: { entity: "feature", project: feature.project, feature_key: feature.feature_key },
        effect: "create",
        before: null,
        after: { id: `feat_${feature.feature_key}`, ...feature, created_at: index + 1, updated_at: index + 1 },
      })),
      plans: [],
      plan_features: [],
      summary: {
        features: { create: 2, update: 0, disable: 0, reenable: 0, unchanged: 0 },
        plans: { create: 0, update: 0, disable: 0, reenable: 0, unchanged: 0 },
        plan_features: { create: 0, update: 0, disable: 0, reenable: 0, unchanged: 0 },
      },
    },
    effective_at: 10,
    expires_at: 310,
    source_generation: 7,
  };
  const copy = () => JSON.parse(JSON.stringify(preview));

  assert.equal(workflow.catalogImportPreviewMatchesLocalInput(preview, digest, snapshot), true);
  assert.equal(workflow.catalogImportApplyMatchesConfirmedPreview(copy(), preview), true);

  const wrongManifest = copy();
  wrongManifest.manifest.features[0].name = "Substituted";
  assert.equal(workflow.catalogImportPreviewMatchesLocalInput(wrongManifest, digest, snapshot), false);

  const substitutions = [
    (value) => { value.preview_id = "civ_substituted_preview"; },
    (value) => { value.manifest_digest = "f".repeat(64); },
    (value) => { value.manifest.features[0].name = "Substituted"; },
    (value) => { value.effects.features[0].after.name = "Substituted"; },
    (value) => {
      value.effects.features[0].effect = "update";
      value.effects.summary.features = { create: 1, update: 1, disable: 0, reenable: 0, unchanged: 0 };
    },
    (value) => { value.effects.features.reverse(); },
    (value) => { value.effective_at += 1; },
    (value) => { value.source_generation += 1; },
  ];
  for (const substitute of substitutions) {
    const response = copy();
    substitute(response);
    assert.equal(workflow.catalogImportApplyMatchesConfirmedPreview(response, preview), false);
  }
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

test("admin UI workflow freezes a confirmed plan projection binding against the live one, not a stray self-comparison", async () => {
  const binding = await loadWorkflowModule("features/catalog/planProjectionBinding.ts");
  const bindingA = { input: {}, digest: "a", preview: {} };
  const bindingB = { input: {}, digest: "b", preview: {} };
  // The exact confirmed binding, at the exact confirmed revision, is usable.
  assert.equal(binding.planProjectionBindingIsUsable(bindingA, 1, bindingA, 1), true);
  // A different revision (the form changed and bumped it) makes it stale, even with the same binding.
  assert.equal(binding.planProjectionBindingIsUsable(bindingA, 1, bindingA, 2), false);
  // A different binding object at the same revision (a fresh preview replaced it) is also stale.
  assert.equal(binding.planProjectionBindingIsUsable(bindingA, 1, bindingB, 1), false);
  // No live binding at all (invalidated) is stale.
  assert.equal(binding.planProjectionBindingIsUsable(bindingA, 1, null, 1), false);
});

test("each catalog validation code names the field of its own form, and whole-form codes name none", async () => {
  const [workflow, fields, messages] = await loadWorkflowModules(["features/catalog/workflow.ts", "features/catalog/fieldErrors.ts", "shared/messages.ts"]);
  const codeOf = (run) => {
    try {
      run();
    } catch (error) {
      return error.message;
    }
    assert.fail("the form should be refused");
  };
  const feature = (patch) => codeOf(() => workflow.normalizeCatalogFeatureForm({ ...workflow.emptyCatalogFeatureForm, feature_key: "export", name: "Export", ...patch }));
  assert.equal(fields.catalogFeatureFieldForCode(feature({ feature_key: "x".repeat(16) })), "feature_key");
  assert.equal(fields.catalogFeatureFieldForCode(feature({ name: "" })), "name");
  assert.equal(fields.catalogFeatureFieldForCode(feature({ project: "" })), "project");
  assert.equal(fields.catalogFeatureFieldForCode(feature({ category: "a\nb" })), "category");
  assert.equal(fields.catalogFeatureFieldForCode(feature({ description: "a\nb" })), "description");
  assert.equal(fields.catalogFeatureFieldForCode("catalog_feature_conflict"), "feature_key");
  assert.equal(messages.describeCode(feature({ feature_key: "x".repeat(16) })).text, "Required. Use one line within the length limit.");

  const plan = (patch) => codeOf(() => workflow.normalizeCatalogPlanForm({ ...workflow.emptyCatalogPlanForm, plan_key: "pro", name: "Pro", ...patch }));
  assert.equal(fields.catalogPlanFieldForCode(plan({ version: 0 })), "version");
  assert.equal(fields.catalogPlanFieldForCode(plan({ plan_key: "" })), "plan_key");
  assert.equal(fields.catalogPlanFieldForCode(plan({ description: "a\nb" })), "description");
  assert.equal(fields.catalogPlanFieldForCode("catalog_plan_conflict"), "plan_key");
  assert.equal(messages.describeCode(plan({ version: 0 })).text, "Enter a whole number from 1 to 1,000,000.");

  const row = (patch) => codeOf(() => workflow.normalizeCatalogPlanFeatureForm({ ...workflow.emptyCatalogPlanFeatureForm, feature_key: "export", ...patch }));
  assert.equal(fields.catalogPlanFeatureFieldForCode(row({ feature_inclusion: "addon" })), "addon_key");
  assert.equal(fields.catalogPlanFeatureFieldForCode(row({ max_active_devices: "1.5" })), "max_active_devices");
  assert.equal(fields.catalogPlanFeatureFieldForCode(row({ display_order: -1 })), "display_order");
  assert.equal(fields.catalogPlanFeatureFieldForCode("catalog_feature_not_found"), "feature_key");
  assert.equal(fields.catalogPlanFeatureFieldForCode("catalog_policy_not_available"), "policy_id");
  assert.equal(fields.catalogPlanFeatureFieldForCode("policy_disabled"), "policy_id");
  // Rules for fields this editor does not show stay with the whole form.
  assert.equal(fields.catalogPlanFeatureFieldForCode("pool_size_must_be_between_0_and_1000000"), null);

  const projection = (patch) => codeOf(() => workflow.normalizePlanProjectionForm({ ...workflow.emptyPlanProjectionForm, license_id: "lic_1", plan_key: "pro", ...patch }));
  assert.equal(fields.planProjectionFieldForCode(projection({ plan_key: "" })), "plan_key");
  assert.equal(fields.planProjectionFieldForCode(projection({ license_id: "" })), "license_id");
  assert.equal(fields.planProjectionFieldForCode(projection({ addons: "x".repeat(129) })), "addons");
  assert.equal(fields.planProjectionFieldForCode(projection({ support_until: "31/12/2026" })), "support_until");
  assert.equal(fields.planProjectionFieldForCode("unknown_addon"), "addons");
  assert.equal(fields.catalogImportFieldForCode("invalid_catalog_import_manifest"), "manifest");

  for (const code of ["invalid_request", "catalog_mutation_failed", "catalog_plan_feature_conflict", "constructor", "definitely_not_a_code"]) {
    for (const fieldFor of [fields.catalogFeatureFieldForCode, fields.catalogPlanFieldForCode, fields.catalogPlanFeatureFieldForCode, fields.planProjectionFieldForCode, fields.catalogImportFieldForCode]) {
      assert.equal(fieldFor(code), null, code);
    }
  }
});
