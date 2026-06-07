import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EntitlementRecord } from "../shared/api";
import {
  canEditEntitlement,
  canRunAction,
  editFormFromEntitlement,
  emptyEntitlementEditForm,
  emptyEntitlementForm,
  entitlementsPath,
  normalizeEntitlementForm,
  normalizeEntitlementPatch,
  patchPath,
  shortHash,
  transitionPath,
} from "./operatorWorkflow";
import "./styles.css";

interface Summary {
  entitlements: {
    total: number;
    active: number;
    revoked: number;
    disabled: number;
  };
}

interface ApiEnvelope<T> {
  ok: boolean;
  code: string;
  request_id: string;
  data?: T;
}

interface EventItem {
  id: number;
  event_type: string;
  project: string;
  feature: string;
  license_fingerprint: string;
  source: string;
  actor: string;
  actor_type: string;
  revocation_seq: number;
  created_at: number;
}

async function api<T>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return response.json() as Promise<ApiEnvelope<T>>;
}

function App(): React.ReactElement {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [entitlements, setEntitlements] = useState<EntitlementRecord[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "entitlements" | "events">("overview");
  const [form, setForm] = useState(emptyEntitlementForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(emptyEntitlementEditForm);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState({ project: "", feature: "", status: "" });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const entitlementsUrl = useMemo(() => {
    return entitlementsPath(filter);
  }, [filter]);

  async function refresh(): Promise<void> {
    const [summaryResponse, entitlementResponse, eventResponse] = await Promise.all([
      api<Summary>("/api/admin/summary"),
      api<{ items: EntitlementRecord[] }>(entitlementsUrl),
      api<{ items: EventItem[] }>("/api/admin/events"),
    ]);
    if (summaryResponse.ok && summaryResponse.data) setSummary(summaryResponse.data);
    if (entitlementResponse.ok && entitlementResponse.data) setEntitlements(entitlementResponse.data.items);
    if (eventResponse.ok && eventResponse.data) setEvents(eventResponse.data.items);
    const failed = [summaryResponse, entitlementResponse, eventResponse].find((item) => !item.ok);
    if (failed) setMessage(`${failed.code} (${failed.request_id})`);
  }

  useEffect(() => {
    void refresh();
  }, [entitlementsUrl]);

  async function runMutation(work: () => Promise<void>): Promise<void> {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function submitCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    await runMutation(async () => {
      let body: ReturnType<typeof normalizeEntitlementForm>;
      try {
        body = normalizeEntitlementForm(form);
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
        await refresh();
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
      const result = await api<EntitlementRecord>(patchPath(item), {
        method: "PATCH",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        cancelEdit();
        await refresh();
      }
    });
  }

  async function transition(item: EntitlementRecord, action: "disable" | "reenable" | "revoke"): Promise<void> {
    await runMutation(async () => {
      const result = await api<EntitlementRecord>(transitionPath(item, action), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ reason }),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setReason("");
        await refresh();
      }
    });
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>licensecc admin</h1>
          <p>{message || "ready"}</p>
        </div>
        <nav>
          <button className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")}>Overview</button>
          <button className={activeTab === "entitlements" ? "active" : ""} onClick={() => setActiveTab("entitlements")}>Entitlements</button>
          <button className={activeTab === "events" ? "active" : ""} onClick={() => setActiveTab("events")}>Events</button>
        </nav>
      </header>

      {activeTab === "overview" && (
        <section className="grid metrics">
          <div><span>Total</span><strong>{summary?.entitlements.total ?? 0}</strong></div>
          <div><span>Active</span><strong>{summary?.entitlements.active ?? 0}</strong></div>
          <div><span>Disabled</span><strong>{summary?.entitlements.disabled ?? 0}</strong></div>
          <div><span>Revoked</span><strong>{summary?.entitlements.revoked ?? 0}</strong></div>
        </section>
      )}

      {activeTab === "entitlements" && (
        <section className="workspace">
          <aside>
            <h2>Create</h2>
            <form onSubmit={(event) => void submitCreate(event)}>
              <label>Project<input value={form.project} onChange={(event) => setForm({ ...form, project: event.target.value })} /></label>
              <label>Feature<input value={form.feature} onChange={(event) => setForm({ ...form, feature: event.target.value })} /></label>
              <label>Fingerprint<input value={form.license_fingerprint} onChange={(event) => setForm({ ...form, license_fingerprint: event.target.value })} /></label>
              <label>Device hash<input value={form.device_hash} onChange={(event) => setForm({ ...form, device_hash: event.target.value })} /></label>
              <label>Assertion TTL<input type="number" value={form.assertion_ttl_seconds} onChange={(event) => setForm({ ...form, assertion_ttl_seconds: Number(event.target.value) })} /></label>
              <label>Valid from<input value={form.valid_from} onChange={(event) => setForm({ ...form, valid_from: event.target.value })} /></label>
              <label>Valid until<input value={form.valid_until} onChange={(event) => setForm({ ...form, valid_until: event.target.value })} /></label>
              <label>Customer ID<input value={form.customer_id} onChange={(event) => setForm({ ...form, customer_id: event.target.value })} /></label>
              <label>License ID<input value={form.license_id} onChange={(event) => setForm({ ...form, license_id: event.target.value })} /></label>
              <label>Notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
              <button disabled={busy} type="submit">Save</button>
            </form>
          </aside>
          <section className="tablePane">
            <div className="filters">
              <input placeholder="project" value={filter.project} onChange={(event) => setFilter({ ...filter, project: event.target.value })} />
              <input placeholder="feature" value={filter.feature} onChange={(event) => setFilter({ ...filter, feature: event.target.value })} />
              <select value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value })}>
                <option value="">all</option>
                <option value="active">active</option>
                <option value="disabled">disabled</option>
                <option value="revoked">revoked</option>
              </select>
            </div>
            <table>
              <thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Details</th><th>Status</th><th>Seq</th><th>Actions</th></tr></thead>
              <tbody>
                {entitlements.map((item) => (
                  <React.Fragment key={item.id}>
                    <tr>
                      <td>{item.project}</td>
                      <td>{item.feature}</td>
                      <td><code>{shortHash(item.license_fingerprint)}</code></td>
                      <td>
                        <div className="details">
                          <span>TTL {item.assertion_ttl_seconds}s</span>
                          <span>Valid {item.valid_from ?? "any"} to {item.valid_until ?? "any"}</span>
                          <span>Customer {item.customer_id ?? "-"}</span>
                          <span>License {item.license_id ?? "-"}</span>
                          {item.notes !== "" && <span>Notes {item.notes}</span>}
                        </div>
                      </td>
                      <td><span className={`status ${item.status}`}>{item.status}</span></td>
                      <td>{item.revocation_seq}</td>
                      <td className="actions">
                        <button disabled={busy || !canEditEntitlement(item.status)} onClick={() => beginEdit(item)}>Edit</button>
                        <button disabled={busy || !canRunAction(item.status, "disable")} onClick={() => void transition(item, "disable")}>Disable</button>
                        <button disabled={busy || !canRunAction(item.status, "reenable")} onClick={() => void transition(item, "reenable")}>Reenable</button>
                        <button disabled={busy || !canRunAction(item.status, "revoke")} onClick={() => void transition(item, "revoke")}>Revoke</button>
                      </td>
                    </tr>
                    {editingId === item.id && (
                      <tr className="editRow">
                        <td colSpan={7}>
                          <form className="editForm" onSubmit={(event) => void submitPatch(event, item)}>
                            <label>Device hash<input value={editForm.device_hash} onChange={(event) => setEditForm({ ...editForm, device_hash: event.target.value })} /></label>
                            <label>Assertion TTL<input type="number" value={editForm.assertion_ttl_seconds} onChange={(event) => setEditForm({ ...editForm, assertion_ttl_seconds: Number(event.target.value) })} /></label>
                            <label>Valid from<input value={editForm.valid_from} onChange={(event) => setEditForm({ ...editForm, valid_from: event.target.value })} /></label>
                            <label>Valid until<input value={editForm.valid_until} onChange={(event) => setEditForm({ ...editForm, valid_until: event.target.value })} /></label>
                            <label>Customer ID<input value={editForm.customer_id} onChange={(event) => setEditForm({ ...editForm, customer_id: event.target.value })} /></label>
                            <label>License ID<input value={editForm.license_id} onChange={(event) => setEditForm({ ...editForm, license_id: event.target.value })} /></label>
                            <label className="wide">Notes<textarea value={editForm.notes} onChange={(event) => setEditForm({ ...editForm, notes: event.target.value })} /></label>
                            <div className="actions wide">
                              <button disabled={busy} type="submit">Update</button>
                              <button disabled={busy} type="button" onClick={cancelEdit}>Cancel</button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            <label className="reason">Reason<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          </section>
        </section>
      )}

      {activeTab === "events" && (
        <section className="tablePane full">
          <table>
            <thead><tr><th>Time</th><th>Event</th><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Source</th><th>Actor</th><th>Seq</th></tr></thead>
            <tbody>
              {events.map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.created_at * 1000).toLocaleString()}</td>
                  <td>{item.event_type}</td>
                  <td>{item.project}</td>
                  <td>{item.feature}</td>
                  <td><code>{shortHash(item.license_fingerprint)}</code></td>
                  <td>{item.source}</td>
                  <td>{item.actor} <span className="muted">({item.actor_type})</span></td>
                  <td>{item.revocation_seq}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
