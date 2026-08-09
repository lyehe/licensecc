import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import type { Policy } from "../../../shared/api";
import { api, apiFailureDetails, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { confirmMutationUnknown, confirmSuccessWithRefreshFailure, ConfirmRefreshFailure, EXACT_READ_PROOF, focusTargetInRow, type ConfirmActionContext, type ConfirmActionOutcome, type ConfirmActionResolution, type ExactReadProof, useContextGeneration, useOperatorControls } from "../../shared/controls";
import { loadMore } from "../../shared/pagination";
import { hasPolicyData, hasPolicyListData, hasPolicyTransitionData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { useRequestFence } from "../../shared/requestFence";
import { canRunPolicyAction, disablePolicyConfirm, emptyPolicyForm, normalizePolicyForm, policiesPath, policyTransitionPath, PolicyFilter, PolicyFormState } from "./workflow";

export function Policies({ active }: { active: boolean }): React.ReactElement | null {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policyFilter, setPolicyFilter] = useState<PolicyFilter>({ project: "", type: "", status: "" });
  const [policiesCursor, setPoliciesCursor] = useState<string | null>(null);
  const [policyForm, setPolicyForm] = useState<PolicyFormState>(emptyPolicyForm);
  const { busy: requestBusy, operationLocked, currentReason, requestConfirm, runConsequenceAction, runKeyedMutation, runMutation, setMessage, setReason } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const policiesUrl = useMemo(() => policiesPath(policyFilter), [policyFilter]);
  const filterContextKey = `${active ? "active" : "inactive"}\u0000${policyFilter.project}\u0000${policyFilter.type}\u0000${policyFilter.status}`;
  const { generation: filterGeneration, isCurrent: isFilterGenerationCurrent, currentGeneration: currentFilterGeneration, currentContext: currentFilterContext } = useContextGeneration(filterContextKey);
  const policyFormContextKey = JSON.stringify(policyForm);
  const { generation: policyFormGeneration, isCurrent: isPolicyFormGenerationCurrent } = useContextGeneration(policyFormContextKey);
  const policiesFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${policiesUrl}`);
  const currentPoliciesRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));

  async function refreshPolicies(strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    const ticket = policiesFence.begin();
    const response = await api<{ items: Policy[]; next_cursor: string | null }>(policiesUrl);
    if (!isCurrent() || !policiesFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<{ items: Policy[]; next_cursor: string | null }>(response, "policies_listed", hasPolicyListData);
    if (parsed !== null) {
      if (policiesFence.settle(ticket, parsed.data.next_cursor ?? null)) {
        setPolicies(parsed.data.items);
        setPoliciesCursor(parsed.data.next_cursor ?? null);
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

  currentPoliciesRefreshRef.current = () => active ? refreshPolicies(true) : Promise.resolve(null);

  useEffect(() => {
    const generation = filterGeneration;
    if (active) void refreshPolicies(false, () => isFilterGenerationCurrent(generation));
  }, [active, filterGeneration, isFilterGenerationCurrent, policiesUrl]);

  function setPolicyType(type: Policy["type"]): void {
    setPolicyForm((current) => ({
      ...current,
      type,
      pool_size: type === "floating" ? Math.max(1, current.pool_size) : type === "node_locked" ? 0 : current.pool_size,
      max_borrow_sec: type === "floating" ? current.max_borrow_sec : type === "node_locked" ? 0 : current.max_borrow_sec,
    }));
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
      setMessage(error instanceof Error ? error.message : "invalid_form");
      return;
    }
    const requestBody = JSON.stringify(body);
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
        setMessage(`${parsed.code} (${parsed.requestId})`);
        if (isPolicyFormGenerationCurrent(formGeneration)) setPolicyForm(emptyPolicyForm);
      },
      refresh: async () => await currentPoliciesRefreshRef.current(),
      onUnapplied: (parsed) => {
        if (isCurrent()) {
        setMessage(`${parsed.code} (${parsed.requestId})`);
        }
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
    if (mutation === undefined) return { ok: false, message: "mutation_busy", retryable: true };
    if (mutation === null) return confirmMutationUnknown(reconciliation);
    const parsed = parseMutationResponse(mutation, expectedCode, dataGuard, mutationFailurePolicies.policyTransition[action], "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") {
      setMessage(`${parsed.code} (${parsed.requestId})`);
      return { ok: false, message: `${parsed.code} (${parsed.requestId})`, retryable: true };
    }
    setMessage(`${parsed.code} (${parsed.requestId})`);
    setReason("");
    try {
      return (await currentPoliciesRefreshRef.current()) === EXACT_READ_PROOF
        ? { ok: true }
        : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    } catch {
      return confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    }
  }

  const policiesSettled = policiesFence.isSettled();
  const visiblePolicies = policiesSettled ? policies : [];
  const visiblePoliciesCursor = policiesFence.canLoadMore() ? policiesCursor : null;

  if (!active) return null;
  return (
    <section className="workspace">
      <aside>
        <h2>Policy editor</h2>
        <form onSubmit={(event) => void submitPolicyCreate(event)}><fieldset disabled={operationLocked}>
          <label>Project<input value={policyForm.project} onChange={(event) => setPolicyForm({ ...policyForm, project: event.target.value })} /></label>
          <label>Name<input value={policyForm.name} onChange={(event) => setPolicyForm({ ...policyForm, name: event.target.value })} /></label>
          <label>Type<select value={policyForm.type} onChange={(event) => setPolicyType(event.target.value as Policy["type"])}><option value="trial">trial</option><option value="node_locked">node_locked</option><option value="floating">floating</option><option value="subscription">subscription</option></select></label>
          <label>Valid from offset (sec)<input type="number" value={policyForm.valid_from_offset_sec} onChange={(event) => setPolicyForm({ ...policyForm, valid_from_offset_sec: event.target.value })} /></label>
          <label>Duration (sec)<input type="number" value={policyForm.duration_sec} onChange={(event) => setPolicyForm({ ...policyForm, duration_sec: event.target.value })} /></label>
          <label>Assertion TTL<input type="number" value={policyForm.assertion_ttl_seconds} onChange={(event) => setPolicyForm({ ...policyForm, assertion_ttl_seconds: Number(event.target.value) })} /></label>
          {policyForm.type === "floating" && <><label>Floating pool size<input type="number" value={policyForm.pool_size} onChange={(event) => setPolicyForm({ ...policyForm, pool_size: Number(event.target.value) })} /></label><label>Max borrow (sec)<input type="number" value={policyForm.max_borrow_sec} onChange={(event) => setPolicyForm({ ...policyForm, max_borrow_sec: Number(event.target.value) })} /></label></>}
          {policyForm.type !== "floating" && <label>Max active devices<input type="number" value={policyForm.max_active_devices} onChange={(event) => setPolicyForm({ ...policyForm, max_active_devices: Number(event.target.value) })} /></label>}
          <label>Meter quota (0 = off)<input type="number" value={policyForm.meter_quota} onChange={(event) => setPolicyForm({ ...policyForm, meter_quota: Number(event.target.value) })} /></label>
          <label>Meter period (sec)<input type="number" value={policyForm.meter_period_sec} onChange={(event) => setPolicyForm({ ...policyForm, meter_period_sec: Number(event.target.value) })} /></label>
          <label>Expiry strategy<select value={policyForm.expiry_strategy} onChange={(event) => setPolicyForm({ ...policyForm, expiry_strategy: event.target.value as Policy["expiry_strategy"] })}><option value="fixed_window">fixed_window</option><option value="non_expiring">non_expiring</option></select></label>
          {policyForm.type === "trial" && <fieldset className="trialPanel"><legend>Trial</legend><label>Expiration basis<select value={policyForm.trial_expiration_basis} onChange={(event) => setPolicyForm({ ...policyForm, trial_expiration_basis: event.target.value as Policy["trial_expiration_basis"] })}><option value="from_issue">from_issue</option><option value="from_first_activation">from_first_activation</option><option value="from_first_use">from_first_use</option></select></label><label>Trial duration (sec)<input type="number" value={policyForm.trial_duration_sec} onChange={(event) => setPolicyForm({ ...policyForm, trial_duration_sec: Number(event.target.value) })} /></label><label className="checkboxRow"><input type="checkbox" checked={policyForm.trial_one_per_device} onChange={(event) => setPolicyForm({ ...policyForm, trial_one_per_device: event.target.checked })} />One trial per device</label><label className="checkboxRow"><input type="checkbox" checked={policyForm.trial_require_device_proof} onChange={(event) => setPolicyForm({ ...policyForm, trial_require_device_proof: event.target.checked })} />Require device proof</label></fieldset>}
          <label>Notes<textarea value={policyForm.notes} onChange={(event) => setPolicyForm({ ...policyForm, notes: event.target.value })} /></label>
          <button disabled={busy || operationLocked} type="submit">Create policy</button>
        </fieldset></form>
      </aside>
      <section className="tablePane">
        <div className="filters"><input placeholder="project" value={policyFilter.project} onChange={(event) => setPolicyFilter({ ...policyFilter, project: event.target.value })} /><select value={policyFilter.type} onChange={(event) => setPolicyFilter({ ...policyFilter, type: event.target.value })}><option value="">all types</option><option value="trial">trial</option><option value="node_locked">node_locked</option><option value="floating">floating</option><option value="subscription">subscription</option></select><select value={policyFilter.status} onChange={(event) => setPolicyFilter({ ...policyFilter, status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option></select></div>
        <table><thead><tr><th>Name</th><th>Project</th><th>Type</th><th>Details</th><th>Status</th><th>Actions</th></tr></thead><tbody>{visiblePolicies.map((policy) => <tr key={policy.id} data-focus-row={`policy:${policy.id}`}><td>{policy.name}</td><td>{policy.project}</td><td>{policy.type}</td><td><div className="details"><span>TTL {policy.assertion_ttl_seconds}s</span><span>Expiry {policy.expiry_strategy}</span><span>Offset {policy.valid_from_offset_sec ?? "-"} / Duration {policy.duration_sec ?? "-"}</span><span>Pool {policy.pool_size} / Max devices {policy.max_active_devices} / Borrow {policy.max_borrow_sec}s</span>{policy.meter_quota > 0 && <span>Meter quota {policy.meter_quota} / {policy.meter_period_sec}s</span>}{policy.type === "trial" && <span>Trial {policy.trial_expiration_basis} {policy.trial_duration_sec}s {policy.trial_one_per_device === 1 ? "one-per-device" : ""} {policy.trial_require_device_proof === 1 ? "proof-required" : ""}</span>}{policy.notes !== "" && <span>Notes {policy.notes}</span>}</div></td><td><span className={`status ${policy.status}`}>{policy.status}</span></td><td className="actions"><button className="danger" disabled={busy || operationLocked || !canRunPolicyAction(policy.status, "disable")} onClick={() => requestConfirm({ title: "Disable policy", body: disablePolicyConfirm(policy), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => policyTransition(policy, "disable", idempotencyKey), successFocusTarget: focusTargetInRow(`policy:${policy.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Disable</button><button data-focus-action="reenable" disabled={busy || operationLocked || !canRunPolicyAction(policy.status, "reenable")} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }: ConfirmActionContext) => policyTransition(policy, "reenable", idempotencyKey), successFocusTarget: focusTargetInRow(`policy:${policy.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Reenable</button></td></tr>)}</tbody></table>
        <div className="tableFooter"><span className="muted">{visiblePolicies.length} shown</span>{visiblePoliciesCursor !== null && <button type="button" disabled={busy || operationLocked} onClick={() => void loadMore(policiesUrl, visiblePoliciesCursor, visiblePolicies, setPolicies, setPoliciesCursor, setMessage, hasPolicyListData, "policies_listed", policiesFence, (policy) => policy.id)}>Load more</button>}</div>
      </section>
    </section>
  );
}
