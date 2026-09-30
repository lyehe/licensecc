import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { useAdminNavigation, useNavigationGuard } from "../../app/navigation";
import type { DraftPolicy, PolicyDraftRequest } from "../../app/types";
import { StatusActions } from "../../shared/ActionMenu";
import { ReadNotice } from "../../shared/ReadNotice";
import type { Policy } from "../../../shared/api";
import { api, apiFailureDetails, parseExactApiSuccess } from "../../shared/api";
import { confirmMutationUnknown, confirmSuccessWithRefreshFailure, ConfirmRefreshFailure, EXACT_READ_PROOF, focusTargetInRow, type ConfirmActionContext, type ConfirmActionOutcome, type ConfirmActionResolution, type ExactReadProof, useContextGeneration, useOperatorControls } from "../../shared/controls";
import { FormStatus } from "../../shared/FeedbackText";
import { FieldDetails, FieldError, fieldProps, useFormFeedback } from "../../shared/fieldErrors";
import { apiFailureFeedback, codeFeedback, refusalOutcome, validationCode } from "../../shared/messages";
import type { OperatorFeedback } from "../../shared/operatorFeedback";
import { loadMore } from "../../shared/pagination";
import { hasPolicyData, hasPolicyListData, hasPolicyTransitionData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { useDebouncedValue } from "../../shared/useDebouncedValue";
import { useRequestFence } from "../../shared/requestFence";
import { canRunPolicyAction, disablePolicyConfirm, emptyPolicyForm, normalizePolicyForm, normalizePolicyPatch, policiesPath, policyFieldForCode, policyFormFromPolicy, policyPath, policyTransitionPath, PolicyFilter, PolicyFormState } from "./workflow";

const POLICY_FORM = "policy-editor";

/**
 * `draftRequest` is set when an entitlement draft chose "Create policy…": the create form opens for
 * the draft's project, and creating the policy (or "Back to entitlement draft") hands the operator
 * back to that parked draft through `onReturnToDraft`.
 */
export function Policies({ active, draftRequest = null, onReturnToDraft }: { active: boolean; draftRequest?: PolicyDraftRequest | null; onReturnToDraft?: (created: DraftPolicy | null) => void }): React.ReactElement | null {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policyFilter, setPolicyFilter] = useState<PolicyFilter>({ project: "", type: "", status: "" });
  const [policiesCursor, setPoliciesCursor] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  // The policy being edited, or null for a new policy. Its identity is shown but never sent.
  const [editing, setEditing] = useState<Policy | null>(null);
  const [readState, setReadState] = useState<{ key: string; loading: boolean; error: OperatorFeedback | null }>({ key: "", loading: true, error: null });
  const [policyForm, setPolicyForm] = useState<PolicyFormState>(emptyPolicyForm);
  const [baseline, setBaseline] = useState(() => JSON.stringify(emptyPolicyForm));
  const [returning, setReturning] = useState<{ created: DraftPolicy | null; feedback?: OperatorFeedback } | null>(null);
  const { busy: requestBusy, operationLocked, currentReason, requestConfirm, runConsequenceAction, runKeyedMutation, runMutation, setFeedback, setReason } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const { routeVersion } = useAdminNavigation();
  const formFeedback = useFormFeedback(POLICY_FORM, routeVersion);
  const { requestLeave } = useNavigationGuard({ when: active && editorOpen && JSON.stringify(policyForm) !== baseline, onDiscard: () => closeEditor() });
  const policiesUrl = useMemo(() => policiesPath(policyFilter), [policyFilter]);
  // The filter alone reloads the list; active only gates whether a reload may fire, so leaving and
  // returning to this tab with the filter unchanged costs zero requests. The debounce runs over the
  // generation number, not the filter itself: a filter that returns to an earlier value within one
  // debounce window (A -> B -> A) still must reload, and debouncing the value would collapse that
  // back to a value React already holds, silently dropping the reload.
  const filterContextKey = `${policyFilter.project}\u0000${policyFilter.type}\u0000${policyFilter.status}`;
  const { generation: filterGeneration, isCurrent: isFilterGenerationCurrent, currentGeneration: currentFilterGeneration, currentContext: currentFilterContext } = useContextGeneration(filterContextKey);
  const policiesReloadGeneration = useDebouncedValue(filterGeneration, 300);
  const lastRequestedPoliciesGeneration = useRef<number | null>(null);
  const policyFormContextKey = JSON.stringify(policyForm);
  const { generation: policyFormGeneration, isCurrent: isPolicyFormGenerationCurrent } = useContextGeneration(policyFormContextKey);
  const policiesFence = useRequestFence(policiesUrl);
  const currentPoliciesRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));

  function openEditor(next: PolicyFormState, target: Policy | null): void {
    formFeedback.clear();
    setEditing(target);
    setPolicyForm(next);
    setBaseline(JSON.stringify(next));
    setEditorOpen(true);
  }

  function closeEditor(): void {
    formFeedback.clear();
    setEditorOpen(false);
    setEditing(null);
    setPolicyForm(emptyPolicyForm);
    setBaseline(JSON.stringify(emptyPolicyForm));
  }

  // An entitlement draft asked for a policy of its project: open the create form for it.
  useEffect(() => {
    if (active && draftRequest !== null) openEditor({ ...emptyPolicyForm, project: draftRequest.project }, null);
  }, [active, draftRequest]);

  // Leave for the draft only after the closed editor has rendered, so its guard has stood down.
  useEffect(() => {
    if (returning === null) return;
    setReturning(null);
    onReturnToDraft?.(returning.created);
    // The return is a route step, which clears page messages; the create's confirmation follows it.
    if (returning.feedback !== undefined) setFeedback(returning.feedback);
  }, [returning, onReturnToDraft, setFeedback]);

  function backToDraft(): void {
    requestLeave(() => { closeEditor(); setReturning({ created: null }); });
  }

  async function refreshPolicies(strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    const ticket = policiesFence.begin();
    setReadState({ key: filterContextKey, loading: true, error: null });
    const response = await api<{ items: Policy[]; next_cursor: string | null }>(policiesUrl);
    if (!isCurrent() || !policiesFence.isCurrent(ticket)) return null;
    setReadState({ key: filterContextKey, loading: false, error: null });
    const parsed = parseExactApiSuccess<{ items: Policy[]; next_cursor: string | null }>(response, "policies_listed", hasPolicyListData);
    if (parsed !== null) {
      if (policiesFence.settle(ticket, parsed.data.next_cursor ?? null)) {
        setPolicies(parsed.data.items);
        setPoliciesCursor(parsed.data.next_cursor ?? null);
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      setReadState({ key: filterContextKey, loading: false, error: apiFailureFeedback(response) });
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setReadState({ key: filterContextKey, loading: false, error: apiFailureFeedback(response) });
    }
    return null;
  }

  currentPoliciesRefreshRef.current = () => active ? refreshPolicies(true) : Promise.resolve(null);

  useEffect(() => {
    if (!active || lastRequestedPoliciesGeneration.current === policiesReloadGeneration) return;
    lastRequestedPoliciesGeneration.current = policiesReloadGeneration;
    void refreshPolicies(false, () => isFilterGenerationCurrent(policiesReloadGeneration));
  }, [active, policiesReloadGeneration, isFilterGenerationCurrent]);

  /** One field edited: its inline error, which described the old value, goes with it. */
  function update(field: keyof PolicyFormState, patch: Partial<PolicyFormState>): void {
    formFeedback.clearField(field);
    setPolicyForm((current) => ({ ...current, ...patch }));
  }

  async function submitPolicyCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    const contextGeneration = filterGeneration;
    const formGeneration = policyFormGeneration;
    const isListCurrent = (): boolean => isFilterGenerationCurrent(contextGeneration);
    const isCurrent = (): boolean =>
      isListCurrent() && isPolicyFormGenerationCurrent(formGeneration);
    let body: ReturnType<typeof normalizePolicyForm>;
    try {
      body = normalizePolicyForm(policyForm);
    } catch (error) {
      formFeedback.show(validationCode(error), null, policyFieldForCode);
      return;
    }
    formFeedback.clear();
    const requestBody = JSON.stringify(body);
    const outcome: { created: Policy | null; feedback?: OperatorFeedback } = { created: null };
    await runKeyedMutation({
      request: { method: "POST", path: "/api/admin/policies", body: requestBody },
      send: (attempt) => api<Policy>(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (result, phase) => parseMutationResponse(result, "policy_created", (value): value is Policy => {
        if (!hasPolicyData(value)) return false;
        const row = value as Policy;
        return row.project === body.project && row.name === body.name && row.type === body.type && row.status === "active";
      }, mutationFailurePolicies.policyCreate, phase),
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        // Only a create the operator still owns opens its policy, or hands it back to the draft. The
        // editor opens as soon as the write is known, which also covers a reconciled replay.
        outcome.created = parsed.data;
        outcome.feedback = codeFeedback(parsed.code, parsed.requestId);
        setFeedback(outcome.feedback);
        if (draftRequest === null && isPolicyFormGenerationCurrent(formGeneration)) openEditor(policyFormFromPolicy(parsed.data), parsed.data);
      },
      refresh: async () => await currentPoliciesRefreshRef.current(),
      onUnapplied: (parsed) => {
        if (isCurrent()) formFeedback.show(parsed.code, parsed.requestId, policyFieldForCode);
      },
      isCurrent,
    });
    // A policy made for an entitlement draft goes straight back to that draft, chosen, once its
    // status read has settled on this page.
    const created = outcome.created;
    if (created !== null && draftRequest !== null) {
      closeEditor();
      setReturning({ created: { id: created.id, project: created.project }, feedback: outcome.feedback });
    }
  }

  async function submitPolicyPatch(event: FormEvent, policy: Policy): Promise<void> {
    event.preventDefault();
    const contextGeneration = filterGeneration;
    const formGeneration = policyFormGeneration;
    const isCurrent = (): boolean => isFilterGenerationCurrent(contextGeneration) && isPolicyFormGenerationCurrent(formGeneration);
    let body: ReturnType<typeof normalizePolicyPatch>;
    try {
      body = normalizePolicyPatch(policyForm);
    } catch (error) {
      formFeedback.show(validationCode(error), null, policyFieldForCode);
      return;
    }
    formFeedback.clear();
    await runKeyedMutation({
      request: { method: "PATCH", path: policyPath(policy.id), body: JSON.stringify(body) },
      send: (attempt) => api<Policy>(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (result, phase) => parseMutationResponse(result, "policy_patched", (value): value is Policy => {
        if (!hasPolicyData(value)) return false;
        const row = value as Policy;
        return row.id === policy.id && row.project === policy.project && row.name === policy.name && row.type === policy.type;
      }, mutationFailurePolicies.policyPatch, phase),
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setFeedback(codeFeedback(parsed.code, parsed.requestId));
        closeEditor();
      },
      refresh: async () => await currentPoliciesRefreshRef.current(),
      onUnapplied: (parsed) => {
        if (isCurrent()) formFeedback.show(parsed.code, parsed.requestId, policyFieldForCode);
      },
      isCurrent,
    });
  }

  async function policyTransition(policy: Policy, action: "disable" | "reenable", idempotencyKey: string = crypto.randomUUID()): Promise<ConfirmActionOutcome> {
    const contextGeneration = filterGeneration;
    let reconciliationGeneration = contextGeneration;
    const isCurrent = (): boolean => isFilterGenerationCurrent(reconciliationGeneration);
    const captureRecoveryContext = (): void => {
      if (currentFilterContext() === filterContextKey) {
        reconciliationGeneration = currentFilterGeneration();
      }
    };
    const targetStatus = action === "reenable" ? "active" : "disabled";
    const expectedCode = `policy_${action}d`;
    const body = JSON.stringify(action === "disable" ? { reason: currentReason() } : {});
    const dataGuard = (value: unknown): value is Policy => hasPolicyTransitionData(value, policy.id, targetStatus);
    const refreshStatus = async (): Promise<ExactReadProof | null> => {
      captureRecoveryContext();
      return await currentPoliciesRefreshRef.current();
    };
    const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent).manualRefresh;
    const replay = async (): Promise<ConfirmActionResolution> => {
      captureRecoveryContext();
      const retry = await runMutation(async () => {
        try {
          return await api<unknown>(policyTransitionPath(policy.id, action), {
            method: "POST",
            headers: { "idempotency-key": idempotencyKey },
            body,
          });
        } catch {
          return null;
        }
      }, "recovery");
      if (retry === undefined || retry === null) return "indeterminate";
      const parsed = parseMutationResponse(retry, expectedCode, dataGuard, mutationFailurePolicies.policyTransition[action], "replay");
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
        return await api<unknown>(policyTransitionPath(policy.id, action), {
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
    const parsed = parseMutationResponse(mutation, expectedCode, dataGuard, mutationFailurePolicies.policyTransition[action], "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") return refusalOutcome(parsed.code, parsed.requestId);
    setFeedback(codeFeedback(parsed.code, parsed.requestId));
    setReason("");
    try {
      return (await currentPoliciesRefreshRef.current()) === EXACT_READ_PROOF
        ? { ok: true }
        : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    } catch {
      return confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    }
  }

  // The previous rows stay on screen through a reload; the region below is marked aria-busy instead.
  const visiblePolicies = policies;
  const visiblePoliciesCursor = policiesFence.canLoadMore() ? policiesCursor : null;
  const policiesLoading = readState.key !== filterContextKey || readState.loading;

  if (!active) return null;
  const editorTitle = editing === null ? "New policy" : "Edit policy";
  const field = (name: keyof PolicyFormState, label: string) => fieldProps(POLICY_FORM, formFeedback.errors, name, label);
  const error = (name: keyof PolicyFormState) => <FieldError form={POLICY_FORM} field={name} errors={formFeedback.errors} />;
  const details = (name: keyof PolicyFormState) => <FieldDetails field={name} feedback={formFeedback} />;
  return (
    <section className="listPage">
      <div className="listHeader"><button className="primary" type="button" disabled={busy} onClick={() => { if (!editorOpen || editing !== null) requestLeave(() => openEditor(emptyPolicyForm, null)); }}>New policy</button></div>
      {editorOpen && <aside className="editorLayout">
        <h2>{editorTitle}</h2>
        {draftRequest !== null && editing === null && <div className="readState"><p>This policy is for your entitlement draft for {draftRequest.project}. Creating it returns you to the draft with the policy chosen.</p><button type="button" disabled={busy} onClick={backToDraft}>Back to entitlement draft</button></div>}
        {editing !== null && <p className="muted">Edits apply to entitlements stamped from now on. Entitlements already stamped from this policy keep their copy. Project, name, and type can't be changed.</p>}
        <form id={POLICY_FORM} aria-label={editorTitle} onSubmit={(event) => void (editing === null ? submitPolicyCreate(event) : submitPolicyPatch(event, editing))}><fieldset disabled={operationLocked}>
          <label>Project<input readOnly={editing !== null} value={policyForm.project} onChange={(event) => setPolicyForm({ ...policyForm, project: event.target.value })} /></label>
          <label>Name (required)<input required readOnly={editing !== null} {...field("name", "Name (required)")} value={policyForm.name} onChange={(event) => update("name", { name: event.target.value })} />{error("name")}</label>{details("name")}
          <label>Type<select aria-label="Type" disabled={editing !== null} value={policyForm.type} onChange={(event) => setPolicyForm({ ...policyForm, type: event.target.value as PolicyFormState["type"] })}><option value="trial">Trial</option><option value="node_locked">Device-locked</option><option value="subscription">Subscription</option></select></label>
          <label>Duration (sec)<input type="number" {...field("duration_sec", "Duration (sec)")} value={policyForm.duration_sec} onChange={(event) => update("duration_sec", { duration_sec: event.target.value })} />{error("duration_sec")}</label>{details("duration_sec")}
          <label>Device limit<input type="number" {...field("max_active_devices", "Device limit")} value={policyForm.max_active_devices} onChange={(event) => update("max_active_devices", { max_active_devices: Number(event.target.value) })} />{error("max_active_devices")}</label>{details("max_active_devices")}
          <label>Expiry strategy<select value={policyForm.expiry_strategy} onChange={(event) => setPolicyForm({ ...policyForm, expiry_strategy: event.target.value as Policy["expiry_strategy"] })}><option value="fixed_window">Fixed dates</option><option value="non_expiring">No expiry</option></select></label>
          {policyForm.type === "trial" && <fieldset className="trialPanel"><legend>Trial</legend><label>Expiration basis<select value={policyForm.trial_expiration_basis} onChange={(event) => setPolicyForm({ ...policyForm, trial_expiration_basis: event.target.value as Policy["trial_expiration_basis"] })}><option value="from_issue">When issued</option><option value="from_first_activation">On first activation</option><option value="from_first_use">On first use</option></select></label><label>Trial duration (sec)<input type="number" {...field("trial_duration_sec", "Trial duration (sec)")} value={policyForm.trial_duration_sec} onChange={(event) => update("trial_duration_sec", { trial_duration_sec: Number(event.target.value) })} />{error("trial_duration_sec")}</label>{details("trial_duration_sec")}<label className="checkboxRow"><input type="checkbox" checked={policyForm.trial_one_per_device} onChange={(event) => setPolicyForm({ ...policyForm, trial_one_per_device: event.target.checked })} />One trial per device</label></fieldset>}
          <details className="advancedSettings"><summary>Advanced settings</summary>
          <label>Valid from offset (sec)<input type="number" {...field("valid_from_offset_sec", "Valid from offset (sec)")} value={policyForm.valid_from_offset_sec} onChange={(event) => update("valid_from_offset_sec", { valid_from_offset_sec: event.target.value })} />{error("valid_from_offset_sec")}</label>{details("valid_from_offset_sec")}
          </details>
          <label>Notes<textarea {...field("notes", "Notes")} value={policyForm.notes} onChange={(event) => update("notes", { notes: event.target.value })} />{error("notes")}</label>{details("notes")}
          <FormStatus feedback={formFeedback.status} />
          <button disabled={busy || operationLocked} type="submit">{editing === null ? "Create policy" : "Save changes"}</button>
        </fieldset></form>
        <button type="button" disabled={busy} onClick={() => requestLeave(closeEditor)}>Close editor</button>
      </aside>}
      <section className="tablePane">
        <ReadNotice label="policies" hasData={policiesFence.isSettled()} loading={policiesLoading} error={readState.key === filterContextKey ? readState.error : null} onRetry={() => void refreshPolicies()} />
        <div className="filters"><label>Project<input placeholder="project" value={policyFilter.project} onChange={(event) => setPolicyFilter({ ...policyFilter, project: event.target.value })} /></label><label>Policy type<select value={policyFilter.type} onChange={(event) => setPolicyFilter({ ...policyFilter, type: event.target.value })}><option value="">all types</option><option value="trial">Trial</option><option value="node_locked">Device-locked</option><option value="subscription">Subscription</option></select></label><label>Status<select value={policyFilter.status} onChange={(event) => setPolicyFilter({ ...policyFilter, status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option></select></label><button type="button" onClick={() => setPolicyFilter({ project: "", type: "", status: "" })}>Clear filters</button></div>
        <div className="tableScroll" role="region" aria-label="Policy records" tabIndex={0} aria-busy={policiesLoading}><table><thead><tr><th>Name</th><th>Project</th><th>Type</th><th>Details</th><th>Status</th><th>Actions</th></tr></thead><tbody>{visiblePolicies.map((policy) => <tr key={policy.id} data-focus-row={`policy:${policy.id}`}><td>{policy.name}</td><td>{policy.project}</td><td>{policy.type}</td><td><div className="details"><span>Expiry {policy.expiry_strategy}</span><span>Offset {policy.valid_from_offset_sec ?? "-"} / Duration {policy.duration_sec ?? "-"}</span><span>Max devices {policy.max_active_devices}</span>{policy.type === "trial" && <span>Trial {policy.trial_expiration_basis} {policy.trial_duration_sec}s {policy.trial_one_per_device === 1 ? "one-per-device" : ""}</span>}{policy.notes !== "" && <span>Notes {policy.notes}</span>}</div></td><td><span className={`status ${policy.status}`}>{policy.status}</span></td><td className="actions"><button type="button" disabled={busy || operationLocked || !policiesFence.canLoadMore()} onClick={() => requestLeave(() => openEditor(policyFormFromPolicy(policy), policy))}>Edit</button><StatusActions status={policy.status}><button className="danger" disabled={busy || operationLocked || !policiesFence.canLoadMore() || !canRunPolicyAction(policy.status, "disable")} onClick={() => requestConfirm({ title: "Disable policy", body: disablePolicyConfirm(policy), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => policyTransition(policy, "disable", idempotencyKey), successFocusTarget: focusTargetInRow(`policy:${policy.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Disable</button><button data-focus-action="reenable" disabled={busy || operationLocked || !policiesFence.canLoadMore() || !canRunPolicyAction(policy.status, "reenable")} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }: ConfirmActionContext) => policyTransition(policy, "reenable", idempotencyKey), successFocusTarget: focusTargetInRow(`policy:${policy.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Reenable</button></StatusActions></td></tr>)}</tbody></table></div>
        {policiesFence.isSettled() && visiblePolicies.length === 0 && <p className="emptyState">No policies match this view.</p>}
        <div className="tableFooter"><span className="muted">{policiesFence.isSettled() ? `${visiblePolicies.length} shown` : ""}</span>{visiblePoliciesCursor !== null && <button type="button" disabled={busy || operationLocked} onClick={() => void loadMore(policiesUrl, visiblePoliciesCursor, visiblePolicies, setPolicies, setPoliciesCursor, setFeedback, hasPolicyListData, "policies_listed", policiesFence, (policy) => policy.id)}>Load more</button>}</div>
      </section>
    </section>
  );
}
