import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EntitlementRecord, Policy } from "../../../shared/api";
import type { DraftPolicy, NavigationIntent } from "../../app/types";
import { api, apiFailureDetails, parseExactApiSuccess } from "../../shared/api";
import { confirmMutationUnknown, confirmSuccessWithRefreshFailure, ConfirmRefreshFailure, EXACT_READ_PROOF, type ConfirmActionOutcome, type ConfirmActionResolution, type ExactReadProof, focusTargetInRow, useContextGeneration, useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";
import { apiFailureFeedback, codeFeedback, failureFeedback, feedbackWith, refusalOutcome, validationCode } from "../../shared/messages";
import type { OperatorFeedback } from "../../shared/operatorFeedback";
import { hasEntitlementListData, hasEntitlementRecordData, hasEntitlementTransitionData, hasPolicyListData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { downloadCsv, loadAllExactPages, loadMore } from "../../shared/pagination";
import { useDebouncedValue } from "../../shared/useDebouncedValue";
import { useRequestFence } from "../../shared/requestFence";
import { useAdminNavigation, useNavigationGuard } from "../../app/navigation";
import { ReadNotice } from "../../shared/ReadNotice";
import { focusWorkspaceTarget } from "../../shared/workspaceFocus";
import { EntitlementEditor } from "./EntitlementEditor";
import { EntitlementList } from "./EntitlementList";
import { protectedCreateFailureMessage } from "./protectedCreate";
import { useEntitlementBatch } from "./useEntitlementBatch";
import {
  editFormFromEntitlement,
  emptyEntitlementEditForm,
  ENTITLEMENT_NOT_RELOADED_AFTER_STALE,
  ENTITLEMENT_RELOADED_AFTER_STALE,
  emptyEntitlementForm,
  entitlementsPath,
  EntitlementAction,
  EntitlementFilter,
  EntitlementFormState,
  normalizeCreateFromPolicy,
  normalizeEntitlementForm,
  normalizeEntitlementPatch,
  patchPath,
  transitionPath,
} from "./workflow";

export function Entitlements({ active, navigationIntent, onNavigationHandled, scopedGrant, onExit, onCreatePolicy, draftPolicy = null, onDraftPolicyUsed }: {
  active: boolean;
  scopedGrant?: EntitlementFilter;
  onExit?: () => void;
  navigationIntent: NavigationIntent | null;
  onNavigationHandled: (intent: NavigationIntent) => void;
  /** Opens the policy form for a project while the create draft stays parked here; false if it could not leave. */
  onCreatePolicy?: (project: string) => boolean;
  draftPolicy?: DraftPolicy | null;
  onDraftPolicyUsed?: () => void;
}): React.ReactElement | null {
  const [entitlements, setEntitlements] = useState<EntitlementRecord[]>([]);
  // The list on screen now, for callbacks that settle after the render that created them.
  const entitlementsRef = useRef(entitlements);
  entitlementsRef.current = entitlements;
  const [entitlementsCursor, setEntitlementsCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<EntitlementFilter>(scopedGrant ?? { project: "", feature: "", status: "" });
  const [form, setForm] = useState<EntitlementFormState>(emptyEntitlementForm);
  const [createOpen, setCreateOpen] = useState(false);
  const [extendValidity, setExtendValidity] = useState(false);
  const [editBaseline, setEditBaseline] = useState("");
  const [listRead, setListRead] = useState<{ context: string; error: OperatorFeedback | null }>({ context: "", error: null });
  const [policyRead, setPolicyRead] = useState<{ context: string; error: OperatorFeedback | null }>({ context: "", error: null });
  // A created entitlement opens as its focused row once the list shows it, but only in the list view
  // it was created from: a later filter the operator chose is never replaced by it.
  const [reveal, setReveal] = useState<{ id: string; context: string; shown: EntitlementRecord[] } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(emptyEntitlementEditForm);
  const [activePolicies, setActivePolicies] = useState<Policy[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const previousEditorOpen = useRef(false);
  const { navigate, rememberFilters } = useAdminNavigation();
  const { busy: requestBusy, operationLocked, operationRetained, currentReason, runKeyedMutation, runMutation, setFeedback, setMessage, setReason } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const { refreshCore, registerCoreRefresh } = useCoreRefresh();
  const entitlementsUrl = useMemo(() => entitlementsPath(filter), [filter]);
  const filterContextKey = `${active ? "active" : "inactive"}\u0000${filter.project}\u0000${filter.feature}\u0000${filter.status}\u0000${filter.id ?? ""}\u0000${filter.customer_id ?? ""}\u0000${filter.license_id ?? ""}`;
  const { generation: filterGeneration, isCurrent: isFilterGenerationCurrent, currentGeneration: currentFilterGeneration, currentContext: currentFilterContext } = useContextGeneration(filterContextKey);
  // The filter alone (never `active`) decides when the list must reload: switching tabs without
  // touching a filter field costs zero requests, and typing coalesces onto one request 300ms after
  // the operator stops, rather than one request per keystroke. The generation is debounced rather
  // than the URL itself: a filter that returns to an earlier value (A -> B -> A) within one debounce
  // window still must reload, and debouncing the URL string would collapse that back to the same
  // value React already holds, silently dropping the reload.
  const { generation: rawFilterGeneration, isCurrent: isRawFilterGenerationCurrent } = useContextGeneration(entitlementsUrl);
  const reloadGeneration = useDebouncedValue(rawFilterGeneration, 300);
  const lastRequestedReload = useRef<number | null>(null);
  const formContextKey = JSON.stringify(form);
  const { generation: formGeneration, isCurrent: isFormGenerationCurrent } = useContextGeneration(formContextKey);
  const editContextKey = `${editingId ?? ""}\u0000${JSON.stringify(editForm)}`;
  const { generation: editGeneration, isCurrent: isEditGenerationCurrent } = useContextGeneration(editContextKey);
  // Tab re-entry sends no request (see the reload effect below), so this fence must not depend on
  // `active`: if it did, a tab switch would reset it and `canLoadMore()`/`isSettled()` would stay
  // false forever, since nothing would ever fire again to re-settle them -- Load More would stay
  // hidden and every action would stay disabled for good.
  const entitlementsFence = useRequestFence(entitlementsUrl);
  const ready = entitlementsFence.canLoadMore();
  const activePoliciesContext = `${active ? "active" : "inactive"}\u0000active-policies`;
  const activePoliciesFence = useRequestFence(activePoliciesContext);
  // "Create policy…" parks the create draft: the guard stands down for that one departure, and the
  // draft stays in this mounted workspace until the operator comes back, with the new policy.
  const [policyDetour, setPolicyDetour] = useState<"leaving" | "away" | null>(null);
  const { requestLeave } = useNavigationGuard({
    when: active && !operationRetained && policyDetour === null && ((createOpen && formContextKey !== JSON.stringify(emptyEntitlementForm)) || (editingId !== null && JSON.stringify(editForm) !== editBaseline)),
    onDiscard: () => { setCreateOpen(false); setForm(emptyEntitlementForm); cancelEdit(); },
  });
  useEffect(() => {
    if (policyDetour === "leaving") setPolicyDetour(onCreatePolicy?.(form.project) ? "away" : null);
  }, [policyDetour, onCreatePolicy, form.project]);
  useEffect(() => {
    if (!active) return;
    setPolicyDetour((current) => current === "away" ? null : current);
    if (draftPolicy === null) return;
    if (createOpen) setForm((previous) => previous.project === draftPolicy.project ? { ...previous, policy_id: draftPolicy.id } : previous);
    onDraftPolicyUsed?.();
  }, [active, draftPolicy, createOpen, onDraftPolicyUsed]);
  useEffect(() => {
    const editorOpen = createOpen || editingId !== null;
    if (active && previousEditorOpen.current && !editorOpen && reveal === null) focusWorkspaceTarget();
    previousEditorOpen.current = editorOpen;
  }, [active, createOpen, editingId]);

  const refresh = useCallback(async (strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> => {
    if (!isCurrent()) return null;
    const ticket = entitlementsFence.begin();
    setListRead({ context: filterContextKey, error: null });
    const response = await api<{ items: EntitlementRecord[]; next_cursor: string | null }>(entitlementsUrl);
    if (!isCurrent() || !entitlementsFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<{ items: EntitlementRecord[]; next_cursor: string | null }>(response, "entitlements_listed", hasEntitlementListData);
    if (parsed !== null) {
      if (entitlementsFence.settle(ticket, parsed.data.next_cursor ?? null)) {
        setEntitlements(parsed.data.items);
        setEntitlementsCursor(parsed.data.next_cursor ?? null);
        return EXACT_READ_PROOF;
      }
    } else {
      // The list's own read notice reports this failure; the page banner does not repeat it.
      setListRead({ context: filterContextKey, error: apiFailureFeedback(response) });
      if (strict) {
        const failure = apiFailureDetails(response);
        throw new ConfirmRefreshFailure(failure.code, failure.requestId);
      }
    }
    return null;
  }, [entitlementsFence, entitlementsUrl, filterContextKey]);

  useEffect(() => {
    return registerCoreRefresh(refresh);
  }, [refresh, registerCoreRefresh]);

  // A filter change reloads just this list (never the summary/events core refresh); entering or
  // leaving this tab with the filter unchanged dispatches nothing, since `reloadGeneration` only
  // advances when the debounced filter itself changes.
  useEffect(() => {
    if (!active || lastRequestedReload.current === reloadGeneration) return;
    lastRequestedReload.current = reloadGeneration;
    void refresh(false, () => isRawFilterGenerationCurrent(reloadGeneration));
  }, [active, reloadGeneration, isRawFilterGenerationCurrent, refresh]);

  const refreshPolicies = useCallback(async (): Promise<void> => {
    setPolicyRead({ context: activePoliciesContext, error: null });
    const result = await loadAllExactPages<Policy>("/api/admin/policies?status=active", "policies_listed", hasPolicyListData, activePoliciesFence, (policy) => policy.id);
    if (result.kind === "success") setActivePolicies(result.items);
    else if (result.kind === "failure") setPolicyRead({ context: activePoliciesContext, error: result.feedback });
  }, [activePoliciesContext, activePoliciesFence]);
  useEffect(() => { if (active) void refreshPolicies(); }, [active, refreshPolicies]);

  useEffect(() => {
    // It waits for a list read newer than the one on screen when the create settled.
    if (reveal === null || (reveal.context === filterContextKey && (!ready || entitlements === reveal.shown))) return;
    setReveal(null);
    if (reveal.context !== filterContextKey) return;
    if (!entitlements.some((item) => item.id === reveal.id)) {
      // Not in this list (another filter or page): show it on its own, as a search result is.
      setFilter({ project: "", feature: "", status: "", id: reveal.id });
      return;
    }
    const target = focusTargetInRow(`entitlement:${reveal.id}`, []);
    focusWorkspaceTarget(typeof target === "function" ? target() : target);
  }, [reveal, ready, entitlements, filterContextKey]);

  useEffect(() => {
    if (navigationIntent?.tab !== "entitlements") return;
    // Navigation has already passed the dirty-draft and pending-operation guards.
    setCreateOpen(false); setForm(emptyEntitlementForm); cancelEdit();
    setFilter({ id: navigationIntent.filter.id, customer_id: navigationIntent.filter.customer_id, license_id: navigationIntent.filter.license_id, project: navigationIntent.filter.project ?? "", feature: navigationIntent.filter.feature ?? "", status: navigationIntent.filter.status ?? "" });
    onNavigationHandled(navigationIntent);
  }, [navigationIntent, onNavigationHandled]);

  useEffect(() => {
    if (scopedGrant || !active || navigationIntent?.tab === "entitlements") return;
    rememberFilters("entitlements", { ...filter });
  }, [active, filter, navigationIntent, rememberFilters, scopedGrant]);

  // Selection survives a reload; a row only drops out of it once it is confirmed gone from the
  // freshly loaded list, never merely because the filter changed or the tab was left and reentered.
  useEffect(() => {
    setSelectedIds((previous) => {
      const present = new Set(entitlements.map((item) => item.id));
      const next = new Set([...previous].filter((id) => present.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [entitlements]);
  async function submitCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (form.policy_id !== "" && (!activePoliciesFence.canLoadMore() || !activePolicies.some((policy) => policy.id === form.policy_id))) {
      setFeedback(codeFeedback("policy_not_available"));
      return;
    }
    const contextGeneration = filterGeneration;
    const capturedFormGeneration = formGeneration;
    const isListCurrent = (): boolean => isFilterGenerationCurrent(contextGeneration);
    const isCurrent = (): boolean => isListCurrent() && isFormGenerationCurrent(capturedFormGeneration);
    let body: ReturnType<typeof normalizeEntitlementForm> | ReturnType<typeof normalizeCreateFromPolicy>;
    try {
      body = form.policy_id !== "" ? normalizeCreateFromPolicy(form) : normalizeEntitlementForm(form);
    } catch (error) {
      setFeedback(codeFeedback(validationCode(error)));
      return;
    }
    const expectedStatus = body.status ?? "active";
    const expectedLimit = "max_active_devices" in body ? body.max_active_devices : undefined;
    const requestBody = JSON.stringify(body);
    await runKeyedMutation({
      request: { method: "POST", path: "/api/admin/entitlements", body: requestBody },
      send: (attempt) => api<EntitlementRecord>(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (result, phase) => parseMutationResponse(result, "entitlement_saved", (value): value is EntitlementRecord => {
        if (!hasEntitlementRecordData(value)) return false;
        const row = value as EntitlementRecord;
        return row.project === body.project && row.feature === body.feature && row.license_fingerprint === body.license_fingerprint && row.status === expectedStatus
          && (expectedLimit === undefined || row.max_active_devices === expectedLimit);
      }, mutationFailurePolicies.entitlementCreate, phase),
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setFeedback(codeFeedback(parsed.code, parsed.requestId));
        // The new entitlement opens as its own row in the list (also after a reconciled replay).
        if (!isFormGenerationCurrent(capturedFormGeneration)) return;
        setCreateOpen(false);
        setForm(emptyEntitlementForm);
        // The list on screen when the save settled, not when it was submitted: a read that landed in
        // between may predate the create, so the reveal waits for the read that follows it.
        setReveal({ id: parsed.data.id, context: filterContextKey, shown: entitlementsRef.current });
      },
      refresh: async () => await refreshCore(true),
      onUnapplied: (parsed) => {
        if (!isCurrent()) return;
        const refusal = protectedCreateFailureMessage(parsed);
        setFeedback(refusal === null ? failureFeedback(parsed.code, parsed.requestId) : feedbackWith(refusal, parsed.code, parsed.requestId));
      },
      isCurrent,
    });
  }

  function beginEdit(item: EntitlementRecord, extend = false): void {
    requestLeave(() => {
      setCreateOpen(false);
      setEditingId(item.id);
      const draft = editFormFromEntitlement(item);
      setEditBaseline(JSON.stringify(draft));
      setEditForm(draft);
      setExtendValidity(extend);
    });
  }

  function cancelEdit(): void {
    setEditingId(null);
    setEditForm(emptyEntitlementEditForm);
    setEditBaseline("");
    setExtendValidity(false);
  }

  async function submitPatch(event: FormEvent, item: EntitlementRecord): Promise<void> {
    event.preventDefault();
    if (!ready || item.status === "revoked") { setMessage("Select a current, editable entitlement before saving changes."); return; }
    const contextGeneration = filterGeneration;
    const capturedEditGeneration = editGeneration;
    const isListCurrent = (): boolean => isFilterGenerationCurrent(contextGeneration);
    const isCurrent = (): boolean => isListCurrent() && isEditGenerationCurrent(capturedEditGeneration);
    let body: ReturnType<typeof normalizeEntitlementPatch>;
    try {
      body = normalizeEntitlementPatch(editForm, item);
    } catch (error) {
      setFeedback(codeFeedback(validationCode(error)));
      return;
    }
    const requestBody = JSON.stringify({ ...body, expected_customer_id: item.customer_id, expected_revocation_seq: item.revocation_seq });
    await runKeyedMutation({
      request: { method: "PATCH", path: patchPath(item), body: requestBody },
      send: (attempt) => api<EntitlementRecord>(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (result, phase) => parseMutationResponse(result, "entitlement_patched", (value): value is EntitlementRecord => {
        if (!hasEntitlementRecordData(value)) return false;
        const row = value as EntitlementRecord;
        return row.id === item.id && row.project === item.project && row.feature === item.feature && row.license_fingerprint === item.license_fingerprint && row.status === item.status && row.revocation_seq > item.revocation_seq;
      }, mutationFailurePolicies.entitlementPatch, phase),
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setFeedback(codeFeedback(parsed.code, parsed.requestId));
        cancelEdit();
      },
      refresh: async () => await refreshCore(true),
      onUnapplied: (parsed) => {
        if (!isCurrent()) return;
        if (parsed.code !== "stale_transition") { setFeedback(failureFeedback(parsed.code, parsed.requestId)); return; }
        // A stale expectation wrote nothing: reload the entitlement so the next save carries its
        // current state, keep the operator's draft, and say it was reloaded only once it was.
        const settle = (reloaded: boolean): void => { if (isListCurrent()) setFeedback(feedbackWith(reloaded ? ENTITLEMENT_RELOADED_AFTER_STALE : ENTITLEMENT_NOT_RELOADED_AFTER_STALE, parsed.code, parsed.requestId)); };
        void refreshCore().then((proof) => settle(proof === EXACT_READ_PROOF), () => settle(false));
      },
      isCurrent,
    });
  }

  async function transition(item: EntitlementRecord, action: EntitlementAction, idempotencyKey: string = crypto.randomUUID()): Promise<ConfirmActionOutcome> {
    const contextGeneration = filterGeneration;
    let reconciliationGeneration = contextGeneration;
    const isCurrent = (): boolean => isFilterGenerationCurrent(reconciliationGeneration);
    const captureRecoveryContext = (): void => {
      if (currentFilterContext() === filterContextKey) {
        reconciliationGeneration = currentFilterGeneration();
      }
    };
    const targetStatus = action === "reenable" ? "active" : action === "disable" ? "disabled" : "revoked";
    const expectedCode = `entitlement_${action}d`;
    const body = JSON.stringify({ ...(action === "disable" || action === "revoke" ? { reason: currentReason() } : {}), expected_customer_id: item.customer_id, expected_revocation_seq: item.revocation_seq });
    const dataGuard = (value: unknown): value is EntitlementRecord => hasEntitlementTransitionData(value, item.id, targetStatus);
    const refreshStatus = async (): Promise<ExactReadProof | null> => {
      captureRecoveryContext();
      return await refreshCore(true);
    };
    const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent).manualRefresh;
    const replay = async (): Promise<ConfirmActionResolution> => {
      captureRecoveryContext();
      const retry = await runMutation(async () => {
        try {
          return await api<unknown>(transitionPath(item, action), { method: "POST", headers: { "idempotency-key": idempotencyKey }, body });
        } catch {
          return null;
        }
      }, "recovery");
      if (retry === undefined || retry === null) return "indeterminate";
      const parsed = parseMutationResponse(retry, expectedCode, dataGuard, mutationFailurePolicies.entitlementTransition[action], "replay");
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
        return await api<unknown>(transitionPath(item, action), {
          method: "POST",
          headers: { "idempotency-key": idempotencyKey },
          body,
        });
      } catch {
        return null;
      }
    }, "consequence");
    if (mutation === undefined) return refusalOutcome("mutation_busy", null);
    if (mutation === null) return confirmMutationUnknown(reconciliation);
    const parsed = parseMutationResponse(mutation, expectedCode, dataGuard, mutationFailurePolicies.entitlementTransition[action], "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") return refusalOutcome(parsed.code, parsed.requestId);
    setFeedback(codeFeedback(parsed.code, parsed.requestId));
    setReason("");
    try {
      return (await refreshCore(true)) === EXACT_READ_PROOF
        ? { ok: true }
        : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    } catch {
      return confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    }
  }

  function toggleSelected(id: string): void {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // The previous rows stay on screen through a reload (aria-busy marks the region instead); the
  // request fence above still drops any response that no longer matches the current request.
  const visibleEntitlements = entitlements;
  const visibleEntitlementsCursor = ready ? entitlementsCursor : null;
  const selectedVisibleRows = visibleEntitlements.filter((item) => selectedIds.has(item.id));
  const selectedCount = selectedVisibleRows.length;
  // "Select all {n} loaded" selects every loaded row; a run larger than the Worker's per-request
  // cap is split into sequential chunks rather than capped here.
  const allSelected = visibleEntitlements.length > 0 && selectedCount === visibleEntitlements.length;
  function toggleSelectAll(): void {
    setSelectedIds(allSelected ? new Set() : new Set(visibleEntitlements.map((item) => item.id)));
  }

  function bulkConfirmBody(action: EntitlementAction): string {
    const count = selectedVisibleRows.length;
    const noun = `${count} selected entitlement${count === 1 ? "" : "s"}`;
    if (action === "revoke") return `Revoke ${noun}. Revocation is TERMINAL and cannot be undone; already-revoked rows are reported as revoked-terminal and skipped.`;
    return `Disable ${noun}. Disabled entitlements stop verifying until re-enabled.`;
  }

  const batch = useEntitlementBatch({
    selectedRows: selectedVisibleRows.map((item) => ({ id: item.id, customer_id: item.customer_id, revocation_seq: item.revocation_seq })), setSelectedIds, runMutation, refreshCore, currentReason, setFeedback, setReason,
    recoveryContext: () => {
      let generation = filterGeneration;
      return { isCurrent: () => isFilterGenerationCurrent(generation), capture: () => { if (currentFilterContext() === filterContextKey) generation = currentFilterGeneration(); } };
    },
  });

  if (!active) return null;
  const listError = listRead.context === filterContextKey ? listRead.error : null;
  const policyError = policyRead.context === activePoliciesContext ? policyRead.error : null;
  const editingItem = visibleEntitlements.find((item) => item.id === editingId);
  const closeEditor = (): void => { requestLeave(() => { setCreateOpen(false); setForm(emptyEntitlementForm); cancelEdit(); }); };
  // A scoped (Manage access) list stays on its one customer's grant: nothing in it may change its filter.
  const pinnedFilter = (): void => undefined;
  return <section className="listPage">
    {onExit && <button disabled={busy} onClick={() => requestLeave(onExit)}>Back to app</button>}
    {createOpen || editingId !== null ? <>
      {editingId !== null && <ReadNotice loading={!ready && listError === null} error={listError} hasData={visibleEntitlements.length > 0} label="entitlements" onRetry={() => void refresh()} />}
      {createOpen || editingItem ? <EntitlementEditor key={createOpen ? "create" : editingId} form={createOpen ? form : editForm} item={createOpen ? undefined : editingItem} extendValidity={extendValidity} busy={busy} locked={operationLocked || (!createOpen && (!ready || editingItem?.status === "revoked"))} lockMessage={operationLocked ? undefined : editingItem?.status === "revoked" ? "Revocation is permanent. This entitlement can no longer be edited." : "Refresh entitlements successfully before changing or saving this draft."} policies={activePoliciesFence.isSettled() ? activePolicies : []} policiesReady={activePoliciesFence.canLoadMore()} policiesError={policyError} onRetryPolicies={() => void refreshPolicies()} onCreatePolicy={createOpen && onCreatePolicy !== undefined ? () => setPolicyDetour("leaving") : undefined} onChange={(patch) => createOpen ? setForm((previous) => ({ ...previous, ...patch })) : setEditForm((previous) => ({ ...previous, ...patch }))} onSubmit={createOpen ? submitCreate : (event) => submitPatch(event, editingItem!)} onCancel={closeEditor} /> : <div className="emptyState"><p>{ready ? "This entitlement is no longer in the current list. Return to the list to select a current record." : "Waiting for the current entitlement record."}</p><button type="button" disabled={busy} onClick={closeEditor}>Back to entitlements</button></div>}
    </> : <>
      <EntitlementList scoped={scopedGrant !== undefined} items={visibleEntitlements} filter={filter} onFilter={scopedGrant === undefined ? setFilter : pinnedFilter} loading={!ready && listError === null} error={listError} ready={ready} busy={busy} selectedIds={selectedIds} selectedCount={selectedCount} allSelected={allSelected} onSelect={toggleSelected} onSelectAll={toggleSelectAll} onClearSelection={() => setSelectedIds(new Set())} onCreate={() => { requestLeave(() => { cancelEdit(); setForm({ ...emptyEntitlementForm, project:filter.project || emptyEntitlementForm.project, feature:filter.feature || emptyEntitlementForm.feature, customer_id:filter.customer_id || "" }); setCreateOpen(true); }); }} onEdit={beginEdit} onRetry={() => void refresh()} onExport={() => void downloadCsv(entitlementsUrl, "entitlements.csv", runMutation, setFeedback)} onLoadMore={visibleEntitlementsCursor === null ? null : () => void loadMore(entitlementsUrl, visibleEntitlementsCursor, visibleEntitlements, setEntitlements, setEntitlementsCursor, setFeedback, hasEntitlementListData, "entitlements_listed", entitlementsFence, (entitlement) => entitlement.id)} onTransition={transition} batch={batch} bulkConfirmBody={bulkConfirmBody} isCurrent={() => isFilterGenerationCurrent(filterGeneration)} onHistory={(item) => navigate({ tab: "events", filter: { entitlement_id: item.id } })} />
    </>}
  </section>;
}
