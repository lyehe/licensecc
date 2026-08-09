import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EntitlementDeviceRecord, EntitlementRecord, Policy } from "../../../shared/api";
import { ENTITLEMENT_BATCH_MAX_IDS } from "../../../shared/api";
import type { NavigationIntent } from "../../app/types";
import { api } from "../../shared/api";
import { HealthBadge } from "../../shared/charts";
import { useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";
import { formatEpoch, shortHash } from "../../shared/format";
import { downloadCsv, loadMore } from "../../shared/pagination";
import {
  batchBody,
  boundedBatchSelection,
  batchPath,
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
  entitlementBatchSelectionNotice,
  entitlementsPath,
  entitlementDevicesPath,
  entitlementMeterPath,
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
  const { busy, currentReason, reason, requestConfirm, runMutation, setMessage, setReason } = useOperatorControls();
  const { refreshCore, registerCoreRefresh } = useCoreRefresh();
  const entitlementsUrl = useMemo(() => entitlementsPath(filter), [filter]);
  const hasLoadedEntitlements = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    const response = await api<{ items: EntitlementRecord[]; next_cursor: string | null }>(entitlementsUrl);
    if (response.ok && response.data) {
      setEntitlements(response.data.items);
      setEntitlementsCursor(response.data.next_cursor ?? null);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }, [entitlementsUrl, setMessage]);

  useEffect(() => {
    return registerCoreRefresh(refresh);
  }, [refresh, registerCoreRefresh]);

  useEffect(() => {
    if (hasLoadedEntitlements.current) {
      void refreshCore();
      return;
    }
    hasLoadedEntitlements.current = true;
    void refresh();
  }, [entitlementsUrl, refresh, refreshCore]);

  useEffect(() => {
    if (!active) return;
    void (async () => {
      const response = await api<{ items: Policy[]; next_cursor: string | null }>("/api/admin/policies?status=active");
      if (response.ok && response.data) setActivePolicies(response.data.items);
    })();
  }, [active]);

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
    await runMutation(async () => {
      let body: ReturnType<typeof normalizeEntitlementForm> | ReturnType<typeof normalizeCreateFromPolicy>;
      try {
        body = form.policy_id !== "" ? normalizeCreateFromPolicy(form) : normalizeEntitlementForm(form);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_form");
        return;
      }
      const result = await api<EntitlementRecord>("/api/admin/entitlements", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setForm(emptyEntitlementForm);
        await refreshCore();
      }
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
    await runMutation(async () => {
      let body: ReturnType<typeof normalizeEntitlementPatch>;
      try {
        body = normalizeEntitlementPatch(editForm);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_patch");
        return;
      }
      const result = await api<EntitlementRecord>(patchPath(item), { method: "PATCH", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        cancelEdit();
        await refreshCore();
      }
    });
  }

  async function transition(item: EntitlementRecord, action: EntitlementAction): Promise<void> {
    await runMutation(async () => {
      const result = await api<EntitlementRecord>(transitionPath(item, action), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ reason: currentReason() }),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setReason("");
        await refreshCore();
      }
    });
  }

  async function releaseSeats(item: EntitlementRecord): Promise<void> {
    await runMutation(async () => {
      const result = await api<{ released: number; seat_ids: string[] }>(releaseSeatsPath(item.id), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ reason: currentReason() }),
      });
      if (result.ok && result.data) {
        const count = result.data.released;
        setMessage(`released ${count} seat${count === 1 ? "" : "s"} (${result.request_id})`);
        setReason("");
        await refreshCore();
      } else {
        setMessage(`${result.code} (${result.request_id})`);
      }
    });
  }

  async function loadDevices(entitlementId: string): Promise<void> {
    const response = await api<{ items: EntitlementDeviceRecord[] }>(entitlementDevicesPath(entitlementId));
    if (response.ok && response.data) setDevices(response.data.items);
    else {
      setDevices([]);
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  function toggleDevices(entitlementId: string): void {
    if (deviceEntitlementId === entitlementId) {
      setDeviceEntitlementId(null);
      setDevices([]);
      return;
    }
    setDeviceEntitlementId(entitlementId);
    void loadDevices(entitlementId);
  }

  async function loadMeterStatus(entitlementId: string): Promise<void> {
    const response = await api<MeterStatus>(entitlementMeterPath(entitlementId));
    if (response.ok && response.data) setMeterStatus(response.data);
    else {
      setMeterStatus(null);
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  function toggleMeter(entitlementId: string): void {
    if (meterEntitlementId === entitlementId) {
      setMeterEntitlementId(null);
      setMeterStatus(null);
      return;
    }
    setMeterEntitlementId(entitlementId);
    void loadMeterStatus(entitlementId);
  }

  async function deviceTransition(device: EntitlementDeviceRecord, action: DeviceAction): Promise<void> {
    if (deviceEntitlementId === null) return;
    const entitlementId = deviceEntitlementId;
    await runMutation(async () => {
      const result = await api<EntitlementRecord>(deviceTransitionPath(entitlementId, device.device_key_id, action), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(action === "reenable" ? {} : { reason: currentReason() }),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        if (action !== "reenable") setReason("");
        await loadDevices(entitlementId);
      }
    });
  }

  function toggleSelected(id: string): void {
    if (!selectedIds.has(id) && selectedIds.size >= ENTITLEMENT_BATCH_MAX_IDS) {
      setMessage(entitlementBatchSelectionNotice);
      return;
    }
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectableLoadedIds = boundedBatchSelection(entitlements.map((item) => item.id));
  const allSelected = selectableLoadedIds.length > 0 && selectableLoadedIds.every((id) => selectedIds.has(id));
  function toggleSelectAll(): void {
    if (!allSelected && entitlements.length > ENTITLEMENT_BATCH_MAX_IDS) {
      setMessage(`Selected the first ${ENTITLEMENT_BATCH_MAX_IDS} loaded entitlements. ${entitlementBatchSelectionNotice}`);
    }
    setSelectedIds(allSelected ? new Set() : new Set(selectableLoadedIds));
  }

  function bulkConfirmBody(action: EntitlementAction): string {
    const count = selectedIds.size;
    const noun = `${count} selected entitlement${count === 1 ? "" : "s"}`;
    if (action === "revoke") return `Revoke ${noun}. Revocation is TERMINAL and cannot be undone; already-revoked rows are reported as revoked-terminal and skipped.`;
    return `Disable ${noun}. Disabled entitlements stop verifying until re-enabled.`;
  }

  async function runBatch(action: EntitlementAction): Promise<void> {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (ids.length > ENTITLEMENT_BATCH_MAX_IDS) {
      setMessage(entitlementBatchSelectionNotice);
      return;
    }
    await runMutation(async () => {
      const result = await api<{ results: Array<{ id: string; ok: boolean; code: string }> }>(batchPath(), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(batchBody(action, ids, currentReason())),
      });
      if (result.ok && result.data) {
        setMessage(`${action}: ${summarizeBatchResults(result.data.results)} (${result.request_id})`);
        setReason("");
        setSelectedIds(new Set());
        await refreshCore();
      } else {
        setMessage(`${result.code} (${result.request_id})`);
      }
    });
  }

  if (!active) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return (
    <section className="workspace">
      <aside>
        <h2>Create</h2>
        <form onSubmit={(event) => void submitCreate(event)}>
          <label>Policy (optional)<select value={form.policy_id} onChange={(event) => setForm({ ...form, policy_id: event.target.value })}><option value="">none (direct create)</option>{activePolicies.map((policy) => <option key={policy.id} value={policy.id}>{policy.name} ({policy.type})</option>)}</select></label>
          {form.policy_id !== "" && <p className="muted">Stamping from a policy. The fields below override the policy defaults; leave blank to inherit. Requires POLICY_STAMP_MODE=on.</p>}
          <label>Project<input value={form.project} onChange={(event) => setForm({ ...form, project: event.target.value })} /></label><label>Feature<input value={form.feature} onChange={(event) => setForm({ ...form, feature: event.target.value })} /></label><label>Fingerprint<input value={form.license_fingerprint} onChange={(event) => setForm({ ...form, license_fingerprint: event.target.value })} /></label><label>Device hash<input value={form.device_hash} onChange={(event) => setForm({ ...form, device_hash: event.target.value })} /></label><label>Assertion TTL<input type="number" value={form.assertion_ttl_seconds} onChange={(event) => setForm({ ...form, assertion_ttl_seconds: Number(event.target.value) })} /></label><label>Valid from<input type="date" value={form.valid_from} onChange={(event) => setForm({ ...form, valid_from: event.target.value })} /></label><label>Valid until<input type="date" value={form.valid_until} onChange={(event) => setForm({ ...form, valid_until: event.target.value })} /></label><label>Customer ID<input value={form.customer_id} onChange={(event) => setForm({ ...form, customer_id: event.target.value })} /></label><label>License ID<input value={form.license_id} onChange={(event) => setForm({ ...form, license_id: event.target.value })} /></label><label>Notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
          <button disabled={busy} type="submit">Save</button>
        </form>
      </aside>
      <section className="tablePane">
        <div className="filters"><input placeholder="project" value={filter.project} onChange={(event) => setFilter({ ...filter, project: event.target.value })} /><input placeholder="feature" value={filter.feature} onChange={(event) => setFilter({ ...filter, feature: event.target.value })} /><select value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option><option value="revoked">revoked</option></select><button type="button" disabled={busy} onClick={() => void downloadCsv(entitlementsUrl, "entitlements.csv", runMutation, setMessage)}>Export CSV</button></div>
        {selectedIds.size > 0 && <div className="bulkBar"><span>{selectedIds.size} selected (maximum {ENTITLEMENT_BATCH_MAX_IDS} per batch)</span><button type="button" disabled={busy} onClick={() => requestConfirm({ title: "Disable selected entitlements", body: bulkConfirmBody("disable"), requiresReason: true, run: () => runBatch("disable") })}>Disable</button><button type="button" disabled={busy} onClick={() => void runBatch("reenable")}>Reenable</button><button type="button" className="danger" disabled={busy} onClick={() => requestConfirm({ title: "Revoke selected entitlements", body: bulkConfirmBody("revoke"), requiresReason: true, run: () => runBatch("revoke") })}>Revoke selected</button><button type="button" disabled={busy} onClick={() => setSelectedIds(new Set())}>Clear</button></div>}
        <table><thead><tr><th className="checkCol"><input type="checkbox" aria-label={`Select up to ${ENTITLEMENT_BATCH_MAX_IDS} loaded rows`} checked={allSelected} onChange={toggleSelectAll} /></th><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Details</th><th>Status</th><th>Seq</th><th>Actions</th></tr></thead><tbody>{entitlements.map((item) => <React.Fragment key={item.id}>
          <tr><td className="checkCol"><input type="checkbox" aria-label={`Select ${item.project}/${item.feature}`} disabled={busy || (!selectedIds.has(item.id) && selectedIds.size >= ENTITLEMENT_BATCH_MAX_IDS)} checked={selectedIds.has(item.id)} onChange={() => toggleSelected(item.id)} /></td><td>{item.project}</td><td>{item.feature}</td><td><code>{shortHash(item.license_fingerprint)}</code></td><td><div className="details"><span>TTL {item.assertion_ttl_seconds}s</span><span>Valid {item.valid_from ?? "any"} to {item.valid_until ?? "any"}</span><span>Customer {item.customer_id ?? "-"}</span><span>License {item.license_id ?? "-"}</span><span>Mode {item.license_mode}</span><span>Pool {item.pool_size} / Max devices {item.max_active_devices} / Borrow {item.max_borrow_sec}s</span>{item.policy_id !== null && <span>Policy {item.policy_id}</span>}{item.notes !== "" && <span>Notes {item.notes}</span>}</div></td><td><span className={`status ${item.status}`}>{item.status}</span><HealthBadge status={item.status} validUntil={item.valid_until} now={nowSeconds} /></td><td>{item.revocation_seq}</td><td className="actions"><button disabled={busy || !canEditEntitlement(item.status)} onClick={() => beginEdit(item)}>Edit</button><button className="danger" disabled={busy || !canRunAction(item.status, "disable")} onClick={() => requestConfirm({ title: "Disable entitlement", body: disableEntitlementConfirm(item), requiresReason: true, run: () => transition(item, "disable") })}>Disable</button><button disabled={busy || !canRunAction(item.status, "reenable")} onClick={() => void transition(item, "reenable")}>Reenable</button><button className="danger" disabled={busy || !canRunAction(item.status, "revoke")} onClick={() => requestConfirm({ title: "Revoke entitlement", body: revokeEntitlementConfirm(item), requiresReason: true, run: () => transition(item, "revoke") })}>Revoke</button><button className="danger" disabled={busy || item.license_mode !== "floating" || item.status !== "active"} onClick={() => requestConfirm({ title: "Release seats", body: releaseSeatsConfirm(item), requiresReason: true, run: () => releaseSeats(item) })}>Release seats</button><button type="button" disabled={busy} aria-expanded={deviceEntitlementId === item.id} onClick={() => toggleDevices(item.id)}>Devices</button><button type="button" disabled={busy} aria-expanded={meterEntitlementId === item.id} onClick={() => toggleMeter(item.id)}>Meter</button></td></tr>
          {editingId === item.id && <tr className="editRow"><td colSpan={8}><form className="editForm" onSubmit={(event) => void submitPatch(event, item)}><label>Device hash<input value={editForm.device_hash} onChange={(event) => setEditForm({ ...editForm, device_hash: event.target.value })} /></label><label>Assertion TTL<input type="number" value={editForm.assertion_ttl_seconds} onChange={(event) => setEditForm({ ...editForm, assertion_ttl_seconds: Number(event.target.value) })} /></label><label>Valid from<input type="date" value={editForm.valid_from} onChange={(event) => setEditForm({ ...editForm, valid_from: event.target.value })} /></label><label>Valid until<input type="date" value={editForm.valid_until} onChange={(event) => setEditForm({ ...editForm, valid_until: event.target.value })} /></label><label>Customer ID<input value={editForm.customer_id} onChange={(event) => setEditForm({ ...editForm, customer_id: event.target.value })} /></label><label>License ID<input value={editForm.license_id} onChange={(event) => setEditForm({ ...editForm, license_id: event.target.value })} /></label><label className="wide">Notes<textarea value={editForm.notes} onChange={(event) => setEditForm({ ...editForm, notes: event.target.value })} /></label><div className="actions wide"><button disabled={busy} type="submit">Update</button><button disabled={busy} type="button" onClick={cancelEdit}>Cancel</button></div></form></td></tr>}
        </React.Fragment>)}</tbody></table>
        <div className="tableFooter"><span className="muted">{entitlements.length} shown</span>{entitlementsCursor !== null && <button type="button" disabled={busy} onClick={() => void loadMore(entitlementsUrl, entitlementsCursor, setEntitlements, setEntitlementsCursor, setMessage)}>Load more</button>}</div>
        {deviceEntitlementId !== null && <section className="deliveriesPane" aria-label="Registered devices"><h3>Devices for {shortHash(deviceEntitlementId)}<button type="button" className="linkish" disabled={busy} onClick={() => toggleDevices(deviceEntitlementId)}>close</button></h3><p className="muted">Revoking or disabling a device bumps the entitlement's revocation_seq, so the online-verify path refuses that device on its next proof-carrying check (before token TTL). Revoke is terminal.</p><table><caption className="srOnly">Registered device keys</caption><thead><tr><th scope="col">Device key</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Last seen</th><th scope="col">Actions</th></tr></thead><tbody>{devices.map((device) => <tr key={device.device_key_id}><td className="mono">{shortDeviceKeyId(device.device_key_id)}</td><td><span className={`status ${device.status}`}>{device.status}</span></td><td>{formatEpoch(device.created_at)}</td><td>{formatEpoch(device.last_seen_at)}</td><td className="actions"><button disabled={busy || !canRunDeviceAction(device.status, "disable")} onClick={() => requestConfirm({ title: "Disable device", body: disableDeviceConfirm(device), requiresReason: true, run: () => deviceTransition(device, "disable") })}>Disable</button><button disabled={busy || !canRunDeviceAction(device.status, "reenable")} onClick={() => void deviceTransition(device, "reenable")}>Reenable</button><button className="danger" disabled={busy || !canRunDeviceAction(device.status, "revoke")} onClick={() => requestConfirm({ title: "Revoke device", body: revokeDeviceConfirm(device), requiresReason: true, run: () => deviceTransition(device, "revoke") })}>Revoke</button></td></tr>)}</tbody></table>{devices.length === 0 && <p className="muted">No devices registered for this entitlement.</p>}</section>}
        {meterEntitlementId !== null && <section className="deliveriesPane" aria-label="Metering status"><h3>Metering for {shortHash(meterEntitlementId)}<button type="button" className="linkish" disabled={busy} onClick={() => toggleMeter(meterEntitlementId)}>close</button></h3>{meterStatus === null ? <p className="muted">No metering data.</p> : <div className="details"><span>Consumed this period: <strong>{meterStatus.units_consumed}</strong>{meterStatus.meter_quota > 0 ? ` / ${meterStatus.meter_quota}` : " (quota off — count-only)"}</span><span>Period: {formatEpoch(meterStatus.period_start)} → {formatEpoch(meterStatus.period_end)} ({meterStatus.meter_period_sec}s)</span><span className="muted">Reading this does not increment the counter.</span></div>}</section>}
        <label className="reason">Reason<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      </section>
    </section>
  );
}
