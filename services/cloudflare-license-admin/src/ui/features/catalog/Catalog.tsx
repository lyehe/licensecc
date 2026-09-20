import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useAdminNavigation } from "../../app/navigation";

import type {
  CatalogFeature,
  CatalogPlan,
  CatalogPlanFeature,
  Policy,
} from "../../../shared/api";
import { api, apiFailureDetails, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { confirmMutationUnknown, confirmSuccessWithRefreshFailure, ConfirmRefreshFailure, EXACT_READ_PROOF, type ConfirmActionOutcome, type ConfirmActionResolution, type ExactReadProof, useContextGeneration, useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";
import { loadAllExactPages, loadMore } from "../../shared/pagination";
import { hasCatalogFeatureData, hasCatalogFeatureListData, hasCatalogFeatureTransitionData, hasCatalogPlanData, hasCatalogPlanFeatureData, hasCatalogPlanFeatureListData, hasCatalogPlanFeatureTransitionData, hasCatalogPlanListData, hasCatalogPlanTransitionData, hasPolicyListData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { useRequestFence } from "../../shared/requestFence";
import { ReadNotice } from "../../shared/ReadNotice";
import {
  canRunCatalogAction,
  catalogFeatureFormFromRecord,
  catalogFeaturePath,
  catalogFeaturesPath,
  catalogFeatureTransitionPath,
  catalogPlanFeatureTransitionPath,
  catalogPlanFeaturesPath,
  catalogPlanFormFromRecord,
  catalogPlanPath,
  catalogPlansPath,
  catalogPlanTransitionPath,
  CatalogFilter,
  emptyCatalogFeatureForm,
  emptyCatalogPlanFeatureForm,
  emptyCatalogPlanForm,
  emptyPlanProjectionForm,
  normalizeCatalogFeatureForm,
  normalizeCatalogFeaturePatch,
  normalizeCatalogPlanFeatureForm,
  normalizeCatalogPlanForm,
  normalizeCatalogPlanPatch,
} from "./workflow";
import { CatalogFeatureEditor, CatalogImportEditor, CatalogPlanEditor, CatalogPlanFeatureEditor, PlanProjectionEditor } from "./CatalogForms";
import { CatalogFeaturesTable, CatalogPlanFeaturesTable, CatalogPlansTable, PlanProjectionResults } from "./CatalogTables";
import { useCatalogImportWorkflow } from "./useCatalogImportWorkflow";
import { usePlanProjectionWorkflow } from "./usePlanProjectionWorkflow";
import { useCatalogWorkspace } from "./useCatalogWorkspace";
import { useCatalogReadState } from "./useCatalogReadState";
import { useCatalogConsequences } from "./useCatalogConsequences";
import { useCatalogExport } from "./useCatalogExport";
import { ProjectPicker } from "./ProjectPicker";

export function Catalog({ active }: { active: boolean }): React.ReactElement | null {
  const [catalogFeaturesSnapshot, setCatalogFeatures] = useState<CatalogFeature[]>([]);
  const [catalogFeatureFilter, setCatalogFeatureFilter] = useState<CatalogFilter>({ project: "", status: "" });
  const [catalogFeaturesCursorSnapshot, setCatalogFeaturesCursor] = useState<string | null>(null);
  const [catalogFeatureForm, setCatalogFeatureForm] = useState(emptyCatalogFeatureForm);
  const [editingCatalogFeatureId, setEditingCatalogFeatureId] = useState<string | null>(null);
  const [catalogPlansSnapshot, setCatalogPlans] = useState<CatalogPlan[]>([]);
  const [catalogPlanFilter, setCatalogPlanFilter] = useState<CatalogFilter>({ project: "", status: "" });
  const [catalogPlansCursorSnapshot, setCatalogPlansCursor] = useState<string | null>(null);
  const [catalogPlanForm, setCatalogPlanForm] = useState(emptyCatalogPlanForm);
  const [editingCatalogPlanId, setEditingCatalogPlanId] = useState<string | null>(null);
  const [selectedCatalogPlanId, setSelectedCatalogPlanId] = useState("");
  const [catalogPlanFeaturesSnapshot, setCatalogPlanFeatures] = useState<CatalogPlanFeature[]>([]);
  const [catalogPlanFeatureForm, setCatalogPlanFeatureForm] = useState(emptyCatalogPlanFeatureForm);
  const [activePolicies, setActivePolicies] = useState<Policy[]>([]);
  const { catalogView, setCatalogView } = useAdminNavigation();
  const { busy: requestBusy, operationLocked, currentReason, requestConfirm, runKeyedMutation, runMutation, setMessage, setReason } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const { refreshCore } = useCoreRefresh();
  // Strict recovery reads the currently rendered catalog context, not the
  // form/filter generation captured before the write. Each reader below still
  // proves its own current fenced GET before a retained notice can clear.
  const currentCatalogFeaturesRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));
  const currentCatalogPlansRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));
  const currentCatalogPlanFeaturesRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));
  const currentCatalogImportRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));
  const planProjection = usePlanProjectionWorkflow({ refreshCore, runKeyedMutation, runMutation, setMessage });
  const catalogImport = useCatalogImportWorkflow({
    active: active && catalogView === "import",
    invalidatePlanProjection: planProjection.invalidate,
    refreshCurrentCatalog: () => currentCatalogImportRefreshRef.current(),
    requestConfirm,
    runMutation,
    setMessage,
  });
  const invalidatePlanProjectionPreview = planProjection.invalidate;
  const invalidateCatalogImportPreview = catalogImport.invalidate;
  const updatePlanProjectionForm = planProjection.updateForm;

  const workspace = useCatalogWorkspace({
    active, view: catalogView, busy: requestBusy, operationLocked,
    snapshots: { featureEditor: JSON.stringify(catalogFeatureForm), planEditor: JSON.stringify(catalogPlanForm), planFeatureEditor: JSON.stringify(catalogPlanFeatureForm), projection: JSON.stringify(planProjection.form), import: catalogImport.text },
    importApplied: catalogImport.preview !== null && catalogImport.previewBinding === null,
    projectionApplied: planProjection.preview !== null && planProjection.previewBinding === null,
    invalidate: () => { invalidatePlanProjectionPreview(); invalidateCatalogImportPreview(); },
    onDiscard: (task) => {
      if (task === "featureEditor") cancelCatalogFeatureEdit();
      else if (task === "planEditor") cancelCatalogPlanEdit();
      else if (task === "planFeatureEditor") setCatalogPlanFeatureForm(emptyCatalogPlanFeatureForm);
      else if (task === "projection") updatePlanProjectionForm(() => emptyPlanProjectionForm);
      else if (task === "import") catalogImport.updateText("");
    },
  });

  const catalogFeaturesUrl = useMemo(() => catalogFeaturesPath(catalogFeatureFilter), [catalogFeatureFilter]);
  const catalogPlansUrl = useMemo(() => catalogPlansPath(catalogPlanFilter), [catalogPlanFilter]);
  const catalogFeatureFilterContextKey = `${active ? "active" : "inactive"}\u0000${catalogView}\u0000${catalogFeatureFilter.project}\u0000${catalogFeatureFilter.status}`;
  const { generation: catalogFeatureGeneration, isCurrent: isCatalogFeatureGenerationCurrent, currentGeneration: currentCatalogFeatureGeneration, currentContext: currentCatalogFeatureContext } = useContextGeneration(catalogFeatureFilterContextKey);
  const catalogFeatureFormContextKey = JSON.stringify({ task: workspace.revision, editingCatalogFeatureId, catalogFeatureForm });
  const { generation: catalogFeatureFormGeneration, isCurrent: isCatalogFeatureFormGenerationCurrent } = useContextGeneration(catalogFeatureFormContextKey);
  const catalogPlanFilterContextKey = `${active ? "active" : "inactive"}\u0000${catalogView}\u0000${catalogPlanFilter.project}\u0000${catalogPlanFilter.status}`;
  const { generation: catalogPlanGeneration, isCurrent: isCatalogPlanGenerationCurrent, currentGeneration: currentCatalogPlanGeneration, currentContext: currentCatalogPlanContext } = useContextGeneration(catalogPlanFilterContextKey);
  const catalogPlanFormContextKey = JSON.stringify({ task: workspace.revision, editingCatalogPlanId, catalogPlanForm });
  const { generation: catalogPlanFormGeneration, isCurrent: isCatalogPlanFormGenerationCurrent } = useContextGeneration(catalogPlanFormContextKey);
  const catalogFeaturesFence = useRequestFence(`${catalogFeatureFilterContextKey}\u0000${catalogFeaturesUrl}`);
  const catalogPlansFence = useRequestFence(`${catalogPlanFilterContextKey}\u0000${catalogPlansUrl}`);
  const featureRead = useCatalogReadState(catalogFeatureFilterContextKey);
  const planRead = useCatalogReadState(catalogPlanFilterContextKey);
  // A selected id is only meaningful while it belongs to the settled current
  // page-one snapshot. On a filter/load transition the raw state may still
  // contain an old id for one render; never let it form a mutation path.
  const settledSelectedCatalogPlanId = catalogPlansFence.isSettled() && catalogPlansSnapshot.some((plan) => plan.id === selectedCatalogPlanId)
    ? selectedCatalogPlanId
    : "";
  const catalogPlanFeatureContextKey = `${catalogPlanFilterContextKey}\u0000${settledSelectedCatalogPlanId}`;
  const { generation: catalogPlanFeatureGeneration, isCurrent: isCatalogPlanFeatureGenerationCurrent, currentGeneration: currentCatalogPlanFeatureGeneration, currentContext: currentCatalogPlanFeatureContext } = useContextGeneration(catalogPlanFeatureContextKey);
  const catalogPlanFeatureFormContextKey = JSON.stringify({ task: workspace.revision, catalogPlanFeatureForm });
  const { generation: catalogPlanFeatureFormGeneration, isCurrent: isCatalogPlanFeatureFormGenerationCurrent } = useContextGeneration(catalogPlanFeatureFormContextKey);
  const catalogPlanFeaturesFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${catalogPlanFeatureContextKey}`);
  const planFeaturesRead = useCatalogReadState(catalogPlanFeatureContextKey);
  const activePoliciesFence = useRequestFence(`${active ? "active" : "inactive"}\u0000catalog-active-policies`);
  const exportCatalogPlan = useCatalogExport(active);

  async function refreshCatalogFeatures(invalidatePreview = true, strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    if (invalidatePreview) invalidatePlanProjectionPreview();
    featureRead.begin();
    const ticket = catalogFeaturesFence.begin();
    const response = await api<{ items: CatalogFeature[]; next_cursor: string | null }>(catalogFeaturesUrl);
    if (!isCurrent() || !catalogFeaturesFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<{ items: CatalogFeature[]; next_cursor: string | null }>(response, "catalog_features_listed", hasCatalogFeatureListData);
    if (parsed !== null) {
      if (catalogFeaturesFence.settle(ticket, parsed.data.next_cursor ?? null)) {
        setCatalogFeatures(parsed.data.items);
        setCatalogFeaturesCursor(parsed.data.next_cursor ?? null);
        featureRead.settle();
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      featureRead.fail(apiFailureMessage(response));
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      featureRead.fail(apiFailureMessage(response));
      setMessage(apiFailureMessage(response));
    }
    return null;
  }

  async function refreshCatalogPlans(invalidatePreview = true, strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    if (invalidatePreview) invalidatePlanProjectionPreview();
    planRead.begin();
    const ticket = catalogPlansFence.begin();
    const response = await api<{ items: CatalogPlan[]; next_cursor: string | null }>(catalogPlansUrl);
    if (!isCurrent() || !catalogPlansFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<{ items: CatalogPlan[]; next_cursor: string | null }>(response, "catalog_plans_listed", hasCatalogPlanListData);
    if (parsed !== null) {
      if (catalogPlansFence.settle(ticket, parsed.data.next_cursor ?? null)) {
        setCatalogPlans(parsed.data.items);
        setCatalogPlansCursor(parsed.data.next_cursor ?? null);
        const selectedStillVisible = selectedCatalogPlanId !== "" && parsed.data.items.some((plan) => plan.id === selectedCatalogPlanId);
        if (!selectedStillVisible) {
          setSelectedCatalogPlanId((current) => parsed.data.items.some((plan) => plan.id === current) ? current : "");
          setCatalogPlanFeatures([]);
          if (editingCatalogPlanId !== null) cancelCatalogPlanEdit();
        }
        planRead.settle();
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      planRead.fail(apiFailureMessage(response));
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      planRead.fail(apiFailureMessage(response));
      setMessage(apiFailureMessage(response));
    }
    return null;
  }

  async function refreshCatalogPlanFeatures(planId = selectedCatalogPlanId, invalidatePreview = true, strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    if (invalidatePreview) invalidatePlanProjectionPreview();
    if (planId === "") {
      setCatalogPlanFeatures([]);
      planFeaturesRead.settle();
      return null;
    }
    planFeaturesRead.begin();
    const ticket = catalogPlanFeaturesFence.begin();
    const response = await api<{ items: CatalogPlanFeature[] }>(catalogPlanFeaturesPath(planId));
    if (!isCurrent() || !catalogPlanFeaturesFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<{ items: CatalogPlanFeature[] }>(response, "catalog_plan_features_listed", hasCatalogPlanFeatureListData);
    if (parsed !== null) {
      if (catalogPlanFeaturesFence.settle(ticket)) {
        setCatalogPlanFeatures(parsed.data.items);
        planFeaturesRead.settle();
        return EXACT_READ_PROOF;
      }
    }
    else if (strict) {
      planFeaturesRead.fail(apiFailureMessage(response));
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    }
    else {
      setCatalogPlanFeatures([]);
      planFeaturesRead.fail(apiFailureMessage(response));
      setMessage(apiFailureMessage(response));
    }
    return null;
  }

  currentCatalogFeaturesRefreshRef.current = () => active ? refreshCatalogFeatures(true, true) : Promise.resolve(null);
  currentCatalogPlansRefreshRef.current = () => active ? refreshCatalogPlans(true, true) : Promise.resolve(null);
  currentCatalogPlanFeaturesRefreshRef.current = () => active && settledSelectedCatalogPlanId !== ""
    ? refreshCatalogPlanFeatures(settledSelectedCatalogPlanId, true, true)
    // No plan is currently selected, so there is no detail route to prove.
    // The visible current snapshot is the catalog-plan list; read it rather
    // than treating a stale no-op as a successful recovery.
    : currentCatalogPlansRefreshRef.current();
  currentCatalogImportRefreshRef.current = async () => {
    if (!active) return null;
    let proved = false;
    if ((await currentCatalogFeaturesRefreshRef.current()) !== EXACT_READ_PROOF) return null;
    proved = true;
    if ((await currentCatalogPlansRefreshRef.current()) !== EXACT_READ_PROOF) return null;
    if (settledSelectedCatalogPlanId !== "" && (await currentCatalogPlanFeaturesRefreshRef.current()) !== EXACT_READ_PROOF) return null;
    return proved ? EXACT_READ_PROOF : null;
  };

  useEffect(() => {
    invalidatePlanProjectionPreview();
    invalidateCatalogImportPreview();
  }, [active]);
  useEffect(() => {
    const generation = catalogFeatureGeneration;
    if (active) void refreshCatalogFeatures(true, false, () => isCatalogFeatureGenerationCurrent(generation));
  }, [active, catalogFeatureGeneration, catalogFeaturesUrl, isCatalogFeatureGenerationCurrent]);
  useEffect(() => {
    const generation = catalogPlanGeneration;
    if (active) void refreshCatalogPlans(true, false, () => isCatalogPlanGenerationCurrent(generation));
  }, [active, catalogPlanGeneration, catalogPlansUrl, isCatalogPlanGenerationCurrent]);
  useEffect(() => {
    const generation = catalogPlanFeatureGeneration;
    if (active) void refreshCatalogPlanFeatures(settledSelectedCatalogPlanId, true, false, () => isCatalogPlanFeatureGenerationCurrent(generation));
  }, [active, catalogPlanFeatureGeneration, isCatalogPlanFeatureGenerationCurrent, settledSelectedCatalogPlanId]);
  useEffect(() => {
    if (!active) return;
    void (async () => {
      const result = await loadAllExactPages<Policy>("/api/admin/policies?status=active", "policies_listed", hasPolicyListData, activePoliciesFence, (policy) => policy.id);
      if (result.kind === "success") setActivePolicies(result.items);
      else if (result.kind === "failure") setMessage(result.message);
    })();
  }, [active, activePoliciesFence, setMessage]);

  function selectCatalogPlan(plan: CatalogPlan): void {
    setSelectedCatalogPlanId(plan.id);
    setCatalogPlanFeatureForm((current) => ({ ...current, project: plan.project }));
    invalidatePlanProjectionPreview();
  }

  function beginCatalogFeatureEdit(feature: CatalogFeature): void {
    const form = catalogFeatureFormFromRecord(feature);
    workspace.open("featureEditor", () => { setEditingCatalogFeatureId(feature.id); setCatalogFeatureForm(form); }, JSON.stringify(form));
  }
  function cancelCatalogFeatureEdit(): void {
    setEditingCatalogFeatureId(null);
    setCatalogFeatureForm(emptyCatalogFeatureForm);
    workspace.markClean("featureEditor", JSON.stringify(emptyCatalogFeatureForm));
  }
  function beginCatalogPlanEdit(plan: CatalogPlan): void {
    const form = catalogPlanFormFromRecord(plan);
    workspace.open("planEditor", () => { setEditingCatalogPlanId(plan.id); setCatalogPlanForm(form); selectCatalogPlan(plan); }, JSON.stringify(form));
  }
  function cancelCatalogPlanEdit(): void {
    setEditingCatalogPlanId(null);
    setCatalogPlanForm(emptyCatalogPlanForm);
    workspace.markClean("planEditor", JSON.stringify(emptyCatalogPlanForm));
  }

  async function submitCatalogFeatureCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (editingCatalogFeatureId !== null && (!catalogFeaturesFence.canLoadMore() || featureRead.error !== null || !catalogFeaturesSnapshot.some((feature) => feature.id === editingCatalogFeatureId))) {
      cancelCatalogFeatureEdit();
      setMessage("catalog_feature_not_visible");
      return;
    }
    const contextGeneration = catalogFeatureGeneration;
    const formGeneration = catalogFeatureFormGeneration;
    const isListCurrent = (): boolean => isCatalogFeatureGenerationCurrent(contextGeneration);
    const isCurrent = (): boolean =>
      isListCurrent() && isCatalogFeatureFormGenerationCurrent(formGeneration);
    let body: ReturnType<typeof normalizeCatalogFeatureForm> | ReturnType<typeof normalizeCatalogFeaturePatch>;
    try {
      body = editingCatalogFeatureId === null ? normalizeCatalogFeatureForm(catalogFeatureForm) : normalizeCatalogFeaturePatch(catalogFeatureForm);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "invalid_catalog_feature");
      return;
    }
    const creating = editingCatalogFeatureId === null;
    const featureId = editingCatalogFeatureId;
    const requestBody = JSON.stringify(body);
    await runKeyedMutation({
      request: { method: creating ? "POST" : "PATCH", path: creating ? "/api/admin/catalog/features" : catalogFeaturePath(featureId as string), body: requestBody },
      send: (attempt) => api<CatalogFeature>(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (result, phase) => parseMutationResponse(result, creating ? "catalog_feature_created" : "catalog_feature_patched", (value): value is CatalogFeature => {
        if (!hasCatalogFeatureData(value)) return false;
        const row = value as CatalogFeature;
        if (creating) {
          const input = body as ReturnType<typeof normalizeCatalogFeatureForm>;
          return row.project === input.project && row.feature_key === input.feature_key && row.status === (input.status ?? "active");
        }
        const patch = body as ReturnType<typeof normalizeCatalogFeaturePatch>;
        return row.id === featureId &&
          (patch.name === undefined || row.name === patch.name) &&
          (patch.description === undefined || row.description === patch.description) &&
          (patch.category === undefined || row.category === patch.category);
      }, creating ? mutationFailurePolicies.catalogFeatureCreate : mutationFailurePolicies.catalogFeaturePatch, phase),
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setMessage(`${parsed.code} (${parsed.requestId})`);
        invalidatePlanProjectionPreview();
        invalidateCatalogImportPreview();
        if (isCatalogFeatureFormGenerationCurrent(formGeneration)) cancelCatalogFeatureEdit();
      },
      refresh: async () => await currentCatalogFeaturesRefreshRef.current(),
      onUnapplied: (parsed) => {
        if (isCurrent()) {
        setMessage(`${parsed.code} (${parsed.requestId})`);
        }
      },
      isCurrent,
    });
  }

  async function catalogFeatureTransition(feature: CatalogFeature, action: "disable" | "reenable", idempotencyKey: string = crypto.randomUUID()): Promise<ConfirmActionOutcome> {
    const contextGeneration = catalogFeatureGeneration;
    let reconciliationGeneration = contextGeneration;
    const isCurrent = (): boolean => isCatalogFeatureGenerationCurrent(reconciliationGeneration);
    const captureRecoveryContext = (): void => {
      if (currentCatalogFeatureContext() === catalogFeatureFilterContextKey) {
        reconciliationGeneration = currentCatalogFeatureGeneration();
      }
    };
    const targetStatus = action === "reenable" ? "active" : "disabled";
    const expectedCode = `catalog_feature_${action}d`;
    const body = JSON.stringify(action === "disable" ? { reason: currentReason() } : {});
    const dataGuard = (value: unknown): value is CatalogFeature => hasCatalogFeatureTransitionData(value, feature.id, targetStatus);
    const refreshStatus = async (): Promise<ExactReadProof | null> => {
      captureRecoveryContext();
      return await currentCatalogFeaturesRefreshRef.current();
    };
    const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent).manualRefresh;
    const replay = async (): Promise<ConfirmActionResolution> => {
      captureRecoveryContext();
      const retry = await runMutation(async () => {
        try {
          return await api<unknown>(catalogFeatureTransitionPath(feature.id, action), { method: "POST", headers: { "idempotency-key": idempotencyKey }, body });
        } catch {
          return null;
        }
      }, "recovery");
      if (retry === undefined || retry === null) return "indeterminate";
      const parsed = parseMutationResponse(retry, expectedCode, dataGuard, mutationFailurePolicies.catalogFeatureTransition[action], "replay");
      if (parsed.kind !== "success") return parsed.kind === "failure" ? "unapplied" : "indeterminate";
      try {
        return (await refreshStatus()) === EXACT_READ_PROOF ? "applied" : "refresh_failed";
      } catch {
        return "refresh_failed";
      }
    };
    const reconciliation = { label: "Reconcile status", run: replay, isCurrent, settlesRetainedAttempt: true, postSuccessRefresh };
    const mutation = await runMutation(async () => {
      try {
        return await api<unknown>(catalogFeatureTransitionPath(feature.id, action), { method: "POST", headers: { "idempotency-key": idempotencyKey }, body });
      } catch {
        return null;
      }
    }, "consequence");
    if (mutation === undefined) return { ok: false, message: "mutation_busy", retryable: true };
    if (mutation === null) return confirmMutationUnknown(reconciliation);
    const parsed = parseMutationResponse(mutation, expectedCode, dataGuard, mutationFailurePolicies.catalogFeatureTransition[action], "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") {
      setMessage(`${parsed.code} (${parsed.requestId})`);
      return { ok: false, message: `${parsed.code} (${parsed.requestId})`, retryable: true };
    }
    setMessage(`${parsed.code} (${parsed.requestId})`);
    invalidatePlanProjectionPreview();
    invalidateCatalogImportPreview();
    if (action === "disable") setReason("");
    try {
      return (await currentCatalogFeaturesRefreshRef.current()) === EXACT_READ_PROOF
        ? { ok: true }
        : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    } catch {
      return confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    }
  }

  async function submitCatalogPlanCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (editingCatalogPlanId !== null && (!catalogPlansFence.canLoadMore() || planRead.error !== null || !catalogPlansSnapshot.some((plan) => plan.id === editingCatalogPlanId))) {
      cancelCatalogPlanEdit();
      setMessage("catalog_plan_not_visible");
      return;
    }
    const contextGeneration = catalogPlanGeneration;
    const formGeneration = catalogPlanFormGeneration;
    const isListCurrent = (): boolean => isCatalogPlanGenerationCurrent(contextGeneration);
    const isCurrent = (): boolean =>
      isListCurrent() && isCatalogPlanFormGenerationCurrent(formGeneration);
    let body: ReturnType<typeof normalizeCatalogPlanForm> | ReturnType<typeof normalizeCatalogPlanPatch>;
    try {
      body = editingCatalogPlanId === null ? normalizeCatalogPlanForm(catalogPlanForm) : normalizeCatalogPlanPatch(catalogPlanForm);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "invalid_catalog_plan");
      return;
    }
    const creating = editingCatalogPlanId === null;
    const planId = editingCatalogPlanId;
    const requestBody = JSON.stringify(body);
    await runKeyedMutation({
      request: { method: creating ? "POST" : "PATCH", path: creating ? "/api/admin/catalog/plans" : catalogPlanPath(planId as string), body: requestBody },
      send: (attempt) => api<CatalogPlan>(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (result, phase) => parseMutationResponse(result, creating ? "catalog_plan_created" : "catalog_plan_patched", (value): value is CatalogPlan => {
        if (!hasCatalogPlanData(value)) return false;
        const row = value as CatalogPlan;
        if (creating) {
          const input = body as ReturnType<typeof normalizeCatalogPlanForm>;
          return row.project === input.project && row.plan_key === input.plan_key && row.version === (input.version ?? 1) && row.status === (input.status ?? "active");
        }
        const patch = body as ReturnType<typeof normalizeCatalogPlanPatch>;
        return row.id === planId &&
          (patch.name === undefined || row.name === patch.name) &&
          (patch.description === undefined || row.description === patch.description);
      }, creating ? mutationFailurePolicies.catalogPlanCreate : mutationFailurePolicies.catalogPlanPatch, phase),
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setMessage(`${parsed.code} (${parsed.requestId})`);
        invalidatePlanProjectionPreview();
        invalidateCatalogImportPreview();
        if (isCatalogPlanFormGenerationCurrent(formGeneration)) {
          cancelCatalogPlanEdit();
          selectCatalogPlan(parsed.data);
        }
      },
      refresh: async () => await currentCatalogPlansRefreshRef.current(),
      onUnapplied: (parsed) => {
        if (isCurrent()) {
        setMessage(`${parsed.code} (${parsed.requestId})`);
        }
      },
      isCurrent,
    });
  }

  async function catalogPlanTransition(plan: CatalogPlan, action: "disable" | "reenable", idempotencyKey: string = crypto.randomUUID()): Promise<ConfirmActionOutcome> {
    const contextGeneration = catalogPlanGeneration;
    let reconciliationGeneration = contextGeneration;
    const isCurrent = (): boolean => isCatalogPlanGenerationCurrent(reconciliationGeneration);
    const captureRecoveryContext = (): void => {
      if (currentCatalogPlanContext() === catalogPlanFilterContextKey) {
        reconciliationGeneration = currentCatalogPlanGeneration();
      }
    };
    const targetStatus = action === "reenable" ? "active" : "disabled";
    const expectedCode = `catalog_plan_${action}d`;
    const body = JSON.stringify(action === "disable" ? { reason: currentReason() } : {});
    const dataGuard = (value: unknown): value is CatalogPlan => hasCatalogPlanTransitionData(value, plan.id, targetStatus);
    const refreshStatus = async (): Promise<ExactReadProof | null> => {
      captureRecoveryContext();
      return await currentCatalogPlansRefreshRef.current();
    };
    const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent).manualRefresh;
    const replay = async (): Promise<ConfirmActionResolution> => {
      captureRecoveryContext();
      const retry = await runMutation(async () => {
        try {
          return await api<unknown>(catalogPlanTransitionPath(plan.id, action), { method: "POST", headers: { "idempotency-key": idempotencyKey }, body });
        } catch {
          return null;
        }
      }, "recovery");
      if (retry === undefined || retry === null) return "indeterminate";
      const parsed = parseMutationResponse(retry, expectedCode, dataGuard, mutationFailurePolicies.catalogPlanTransition[action], "replay");
      if (parsed.kind !== "success") return parsed.kind === "failure" ? "unapplied" : "indeterminate";
      try {
        return (await refreshStatus()) === EXACT_READ_PROOF ? "applied" : "refresh_failed";
      } catch {
        return "refresh_failed";
      }
    };
    const reconciliation = { label: "Reconcile status", run: replay, isCurrent, settlesRetainedAttempt: true, postSuccessRefresh };
    const mutation = await runMutation(async () => {
      try {
        return await api<unknown>(catalogPlanTransitionPath(plan.id, action), { method: "POST", headers: { "idempotency-key": idempotencyKey }, body });
      } catch {
        return null;
      }
    }, "consequence");
    if (mutation === undefined) return { ok: false, message: "mutation_busy", retryable: true };
    if (mutation === null) return confirmMutationUnknown(reconciliation);
    const parsed = parseMutationResponse(mutation, expectedCode, dataGuard, mutationFailurePolicies.catalogPlanTransition[action], "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") {
      setMessage(`${parsed.code} (${parsed.requestId})`);
      return { ok: false, message: `${parsed.code} (${parsed.requestId})`, retryable: true };
    }
    setMessage(`${parsed.code} (${parsed.requestId})`);
    invalidatePlanProjectionPreview();
    invalidateCatalogImportPreview();
    if (action === "disable") setReason("");
    try {
      return (await currentCatalogPlansRefreshRef.current()) === EXACT_READ_PROOF
        ? { ok: true }
        : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    } catch {
      return confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    }
  }

  async function catalogPlanFeatureTransition(row: CatalogPlanFeature, action: "disable" | "reenable", idempotencyKey: string = crypto.randomUUID()): Promise<ConfirmActionOutcome> {
    const contextGeneration = catalogPlanFeatureGeneration;
    let reconciliationGeneration = contextGeneration;
    const isCurrent = (): boolean => isCatalogPlanFeatureGenerationCurrent(reconciliationGeneration);
    const captureRecoveryContext = (): void => {
      if (currentCatalogPlanFeatureContext() === catalogPlanFeatureContextKey) {
        reconciliationGeneration = currentCatalogPlanFeatureGeneration();
      }
    };
    const targetStatus = action === "reenable" ? "active" : "disabled";
    const expectedCode = `catalog_plan_feature_${action}d`;
    const body = JSON.stringify(action === "disable" ? { reason: currentReason() } : {});
    const dataGuard = (value: unknown): value is CatalogPlanFeature => hasCatalogPlanFeatureTransitionData(value, row.plan_id, row.feature_key, targetStatus);
    const refreshStatus = async (): Promise<ExactReadProof | null> => {
      captureRecoveryContext();
      return await currentCatalogPlanFeaturesRefreshRef.current();
    };
    const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent).manualRefresh;
    const replay = async (): Promise<ConfirmActionResolution> => {
      captureRecoveryContext();
      const retry = await runMutation(async () => {
        try {
          return await api<unknown>(catalogPlanFeatureTransitionPath(row.plan_id, row.feature_key, action), { method: "POST", headers: { "idempotency-key": idempotencyKey }, body });
        } catch {
          return null;
        }
      }, "recovery");
      if (retry === undefined || retry === null) return "indeterminate";
      const parsed = parseMutationResponse(retry, expectedCode, dataGuard, mutationFailurePolicies.catalogPlanFeatureTransition[action], "replay");
      if (parsed.kind !== "success") return parsed.kind === "failure" ? "unapplied" : "indeterminate";
      try {
        return (await refreshStatus()) === EXACT_READ_PROOF ? "applied" : "refresh_failed";
      } catch {
        return "refresh_failed";
      }
    };
    const reconciliation = { label: "Reconcile status", run: replay, isCurrent, settlesRetainedAttempt: true, postSuccessRefresh };
    const mutation = await runMutation(async () => {
      try {
        return await api<unknown>(catalogPlanFeatureTransitionPath(row.plan_id, row.feature_key, action), { method: "POST", headers: { "idempotency-key": idempotencyKey }, body });
      } catch {
        return null;
      }
    }, "consequence");
    if (mutation === undefined) return { ok: false, message: "mutation_busy", retryable: true };
    if (mutation === null) return confirmMutationUnknown(reconciliation);
    const parsed = parseMutationResponse(mutation, expectedCode, dataGuard, mutationFailurePolicies.catalogPlanFeatureTransition[action], "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") {
      setMessage(`${parsed.code} (${parsed.requestId})`);
      return { ok: false, message: `${parsed.code} (${parsed.requestId})`, retryable: true };
    }
    setMessage(`${parsed.code} (${parsed.requestId})`);
    invalidatePlanProjectionPreview();
    invalidateCatalogImportPreview();
    if (action === "disable") setReason("");
    try {
      return (await currentCatalogPlanFeaturesRefreshRef.current()) === EXACT_READ_PROOF
        ? { ok: true }
        : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    } catch {
      return confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    }
  }

  async function submitCatalogPlanFeatureCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (settledSelectedCatalogPlanId === "" || !catalogPlansFence.canLoadMore() || planRead.error !== null) {
      setMessage("catalog_plan_required");
      return;
    }
    const contextGeneration = catalogPlanFeatureGeneration;
    const formGeneration = catalogPlanFeatureFormGeneration;
    const selectedPlanId = settledSelectedCatalogPlanId;
    if (catalogPlanFeatureForm.policy_id !== "" && (!activePoliciesFence.isSettled() || !activePolicies.some((policy) => policy.id === catalogPlanFeatureForm.policy_id))) {
      setMessage("catalog_policy_not_available");
      return;
    }
    const isListCurrent = (): boolean => isCatalogPlanFeatureGenerationCurrent(contextGeneration);
    const isCurrent = (): boolean =>
      isListCurrent() && isCatalogPlanFeatureFormGenerationCurrent(formGeneration);
    let body: ReturnType<typeof normalizeCatalogPlanFeatureForm>;
    try {
      body = normalizeCatalogPlanFeatureForm(catalogPlanFeatureForm);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "invalid_catalog_plan_feature");
      return;
    }
    const requestBody = JSON.stringify(body);
    await runKeyedMutation({
      request: { method: "POST", path: catalogPlanFeaturesPath(selectedPlanId), body: requestBody },
      send: (attempt) => api<CatalogPlanFeature>(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (result, phase) => parseMutationResponse(result, "catalog_plan_feature_saved", (value): value is CatalogPlanFeature => {
        if (!hasCatalogPlanFeatureData(value)) return false;
        const row = value as CatalogPlanFeature;
        return row.plan_id === selectedPlanId && row.project === body.project && row.feature_key === body.feature_key && row.feature_inclusion === body.feature_inclusion && row.status === body.status;
      }, mutationFailurePolicies.catalogPlanFeatureSave, phase),
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setMessage(`${parsed.code} (${parsed.requestId})`);
        invalidatePlanProjectionPreview();
        invalidateCatalogImportPreview();
        if (isCatalogPlanFeatureFormGenerationCurrent(formGeneration)) {
          const form = { ...emptyCatalogPlanFeatureForm, project: catalogPlanFeatureForm.project };
          setCatalogPlanFeatureForm(form);
          workspace.markClean("planFeatureEditor", JSON.stringify(form));
        }
      },
      refresh: async () => await currentCatalogPlanFeaturesRefreshRef.current(),
      onUnapplied: (parsed) => {
        if (isCurrent()) {
        setMessage(`${parsed.code} (${parsed.requestId})`);
        }
      },
      isCurrent,
    });
  }

  const catalogFeaturesSettled = catalogFeaturesFence.isSettled();
  const catalogPlansSettled = catalogPlansFence.isSettled();
  const catalogPlanFeaturesSettled = catalogPlanFeaturesFence.isSettled();
  const catalogFeatures = catalogFeaturesSettled ? catalogFeaturesSnapshot : [];
  const catalogFeaturesCursor = catalogFeaturesFence.canLoadMore() ? catalogFeaturesCursorSnapshot : null;
  const catalogPlans = catalogPlansSettled ? catalogPlansSnapshot : [];
  const catalogPlansCursor = catalogPlansFence.canLoadMore() ? catalogPlansCursorSnapshot : null;
  const catalogPlanFeatures = catalogPlanFeaturesSettled ? catalogPlanFeaturesSnapshot : [];
  const visibleCatalogFeatures = catalogFeatures;
  const visibleCatalogPlans = catalogPlans;
  const activePoliciesSettled = activePoliciesFence.isSettled();
  const visibleActivePolicies = activePoliciesSettled ? activePolicies : [];
  const catalogFeatureEditActionable = editingCatalogFeatureId === null || (catalogFeaturesFence.canLoadMore() && featureRead.error === null && catalogFeaturesSnapshot.some((feature) => feature.id === editingCatalogFeatureId));
  const catalogPlanEditActionable = editingCatalogPlanId === null || (catalogPlansFence.canLoadMore() && planRead.error === null && catalogPlansSnapshot.some((plan) => plan.id === editingCatalogPlanId));
  const planForm = planProjection.form;
  const planPreviewBinding = planProjection.previewBinding;
  const planPreview = planProjection.preview;
  const submitPlanPreview = planProjection.submitPreview;
  const applyPlanProjectionFromPreview = planProjection.applyFromPreview;
  const catalogImportText = catalogImport.text;
  const catalogImportPreviewBinding = catalogImport.previewBinding;
  const catalogImportPreview = catalogImport.preview;
  const previewCatalogImport = catalogImport.previewImport;
  const requestCatalogImportApply = catalogImport.requestApply;

  const { requestPlanDisable, runPlanReenable, requestFeatureDisable, runFeatureReenable, requestPlanFeatureDisable, runPlanFeatureReenable } = useCatalogConsequences(
    { run: catalogPlanTransition, isCurrent: () => isCatalogPlanGenerationCurrent(catalogPlanGeneration) },
    { run: catalogFeatureTransition, isCurrent: () => isCatalogFeatureGenerationCurrent(catalogFeatureGeneration) },
    { run: catalogPlanFeatureTransition, isCurrent: () => isCatalogPlanFeatureGenerationCurrent(catalogPlanFeatureGeneration) },
  );
  if (!active) return null;
  const selectedCatalogPlan = visibleCatalogPlans.find((plan) => plan.id === settledSelectedCatalogPlanId) ?? null;

  function prepareProjection(plan: CatalogPlan | null = null): void {
    const form = plan === null ? { ...emptyPlanProjectionForm } : { ...emptyPlanProjectionForm, project: plan.project, plan_id: plan.id, plan_key: plan.plan_key };
    workspace.open("projection", () => updatePlanProjectionForm(() => form), JSON.stringify(form));
  }
  return (
    <section className="listPage catalogWorkspace">
      {workspace.task === null && catalogView !== "import" && <ProjectPicker onSelect={project => { setCatalogPlanFilter(previous => ({ ...previous, project })); setCatalogFeatureFilter(previous => ({ ...previous, project })); }} />}
      <nav className="sectionTabs" aria-label="Catalog views">{(["plans", "features", "import"] as const).map((view) => <a key={view} href={view === "plans" ? "#/plans" : `#/plans?view=${view}`} aria-current={catalogView === view ? "page" : undefined} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); setCatalogView(view); }}>{view === "plans" ? "Plans" : view === "features" ? "Features" : "Import"}</a>)}</nav>
      {catalogView === "import" ? <section className="importWorkspace"><fieldset disabled={operationLocked}>
        <CatalogImportEditor text={catalogImportText} previewBinding={catalogImportPreviewBinding} preview={catalogImportPreview} busy={busy} onUpdate={catalogImport.updateText} onPreview={() => void previewCatalogImport()} onApply={requestCatalogImportApply} />
      </fieldset></section> : workspace.task !== null ? <section className={workspace.task === "planDetail" ? "recordDetail" : "editorLayout"} data-focus-section="catalog-task">
        <div className="editorHeader"><button type="button" disabled={busy} onClick={workspace.close}>{catalogView === "features" ? "Back to features" : "Back to plans"}</button></div>
        <fieldset disabled={operationLocked}>
          {workspace.task === "featureEditor" && <CatalogFeatureEditor form={catalogFeatureForm} editingId={editingCatalogFeatureId} busy={busy} actionable={catalogFeatureEditActionable} onChange={setCatalogFeatureForm} onSubmit={(event) => void submitCatalogFeatureCreate(event)} onCancel={workspace.close} />}
          {workspace.task === "planEditor" && <CatalogPlanEditor form={catalogPlanForm} editingId={editingCatalogPlanId} busy={busy} actionable={catalogPlanEditActionable} onChange={setCatalogPlanForm} onSubmit={(event) => void submitCatalogPlanCreate(event)} onCancel={workspace.close} />}
          {workspace.task === "planFeatureEditor" && <CatalogPlanFeatureEditor form={catalogPlanFeatureForm} busy={busy} plansSettled={catalogPlansFence.canLoadMore() && planRead.error === null} activePoliciesSettled={activePoliciesSettled} selectedPlanId={settledSelectedCatalogPlanId} plans={visibleCatalogPlans} features={visibleCatalogFeatures} policies={visibleActivePolicies} onChange={setCatalogPlanFeatureForm} onSelectPlan={selectCatalogPlan} onClearPlan={() => { setSelectedCatalogPlanId(""); invalidatePlanProjectionPreview(); }} onSubmit={(event) => void submitCatalogPlanFeatureCreate(event)} />}
          {workspace.task === "projection" && <><PlanProjectionEditor form={planForm} previewBinding={planPreviewBinding} busy={busy} onUpdate={updatePlanProjectionForm} onSubmit={(event) => void submitPlanPreview(event)} onApply={() => void applyPlanProjectionFromPreview()} /><PlanProjectionResults preview={planPreview} binding={planPreviewBinding} /></>}
        </fieldset>
        {workspace.task === "planDetail" && (selectedCatalogPlan === null ? <><h2>Plan unavailable</h2><p>The selected plan is not in the current settled list. Return to Plans and select an available record.</p><ReadNotice {...planRead} hasData={false} onRetry={() => void refreshCatalogPlans()} label="plans" /></> : <>
          <div className="detailHeader"><div><h2>{selectedCatalogPlan.name || selectedCatalogPlan.plan_key}</h2><p>{selectedCatalogPlan.project} / {selectedCatalogPlan.plan_key} · Version {selectedCatalogPlan.version}</p></div><span className={`status ${selectedCatalogPlan.status}`}>{selectedCatalogPlan.status}</span></div>
          <p>{selectedCatalogPlan.description || "No description provided."}</p>
          <div className="pageActions"><button type="button" className="primary" disabled={busy} onClick={() => { const form = { ...emptyCatalogPlanFeatureForm, project: selectedCatalogPlan.project }; workspace.open("planFeatureEditor", () => setCatalogPlanFeatureForm(form), JSON.stringify(form)); }}>Add feature</button><button type="button" disabled={busy} onClick={() => prepareProjection(selectedCatalogPlan)}>Prepare plan application</button><button type="button" disabled={busy} onClick={() => beginCatalogPlanEdit(selectedCatalogPlan)}>Edit plan</button></div>
          <details><summary>Technical details</summary><code>{selectedCatalogPlan.id}</code></details>
          <ReadNotice {...planFeaturesRead} hasData={catalogPlanFeatures.length > 0} onRetry={() => void refreshCatalogPlanFeatures()} label="plan features" />
          <CatalogPlanFeaturesTable rows={catalogPlanFeatures} loaded={catalogPlanFeaturesSettled && !planFeaturesRead.loading && planFeaturesRead.error === null} selectedPlan={selectedCatalogPlan} busy={busy || planFeaturesRead.loading || planFeaturesRead.error !== null} canDisable={(row) => canRunCatalogAction(row.status, "disable")} canReenable={(row) => canRunCatalogAction(row.status, "reenable")} onDisable={requestPlanFeatureDisable} onReenable={runPlanFeatureReenable} />
        </>)}
      </section> : catalogView === "plans" ? <>
        <div className="listHeader"><p>Reusable plans and their included features.</p><div className="pageActions"><button type="button" disabled={busy} onClick={() => prepareProjection()}>Prepare plan application</button><button type="button" className="primary" disabled={busy} onClick={() => workspace.open("planEditor", cancelCatalogPlanEdit, JSON.stringify(emptyCatalogPlanForm))}>New plan</button></div></div>
        <section className="tablePane" data-focus-section="catalog-list"><ReadNotice {...planRead} hasData={catalogPlans.length > 0} onRetry={() => void refreshCatalogPlans()} label="plans" />
          <CatalogPlansTable plans={catalogPlans} selectedPlanId={selectedCatalogPlanId} filter={catalogPlanFilter} loaded={catalogPlansSettled} hasMore={catalogPlansCursor !== null} actionsDisabled={busy || planRead.loading || planRead.error !== null} canDisable={(plan) => canRunCatalogAction(plan.status, "disable")} canReenable={(plan) => canRunCatalogAction(plan.status, "reenable")} onFilter={setCatalogPlanFilter} onSelect={(plan) => workspace.open("planDetail", () => selectCatalogPlan(plan))} onEdit={beginCatalogPlanEdit} onExport={(plan) => void exportCatalogPlan(plan)} onDisable={requestPlanDisable} onReenable={runPlanReenable} onLoadMore={() => { if (catalogPlansCursor !== null) void loadMore(catalogPlansUrl, catalogPlansCursor, catalogPlans, setCatalogPlans, setCatalogPlansCursor, setMessage, hasCatalogPlanListData, "catalog_plans_listed", catalogPlansFence, (plan) => plan.id); }} />
        </section>
      </> : <>
        <div className="listHeader"><p>Features that can be included in your plans.</p><button type="button" className="primary" disabled={busy} onClick={() => workspace.open("featureEditor", cancelCatalogFeatureEdit, JSON.stringify(emptyCatalogFeatureForm))}>New feature</button></div>
        <section className="tablePane" data-focus-section="catalog-list"><ReadNotice {...featureRead} hasData={catalogFeatures.length > 0} onRetry={() => void refreshCatalogFeatures()} label="features" />
          <CatalogFeaturesTable features={catalogFeatures} filter={catalogFeatureFilter} loaded={catalogFeaturesSettled} hasMore={catalogFeaturesCursor !== null} actionsDisabled={busy || featureRead.loading || featureRead.error !== null} canDisable={(feature) => canRunCatalogAction(feature.status, "disable")} canReenable={(feature) => canRunCatalogAction(feature.status, "reenable")} onFilter={setCatalogFeatureFilter} onEdit={beginCatalogFeatureEdit} onDisable={requestFeatureDisable} onReenable={runFeatureReenable} onLoadMore={() => { if (catalogFeaturesCursor !== null) void loadMore(catalogFeaturesUrl, catalogFeaturesCursor, catalogFeatures, setCatalogFeatures, setCatalogFeaturesCursor, setMessage, hasCatalogFeatureListData, "catalog_features_listed", catalogFeaturesFence, (feature) => feature.id); }} />
        </section>
      </>}
    </section>
  );
}
