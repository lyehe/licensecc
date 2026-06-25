import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EntitlementRecord } from "../shared/api";
import {
  canEditEntitlement,
  canRunAction,
  canRunCustomerAction,
  customerDetailPath,
  customerTransitionPath,
  customersPath,
  editFormFromEntitlement,
  emptyEntitlementEditForm,
  emptyEntitlementForm,
  entitlementsPath,
  formatEpoch,
  licensesPath,
  normalizeEntitlementForm,
  normalizeEntitlementPatch,
  ordersPath,
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

interface CustomerListItem {
  id: string;
  name: string;
  email: string;
  status: "active" | "disabled";
  external_ref: string;
  created_at: number;
  updated_at: number;
  entitlement_count: number;
  active_entitlement_count: number;
}

interface CustomerDetail {
  customer: {
    id: string;
    name: string;
    email: string;
    status: string;
    external_ref: string;
    metadata_json: string;
    created_at: number;
    updated_at: number;
  };
  entitlements: Array<{
    project: string;
    feature: string;
    license_fingerprint: string;
    status: string;
    valid_from: number | null;
    valid_until: number | null;
    revocation_seq: number;
    updated_at: number;
  }>;
  account_tokens: Array<{
    id: string;
    token_prefix: string;
    name: string;
    status: string;
    scopes_json: string;
    expires_at: number | null;
    last_used_at: number | null;
    created_at: number;
  }>;
  licenses: Array<{
    id: string;
    project: string;
    label: string;
    created_at: number;
    updated_at: number;
  }>;
  orders: Array<{
    subscription_id: string;
    project: string;
    feature: string;
    license_fingerprint: string;
    last_seq: number;
    order_epoch: number;
    updated_at: number;
  }>;
  events: Array<{
    id: number;
    event_type: string;
    prev_status: string;
    next_status: string;
    actor: string;
    actor_type: string;
    reason: string;
    created_at: number;
  }>;
}

interface LicenseListItem {
  id: string;
  customer_id: string;
  project: string;
  label: string;
  created_at: number;
  updated_at: number;
}

interface OrderEventItem {
  event_id: number;
  subscription_id: string;
  project: string;
  feature: string;
  order_epoch: number;
  seq: number;
  intent: string;
  key_id: string;
  status: string;
  received_at: number;
  processed_at: number | null;
  stale: boolean;
}

interface FulfillmentSummary {
  accepted: number;
  processed: number;
  superseded: number;
  rejected: number;
  stale_accepted: number;
}

interface OrdersResponse {
  items: OrderEventItem[];
  summary: FulfillmentSummary;
  stale_secs: number;
  next_cursor: string | null;
}

interface Report {
  generated_at: number;
  entitlements: { total: number; active: number; revoked: number; disabled: number };
  customers: { total: number; active: number; disabled: number };
  account_tokens: { active: number };
  licenses: { total: number };
  fulfillment: {
    accepted: number;
    processed: number;
    superseded: number;
    rejected: number;
    stale_accepted: number;
    events_24h: number;
    events_7d: number;
  };
  customer_suspensions_7d: number;
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
  const [activeTab, setActiveTab] = useState<
    "overview" | "entitlements" | "events" | "customers" | "licenses" | "fulfillment" | "reports"
  >("overview");
  const [form, setForm] = useState(emptyEntitlementForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(emptyEntitlementEditForm);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState({ project: "", feature: "", status: "" });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const [customerFilter, setCustomerFilter] = useState({ status: "", q: "" });
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [customerDetail, setCustomerDetail] = useState<CustomerDetail | null>(null);

  const [licenses, setLicenses] = useState<LicenseListItem[]>([]);
  const [licenseFilter, setLicenseFilter] = useState({ project: "", customer_id: "", q: "" });

  const [orders, setOrders] = useState<OrdersResponse | null>(null);
  const [orderFilter, setOrderFilter] = useState({ status: "", subscription_id: "" });

  const [report, setReport] = useState<Report | null>(null);

  const entitlementsUrl = useMemo(() => {
    return entitlementsPath(filter);
  }, [filter]);

  const customersUrl = useMemo(() => customersPath(customerFilter), [customerFilter]);
  const licensesUrl = useMemo(() => licensesPath(licenseFilter), [licenseFilter]);
  const ordersUrl = useMemo(() => ordersPath(orderFilter), [orderFilter]);

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

  async function loadCustomerDetail(id: string): Promise<void> {
    const response = await api<CustomerDetail>(customerDetailPath(id));
    if (response.ok && response.data) {
      setCustomerDetail(response.data);
    } else {
      setCustomerDetail(null);
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  useEffect(() => {
    if (activeTab !== "customers") {
      return;
    }
    void (async () => {
      const response = await api<{ items: CustomerListItem[]; next_cursor: string | null }>(customersUrl);
      if (response.ok && response.data) {
        setCustomers(response.data.items);
      } else {
        setMessage(`${response.code} (${response.request_id})`);
      }
    })();
  }, [activeTab, customersUrl]);

  useEffect(() => {
    if (activeTab !== "customers" || selectedCustomerId === null) {
      return;
    }
    void loadCustomerDetail(selectedCustomerId);
  }, [activeTab, selectedCustomerId]);

  useEffect(() => {
    if (activeTab !== "licenses") {
      return;
    }
    void (async () => {
      const response = await api<{ items: LicenseListItem[]; next_cursor: string | null }>(licensesUrl);
      if (response.ok && response.data) {
        setLicenses(response.data.items);
      } else {
        setMessage(`${response.code} (${response.request_id})`);
      }
    })();
  }, [activeTab, licensesUrl]);

  useEffect(() => {
    if (activeTab !== "fulfillment") {
      return;
    }
    void (async () => {
      const response = await api<OrdersResponse>(ordersUrl);
      if (response.ok && response.data) {
        setOrders(response.data);
      } else {
        setMessage(`${response.code} (${response.request_id})`);
      }
    })();
  }, [activeTab, ordersUrl]);

  useEffect(() => {
    if (activeTab !== "reports") {
      return;
    }
    void (async () => {
      const response = await api<Report>("/api/admin/report");
      if (response.ok && response.data) {
        setReport(response.data);
      } else {
        setMessage(`${response.code} (${response.request_id})`);
      }
    })();
  }, [activeTab]);

  function selectCustomer(id: string): void {
    setSelectedCustomerId(id);
    if (id === selectedCustomerId) {
      void loadCustomerDetail(id);
    }
  }

  async function customerTransition(action: "disable" | "reenable"): Promise<void> {
    if (selectedCustomerId === null) {
      return;
    }
    const id = selectedCustomerId;
    await runMutation(async () => {
      const result = await api<CustomerListItem>(customerTransitionPath(id, action), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(action === "disable" ? { reason } : {}),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setReason("");
        await loadCustomerDetail(id);
        const listResponse = await api<{ items: CustomerListItem[]; next_cursor: string | null }>(customersUrl);
        if (listResponse.ok && listResponse.data) {
          setCustomers(listResponse.data.items);
        }
      }
    });
  }

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
          <button className={activeTab === "customers" ? "active" : ""} onClick={() => setActiveTab("customers")}>Customers</button>
          <button className={activeTab === "licenses" ? "active" : ""} onClick={() => setActiveTab("licenses")}>Licenses</button>
          <button className={activeTab === "fulfillment" ? "active" : ""} onClick={() => setActiveTab("fulfillment")}>Fulfillment</button>
          <button className={activeTab === "reports" ? "active" : ""} onClick={() => setActiveTab("reports")}>Reports</button>
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

      {activeTab === "customers" && (
        <section className="workspace">
          <section className="tablePane">
            <div className="filters">
              <select value={customerFilter.status} onChange={(event) => setCustomerFilter({ ...customerFilter, status: event.target.value })}>
                <option value="">all</option>
                <option value="active">active</option>
                <option value="disabled">disabled</option>
              </select>
              <input placeholder="search id / email / name" value={customerFilter.q} onChange={(event) => setCustomerFilter({ ...customerFilter, q: event.target.value })} />
            </div>
            <table>
              <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Status</th><th>Entitlements</th><th>Active</th></tr></thead>
              <tbody>
                {customers.map((item) => (
                  <tr key={item.id} className={selectedCustomerId === item.id ? "selectedRow" : ""}>
                    <td><button type="button" disabled={busy} onClick={() => selectCustomer(item.id)}>{item.id}</button></td>
                    <td>{item.name}</td>
                    <td>{item.email}</td>
                    <td><span className={`status ${item.status}`}>{item.status}</span></td>
                    <td>{item.entitlement_count}</td>
                    <td>{item.active_entitlement_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <aside>
            {customerDetail === null ? (
              <p className="muted">Select a customer to view details.</p>
            ) : (
              <div className="details">
                <h2>{customerDetail.customer.name}</h2>
                <span>{customerDetail.customer.email}</span>
                <span>Status <span className={`status ${customerDetail.customer.status}`}>{customerDetail.customer.status}</span></span>
                <span>External ref {customerDetail.customer.external_ref || "-"}</span>
                <span>Created {formatEpoch(customerDetail.customer.created_at)}</span>
                <span>Updated {formatEpoch(customerDetail.customer.updated_at)}</span>

                <label className="reason">Reason<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
                <div className="actions">
                  <button disabled={busy || !canRunCustomerAction(customerDetail.customer.status, "disable")} onClick={() => void customerTransition("disable")}>Disable</button>
                  <button disabled={busy || !canRunCustomerAction(customerDetail.customer.status, "reenable")} onClick={() => void customerTransition("reenable")}>Reenable</button>
                </div>

                <h2>Entitlements</h2>
                <table>
                  <thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Status</th><th>Seq</th><th>Until</th></tr></thead>
                  <tbody>
                    {customerDetail.entitlements.map((ent) => (
                      <tr key={`${ent.project}/${ent.feature}/${ent.license_fingerprint}`}>
                        <td>{ent.project}</td>
                        <td>{ent.feature}</td>
                        <td><code>{shortHash(ent.license_fingerprint)}</code></td>
                        <td><span className={`status ${ent.status}`}>{ent.status}</span></td>
                        <td>{ent.revocation_seq}</td>
                        <td>{formatEpoch(ent.valid_until)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h2>Account tokens</h2>
                <table>
                  <thead><tr><th>Prefix</th><th>Name</th><th>Status</th><th>Scopes</th><th>Expires</th><th>Last used</th></tr></thead>
                  <tbody>
                    {customerDetail.account_tokens.map((token) => (
                      <tr key={token.id}>
                        <td><code>{token.token_prefix}</code></td>
                        <td>{token.name}</td>
                        <td><span className={`status ${token.status}`}>{token.status}</span></td>
                        <td>{token.scopes_json}</td>
                        <td>{formatEpoch(token.expires_at)}</td>
                        <td>{formatEpoch(token.last_used_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h2>Licenses</h2>
                <table>
                  <thead><tr><th>ID</th><th>Project</th><th>Label</th><th>Created</th></tr></thead>
                  <tbody>
                    {customerDetail.licenses.map((license) => (
                      <tr key={license.id}>
                        <td>{license.id}</td>
                        <td>{license.project}</td>
                        <td>{license.label}</td>
                        <td>{formatEpoch(license.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h2>Orders</h2>
                <table>
                  <thead><tr><th>Subscription</th><th>Project</th><th>Feature</th><th>Seq</th><th>Epoch</th><th>Updated</th></tr></thead>
                  <tbody>
                    {customerDetail.orders.map((order) => (
                      <tr key={`${order.subscription_id}/${order.project}/${order.feature}`}>
                        <td>{order.subscription_id}</td>
                        <td>{order.project}</td>
                        <td>{order.feature}</td>
                        <td>{order.last_seq}</td>
                        <td>{order.order_epoch}</td>
                        <td>{formatEpoch(order.updated_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h2>History</h2>
                <table>
                  <thead><tr><th>Time</th><th>Event</th><th>From</th><th>To</th><th>Actor</th><th>Reason</th></tr></thead>
                  <tbody>
                    {customerDetail.events.map((event) => (
                      <tr key={event.id}>
                        <td>{formatEpoch(event.created_at)}</td>
                        <td>{event.event_type}</td>
                        <td>{event.prev_status}</td>
                        <td>{event.next_status}</td>
                        <td>{event.actor} <span className="muted">({event.actor_type})</span></td>
                        <td className="reason">{event.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </aside>
        </section>
      )}

      {activeTab === "licenses" && (
        <section className="tablePane full">
          <div className="filters">
            <input placeholder="project" value={licenseFilter.project} onChange={(event) => setLicenseFilter({ ...licenseFilter, project: event.target.value })} />
            <input placeholder="customer_id" value={licenseFilter.customer_id} onChange={(event) => setLicenseFilter({ ...licenseFilter, customer_id: event.target.value })} />
            <input placeholder="search id / label" value={licenseFilter.q} onChange={(event) => setLicenseFilter({ ...licenseFilter, q: event.target.value })} />
          </div>
          <table>
            <thead><tr><th>ID</th><th>Customer</th><th>Project</th><th>Label</th><th>Created</th></tr></thead>
            <tbody>
              {licenses.map((item) => (
                <tr key={item.id}>
                  <td>{item.id}</td>
                  <td><code>{shortHash(item.customer_id)}</code></td>
                  <td>{item.project}</td>
                  <td>{item.label}</td>
                  <td>{formatEpoch(item.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {activeTab === "fulfillment" && (
        <section className="tablePane full">
          <section className="grid metrics reportCards">
            <div><span>Accepted</span><strong>{orders?.summary.accepted ?? 0}</strong></div>
            <div><span>Processed</span><strong>{orders?.summary.processed ?? 0}</strong></div>
            <div><span>Superseded</span><strong>{orders?.summary.superseded ?? 0}</strong></div>
            <div><span>Rejected</span><strong>{orders?.summary.rejected ?? 0}</strong></div>
            <div><span>Stale</span><strong>{orders?.summary.stale_accepted ?? 0}</strong></div>
          </section>
          <div className="filters">
            <select value={orderFilter.status} onChange={(event) => setOrderFilter({ ...orderFilter, status: event.target.value })}>
              <option value="">all</option>
              <option value="accepted">accepted</option>
              <option value="processed">processed</option>
              <option value="superseded">superseded</option>
              <option value="rejected">rejected</option>
            </select>
            <input placeholder="subscription_id" value={orderFilter.subscription_id} onChange={(event) => setOrderFilter({ ...orderFilter, subscription_id: event.target.value })} />
          </div>
          <table>
            <thead><tr><th>Received</th><th>Subscription</th><th>Project</th><th>Feature</th><th>Seq</th><th>Intent</th><th>Status</th><th>Processed</th></tr></thead>
            <tbody>
              {(orders?.items ?? []).map((item) => (
                <tr key={item.event_id} className={item.stale ? "staleRow" : ""}>
                  <td>{formatEpoch(item.received_at)}</td>
                  <td>{item.subscription_id}</td>
                  <td>{item.project}</td>
                  <td>{item.feature}</td>
                  <td>{item.seq}</td>
                  <td>{item.intent}</td>
                  <td><span className={`status ${item.status}`}>{item.status}</span>{item.stale && <span className="staleFlag">STALE</span>}</td>
                  <td>{formatEpoch(item.processed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {activeTab === "reports" && (
        <section className="grid metrics reportCards">
          <div><span>Entitlements total</span><strong>{report?.entitlements.total ?? 0}</strong></div>
          <div><span>Entitlements active</span><strong>{report?.entitlements.active ?? 0}</strong></div>
          <div><span>Entitlements revoked</span><strong>{report?.entitlements.revoked ?? 0}</strong></div>
          <div><span>Entitlements disabled</span><strong>{report?.entitlements.disabled ?? 0}</strong></div>
          <div><span>Customers total</span><strong>{report?.customers.total ?? 0}</strong></div>
          <div><span>Customers active</span><strong>{report?.customers.active ?? 0}</strong></div>
          <div><span>Customers disabled</span><strong>{report?.customers.disabled ?? 0}</strong></div>
          <div><span>Active account tokens</span><strong>{report?.account_tokens.active ?? 0}</strong></div>
          <div><span>Licenses total</span><strong>{report?.licenses.total ?? 0}</strong></div>
          <div><span>Fulfillment processed</span><strong>{report?.fulfillment.processed ?? 0}</strong></div>
          <div><span>Fulfillment stale accepted</span><strong>{report?.fulfillment.stale_accepted ?? 0}</strong></div>
          <div><span>Order events 24h</span><strong>{report?.fulfillment.events_24h ?? 0}</strong></div>
          <div><span>Order events 7d</span><strong>{report?.fulfillment.events_7d ?? 0}</strong></div>
          <div><span>Customer suspensions 7d</span><strong>{report?.customer_suspensions_7d ?? 0}</strong></div>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
