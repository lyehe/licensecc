import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import type {
  CatalogFeature,
  CatalogImportApplyResult,
  CatalogImportEffect,
  CatalogImportManifest,
  CatalogImportPreviewResponse,
  CatalogPlan,
  CatalogPlanFeature,
  PlanProjectionApplyInput,
  PlanProjectionApplyResult,
  PlanProjectionInput,
  PlanProjectionItem,
  PlanProjectionPreviewResponse,
  Policy,
} from "../../../shared/api";
import { api, apiFailureDetails, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { confirmMutationUnknown, confirmSuccessWithRefreshFailure, ConfirmRefreshFailure, EXACT_READ_PROOF, focusTargetInRow, focusTargetInSection, type ConfirmActionContext, type ConfirmActionOutcome, type ConfirmActionResolution, type ExactReadProof, useContextGeneration, useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";
import { formatEpoch, shortHash } from "../../shared/format";
import { loadAllExactPages, loadMore } from "../../shared/pagination";
import { hasCatalogFeatureData, hasCatalogFeatureListData, hasCatalogFeatureTransitionData, hasCatalogImportApplyData, hasCatalogImportManifestData, hasCatalogImportPreviewData, hasCatalogPlanData, hasCatalogPlanFeatureData, hasCatalogPlanFeatureListData, hasCatalogPlanFeatureTransitionData, hasCatalogPlanListData, hasCatalogPlanTransitionData, hasPlanProjectionApplyData, hasPlanProjectionPreviewEvidence, hasPolicyListData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { useRequestFence } from "../../shared/requestFence";
import {
  canRunCatalogAction,
  catalogFeatureFormFromRecord,
  catalogFeaturePath,
  catalogFeaturesPath,
  catalogFeatureTransitionPath,
  catalogImportApplyBody,
  catalogImportEffectValueLabel,
  catalogImportInputDigest,
  catalogImportInputSnapshot,
  catalogImportPath,
  catalogImportTargetFields,
  catalogImportTargetKey,
  catalogPlanExportPath,
  catalogPlanFeatureTransitionPath,
  catalogPlanFeaturesPath,
  catalogPlanFormFromRecord,
  catalogPlanPath,
  catalogPlansPath,
  catalogPlanTransitionPath,
  CatalogFilter,
  disableCatalogFeatureConfirm,
  disableCatalogPlanConfirm,
  disableCatalogPlanFeatureConfirm,
  emptyCatalogFeatureForm,
  emptyCatalogPlanFeatureForm,
  emptyCatalogPlanForm,
  emptyPlanProjectionForm,
  normalizeCatalogFeatureForm,
  normalizeCatalogFeaturePatch,
  normalizeCatalogPlanFeatureForm,
  normalizeCatalogPlanForm,
  normalizeCatalogPlanPatch,
  normalizePlanProjectionForm,
  planProjectionInputDigest,
  planProjectionApplyBody,
  planProjectionApplyPath,
  PlanProjectionFormState,
  planProjectionPreviewPath,
} from "./workflow";

interface PlanProjectionPreviewBinding {
  input: PlanProjectionInput;
  digest: string;
  preview: PlanProjectionPreviewResponse;
}

interface CatalogImportPreviewBinding {
  digest: string;
  snapshot: string;
  preview: CatalogImportPreviewResponse;
}

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
  const [catalogImportText, setCatalogImportText] = useState("");
  const [catalogImportPreviewBinding, setCatalogImportPreviewBinding] = useState<CatalogImportPreviewBinding | null>(null);
  const catalogImportPreviewBindingRef = useRef<CatalogImportPreviewBinding | null>(null);
  catalogImportPreviewBindingRef.current = catalogImportPreviewBinding;
  const [catalogImportApplyResult, setCatalogImportApplyResult] = useState<CatalogImportApplyResult | null>(null);
  const catalogImportRevision = useRef(0);
  const [planForm, setPlanForm] = useState(emptyPlanProjectionForm);
  const [planPreviewBinding, setPlanPreviewBinding] = useState<PlanProjectionPreviewBinding | null>(null);
  const [planApplyResult, setPlanApplyResult] = useState<PlanProjectionApplyResult | null>(null);
  const planProjectionRevision = useRef(0);
  const [activePolicies, setActivePolicies] = useState<Policy[]>([]);
  const { busy: requestBusy, operationLocked, currentReason, requestConfirm, runConsequenceAction, runKeyedMutation, runMutation, setMessage, setReason } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const { refreshCore } = useCoreRefresh();
  const catalogFeaturesUrl = useMemo(() => catalogFeaturesPath(catalogFeatureFilter), [catalogFeatureFilter]);
  const catalogPlansUrl = useMemo(() => catalogPlansPath(catalogPlanFilter), [catalogPlanFilter]);
  const catalogFeatureFilterContextKey = `${active ? "active" : "inactive"}\u0000${catalogFeatureFilter.project}\u0000${catalogFeatureFilter.status}`;
  const { generation: catalogFeatureGeneration, isCurrent: isCatalogFeatureGenerationCurrent, currentGeneration: currentCatalogFeatureGeneration, currentContext: currentCatalogFeatureContext } = useContextGeneration(catalogFeatureFilterContextKey);
  const catalogFeatureFormContextKey = JSON.stringify({ editingCatalogFeatureId, catalogFeatureForm });
  const { generation: catalogFeatureFormGeneration, isCurrent: isCatalogFeatureFormGenerationCurrent } = useContextGeneration(catalogFeatureFormContextKey);
  const catalogPlanFilterContextKey = `${active ? "active" : "inactive"}\u0000${catalogPlanFilter.project}\u0000${catalogPlanFilter.status}`;
  const { generation: catalogPlanGeneration, isCurrent: isCatalogPlanGenerationCurrent, currentGeneration: currentCatalogPlanGeneration, currentContext: currentCatalogPlanContext } = useContextGeneration(catalogPlanFilterContextKey);
  const catalogPlanFormContextKey = JSON.stringify({ editingCatalogPlanId, catalogPlanForm });
  const { generation: catalogPlanFormGeneration, isCurrent: isCatalogPlanFormGenerationCurrent } = useContextGeneration(catalogPlanFormContextKey);
  const catalogFeaturesFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${catalogFeaturesUrl}`);
  const catalogPlansFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${catalogPlansUrl}`);
  // A selected id is only meaningful while it belongs to the settled current
  // page-one snapshot. On a filter/load transition the raw state may still
  // contain an old id for one render; never let it form a mutation path.
  const settledSelectedCatalogPlanId = catalogPlansFence.isSettled() && catalogPlansSnapshot.some((plan) => plan.id === selectedCatalogPlanId)
    ? selectedCatalogPlanId
    : "";
  const catalogPlanFeatureContextKey = `${catalogPlanFilterContextKey}\u0000${settledSelectedCatalogPlanId}`;
  const { generation: catalogPlanFeatureGeneration, isCurrent: isCatalogPlanFeatureGenerationCurrent, currentGeneration: currentCatalogPlanFeatureGeneration, currentContext: currentCatalogPlanFeatureContext } = useContextGeneration(catalogPlanFeatureContextKey);
  const catalogPlanFeatureFormContextKey = JSON.stringify(catalogPlanFeatureForm);
  const { generation: catalogPlanFeatureFormGeneration, isCurrent: isCatalogPlanFeatureFormGenerationCurrent } = useContextGeneration(catalogPlanFeatureFormContextKey);
  const catalogImportContextKey = `${active ? "active" : "inactive"}\u0000${catalogImportText}`;
  const { generation: catalogImportGeneration, isCurrent: isCatalogImportGenerationCurrent } = useContextGeneration(catalogImportContextKey);
  const catalogPlanFeaturesFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${catalogPlanFeatureContextKey}`);
  const activePoliciesFence = useRequestFence(`${active ? "active" : "inactive"}\u0000catalog-active-policies`);
  const exportFence = useRequestFence(`${active ? "active" : "inactive"}\u0000catalog-export`);
  // Strict recovery reads the currently rendered catalog context, not the
  // form/filter generation captured before the write. Each reader below still
  // proves its own current fenced GET before a retained notice can clear.
  const currentCatalogFeaturesRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));
  const currentCatalogPlansRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));
  const currentCatalogPlanFeaturesRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));
  const currentCatalogImportRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));

  async function refreshCatalogFeatures(invalidatePreview = true, strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    if (invalidatePreview) invalidatePlanProjectionPreview();
    const ticket = catalogFeaturesFence.begin();
    const response = await api<{ items: CatalogFeature[]; next_cursor: string | null }>(catalogFeaturesUrl);
    if (!isCurrent() || !catalogFeaturesFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<{ items: CatalogFeature[]; next_cursor: string | null }>(response, "catalog_features_listed", hasCatalogFeatureListData);
    if (parsed !== null) {
      if (catalogFeaturesFence.settle(ticket, parsed.data.next_cursor ?? null)) {
        setCatalogFeatures(parsed.data.items);
        setCatalogFeaturesCursor(parsed.data.next_cursor ?? null);
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setMessage(apiFailureMessage(response));
    }
    return null;
  }

  async function refreshCatalogPlans(invalidatePreview = true, strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    if (invalidatePreview) invalidatePlanProjectionPreview();
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
          setSelectedCatalogPlanId(parsed.data.items[0]?.id ?? "");
          setCatalogPlanFeatures([]);
          if (editingCatalogPlanId !== null) cancelCatalogPlanEdit();
        }
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setMessage(apiFailureMessage(response));
    }
    return null;
  }

  async function refreshCatalogPlanFeatures(planId = selectedCatalogPlanId, invalidatePreview = true, strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    if (invalidatePreview) invalidatePlanProjectionPreview();
    if (planId === "") {
      setCatalogPlanFeatures([]);
      return null;
    }
    const ticket = catalogPlanFeaturesFence.begin();
    const response = await api<{ items: CatalogPlanFeature[] }>(catalogPlanFeaturesPath(planId));
    if (!isCurrent() || !catalogPlanFeaturesFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<{ items: CatalogPlanFeature[] }>(response, "catalog_plan_features_listed", hasCatalogPlanFeatureListData);
    if (parsed !== null) {
      if (catalogPlanFeaturesFence.settle(ticket)) {
        setCatalogPlanFeatures(parsed.data.items);
        return EXACT_READ_PROOF;
      }
    }
    else if (strict) {
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    }
    else {
      setCatalogPlanFeatures([]);
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

  function invalidatePlanProjectionPreview(): void {
    planProjectionRevision.current += 1;
    setPlanPreviewBinding(null);
    setPlanApplyResult(null);
  }

  function invalidateCatalogImportPreview(clearResult = true): void {
    catalogImportRevision.current += 1;
    catalogImportPreviewBindingRef.current = null;
    setCatalogImportPreviewBinding(null);
    if (clearResult) setCatalogImportApplyResult(null);
  }

  function updatePlanProjectionForm(updater: (current: PlanProjectionFormState) => PlanProjectionFormState): void {
    planProjectionRevision.current += 1;
    setPlanForm(updater);
    setPlanPreviewBinding(null);
  }

  function selectCatalogPlan(plan: CatalogPlan): void {
    setSelectedCatalogPlanId(plan.id);
    setCatalogPlanFeatureForm((current) => ({ ...current, project: plan.project }));
    updatePlanProjectionForm((current) => ({ ...current, project: plan.project, plan_id: plan.id, plan_key: plan.plan_key }));
  }

  function beginCatalogFeatureEdit(feature: CatalogFeature): void {
    setEditingCatalogFeatureId(feature.id);
    setCatalogFeatureForm(catalogFeatureFormFromRecord(feature));
  }
  function cancelCatalogFeatureEdit(): void {
    setEditingCatalogFeatureId(null);
    setCatalogFeatureForm(emptyCatalogFeatureForm);
  }
  function beginCatalogPlanEdit(plan: CatalogPlan): void {
    setEditingCatalogPlanId(plan.id);
    setCatalogPlanForm(catalogPlanFormFromRecord(plan));
    selectCatalogPlan(plan);
  }
  function cancelCatalogPlanEdit(): void {
    setEditingCatalogPlanId(null);
    setCatalogPlanForm(emptyCatalogPlanForm);
  }

  async function submitCatalogFeatureCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (editingCatalogFeatureId !== null && (!catalogFeaturesFence.isSettled() || !catalogFeaturesSnapshot.some((feature) => feature.id === editingCatalogFeatureId))) {
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
    if (editingCatalogPlanId !== null && (!catalogPlansFence.isSettled() || !catalogPlansSnapshot.some((plan) => plan.id === editingCatalogPlanId))) {
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

  async function exportCatalogPlan(plan: CatalogPlan): Promise<void> {
    await runMutation(async () => {
      const ticket = exportFence.begin();
      const result = await api<CatalogImportManifest>(catalogPlanExportPath(plan.id));
      if (!exportFence.isCurrent(ticket)) return;
      const parsed = parseExactApiSuccess<CatalogImportManifest>(result, "catalog_plan_exported", hasCatalogImportManifestData);
      if (parsed === null) {
        setMessage(apiFailureMessage(result));
        return;
      }
      setMessage(`${parsed.code} (${parsed.requestId})`);
      const blob = new Blob([JSON.stringify(parsed.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${plan.plan_key}-catalog.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setMessage(`exported ${plan.plan_key}-catalog.json`);
      } finally {
        URL.revokeObjectURL(url);
      }
    });
  }

  async function previewCatalogImport(): Promise<void> {
    const importGeneration = catalogImportGeneration;
    const revision = catalogImportRevision.current;
    const isCurrent = (): boolean => active && isCatalogImportGenerationCurrent(importGeneration) && catalogImportRevision.current === revision;
    let manifest: CatalogImportManifest;
    let snapshot: string;
    let digest: string;
    try {
      manifest = JSON.parse(catalogImportText) as CatalogImportManifest;
      snapshot = catalogImportInputSnapshot(manifest);
      digest = await catalogImportInputDigest(manifest);
    } catch {
      if (isCurrent()) setMessage("invalid_catalog_import_manifest");
      return;
    }
    if (!isCurrent()) return;
    await runMutation(async () => {
      const parsed = parseMutationResponse(
        await api<unknown>(catalogImportPath(true), { method: "POST", body: JSON.stringify(manifest) }),
        "catalog_import_previewed",
        hasCatalogImportPreviewData,
        mutationFailurePolicies.catalogImport,
        "initial",
      );
      if (!isCurrent()) return;
      if (parsed.kind === "success") {
        if (parsed.data.manifest_digest !== digest) {
          invalidateCatalogImportPreview();
          setMessage("catalog_import_manifest_digest_mismatch");
          return;
        }
        const binding: CatalogImportPreviewBinding = { digest, snapshot, preview: parsed.data };
        catalogImportPreviewBindingRef.current = binding;
        setCatalogImportPreviewBinding(binding);
        setCatalogImportApplyResult(null);
        setMessage(`${parsed.code} (${parsed.requestId})`);
        return;
      }
      if (parsed.kind === "failure") {
        setMessage(parsed.code === "catalog_import_too_large"
          ? "catalog_import_too_large — narrow the manifest and preview again"
          : `${parsed.code} (${parsed.requestId})`);
        return;
      }
      setMessage("invalid_mutation_response");
    });
  }

  function catalogImportBindingIsUsable(binding: CatalogImportPreviewBinding, revision: number): boolean {
    return catalogImportRevision.current === revision && catalogImportPreviewBindingRef.current === binding;
  }

  async function applyCatalogImportFromPreview(
    binding: CatalogImportPreviewBinding,
    revision: number,
    importGeneration: number,
    idempotencyKey: string,
  ): Promise<ConfirmActionOutcome> {
    const isCurrent = (): boolean => active && isCatalogImportGenerationCurrent(importGeneration);
    if (!catalogImportBindingIsUsable(binding, revision)) {
      return { ok: false, message: "preview_required", retryable: true };
    }
    const body = JSON.stringify(catalogImportApplyBody(binding.preview.preview_id));
    const refreshStatus = async (): Promise<ExactReadProof | null> => await currentCatalogImportRefreshRef.current();
    const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent).manualRefresh;
    const applyKnown = async (parsed: { code: string; requestId: string; data: CatalogImportApplyResult }): Promise<ConfirmActionResolution> => {
      // The capability is consumed on the server even when the view became
      // inactive while the response was in flight. Only clear the exact
      // binding that issued this request, so a newer Preview is never lost.
      if (catalogImportBindingIsUsable(binding, revision)) {
        invalidateCatalogImportPreview();
        setCatalogImportApplyResult(parsed.data);
        invalidatePlanProjectionPreview();
      }
      if (isCurrent()) {
        setMessage(`${parsed.code} (${parsed.requestId})`);
      }
      if (!isCurrent()) return "applied";
      try {
        return (await refreshStatus()) === EXACT_READ_PROOF ? "applied" : "refresh_failed";
      } catch {
        return "refresh_failed";
      }
    };
    const replay = async (): Promise<ConfirmActionResolution> => {
      if (!isCurrent()) return "indeterminate";
      let retry: unknown | undefined;
      try {
        retry = await runMutation(async () => await api<unknown>(catalogImportPath(), {
          method: "POST",
          headers: { "idempotency-key": idempotencyKey },
          body,
        }), "recovery");
      } catch {
        return "indeterminate";
      }
      if (retry === undefined) return "indeterminate";
      const parsed = parseMutationResponse(retry, "catalog_import_applied", hasCatalogImportApplyData, mutationFailurePolicies.catalogImport, "replay");
      if (parsed.kind !== "success") return parsed.kind === "failure" ? "unapplied" : "indeterminate";
      return await applyKnown(parsed);
    };
    const reconciliation = { label: "Reconcile catalog import", run: replay, isCurrent, settlesRetainedAttempt: true, postSuccessRefresh };
    let mutation: unknown | undefined;
    try {
      mutation = await runMutation(async () => await api<unknown>(catalogImportPath(), {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body,
      }), "consequence");
    } catch {
      return confirmMutationUnknown(reconciliation);
    }
    if (mutation === undefined) return confirmMutationUnknown(reconciliation);
    const parsed = parseMutationResponse(mutation, "catalog_import_applied", hasCatalogImportApplyData, mutationFailurePolicies.catalogImport, "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") {
      if (["catalog_import_snapshot_stale", "stale_catalog_import_preview", "expired_catalog_import_preview", "claimed_catalog_import_preview", "catalog_import_too_large"].includes(parsed.code)) {
        invalidateCatalogImportPreview();
      }
      const message = ["catalog_import_snapshot_stale", "stale_catalog_import_preview", "expired_catalog_import_preview", "claimed_catalog_import_preview", "catalog_import_too_large"].includes(parsed.code)
        ? `${parsed.code} — preview again`
        : `${parsed.code} (${parsed.requestId})`;
      setMessage(message);
      return { ok: false, message, retryable: true };
    }
    return await applyKnown(parsed) === "applied"
      ? { ok: true }
      : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
  }

  function requestCatalogImportApply(): void {
    const binding = catalogImportPreviewBinding;
    if (binding === null) {
      setMessage("preview_required");
      return;
    }
    const revision = catalogImportRevision.current;
    const importGeneration = catalogImportGeneration;
    requestConfirm({
      title: "Apply catalog import",
      body: "Apply this exact server-bound Preview. The manifest editor is not sent again.",
      details: catalogImportConsequenceDetails(binding.preview),
      requiresReason: false,
      run: ({ idempotencyKey }: ConfirmActionContext) => applyCatalogImportFromPreview(binding, revision, importGeneration, idempotencyKey),
      successFocusTarget: focusTargetInSection("catalog-import"),
      isCurrent: () => active && isCatalogImportGenerationCurrent(importGeneration),
    });
  }

  async function submitCatalogPlanFeatureCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (settledSelectedCatalogPlanId === "") {
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
        if (isCatalogPlanFeatureFormGenerationCurrent(formGeneration)) setCatalogPlanFeatureForm((current) => ({ ...emptyCatalogPlanFeatureForm, project: current.project }));
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

  async function submitPlanPreview(event: FormEvent): Promise<void> {
    event.preventDefault();
    const revision = planProjectionRevision.current;
    await runMutation(async () => {
      let body: ReturnType<typeof normalizePlanProjectionForm>;
      try {
        body = normalizePlanProjectionForm(planForm);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_plan_projection");
        setPlanPreviewBinding(null);
        setPlanApplyResult(null);
        return;
      }
      let digest: string;
      try {
        digest = await planProjectionInputDigest(body);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "plan_projection_digest_failed");
        setPlanPreviewBinding(null);
        setPlanApplyResult(null);
        return;
      }
      setPlanPreviewBinding(null);
      setPlanApplyResult(null);
      const result = await api<PlanProjectionPreviewResponse>(planProjectionPreviewPath(), { method: "POST", body: JSON.stringify(body) });
      if (revision !== planProjectionRevision.current) return;
      const parsed = parseMutationResponse(result, "license_plan_projection_previewed", (value): value is PlanProjectionPreviewResponse => hasPlanProjectionPreviewEvidence(value, body), mutationFailurePolicies.catalogProjectionPreview, "initial");
      if (parsed.kind === "success") {
        setMessage(`${parsed.code} (${parsed.requestId})`);
        setPlanPreviewBinding({ input: body, digest, preview: parsed.data });
      } else if (parsed.kind === "failure") {
        setMessage(`${parsed.code} (${parsed.requestId})`);
      } else {
        setMessage("invalid_mutation_response");
      }
    });
  }

  async function applyPlanProjectionFromPreview(): Promise<void> {
    const binding = planPreviewBinding;
    const revision = planProjectionRevision.current;
    if (binding === null || binding.preview.blocked.length > 0) {
      setMessage("plan_projection_preview_required");
      return;
    }
    if (revision !== planProjectionRevision.current) {
      setMessage("plan_projection_preview_required");
      return;
    }
    const body: PlanProjectionApplyInput = planProjectionApplyBody(binding.preview.preview_id);
    const requestBody = JSON.stringify(body);
    const isCurrent = (): boolean => revision === planProjectionRevision.current;
    let appliedResult: PlanProjectionApplyResult | null = null;
    await runKeyedMutation<PlanProjectionApplyResult>({
      request: { method: "POST", path: planProjectionApplyPath(), body: requestBody },
      send: (attempt) => api<PlanProjectionApplyResult>(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (result, phase) => parseMutationResponse(result, "license_plan_projection_applied", (value): value is PlanProjectionApplyResult => {
        if (!hasPlanProjectionApplyData(value) || !hasPlanProjectionPreviewEvidence(value, binding.input)) return false;
        return (value as PlanProjectionApplyResult).preview_id === binding.preview.preview_id;
      }, mutationFailurePolicies.catalogProjectionApply, phase),
      onUnapplied: (parsed) => {
        if (!isCurrent()) return;
        if (["stale_projection_preview", "projection_preview_grant_expired", "license_fingerprint_conflict", "plan_projection_blocked"].includes(parsed.code)) {
        invalidatePlanProjectionPreview();
        setMessage(`${parsed.code} — preview again`);
        return;
        }
        setMessage(`${parsed.code} (${parsed.requestId})`);
      },
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setMessage(`${parsed.code} (${parsed.requestId})`);
        appliedResult = parsed.data;
      },
      refresh: async (): Promise<ExactReadProof | null> => {
        const proof = await refreshCore(true, isCurrent);
        if (proof !== EXACT_READ_PROOF || !isCurrent() || appliedResult === null) return null;
        invalidatePlanProjectionPreview();
        setPlanApplyResult(appliedResult);
        return EXACT_READ_PROOF;
      },
      isCurrent,
    });
  }

  function projectionRows(title: string, items: PlanProjectionItem[]): React.ReactElement | null {
    if (items.length === 0) return null;
    return <section className="deliveriesPane"><h3>{title}</h3><table><thead><tr><th>Feature</th><th>Mode</th><th>Policy</th><th>Window</th><th>Capacity</th><th>Source</th></tr></thead><tbody>{items.map((item) => <tr key={`${title}:${item.feature}`}><td>{item.feature}</td><td>{item.license_mode}</td><td>{item.policy_id ?? "-"}</td><td>{item.valid_until === null ? "open" : formatEpoch(item.valid_until)}</td><td>{item.pool_size > 0 ? `pool ${item.pool_size}` : `devices ${item.max_active_devices}`}</td><td>{item.addon_key ?? item.source}{item.reason ? ` / ${item.reason}` : ""}</td></tr>)}</tbody></table></section>;
  }

  function catalogImportEffectSummary(label: string, summary: CatalogImportPreviewResponse["effects"]["summary"]["features"]): string {
    return `${label}: ${summary.create} create, ${summary.update} update, ${summary.disable} disable, ${summary.reenable} reenable, ${summary.unchanged} unchanged`;
  }

  function catalogImportEffectChanges(effect: CatalogImportEffect): Array<{ field: string; before: unknown; after: unknown }> {
    const before = effect.before ?? {};
    return [...new Set([...Object.keys(before), ...Object.keys(effect.after)])]
      .filter((field) => !["id", "created_at", "updated_at"].includes(field) && before[field] !== effect.after[field])
      .sort()
      .map((field) => ({ field, before: before[field], after: effect.after[field] }));
  }

  function catalogImportRows(title: string, effects: CatalogImportEffect[]): React.ReactElement | null {
    if (effects.length === 0) return null;
    return <section className="deliveriesPane"><h3>{title}</h3><table><thead><tr><th>Transition</th><th>Target</th><th>Delta</th></tr></thead><tbody>{effects.map((effect) => {
      const changes = catalogImportEffectChanges(effect);
      const targetFields = catalogImportTargetFields(effect.target);
      return <tr key={JSON.stringify([title, catalogImportTargetKey(effect.target)])}><td>{effect.effect}</td><td><dl aria-label="Catalog import target">{targetFields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd><code>{catalogImportEffectValueLabel(field.value)}</code></dd></div>)}</dl></td><td><details><summary>Before → after ({changes.length})</summary>{changes.length === 0 ? <span className="muted">No mutable field changes</span> : <ul>{changes.map((change) => <li key={change.field}><code>{change.field}</code>: {catalogImportEffectValueLabel(change.before)} → {catalogImportEffectValueLabel(change.after)}</li>)}</ul>}</details></td></tr>;
    })}</tbody></table></section>;
  }

  function catalogImportConsequenceDetails(preview: CatalogImportPreviewResponse): React.ReactElement {
    return <div className="catalogImportConsequences"><div className="details"><span>Server preview {preview.preview_id}</span><span>Server digest {preview.manifest_digest}</span><span>Effective {formatEpoch(preview.effective_at)}</span><span>Expires {formatEpoch(preview.expires_at)}</span><span>{catalogImportEffectSummary("Features", preview.effects.summary.features)}</span><span>{catalogImportEffectSummary("Plans", preview.effects.summary.plans)}</span><span>{catalogImportEffectSummary("Plan rows", preview.effects.summary.plan_features)}</span></div>{catalogImportRows("Features", preview.effects.features)}{catalogImportRows("Plans", preview.effects.plans)}{catalogImportRows("Plan rows", preview.effects.plan_features)}</div>;
  }

  function catalogOverrideSummary(row: CatalogPlanFeature): string {
    const parts = [row.assertion_ttl_seconds === null ? "" : `TTL ${row.assertion_ttl_seconds}s`, row.pool_size === null ? "" : `pool ${row.pool_size}`, row.max_active_devices === null ? "" : `devices ${row.max_active_devices}`, row.max_borrow_sec === null ? "" : `borrow ${row.max_borrow_sec}s`, row.meter_quota === null ? "" : `meter ${row.meter_quota}`, row.meter_period_sec === null ? "" : `period ${row.meter_period_sec}s`].filter((item) => item !== "");
    return parts.length === 0 ? "-" : parts.join(" / ");
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
  const catalogFeatureEditActionable = editingCatalogFeatureId === null || (catalogFeaturesSettled && catalogFeaturesSnapshot.some((feature) => feature.id === editingCatalogFeatureId));
  const catalogPlanEditActionable = editingCatalogPlanId === null || (catalogPlansSettled && catalogPlansSnapshot.some((plan) => plan.id === editingCatalogPlanId));

  if (!active) return null;
  const selectedCatalogPlan = visibleCatalogPlans.find((plan) => plan.id === settledSelectedCatalogPlanId) ?? null;
  const planPreview = planPreviewBinding?.preview ?? planApplyResult;
  const catalogImportPreview = catalogImportPreviewBinding?.preview ?? catalogImportApplyResult;
  return (
    <section className="workspace">
      <aside><fieldset disabled={operationLocked}>
        <h2>{editingCatalogFeatureId === null ? "Catalog feature" : "Edit feature"}</h2>
        <form aria-label="Catalog feature" onSubmit={(event) => void submitCatalogFeatureCreate(event)}><label>Project<input disabled={editingCatalogFeatureId !== null} value={catalogFeatureForm.project} onChange={(event) => setCatalogFeatureForm({ ...catalogFeatureForm, project: event.target.value })} /></label><label>Feature key<input disabled={editingCatalogFeatureId !== null} value={catalogFeatureForm.feature_key} onChange={(event) => setCatalogFeatureForm({ ...catalogFeatureForm, feature_key: event.target.value })} /></label><label>Name<input value={catalogFeatureForm.name} onChange={(event) => setCatalogFeatureForm({ ...catalogFeatureForm, name: event.target.value })} /></label><label>Category<input value={catalogFeatureForm.category} onChange={(event) => setCatalogFeatureForm({ ...catalogFeatureForm, category: event.target.value })} /></label><label>Status<select disabled={editingCatalogFeatureId !== null} value={catalogFeatureForm.status} onChange={(event) => setCatalogFeatureForm({ ...catalogFeatureForm, status: event.target.value as CatalogFeature["status"] })}><option value="active">active</option><option value="disabled">disabled</option></select></label><label>Description<textarea value={catalogFeatureForm.description} onChange={(event) => setCatalogFeatureForm({ ...catalogFeatureForm, description: event.target.value })} /></label><div className="actions"><button disabled={busy || !catalogFeatureEditActionable} type="submit">{editingCatalogFeatureId === null ? "Create feature" : "Update feature"}</button>{editingCatalogFeatureId !== null && <button type="button" disabled={busy} onClick={cancelCatalogFeatureEdit}>Cancel</button>}</div></form>
        <h2>{editingCatalogPlanId === null ? "Catalog plan" : "Edit plan"}</h2>
        <form aria-label="Catalog plan" onSubmit={(event) => void submitCatalogPlanCreate(event)}><label>Project<input disabled={editingCatalogPlanId !== null} value={catalogPlanForm.project} onChange={(event) => setCatalogPlanForm({ ...catalogPlanForm, project: event.target.value })} /></label><label>Plan key<input disabled={editingCatalogPlanId !== null} value={catalogPlanForm.plan_key} onChange={(event) => setCatalogPlanForm({ ...catalogPlanForm, plan_key: event.target.value })} /></label><label>Name<input value={catalogPlanForm.name} onChange={(event) => setCatalogPlanForm({ ...catalogPlanForm, name: event.target.value })} /></label><label>Version<input disabled={editingCatalogPlanId !== null} type="number" value={catalogPlanForm.version} onChange={(event) => setCatalogPlanForm({ ...catalogPlanForm, version: Number(event.target.value) })} /></label><label>Status<select disabled={editingCatalogPlanId !== null} value={catalogPlanForm.status} onChange={(event) => setCatalogPlanForm({ ...catalogPlanForm, status: event.target.value as CatalogPlan["status"] })}><option value="active">active</option><option value="disabled">disabled</option></select></label><label>Description<textarea value={catalogPlanForm.description} onChange={(event) => setCatalogPlanForm({ ...catalogPlanForm, description: event.target.value })} /></label><div className="actions"><button disabled={busy || !catalogPlanEditActionable} type="submit">{editingCatalogPlanId === null ? "Create plan" : "Update plan"}</button>{editingCatalogPlanId !== null && <button type="button" disabled={busy} onClick={cancelCatalogPlanEdit}>Cancel</button>}</div></form>
        <h2>Plan feature</h2>
        <form aria-label="Plan feature" onSubmit={(event) => void submitCatalogPlanFeatureCreate(event)}><label>Selected plan<select disabled={!catalogPlansSettled} value={settledSelectedCatalogPlanId} onChange={(event) => { const plan = visibleCatalogPlans.find((item) => item.id === event.target.value); if (plan !== undefined) selectCatalogPlan(plan); else { setSelectedCatalogPlanId(""); invalidatePlanProjectionPreview(); } }}><option value="">none</option>{visibleCatalogPlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.plan_key} ({plan.project})</option>)}</select></label><label>Project<input value={catalogPlanFeatureForm.project} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, project: event.target.value })} /></label><label>Feature key<input list="catalog-feature-keys" value={catalogPlanFeatureForm.feature_key} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, feature_key: event.target.value })} /></label><datalist id="catalog-feature-keys">{visibleCatalogFeatures.map((feature) => <option key={feature.id} value={feature.feature_key} />)}</datalist><label>Inclusion<select value={catalogPlanFeatureForm.feature_inclusion} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, feature_inclusion: event.target.value as CatalogPlanFeature["feature_inclusion"] })}><option value="included">included</option><option value="addon">addon</option></select></label>{catalogPlanFeatureForm.feature_inclusion === "addon" && <label>Add-on key<input value={catalogPlanFeatureForm.addon_key} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, addon_key: event.target.value })} /></label>}<label>Policy ID<input disabled={!activePoliciesSettled} list="active-policy-ids" value={catalogPlanFeatureForm.policy_id} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, policy_id: event.target.value })} /></label><datalist id="active-policy-ids">{visibleActivePolicies.map((policy) => <option key={policy.id} value={policy.id}>{policy.name}</option>)}</datalist><label>Display order<input type="number" value={catalogPlanFeatureForm.display_order} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, display_order: Number(event.target.value) })} /></label><label>Status<select value={catalogPlanFeatureForm.status} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, status: event.target.value as CatalogPlanFeature["status"] })}><option value="active">active</option><option value="disabled">disabled</option></select></label><label>Pool size<input type="number" value={catalogPlanFeatureForm.pool_size} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, pool_size: event.target.value })} /></label><label>Max devices<input type="number" value={catalogPlanFeatureForm.max_active_devices} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, max_active_devices: event.target.value })} /></label><label>Max borrow<input type="number" value={catalogPlanFeatureForm.max_borrow_sec} onChange={(event) => setCatalogPlanFeatureForm({ ...catalogPlanFeatureForm, max_borrow_sec: event.target.value })} /></label><button disabled={busy || !catalogPlansSettled || !activePoliciesSettled || settledSelectedCatalogPlanId === ""} type="submit">Save plan feature</button></form>
        <h2>Plan projection</h2>
        <form aria-label="Plan projection" onSubmit={(event) => void submitPlanPreview(event)}><label>Project<input value={planForm.project} onChange={(event) => updatePlanProjectionForm((current) => ({ ...current, project: event.target.value }))} /></label><label>License ID<input value={planForm.license_id} onChange={(event) => updatePlanProjectionForm((current) => ({ ...current, license_id: event.target.value }))} /></label><label>Fingerprint<input value={planForm.license_fingerprint} onChange={(event) => updatePlanProjectionForm((current) => ({ ...current, license_fingerprint: event.target.value }))} /></label><label>Customer ID<input value={planForm.customer_id} onChange={(event) => updatePlanProjectionForm((current) => ({ ...current, customer_id: event.target.value }))} /></label><label>Plan key<input placeholder="pro" value={planForm.plan_key} onChange={(event) => updatePlanProjectionForm((current) => ({ ...current, plan_key: event.target.value }))} /></label><label>Plan ID<input value={planForm.plan_id} onChange={(event) => updatePlanProjectionForm((current) => ({ ...current, plan_id: event.target.value }))} /></label><label>Support until<input type="date" value={planForm.support_until} onChange={(event) => updatePlanProjectionForm((current) => ({ ...current, support_until: event.target.value }))} /></label><label>Add-ons (csv)<input placeholder="team_seats,priority_support" value={planForm.addons} onChange={(event) => updatePlanProjectionForm((current) => ({ ...current, addons: event.target.value }))} /></label><label>Notes<textarea value={planForm.notes} onChange={(event) => updatePlanProjectionForm((current) => ({ ...current, notes: event.target.value }))} /></label><div className="actions"><button disabled={busy} type="submit">Preview</button><button disabled={busy || planPreviewBinding === null || planPreviewBinding.preview.blocked.length > 0} type="button" onClick={() => void applyPlanProjectionFromPreview()}>Apply</button></div></form>
        <section data-focus-section="catalog-import">
          <h2>Catalog import</h2>
          <form aria-label="Catalog import" onSubmit={(event) => { event.preventDefault(); void previewCatalogImport(); }}><label>Manifest JSON<textarea value={catalogImportText} onChange={(event) => { setCatalogImportText(event.target.value); invalidateCatalogImportPreview(); }} /></label><div className="actions"><button type="submit" disabled={busy || catalogImportText.trim() === ""}>Preview import</button><button type="button" disabled={busy || catalogImportPreviewBinding === null} onClick={requestCatalogImportApply}>Apply import</button></div>{catalogImportPreview !== null && <div className="details"><span>{catalogImportEffectSummary("Features", catalogImportPreview.effects.summary.features)}</span><span>{catalogImportEffectSummary("Plans", catalogImportPreview.effects.summary.plans)}</span><span>{catalogImportEffectSummary("Plan rows", catalogImportPreview.effects.summary.plan_features)}</span>{catalogImportPreviewBinding === null ? <span>Applied; preview again before another Apply</span> : <><span>Server preview {catalogImportPreviewBinding.preview.preview_id}</span><span>Server digest {catalogImportPreviewBinding.preview.manifest_digest}</span><span>Local manifest digest {catalogImportPreviewBinding.digest}</span><span>Effective {formatEpoch(catalogImportPreviewBinding.preview.effective_at)}</span></>}</div>}</form>
          {catalogImportPreview !== null && <><p className="muted">Each target and transition is server-derived from the persisted preview snapshot.</p>{catalogImportRows("Imported features", catalogImportPreview.effects.features)}{catalogImportRows("Imported plans", catalogImportPreview.effects.plans)}{catalogImportRows("Imported plan rows", catalogImportPreview.effects.plan_features)}</>}
        </section>
      </fieldset></aside>
      <section className="tablePane">
        <section className="deliveriesPane"><h3>Catalog plans</h3><div className="filters"><input placeholder="project" value={catalogPlanFilter.project} onChange={(event) => setCatalogPlanFilter({ ...catalogPlanFilter, project: event.target.value })} /><select value={catalogPlanFilter.status} onChange={(event) => setCatalogPlanFilter({ ...catalogPlanFilter, status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option></select></div><table><thead><tr><th>Plan</th><th>Project</th><th>Version</th><th>Status</th><th>Actions</th></tr></thead><tbody>{catalogPlans.map((plan) => <tr key={plan.id} className={plan.id === selectedCatalogPlanId ? "selectedRow" : ""} data-focus-row={`catalog-plan:${plan.id}`}><td>{plan.name}<div className="muted">{plan.plan_key}</div></td><td>{plan.project}</td><td>{plan.version}</td><td><span className={`status ${plan.status}`}>{plan.status}</span></td><td className="actions"><button type="button" disabled={busy || operationLocked} onClick={() => selectCatalogPlan(plan)}>Use</button><button type="button" disabled={busy || operationLocked} onClick={() => beginCatalogPlanEdit(plan)}>Edit</button><button type="button" disabled={busy || operationLocked} onClick={() => void exportCatalogPlan(plan)}>Export</button><button className="danger" type="button" disabled={busy || operationLocked || !canRunCatalogAction(plan.status, "disable")} onClick={() => requestConfirm({ title: "Disable plan", body: disableCatalogPlanConfirm(plan), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => catalogPlanTransition(plan, "disable", idempotencyKey), successFocusTarget: focusTargetInRow(`catalog-plan:${plan.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isCatalogPlanGenerationCurrent(catalogPlanGeneration) })}>Disable</button><button data-focus-action="reenable" type="button" disabled={busy || operationLocked || !canRunCatalogAction(plan.status, "reenable")} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }: ConfirmActionContext) => catalogPlanTransition(plan, "reenable", idempotencyKey), successFocusTarget: focusTargetInRow(`catalog-plan:${plan.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isCatalogPlanGenerationCurrent(catalogPlanGeneration) })}>Reenable</button></td></tr>)}</tbody></table><div className="tableFooter"><span className="muted">{catalogPlans.length} shown</span>{catalogPlansCursor !== null && <button type="button" disabled={busy || operationLocked} onClick={() => void loadMore(catalogPlansUrl, catalogPlansCursor, catalogPlans, setCatalogPlans, setCatalogPlansCursor, setMessage, hasCatalogPlanListData, "catalog_plans_listed", catalogPlansFence, (plan) => plan.id)}>Load more</button>}</div></section>
        <section className="deliveriesPane"><h3>Catalog features</h3><div className="filters"><input placeholder="project" value={catalogFeatureFilter.project} onChange={(event) => setCatalogFeatureFilter({ ...catalogFeatureFilter, project: event.target.value })} /><select value={catalogFeatureFilter.status} onChange={(event) => setCatalogFeatureFilter({ ...catalogFeatureFilter, status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option></select></div><table><thead><tr><th>Feature</th><th>Project</th><th>Category</th><th>Status</th><th>Actions</th></tr></thead><tbody>{catalogFeatures.map((feature) => <tr key={feature.id} data-focus-row={`catalog-feature:${feature.id}`}><td>{feature.name}<div className="muted">{feature.feature_key}</div></td><td>{feature.project}</td><td>{feature.category || "-"}</td><td><span className={`status ${feature.status}`}>{feature.status}</span></td><td className="actions"><button type="button" disabled={busy || operationLocked} onClick={() => beginCatalogFeatureEdit(feature)}>Edit</button><button className="danger" type="button" disabled={busy || operationLocked || !canRunCatalogAction(feature.status, "disable")} onClick={() => requestConfirm({ title: "Disable feature", body: disableCatalogFeatureConfirm(feature), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => catalogFeatureTransition(feature, "disable", idempotencyKey), successFocusTarget: focusTargetInRow(`catalog-feature:${feature.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isCatalogFeatureGenerationCurrent(catalogFeatureGeneration) })}>Disable</button><button data-focus-action="reenable" type="button" disabled={busy || operationLocked || !canRunCatalogAction(feature.status, "reenable")} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }: ConfirmActionContext) => catalogFeatureTransition(feature, "reenable", idempotencyKey), successFocusTarget: focusTargetInRow(`catalog-feature:${feature.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isCatalogFeatureGenerationCurrent(catalogFeatureGeneration) })}>Reenable</button></td></tr>)}</tbody></table><div className="tableFooter"><span className="muted">{catalogFeatures.length} shown</span>{catalogFeaturesCursor !== null && <button type="button" disabled={busy || operationLocked} onClick={() => void loadMore(catalogFeaturesUrl, catalogFeaturesCursor, catalogFeatures, setCatalogFeatures, setCatalogFeaturesCursor, setMessage, hasCatalogFeatureListData, "catalog_features_listed", catalogFeaturesFence, (feature) => feature.id)}>Load more</button>}</div></section>
        <section className="deliveriesPane"><h3>{selectedCatalogPlan === null ? "Plan features" : `Plan features / ${selectedCatalogPlan.plan_key}`}</h3><table><thead><tr><th>Feature</th><th>Inclusion</th><th>Add-on</th><th>Policy</th><th>Overrides</th><th>Status</th><th>Actions</th></tr></thead><tbody>{catalogPlanFeatures.map((row) => <tr key={`${row.plan_id}:${row.feature_key}`} data-focus-row={`catalog-plan-feature:${row.plan_id}:${row.feature_key}`}><td>{row.feature_name}<div className="muted">{row.feature_key}</div></td><td>{row.feature_inclusion}</td><td>{row.addon_key ?? "-"}</td><td>{row.policy_id ?? "-"}</td><td>{catalogOverrideSummary(row)}</td><td><span className={`status ${row.status}`}>{row.status}</span></td><td className="actions"><button className="danger" type="button" disabled={busy || !canRunCatalogAction(row.status, "disable")} onClick={() => requestConfirm({ title: "Disable plan row", body: disableCatalogPlanFeatureConfirm(row), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => catalogPlanFeatureTransition(row, "disable", idempotencyKey), successFocusTarget: focusTargetInRow(`catalog-plan-feature:${row.plan_id}:${row.feature_key}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isCatalogPlanFeatureGenerationCurrent(catalogPlanFeatureGeneration) })}>Disable</button><button data-focus-action="reenable" type="button" disabled={busy || !canRunCatalogAction(row.status, "reenable")} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }: ConfirmActionContext) => catalogPlanFeatureTransition(row, "reenable", idempotencyKey), successFocusTarget: focusTargetInRow(`catalog-plan-feature:${row.plan_id}:${row.feature_key}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isCatalogPlanFeatureGenerationCurrent(catalogPlanFeatureGeneration) })}>Reenable</button></td></tr>)}</tbody></table>{catalogPlanFeatures.length === 0 && <p className="muted">No rows for the selected plan.</p>}</section>
        {planPreview === null ? <section className="deliveriesPane"><h3>Projection</h3><p className="muted">No preview loaded.</p></section> : <><section className="grid metrics"><div><span>Create</span><strong>{planPreview.summary.create}</strong></div><div><span>Update</span><strong>{planPreview.summary.update}</strong></div><div><span>Disable</span><strong>{planPreview.summary.disable}</strong></div><div><span>Blocked</span><strong>{planPreview.summary.blocked}</strong></div></section><section className="deliveriesPane"><h3>{planPreview.assignment.plan_key} / {planPreview.assignment.license_id}</h3><div className="details"><span>Project {planPreview.assignment.project}</span><span>Fingerprint {shortHash(planPreview.assignment.license_fingerprint)}</span><span>Customer {planPreview.assignment.customer_id ?? "-"}</span><span>Add-ons {planPreview.assignment.addons.length === 0 ? "-" : planPreview.assignment.addons.join(", ")}</span>{planPreviewBinding === null ? <span>Execution result; re-preview required before another Apply</span> : <><span>Server preview {planPreviewBinding.preview.preview_id}</span><span>Effective {formatEpoch(planPreviewBinding.preview.effective_at)}</span><span>Local form digest {planPreviewBinding.digest}</span></>}</div></section>{projectionRows("Create", planPreview.will_create)}{projectionRows("Update", planPreview.will_update)}{projectionRows("Disable", planPreview.will_disable)}{projectionRows("Blocked", planPreview.blocked)}{projectionRows("Unchanged", planPreview.unchanged)}</>}
      </section>
    </section>
  );
}
