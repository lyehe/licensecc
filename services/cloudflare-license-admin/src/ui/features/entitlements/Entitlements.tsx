import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EntitlementDeviceRecord, EntitlementRecord, Policy } from "../../../shared/api";
import { ENTITLEMENT_BATCH_MAX_IDS } from "../../../shared/api";
import type { DraftPolicy, NavigationIntent } from "../../app/types";
import { api, apiFailureDetails, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { confirmMutationUnknown, confirmSuccessWithRefreshFailure, ConfirmRefreshFailure, EXACT_READ_PROOF, type ConfirmActionOutcome, type ConfirmActionResolution, type ExactReadProof, useContextGeneration, useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";
import { hasBatchResultsData, hasDeviceTransitionData, hasEntitlementListData, hasEntitlementRecordData, hasEntitlementTransitionData, hasPolicyListData, hasReleaseSeatsData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { downloadCsv, loadAllExactPages, loadMore } from "../../shared/pagination";
import { useDebouncedValue } from "../../shared/useDebouncedValue";
import { useRequestFence } from "../../shared/requestFence";
import { useAdminNavigation, useNavigationGuard } from "../../app/navigation";
import { ReadNotice } from "../../shared/ReadNotice";
import { focusWorkspaceTarget } from "../../shared/workspaceFocus";
import { EntitlementEditor } from "./EntitlementEditor";
import { EntitlementList } from "./EntitlementList";
import { EntitlementInspectors } from "./EntitlementInspectors";
import { protectedCreateFailureMessage } from "./protectedCreate";
import { useEntitlementInspection } from "./useEntitlementInspection";
import {
  batchBody,
  batchPath,
  boundedBatchSelection,
  DeviceAction,
  deviceTransitionPath,
  editFormFromEntitlement,
  emptyEntitlementEditForm,
  emptyEntitlementForm,
  entitlementDetailPath,
  entitlementsPath,
  entitlementBatchSelectionNotice,
  EntitlementAction,
  EntitlementFilter,
  EntitlementFormState,
  normalizeCreateFromPolicy,
  normalizeEntitlementForm,
  normalizeEntitlementPatch,
  patchPath,
  releaseSeatsPath,
  summarizeBatchResults,
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
  const [entitlementsCursor, setEntitlementsCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<EntitlementFilter>(scopedGrant ?? { project: "", feature: "", status: "" });
  const [form, setForm] = useState<EntitlementFormState>(emptyEntitlementForm);
  const [createOpen, setCreateOpen] = useState(false);
  const [extendValidity, setExtendValidity] = useState(false);
  const [editBaseline, setEditBaseline] = useState("");
  const [listRead, setListRead] = useState<{ context: string; error: string | null }>({ context: "", error: null });
  const [policyRead, setPolicyRead] = useState<{ context: string; error: string | null }>({ context: "", error: null });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(emptyEntitlementEditForm);
  const [activePolicies, setActivePolicies] = useState<Policy[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const previousEditorOpen = useRef(false);
  const { navigate, rememberFilters } = useAdminNavigation();
  const { busy: requestBusy, operationLocked, currentReason, runKeyedMutation, runMutation, setFeedback, setMessage, setReason } = useOperatorControls();
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
  const releaseDetailFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${filterContextKey}\u0000release-detail`);
  const activePoliciesContext = `${active ? "active" : "inactive"}\u0000active-policies`;
  const activePoliciesFence = useRequestFence(activePoliciesContext);
  const inspection = useEntitlementInspection(active, filterContextKey, setMessage);
  const { deviceEntitlementId, deviceContextKey, deviceGeneration, isDeviceGenerationCurrent, currentDeviceGeneration, currentDeviceContext, currentDevicesRefreshRef } = inspection;
  // "Create policy…" parks the create draft: the guard stands down for that one departure, and the
  // draft stays in this mounted workspace until the operator comes back, with the new policy.
  const [policyDetour, setPolicyDetour] = useState<"leaving" | "away" | null>(null);
  const { requestLeave } = useNavigationGuard({
    when: active && !operationLocked && policyDetour === null && ((createOpen && formContextKey !== JSON.stringify(emptyEntitlementForm)) || (editingId !== null && JSON.stringify(editForm) !== editBaseline)),
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
    if (active && previousEditorOpen.current && !editorOpen) focusWorkspaceTarget();
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
      setListRead({ context: filterContextKey, error: apiFailureMessage(response) });
      if (strict) {
        const failure = apiFailureDetails(response);
        throw new ConfirmRefreshFailure(failure.code, failure.requestId);
      }
      setMessage(apiFailureMessage(response));
    }
    return null;
  }, [entitlementsFence, entitlementsUrl, filterContextKey, setMessage]);

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
    else if (result.kind === "failure") { setPolicyRead({ context: activePoliciesContext, error: result.message }); setMessage(result.message); }
  }, [activePoliciesContext, activePoliciesFence, setMessage]);
  useEffect(() => { if (active) void refreshPolicies(); }, [active, refreshPolicies]);

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
      setMessage("policy_not_available");
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
      setMessage(error instanceof Error ? error.message : "invalid_form");
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
        return row.project === body.project && row.feature === body.feature && row.license_fingerprint === body.license_fingerprint && row.status === expectedStatus && row.enforcement_mode === body.enforcement_mode
          && (expectedLimit === undefined || row.max_active_devices === expectedLimit);
      }, mutationFailurePolicies.entitlementCreate, phase),
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setMessage(`${parsed.code} (${parsed.requestId})`);
        if (isFormGenerationCurrent(capturedFormGeneration)) setForm(emptyEntitlementForm);
      },
      refresh: async () => await refreshCore(true),
      onUnapplied: (parsed) => {
        if (!isCurrent()) return;
        const refusal = protectedCreateFailureMessage(parsed);
        if (refusal === null) setMessage(`${parsed.code} (${parsed.requestId})`);
        else setFeedback({ tone: "error", message: refusal });
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
      setMessage(error instanceof Error ? error.message : "invalid_patch");
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
        setMessage(`${parsed.code} (${parsed.requestId})`);
        cancelEdit();
      },
      refresh: async () => await refreshCore(true),
      onUnapplied: (parsed) => {
        if (isCurrent()) {
        setMessage(`${parsed.code} (${parsed.requestId})`);
        }
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
    if (mutation === undefined) return { ok: false, message: "mutation_busy", retryable: true };
    if (mutation === null) return confirmMutationUnknown(reconciliation);
    const parsed = parseMutationResponse(mutation, expectedCode, dataGuard, mutationFailurePolicies.entitlementTransition[action], "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") {
      setMessage(`${parsed.code} (${parsed.requestId})`);
      return { ok: false, message: `${parsed.code} (${parsed.requestId})`, retryable: true };
    }
    setMessage(`${parsed.code} (${parsed.requestId})`);
    setReason("");
    try {
      return (await refreshCore(true)) === EXACT_READ_PROOF
        ? { ok: true }
        : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    } catch {
      return confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    }
  }

  async function refreshReleasedEntitlement(item: EntitlementRecord, strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    const ticket = releaseDetailFence.begin();
    const response = await api<EntitlementRecord>(entitlementDetailPath(item.id));
    if (!isCurrent() || !releaseDetailFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<EntitlementRecord>(response, "entitlement", hasEntitlementRecordData);
    const target = parsed?.data;
    if (target !== undefined && target.id === item.id && target.project === item.project && target.feature === item.feature && target.license_fingerprint === item.license_fingerprint) {
      if (releaseDetailFence.settle(ticket)) {
        setEntitlements((previous) => previous.map((row) => row.id === target.id ? target : row));
        return EXACT_READ_PROOF;
      }
    }
    if (strict) {
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(parsed === null ? failure.code : "invalid_target_identity", parsed === null ? failure.requestId : parsed.requestId);
    }
    setMessage(parsed === null ? apiFailureMessage(response) : "invalid_api_response (target_identity)");
    return null;
  }

  async function releaseSeats(item: EntitlementRecord, idempotencyKey: string = crypto.randomUUID()): Promise<ConfirmActionOutcome> {
    const contextGeneration = filterGeneration;
    let reconciliationGeneration = contextGeneration;
    const isCurrent = (): boolean => isFilterGenerationCurrent(reconciliationGeneration);
    const captureRecoveryContext = (): void => {
      if (currentFilterContext() === filterContextKey) {
        reconciliationGeneration = currentFilterGeneration();
      }
    };
    const expectedCode = "seats_released";
    const body = JSON.stringify({ reason: currentReason() });
    let expectedEvidence: { released: number; seat_ids: string[] } | null = null;
    const hasSameEvidence = (candidate: { released: number; seat_ids: string[] }): boolean =>
      expectedEvidence !== null &&
      candidate.released === expectedEvidence.released &&
      candidate.seat_ids.length === expectedEvidence.seat_ids.length &&
      candidate.seat_ids.every((seatId, index) => seatId === expectedEvidence?.seat_ids[index]);
    const postRelease = async (): Promise<unknown | null> => {
      try {
        return await api<unknown>(releaseSeatsPath(item.id), {
          method: "POST",
          headers: { "idempotency-key": idempotencyKey },
          body,
        });
      } catch {
        return null;
      }
    };
    const refreshStatus = async (): Promise<ExactReadProof | null> => {
      captureRecoveryContext();
      return await refreshReleasedEntitlement(item, true);
    };
    const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent).manualRefresh;
    const replay = async (): Promise<ConfirmActionResolution> => {
      captureRecoveryContext();
      const retry = await runMutation(postRelease, "recovery");
      if (retry === undefined || retry === null) return "indeterminate";
      const parsed = parseMutationResponse(retry, expectedCode, hasReleaseSeatsData, mutationFailurePolicies.releaseSeats, "replay");
      if (parsed.kind !== "success") return parsed.kind === "failure" ? "unapplied" : "indeterminate";
      if (expectedEvidence !== null && !hasSameEvidence(parsed.data)) return "indeterminate";
      try {
        return (await refreshStatus()) === EXACT_READ_PROOF ? "applied" : "refresh_failed";
      } catch {
        return "refresh_failed";
      }
    };
    const reconciliation = { label: "Reconcile status", run: replay, isCurrent, settlesRetainedAttempt: true, postSuccessRefresh };
    const mutation = await runMutation(postRelease, "consequence");
    if (mutation === undefined) return { ok: false, message: "mutation_busy", retryable: true };
    if (mutation === null) return confirmMutationUnknown(reconciliation);
    const parsed = parseMutationResponse(mutation, expectedCode, hasReleaseSeatsData, mutationFailurePolicies.releaseSeats, "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") {
      const message = `${parsed.code} (${parsed.requestId})`;
      setMessage(message);
      return { ok: false, message, retryable: true };
    }
    expectedEvidence = parsed.data;
    const count = parsed.data.released;
    setMessage(`released ${count} seat${count === 1 ? "" : "s"} (${parsed.requestId})`);
    setReason("");
    // The release response deliberately has no entitlement identity. Replaying
    // the immutable request with the same key binds that outcome to this
    // selected entitlement, then a strict exact target GET proves the row.
    const replayed = await runMutation(postRelease, "consequence");
    const replayedParsed = replayed === undefined || replayed === null
      ? null
      : parseMutationResponse(replayed, expectedCode, hasReleaseSeatsData, mutationFailurePolicies.releaseSeats, "replay");
    if (replayedParsed === null || replayedParsed.kind !== "success" || !hasSameEvidence(replayedParsed.data)) {
      return confirmMutationUnknown(reconciliation);
    }
    try {
      return (await refreshReleasedEntitlement(item, true)) === EXACT_READ_PROOF
        ? { ok: true }
        : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    } catch {
      return confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    }
  }

  async function deviceTransition(device: EntitlementDeviceRecord, action: DeviceAction, idempotencyKey: string = crypto.randomUUID()): Promise<ConfirmActionOutcome> {
    if (deviceEntitlementId === null) return { ok: false, message: "device_entitlement_not_selected" };
    const entitlementId = deviceEntitlementId;
    const contextGeneration = deviceGeneration;
    let reconciliationGeneration = contextGeneration;
    const isCurrent = (): boolean => isDeviceGenerationCurrent(reconciliationGeneration);
    const captureRecoveryContext = (): void => {
      if (currentDeviceContext() === deviceContextKey) {
        reconciliationGeneration = currentDeviceGeneration();
      }
    };
    const parentEntitlement = entitlements.find((item) => item.id === entitlementId);
    const expectedCode = `device_${action}d`;
    const body = JSON.stringify(action === "reenable" ? {} : { reason: currentReason() });
    const dataGuard = (value: unknown): value is EntitlementRecord => parentEntitlement !== undefined && hasDeviceTransitionData(value, parentEntitlement);
    const refreshStatus = async (): Promise<ExactReadProof | null> => {
      captureRecoveryContext();
      return await currentDevicesRefreshRef.current();
    };
    const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent).manualRefresh;
    const replay = async (): Promise<ConfirmActionResolution> => {
      captureRecoveryContext();
      const retry = await runMutation(async () => {
        try {
          return await api<unknown>(deviceTransitionPath(entitlementId, device.device_key_id, action), {
            method: "POST",
            headers: { "idempotency-key": idempotencyKey },
            body,
          });
        } catch {
          return null;
        }
      }, "recovery");
      if (retry === undefined || retry === null) return "indeterminate";
      const parsed = parseMutationResponse(retry, expectedCode, dataGuard, mutationFailurePolicies.deviceTransition[action], "replay");
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
        return await api<unknown>(deviceTransitionPath(entitlementId, device.device_key_id, action), {
          method: "POST",
          headers: { "idempotency-key": idempotencyKey },
          body,
        });
      } catch {
        return null;
      }
    }, "consequence");
    if (mutation === undefined) return { ok: false, message: "mutation_busy", retryable: true };
    if (mutation === null) return confirmMutationUnknown(reconciliation);
    const parsed = parseMutationResponse(mutation, expectedCode, dataGuard, mutationFailurePolicies.deviceTransition[action], "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") {
      setMessage(`${parsed.code} (${parsed.requestId})`);
      return { ok: false, message: `${parsed.code} (${parsed.requestId})`, retryable: true };
    }
    setMessage(`${parsed.code} (${parsed.requestId})`);
    if (action !== "reenable") setReason("");
    try {
      return (await currentDevicesRefreshRef.current()) === EXACT_READ_PROOF
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
      else if (next.size >= ENTITLEMENT_BATCH_MAX_IDS) {
        setMessage(entitlementBatchSelectionNotice);
        return previous;
      } else next.add(id);
      return next;
    });
  }

  // The previous rows stay on screen through a reload (aria-busy marks the region instead); the
  // request fence above still drops any response that no longer matches the current request.
  const visibleEntitlements = entitlements;
  const visibleEntitlementsCursor = ready ? entitlementsCursor : null;
  const selectedVisibleIds = visibleEntitlements.filter((item) => selectedIds.has(item.id)).map((item) => item.id);
  const selectedCount = selectedVisibleIds.length;
  const selectableLoadedIds = boundedBatchSelection(visibleEntitlements.map((item) => item.id));
  const allSelected = selectableLoadedIds.length > 0 && selectableLoadedIds.every((id) => selectedIds.has(id));
  function toggleSelectAll(): void {
    if (allSelected) {
      setSelectedIds(new Set());
      return;
    }
    if (visibleEntitlements.length > ENTITLEMENT_BATCH_MAX_IDS) setMessage(entitlementBatchSelectionNotice);
    setSelectedIds(new Set(selectableLoadedIds));
  }

  function bulkConfirmBody(action: EntitlementAction): string {
    const count = selectedVisibleIds.length;
    const noun = `${count} selected entitlement${count === 1 ? "" : "s"}`;
    if (action === "revoke") return `Revoke ${noun}. Revocation is TERMINAL and cannot be undone; already-revoked rows are reported as revoked-terminal and skipped.`;
    return `Disable ${noun}. Disabled entitlements stop verifying until re-enabled.`;
  }

  async function runBatch(action: EntitlementAction, idempotencyKey: string = crypto.randomUUID()): Promise<ConfirmActionOutcome> {
    const ids = selectedVisibleIds;
    if (ids.length === 0) return { ok: false, message: "no_entitlements_selected" };
    if (ids.length > ENTITLEMENT_BATCH_MAX_IDS) {
      setMessage(entitlementBatchSelectionNotice);
      return { ok: false, message: entitlementBatchSelectionNotice, retryable: true };
    }
    const contextGeneration = filterGeneration;
    let reconciliationGeneration = contextGeneration;
    const isCurrent = (): boolean => isFilterGenerationCurrent(reconciliationGeneration);
    const captureRecoveryContext = (): void => {
      if (currentFilterContext() === filterContextKey) {
        reconciliationGeneration = currentFilterGeneration();
      }
    };
    const expectedCode = `entitlement_${action}d`;
    const body = JSON.stringify(batchBody(action, ids, currentReason()));
    const dataGuard = (value: unknown): value is { results: Array<{ id: string; ok: boolean; code: string }> } => hasBatchResultsData(value, ids, expectedCode);
    const refreshStatus = async (): Promise<ExactReadProof | null> => {
      captureRecoveryContext();
      return await refreshCore(true);
    };
    const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent).manualRefresh;
    const replay = async (): Promise<ConfirmActionResolution> => {
      captureRecoveryContext();
      const retry = await runMutation(async () => {
        try {
          return await api<unknown>(batchPath(), {
            method: "POST",
            headers: { "idempotency-key": idempotencyKey },
            body,
          });
        } catch {
          return null;
        }
      }, "recovery");
      if (retry === undefined || retry === null) return "indeterminate";
      const parsed = parseMutationResponse(retry, "batch_done", dataGuard, mutationFailurePolicies.entitlementBatch[action], "replay");
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
        return await api<{ results: Array<{ id: string; ok: boolean; code: string }> }>(batchPath(), {
          method: "POST",
          headers: { "idempotency-key": idempotencyKey },
          body,
        });
      } catch {
        return null;
      }
    }, "consequence");
    if (mutation === undefined) return { ok: false, message: "mutation_busy", retryable: true };
    if (mutation === null) return confirmMutationUnknown(reconciliation);
    const parsed = parseMutationResponse(mutation, "batch_done", dataGuard, mutationFailurePolicies.entitlementBatch[action], "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") {
      const message = `${parsed.code} (${parsed.requestId})`;
      setMessage(message);
      return { ok: false, message, retryable: true };
    }
    setMessage(`${action}: ${summarizeBatchResults(parsed.data.results)} (${parsed.requestId})`);
    setReason("");
    setSelectedIds(new Set());
    try {
      return (await refreshCore(true)) === EXACT_READ_PROOF
        ? { ok: true }
        : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    } catch {
      return confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    }
  }

  if (!active) return null;
  const listError = listRead.context === filterContextKey ? listRead.error : null;
  const policyError = policyRead.context === activePoliciesContext ? policyRead.error : null;
  const editingItem = visibleEntitlements.find((item) => item.id === editingId);
  const closeEditor = (): void => { requestLeave(() => { setCreateOpen(false); setForm(emptyEntitlementForm); cancelEdit(); }); };
  return <section className="listPage">
    {onExit && <button disabled={busy} onClick={() => requestLeave(onExit)}>Back to app</button>}
    {createOpen || editingId !== null ? <>
      {editingId !== null && <ReadNotice loading={!ready && listError === null} error={listError} hasData={visibleEntitlements.length > 0} label="entitlements" onRetry={() => void refresh()} />}
      {createOpen || editingItem ? <EntitlementEditor key={createOpen ? "create" : editingId} form={createOpen ? form : editForm} item={createOpen ? undefined : editingItem} extendValidity={extendValidity} busy={busy} locked={operationLocked || (!createOpen && (!ready || editingItem?.status === "revoked"))} lockMessage={operationLocked ? undefined : editingItem?.status === "revoked" ? "Revocation is permanent. This entitlement can no longer be edited." : "Refresh entitlements successfully before changing or saving this draft."} policies={activePoliciesFence.isSettled() ? activePolicies : []} policiesReady={activePoliciesFence.canLoadMore()} policiesError={policyError} onRetryPolicies={() => void refreshPolicies()} onCreatePolicy={createOpen && onCreatePolicy !== undefined ? () => setPolicyDetour("leaving") : undefined} onChange={(patch) => createOpen ? setForm((previous) => ({ ...previous, ...patch })) : setEditForm((previous) => ({ ...previous, ...patch }))} onSubmit={createOpen ? submitCreate : (event) => submitPatch(event, editingItem!)} onCancel={closeEditor} /> : <div className="emptyState"><p>{ready ? "This entitlement is no longer in the current list. Return to the list to select a current record." : "Waiting for the current entitlement record."}</p><button type="button" disabled={busy} onClick={closeEditor}>Back to entitlements</button></div>}
    </> : <>
      <EntitlementList scoped={scopedGrant !== undefined} items={visibleEntitlements} filter={filter} onFilter={setFilter} loading={!ready && listError === null} error={listError} ready={ready} busy={busy} selectedIds={selectedIds} selectedCount={selectedCount} allSelected={allSelected} onSelect={toggleSelected} onSelectAll={toggleSelectAll} onClearSelection={() => setSelectedIds(new Set())} onCreate={() => { requestLeave(() => { cancelEdit(); setForm({ ...emptyEntitlementForm, project:filter.project || emptyEntitlementForm.project, feature:filter.feature || emptyEntitlementForm.feature, customer_id:filter.customer_id || "" }); setCreateOpen(true); }); }} onEdit={beginEdit} onRetry={() => void refresh()} onExport={() => void downloadCsv(entitlementsUrl, "entitlements.csv", runMutation, setMessage)} onLoadMore={visibleEntitlementsCursor === null ? null : () => void loadMore(entitlementsUrl, visibleEntitlementsCursor, visibleEntitlements, setEntitlements, setEntitlementsCursor, setMessage, hasEntitlementListData, "entitlements_listed", entitlementsFence, (entitlement) => entitlement.id)} onTransition={transition} onReleaseSeats={releaseSeats} onBatch={runBatch} bulkConfirmBody={bulkConfirmBody} isCurrent={() => isFilterGenerationCurrent(filterGeneration)} deviceEntitlementId={deviceEntitlementId} meterEntitlementId={inspection.meterEntitlementId} onDevices={inspection.toggleDevices} onMeter={inspection.toggleMeter} onHistory={(item) => navigate({ tab: "events", filter: { entitlement_id: item.id } })} />
      <EntitlementInspectors inspection={inspection} busy={busy} onDeviceTransition={deviceTransition} />
    </>}
  </section>;
}
