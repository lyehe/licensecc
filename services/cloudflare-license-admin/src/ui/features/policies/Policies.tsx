import React, { FormEvent, useEffect, useMemo, useState } from "react";

import type { Policy } from "../../../shared/api";
import { api } from "../../shared/api";
import { useOperatorControls } from "../../shared/controls";
import { loadMore } from "../../shared/pagination";
import { canRunPolicyAction, disablePolicyConfirm, emptyPolicyForm, normalizePolicyForm, policiesPath, policyTransitionPath, PolicyFilter, PolicyFormState } from "./workflow";

export function Policies({ active }: { active: boolean }): React.ReactElement | null {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policyFilter, setPolicyFilter] = useState<PolicyFilter>({ project: "", type: "", status: "" });
  const [policiesCursor, setPoliciesCursor] = useState<string | null>(null);
  const [policyForm, setPolicyForm] = useState<PolicyFormState>(emptyPolicyForm);
  const { busy, currentReason, requestConfirm, runMutation, setMessage, setReason } = useOperatorControls();
  const policiesUrl = useMemo(() => policiesPath(policyFilter), [policyFilter]);

  async function refreshPolicies(): Promise<void> {
    const response = await api<{ items: Policy[]; next_cursor: string | null }>(policiesUrl);
    if (response.ok && response.data) {
      setPolicies(response.data.items);
      setPoliciesCursor(response.data.next_cursor ?? null);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  useEffect(() => {
    if (active) void refreshPolicies();
  }, [active, policiesUrl]);

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
    await runMutation(async () => {
      let body: ReturnType<typeof normalizePolicyForm>;
      try {
        body = normalizePolicyForm(policyForm);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_form");
        return;
      }
      const result = await api<Policy>("/api/admin/policies", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setPolicyForm(emptyPolicyForm);
        await refreshPolicies();
      }
    });
  }

  async function policyTransition(policy: Policy, action: "disable" | "reenable"): Promise<void> {
    await runMutation(async () => {
      const result = await api<Policy>(policyTransitionPath(policy.id, action), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(action === "disable" ? { reason: currentReason() } : {}),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setReason("");
        await refreshPolicies();
      }
    });
  }

  if (!active) return null;
  return (
    <section className="workspace">
      <aside>
        <h2>Policy editor</h2>
        <form onSubmit={(event) => void submitPolicyCreate(event)}>
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
          <button disabled={busy} type="submit">Create policy</button>
        </form>
      </aside>
      <section className="tablePane">
        <div className="filters"><input placeholder="project" value={policyFilter.project} onChange={(event) => setPolicyFilter({ ...policyFilter, project: event.target.value })} /><select value={policyFilter.type} onChange={(event) => setPolicyFilter({ ...policyFilter, type: event.target.value })}><option value="">all types</option><option value="trial">trial</option><option value="node_locked">node_locked</option><option value="floating">floating</option><option value="subscription">subscription</option></select><select value={policyFilter.status} onChange={(event) => setPolicyFilter({ ...policyFilter, status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option></select></div>
        <table><thead><tr><th>Name</th><th>Project</th><th>Type</th><th>Details</th><th>Status</th><th>Actions</th></tr></thead><tbody>{policies.map((policy) => <tr key={policy.id}><td>{policy.name}</td><td>{policy.project}</td><td>{policy.type}</td><td><div className="details"><span>TTL {policy.assertion_ttl_seconds}s</span><span>Expiry {policy.expiry_strategy}</span><span>Offset {policy.valid_from_offset_sec ?? "-"} / Duration {policy.duration_sec ?? "-"}</span><span>Pool {policy.pool_size} / Max devices {policy.max_active_devices} / Borrow {policy.max_borrow_sec}s</span>{policy.meter_quota > 0 && <span>Meter quota {policy.meter_quota} / {policy.meter_period_sec}s</span>}{policy.type === "trial" && <span>Trial {policy.trial_expiration_basis} {policy.trial_duration_sec}s {policy.trial_one_per_device === 1 ? "one-per-device" : ""} {policy.trial_require_device_proof === 1 ? "proof-required" : ""}</span>}{policy.notes !== "" && <span>Notes {policy.notes}</span>}</div></td><td><span className={`status ${policy.status}`}>{policy.status}</span></td><td className="actions"><button className="danger" disabled={busy || !canRunPolicyAction(policy.status, "disable")} onClick={() => requestConfirm({ title: "Disable policy", body: disablePolicyConfirm(policy), requiresReason: true, run: () => policyTransition(policy, "disable") })}>Disable</button><button disabled={busy || !canRunPolicyAction(policy.status, "reenable")} onClick={() => void policyTransition(policy, "reenable")}>Reenable</button></td></tr>)}</tbody></table>
        <div className="tableFooter"><span className="muted">{policies.length} shown</span>{policiesCursor !== null && <button type="button" disabled={busy} onClick={() => void loadMore(policiesUrl, policiesCursor, setPolicies, setPoliciesCursor, setMessage)}>Load more</button>}</div>
      </section>
    </section>
  );
}
