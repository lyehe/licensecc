import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EntitlementDeviceRecord, EntitlementRecord, Policy } from "../../../shared/api";
import { ENTITLEMENT_BATCH_MAX_IDS } from "../../../shared/api";
import type { NavigationIntent } from "../../app/types";
import { api, apiFailureDetails, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { HealthBadge } from "../../shared/charts";
import { confirmMutationUnknown, confirmSuccessWithRefreshFailure, ConfirmRefreshFailure, EXACT_READ_PROOF, focusTargetInRow, focusTargetInSection, type ConfirmActionContext, type ConfirmActionOutcome, type ConfirmActionResolution, type ExactReadProof, useContextGeneration, useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";
import { formatEpoch, shortHash } from "../../shared/format";
import { hasBatchResultsData, hasDeviceListData, hasDeviceTransitionData, hasEntitlementListData, hasEntitlementRecordData, hasEntitlementTransitionData, hasMeterStatusData, hasPolicyListData, hasReleaseSeatsData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { downloadCsv, loadAllExactPages, loadMore } from "../../shared/pagination";
import { useRequestFence } from "../../shared/requestFence";
import {
  batchBody,
  batchPath,
  boundedBatchSelection,
  canEditEntitlement,
  canRunAction,
  canRunDeviceAction,
  DeviceAction,
  disableDeviceConfirm,
  disableEntitlementConfirm,
  deviceTransitionPath,
  editFormFromEntitlement,
  emptyEntitlementEditForm,
  emptyEntitlementForm,
  entitlementDetailPath,
  entitlementsPath,
  entitlementDevicesPath,
  entitlementMeterPath,
  entitlementBatchSelectionNotice,
  EntitlementAction,
  EntitlementFilter,
  EntitlementFormState,
  normalizeCreateFromPolicy,
  normalizeEntitlementForm,
  normalizeEntitlementPatch,
  patchPath,
  releaseSeatsConfirm,
  releaseSeatsPath,
  revokeDeviceConfirm,
  revokeEntitlementConfirm,
  shortDeviceKeyId,
  summarizeBatchResults,
  transitionPath,
} from "./workflow";

interface MeterStatus {
  meter_quota: number;
  meter_period_sec: number;
  period_start: number;
  period_end: number;
  units_consumed: number;
  server_time: number;
}

export function Entitlements({ active, navigationIntent, onNavigationHandled }: {
  active: boolean;
  navigationIntent: NavigationIntent | null;
  onNavigationHandled: (intent: NavigationIntent) => void;
}): React.ReactElement | null {
  const [entitlements, setEntitlements] = useState<EntitlementRecord[]>([]);
  const [entitlementsCursor, setEntitlementsCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<EntitlementFilter>({ project: "", feature: "", status: "" });
  const [form, setForm] = useState<EntitlementFormState>(emptyEntitlementForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(emptyEntitlementEditForm);
  const [activePolicies, setActivePolicies] = useState<Policy[]>([]);
  const [deviceEntitlementId, setDeviceEntitlementId] = useState<string | null>(null);
  const [devices, setDevices] = useState<EntitlementDeviceRecord[]>([]);
  const [meterEntitlementId, setMeterEntitlementId] = useState<string | null>(null);
  const [meterStatus, setMeterStatus] = useState<MeterStatus | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const { busy: requestBusy, operationLocked, currentReason, reason, requestConfirm, runConsequenceAction, runKeyedMutation, runMutation, setMessage, setReason } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const { refreshCore, registerCoreRefresh } = useCoreRefresh();
  const entitlementsUrl = useMemo(() => entitlementsPath(filter), [filter]);
  const filterContextKey = `${active ? "active" : "inactive"}\u0000${filter.project}\u0000${filter.feature}\u0000${filter.status}`;
  const { generation: filterGeneration, isCurrent: isFilterGenerationCurrent, currentGeneration: currentFilterGeneration, currentContext: currentFilterContext } = useContextGeneration(filterContextKey);
  const formContextKey = JSON.stringify(form);
  const { generation: formGeneration, isCurrent: isFormGenerationCurrent } = useContextGeneration(formContextKey);
  const editContextKey = `${editingId ?? ""}\u0000${JSON.stringify(editForm)}`;
  const { generation: editGeneration, isCurrent: isEditGenerationCurrent } = useContextGeneration(editContextKey);
  const deviceContextKey = `${filterContextKey}\u0000${deviceEntitlementId ?? ""}`;
  const { generation: deviceGeneration, isCurrent: isDeviceGenerationCurrent, currentGeneration: currentDeviceGeneration, currentContext: currentDeviceContext } = useContextGeneration(deviceContextKey);
  const meterContextKey = `${filterContextKey}\u0000${meterEntitlementId ?? ""}`;
  const entitlementsFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${entitlementsUrl}`);
  const releaseDetailFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${filterContextKey}\u0000release-detail`);
  const activePoliciesFence = useRequestFence(`${active ? "active" : "inactive"}\u0000active-policies`);
  const devicesFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${deviceContextKey}`);
  const meterFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${meterContextKey}`);
  const hasLoadedEntitlements = useRef(false);
  const currentDevicesRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));

  const refresh = useCallback(async (strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> => {
    if (!isCurrent()) return null;
    const ticket = entitlementsFence.begin();
    const response = await api<{ items: EntitlementRecord[]; next_cursor: string | null }>(entitlementsUrl);
    if (!isCurrent() || !entitlementsFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<{ items: EntitlementRecord[]; next_cursor: string | null }>(response, "entitlements_listed", hasEntitlementListData);
    if (parsed !== null) {
      if (entitlementsFence.settle(ticket, parsed.data.next_cursor ?? null)) {
        setEntitlements(parsed.data.items);
        setEntitlementsCursor(parsed.data.next_cursor ?? null);
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setMessage(apiFailureMessage(response));
    }
    return null;
  }, [entitlementsFence, entitlementsUrl, setMessage]);

  useEffect(() => {
    return registerCoreRefresh(refresh);
  }, [refresh, registerCoreRefresh]);

  useEffect(() => {
    const isCurrent = (): boolean => isFilterGenerationCurrent(filterGeneration);
    if (hasLoadedEntitlements.current) {
      void refreshCore(false, isCurrent);
      return;
    }
    hasLoadedEntitlements.current = true;
    void refresh(false, isCurrent);
  }, [entitlementsUrl, filterGeneration, isFilterGenerationCurrent, refresh, refreshCore]);

  useEffect(() => {
    if (!active) return;
    void (async () => {
      const result = await loadAllExactPages<Policy>("/api/admin/policies?status=active", "policies_listed", hasPolicyListData, activePoliciesFence, (policy) => policy.id);
      if (result.kind === "success") setActivePolicies(result.items);
      else if (result.kind === "failure") setMessage(result.message);
    })();
  }, [active, activePoliciesFence, setMessage]);

  useEffect(() => {
    if (navigationIntent?.tab !== "entitlements") return;
    setFilter({ project: navigationIntent.filter.project ?? "", feature: navigationIntent.filter.feature ?? "", status: navigationIntent.filter.status ?? "" });
    onNavigationHandled(navigationIntent);
  }, [navigationIntent, onNavigationHandled]);

  useEffect(() => {
    setSelectedIds((previous) => {
      const present = new Set(entitlements.map((item) => item.id));
      const next = new Set([...previous].filter((id) => present.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [entitlements]);

  async function submitCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (form.policy_id !== "" && (!activePoliciesFence.isSettled() || !activePolicies.some((policy) => policy.id === form.policy_id))) {
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
    const requestBody = JSON.stringify(body);
    await runKeyedMutation({
      request: { method: "POST", path: "/api/admin/entitlements", body: requestBody },
      send: (attempt) => api<EntitlementRecord>(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (result, phase) => parseMutationResponse(result, "entitlement_saved", (value): value is EntitlementRecord => {
        if (!hasEntitlementRecordData(value)) return false;
        const row = value as EntitlementRecord;
        return row.project === body.project && row.feature === body.feature && row.license_fingerprint === body.license_fingerprint && row.status === expectedStatus;
      }, mutationFailurePolicies.entitlementCreate, phase),
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setMessage(`${parsed.code} (${parsed.requestId})`);
        if (isFormGenerationCurrent(capturedFormGeneration)) setForm(emptyEntitlementForm);
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

  function beginEdit(item: EntitlementRecord): void {
    setEditingId(item.id);
    setEditForm(editFormFromEntitlement(item));
  }

  function cancelEdit(): void {
    setEditingId(null);
    setEditForm(emptyEntitlementEditForm);
  }

  async function submitPatch(event: FormEvent, item: EntitlementRecord): Promise<void> {
    event.preventDefault();
    const contextGeneration = filterGeneration;
    const capturedEditGeneration = editGeneration;
    const isListCurrent = (): boolean => isFilterGenerationCurrent(contextGeneration);
    const isCurrent = (): boolean => isListCurrent() && isEditGenerationCurrent(capturedEditGeneration);
    let body: ReturnType<typeof normalizeEntitlementPatch>;
    try {
      body = normalizeEntitlementPatch(editForm);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "invalid_patch");
      return;
    }
    const requestBody = JSON.stringify(body);
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
    const body = JSON.stringify(action === "disable" || action === "revoke" ? { reason: currentReason() } : {});
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

  async function loadDevices(entitlementId: string, strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    const ticket = devicesFence.begin();
    const response = await api<{ items: EntitlementDeviceRecord[] }>(entitlementDevicesPath(entitlementId));
    if (!isCurrent() || !devicesFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<{ items: EntitlementDeviceRecord[] }>(response, "devices_listed", hasDeviceListData);
    if (parsed !== null) {
      if (devicesFence.settle(ticket)) {
        setDevices(parsed.data.items);
        return EXACT_READ_PROOF;
      }
    }
    else if (strict) {
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    }
    else {
      setDevices([]);
      setMessage(apiFailureMessage(response));
    }
    return null;
  }

  currentDevicesRefreshRef.current = () => active && deviceEntitlementId !== null
    ? loadDevices(deviceEntitlementId, true)
    : Promise.resolve(null);

  function toggleDevices(entitlementId: string): void {
    if (deviceEntitlementId === entitlementId) {
      setDeviceEntitlementId(null);
      setDevices([]);
      return;
    }
    setDeviceEntitlementId(entitlementId);
    setDevices([]);
  }

  useEffect(() => {
    if (active && deviceEntitlementId !== null) {
      void loadDevices(deviceEntitlementId);
    }
  }, [active, deviceEntitlementId, devicesFence]);

  async function loadMeterStatus(entitlementId: string): Promise<void> {
    const ticket = meterFence.begin();
    const response = await api<MeterStatus>(entitlementMeterPath(entitlementId));
    if (!meterFence.isCurrent(ticket)) return;
    const parsed = parseExactApiSuccess<MeterStatus>(response, "meter_status", hasMeterStatusData);
    if (parsed !== null) {
      if (meterFence.settle(ticket)) setMeterStatus(parsed.data);
    }
    else {
      setMeterStatus(null);
      setMessage(apiFailureMessage(response));
    }
  }

  function toggleMeter(entitlementId: string): void {
    if (meterEntitlementId === entitlementId) {
      setMeterEntitlementId(null);
      setMeterStatus(null);
      return;
    }
    setMeterEntitlementId(entitlementId);
    setMeterStatus(null);
  }

  useEffect(() => {
    if (active && meterEntitlementId !== null) {
      void loadMeterStatus(meterEntitlementId);
    }
  }, [active, meterEntitlementId, meterFence]);

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

  const entitlementsSettled = entitlementsFence.isSettled();
  const visibleEntitlements = entitlementsSettled ? entitlements : [];
  const visibleEntitlementsCursor = entitlementsFence.canLoadMore() ? entitlementsCursor : null;
  const visibleDevices = devicesFence.isSettled() ? devices : [];
  const visibleMeterStatus = meterFence.isSettled() ? meterStatus : null;
  // A filter/context change hides the previous snapshot synchronously.  Keep
  // the batch body equally scoped to the newly settled rows so a short React
  // effect window can never submit IDs selected in the previous context.
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
  const nowSeconds = Math.floor(Date.now() / 1000);
  const activePoliciesSettled = activePoliciesFence.isSettled();
  const visibleActivePolicies = activePoliciesSettled ? activePolicies : [];
  return (
    <section className="workspace">
      <aside>
        <h2>Create</h2>
        <form onSubmit={(event) => void submitCreate(event)}><fieldset disabled={operationLocked}>
          <label>Policy (optional)<select disabled={!activePoliciesSettled} value={activePoliciesSettled ? form.policy_id : ""} onChange={(event) => setForm({ ...form, policy_id: event.target.value })}><option value="">none (direct create)</option>{visibleActivePolicies.map((policy) => <option key={policy.id} value={policy.id}>{policy.name} ({policy.type})</option>)}</select></label>
          {form.policy_id !== "" && <p className="muted">Stamping from a policy. The fields below override the policy defaults; leave blank to inherit. Requires POLICY_STAMP_MODE=on.</p>}
          <label>Project<input value={form.project} onChange={(event) => setForm({ ...form, project: event.target.value })} /></label><label>Feature<input value={form.feature} onChange={(event) => setForm({ ...form, feature: event.target.value })} /></label><label>Fingerprint<input value={form.license_fingerprint} onChange={(event) => setForm({ ...form, license_fingerprint: event.target.value })} /></label><label>Device hash<input value={form.device_hash} onChange={(event) => setForm({ ...form, device_hash: event.target.value })} /></label><label>Assertion TTL<input type="number" value={form.assertion_ttl_seconds} onChange={(event) => setForm({ ...form, assertion_ttl_seconds: Number(event.target.value) })} /></label><label>Valid from<input type="date" value={form.valid_from} onChange={(event) => setForm({ ...form, valid_from: event.target.value })} /></label><label>Valid until<input type="date" value={form.valid_until} onChange={(event) => setForm({ ...form, valid_until: event.target.value })} /></label><label>Customer ID<input value={form.customer_id} onChange={(event) => setForm({ ...form, customer_id: event.target.value })} /></label><label>License ID<input value={form.license_id} onChange={(event) => setForm({ ...form, license_id: event.target.value })} /></label><label>Notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
          <button disabled={busy || operationLocked} type="submit">Save</button>
        </fieldset></form>
      </aside>
      <section className="tablePane" data-focus-section="entitlements">
        <div className="filters"><input placeholder="project" value={filter.project} onChange={(event) => setFilter({ ...filter, project: event.target.value })} /><input placeholder="feature" value={filter.feature} onChange={(event) => setFilter({ ...filter, feature: event.target.value })} /><select value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option><option value="revoked">revoked</option></select><button type="button" disabled={busy} onClick={() => void downloadCsv(entitlementsUrl, "entitlements.csv", runMutation, setMessage)}>Export CSV</button></div>
        {selectedCount > 0 && <div className="bulkBar"><span>{selectedCount} selected (maximum {ENTITLEMENT_BATCH_MAX_IDS} per batch)</span><button type="button" disabled={busy} onClick={() => requestConfirm({ title: "Disable selected entitlements", body: bulkConfirmBody("disable"), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => runBatch("disable", idempotencyKey), successFocusTarget: focusTargetInSection("entitlements"), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Disable</button><button type="button" disabled={busy} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }: ConfirmActionContext) => runBatch("reenable", idempotencyKey), successFocusTarget: focusTargetInSection("entitlements"), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Reenable</button><button type="button" className="danger" disabled={busy} onClick={() => requestConfirm({ title: "Revoke selected entitlements", body: bulkConfirmBody("revoke"), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => runBatch("revoke", idempotencyKey), successFocusTarget: focusTargetInSection("entitlements"), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Revoke selected</button><button type="button" disabled={busy} onClick={() => setSelectedIds(new Set())}>Clear</button></div>}
        <table><thead><tr><th className="checkCol"><input type="checkbox" aria-label={`Select all loaded rows (up to ${ENTITLEMENT_BATCH_MAX_IDS})`} checked={allSelected} onChange={toggleSelectAll} /></th><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Details</th><th>Status</th><th>Seq</th><th>Actions</th></tr></thead><tbody>{visibleEntitlements.map((item) => <React.Fragment key={item.id}>
          <tr data-focus-row={`entitlement:${item.id}`}><td className="checkCol"><input type="checkbox" aria-label={`Select ${item.project}/${item.feature}`} checked={selectedIds.has(item.id)} disabled={busy || (!selectedIds.has(item.id) && selectedCount >= ENTITLEMENT_BATCH_MAX_IDS)} onChange={() => toggleSelected(item.id)} /></td><td>{item.project}</td><td>{item.feature}</td><td><code>{shortHash(item.license_fingerprint)}</code></td><td><div className="details"><span>TTL {item.assertion_ttl_seconds}s</span><span>Valid {item.valid_from ?? "any"} to {item.valid_until ?? "any"}</span><span>Customer {item.customer_id ?? "-"}</span><span>License {item.license_id ?? "-"}</span><span>Mode {item.license_mode}</span><span>Pool {item.pool_size} / Max devices {item.max_active_devices} / Borrow {item.max_borrow_sec}s</span>{item.policy_id !== null && <span>Policy {item.policy_id}</span>}{item.notes !== "" && <span>Notes {item.notes}</span>}</div></td><td><span className={`status ${item.status}`}>{item.status}</span><HealthBadge status={item.status} validUntil={item.valid_until} now={nowSeconds} /></td><td>{item.revocation_seq}</td><td className="actions"><button disabled={busy || !canEditEntitlement(item.status)} onClick={() => beginEdit(item)}>Edit</button><button className="danger" disabled={busy || !canRunAction(item.status, "disable")} onClick={() => requestConfirm({ title: "Disable entitlement", body: disableEntitlementConfirm(item), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => transition(item, "disable", idempotencyKey), successFocusTarget: focusTargetInRow(`entitlement:${item.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Disable</button><button data-focus-action="reenable" disabled={busy || !canRunAction(item.status, "reenable")} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }: ConfirmActionContext) => transition(item, "reenable", idempotencyKey), successFocusTarget: focusTargetInRow(`entitlement:${item.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Reenable</button><button className="danger" disabled={busy || !canRunAction(item.status, "revoke")} onClick={() => requestConfirm({ title: "Revoke entitlement", body: revokeEntitlementConfirm(item), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => transition(item, "revoke", idempotencyKey), successFocusTarget: focusTargetInRow(`entitlement:${item.id}`, [".status"]), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Revoke</button><button className="danger" disabled={busy || item.license_mode !== "floating" || item.status !== "active"} onClick={() => requestConfirm({ title: "Release seats", body: releaseSeatsConfirm(item), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => releaseSeats(item, idempotencyKey), successFocusTarget: focusTargetInRow(`entitlement:${item.id}`, ['button[data-focus-action="disable"]', ".status"]), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Release seats</button><button type="button" disabled={busy} aria-expanded={deviceEntitlementId === item.id} onClick={() => toggleDevices(item.id)}>Devices</button><button type="button" disabled={busy} aria-expanded={meterEntitlementId === item.id} onClick={() => toggleMeter(item.id)}>Meter</button></td></tr>
          {editingId === item.id && <tr className="editRow"><td colSpan={8}><form className="editForm" onSubmit={(event) => void submitPatch(event, item)}><fieldset disabled={operationLocked}><label>Device hash<input value={editForm.device_hash} onChange={(event) => setEditForm({ ...editForm, device_hash: event.target.value })} /></label><label>Assertion TTL<input type="number" value={editForm.assertion_ttl_seconds} onChange={(event) => setEditForm({ ...editForm, assertion_ttl_seconds: Number(event.target.value) })} /></label><label>Valid from<input type="date" value={editForm.valid_from} onChange={(event) => setEditForm({ ...editForm, valid_from: event.target.value })} /></label><label>Valid until<input type="date" value={editForm.valid_until} onChange={(event) => setEditForm({ ...editForm, valid_until: event.target.value })} /></label><label>Customer ID<input value={editForm.customer_id} onChange={(event) => setEditForm({ ...editForm, customer_id: event.target.value })} /></label><label>License ID<input value={editForm.license_id} onChange={(event) => setEditForm({ ...editForm, license_id: event.target.value })} /></label><label className="wide">Notes<textarea value={editForm.notes} onChange={(event) => setEditForm({ ...editForm, notes: event.target.value })} /></label><div className="actions wide"><button disabled={busy} type="submit">Update</button><button disabled={busy} type="button" onClick={cancelEdit}>Cancel</button></div></fieldset></form></td></tr>}
        </React.Fragment>)}</tbody></table>
        <div className="tableFooter"><span className="muted">{visibleEntitlements.length} shown</span>{visibleEntitlementsCursor !== null && <button type="button" disabled={busy || operationLocked} onClick={() => void loadMore(entitlementsUrl, visibleEntitlementsCursor, visibleEntitlements, setEntitlements, setEntitlementsCursor, setMessage, hasEntitlementListData, "entitlements_listed", entitlementsFence, (entitlement) => entitlement.id)}>Load more</button>}</div>
        {deviceEntitlementId !== null && <section className="deliveriesPane" aria-label="Registered devices"><h3>Devices for {shortHash(deviceEntitlementId)}<button type="button" className="linkish" disabled={busy} onClick={() => toggleDevices(deviceEntitlementId)}>close</button></h3><p className="muted">Revoking or disabling a device bumps the entitlement's revocation_seq, so the online-verify path refuses that device on its next proof-carrying check (before token TTL). Revoke is terminal.</p><table><caption className="srOnly">Registered device keys</caption><thead><tr><th scope="col">Device key</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Last seen</th><th scope="col">Actions</th></tr></thead><tbody>{visibleDevices.map((device) => <tr key={device.device_key_id} data-focus-row={`device:${device.device_key_id}`}><td className="mono">{shortDeviceKeyId(device.device_key_id)}</td><td><span className={`status ${device.status}`}>{device.status}</span></td><td>{formatEpoch(device.created_at)}</td><td>{formatEpoch(device.last_seen_at)}</td><td className="actions"><button disabled={busy || !canRunDeviceAction(device.status, "disable")} onClick={() => requestConfirm({ title: "Disable device", body: disableDeviceConfirm(device), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => deviceTransition(device, "disable", idempotencyKey), successFocusTarget: focusTargetInRow(`device:${device.device_key_id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isDeviceGenerationCurrent(deviceGeneration) })}>Disable</button><button data-focus-action="reenable" disabled={busy || !canRunDeviceAction(device.status, "reenable")} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }: ConfirmActionContext) => deviceTransition(device, "reenable", idempotencyKey), successFocusTarget: focusTargetInRow(`device:${device.device_key_id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isDeviceGenerationCurrent(deviceGeneration) })}>Reenable</button><button className="danger" disabled={busy || !canRunDeviceAction(device.status, "revoke")} onClick={() => requestConfirm({ title: "Revoke device", body: revokeDeviceConfirm(device), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => deviceTransition(device, "revoke", idempotencyKey), successFocusTarget: focusTargetInRow(`device:${device.device_key_id}`, [".status"]), isCurrent: () => isDeviceGenerationCurrent(deviceGeneration) })}>Revoke</button></td></tr>)}</tbody></table>{visibleDevices.length === 0 && devicesFence.isSettled() && <p className="muted">No devices registered for this entitlement.</p>}</section>}
        {meterEntitlementId !== null && <section className="deliveriesPane" aria-label="Metering status"><h3>Metering for {shortHash(meterEntitlementId)}<button type="button" className="linkish" disabled={busy} onClick={() => toggleMeter(meterEntitlementId)}>close</button></h3>{visibleMeterStatus === null ? <p className="muted">No metering data.</p> : <div className="details"><span>Consumed this period: <strong>{visibleMeterStatus.units_consumed}</strong>{visibleMeterStatus.meter_quota > 0 ? ` / ${visibleMeterStatus.meter_quota}` : " (quota off — count-only)"}</span><span>Period: {formatEpoch(visibleMeterStatus.period_start)} → {formatEpoch(visibleMeterStatus.period_end)} ({visibleMeterStatus.meter_period_sec}s)</span><span className="muted">Reading this does not increment the counter.</span></div>}</section>}
        <label className="reason">Reason<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      </section>
    </section>
  );
}
