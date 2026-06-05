import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EntitlementRecord } from "../shared/api";
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
  actor: string;
  revocation_seq: number;
  created_at: number;
}

const emptyForm = {
  project: "DEFAULT",
  feature: "DEFAULT",
  license_fingerprint: "",
  device_hash: "",
  assertion_ttl_seconds: 300,
  cache_ttl_seconds: 3600,
  valid_from: "",
  valid_until: "",
  notes: "",
};

function shortHash(value: string): string {
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
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
  const [form, setForm] = useState(emptyForm);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState({ project: "", feature: "", status: "" });

  const entitlementsUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (filter.project !== "") params.set("project", filter.project);
    if (filter.feature !== "") params.set("feature", filter.feature);
    if (filter.status !== "") params.set("status", filter.status);
    return `/api/admin/entitlements${params.size === 0 ? "" : `?${params.toString()}`}`;
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

  async function submitCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    const body = {
      ...form,
      device_hash: form.device_hash,
      assertion_ttl_seconds: Number(form.assertion_ttl_seconds),
      cache_ttl_seconds: Number(form.cache_ttl_seconds),
      valid_from: form.valid_from === "" ? null : Number(form.valid_from),
      valid_until: form.valid_until === "" ? null : Number(form.valid_until),
    };
    const result = await api<EntitlementRecord>("/api/admin/entitlements", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    setMessage(`${result.code} (${result.request_id})`);
    if (result.ok) {
      setForm(emptyForm);
      await refresh();
    }
  }

  async function transition(item: EntitlementRecord, action: "disable" | "reenable" | "revoke"): Promise<void> {
    const result = await api<EntitlementRecord>(`/api/admin/entitlements/${item.id}/${action}`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ reason }),
    });
    setMessage(`${result.code} (${result.request_id})`);
    if (result.ok) {
      setReason("");
      await refresh();
    }
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
              <label>Cache TTL<input type="number" value={form.cache_ttl_seconds} onChange={(event) => setForm({ ...form, cache_ttl_seconds: Number(event.target.value) })} /></label>
              <label>Valid from<input value={form.valid_from} onChange={(event) => setForm({ ...form, valid_from: event.target.value })} /></label>
              <label>Valid until<input value={form.valid_until} onChange={(event) => setForm({ ...form, valid_until: event.target.value })} /></label>
              <label>Notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
              <button type="submit">Save</button>
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
              <thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Status</th><th>Seq</th><th>Actions</th></tr></thead>
              <tbody>
                {entitlements.map((item) => (
                  <tr key={item.id}>
                    <td>{item.project}</td>
                    <td>{item.feature}</td>
                    <td><code>{shortHash(item.license_fingerprint)}</code></td>
                    <td><span className={`status ${item.status}`}>{item.status}</span></td>
                    <td>{item.revocation_seq}</td>
                    <td className="actions">
                      <button disabled={item.status !== "active"} onClick={() => void transition(item, "disable")}>Disable</button>
                      <button disabled={item.status !== "disabled"} onClick={() => void transition(item, "reenable")}>Reenable</button>
                      <button disabled={item.status === "revoked"} onClick={() => void transition(item, "revoke")}>Revoke</button>
                    </td>
                  </tr>
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
            <thead><tr><th>Time</th><th>Event</th><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Actor</th><th>Seq</th></tr></thead>
            <tbody>
              {events.map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.created_at * 1000).toLocaleString()}</td>
                  <td>{item.event_type}</td>
                  <td>{item.project}</td>
                  <td>{item.feature}</td>
                  <td><code>{shortHash(item.license_fingerprint)}</code></td>
                  <td>{item.actor}</td>
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
