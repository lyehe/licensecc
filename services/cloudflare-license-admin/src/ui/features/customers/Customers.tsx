import React, { useEffect, useMemo, useState } from "react";

import type { NavigationIntent } from "../../app/types";
import { api } from "../../shared/api";
import { HealthBadge } from "../../shared/charts";
import { useOperatorControls } from "../../shared/controls";
import { formatEpoch, shortHash } from "../../shared/format";
import { downloadCsv, loadMore } from "../../shared/pagination";
import { canRunCustomerAction, customerDetailPath, customerTransitionPath, customersPath, CustomerListFilter, disableCustomerConfirm } from "./workflow";

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
  licenses: Array<{ id: string; project: string; label: string; created_at: number; updated_at: number }>;
  orders: Array<{ subscription_id: string; project: string; feature: string; license_fingerprint: string; last_seq: number; order_epoch: number; updated_at: number }>;
  events: Array<{ id: number; event_type: string; prev_status: string; next_status: string; actor: string; actor_type: string; reason: string; created_at: number }>;
}

export function Customers({ active, navigationIntent, onNavigationHandled }: {
  active: boolean;
  navigationIntent: NavigationIntent | null;
  onNavigationHandled: (intent: NavigationIntent) => void;
}): React.ReactElement | null {
  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const [customerFilter, setCustomerFilter] = useState<CustomerListFilter>({ status: "", q: "" });
  const [customersCursor, setCustomersCursor] = useState<string | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [customerDetail, setCustomerDetail] = useState<CustomerDetail | null>(null);
  const { busy, currentReason, reason, requestConfirm, runMutation, setMessage, setReason } = useOperatorControls();
  const customersUrl = useMemo(() => customersPath(customerFilter), [customerFilter]);

  async function loadCustomerDetail(id: string): Promise<void> {
    const response = await api<CustomerDetail>(customerDetailPath(id));
    if (response.ok && response.data) {
      setCustomerDetail(response.data);
    } else {
      setCustomerDetail(null);
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  async function refreshCustomers(): Promise<void> {
    const response = await api<{ items: CustomerListItem[]; next_cursor: string | null }>(customersUrl);
    if (response.ok && response.data) {
      setCustomers(response.data.items);
      setCustomersCursor(response.data.next_cursor ?? null);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  useEffect(() => {
    if (navigationIntent?.tab !== "customers") return;
    setCustomerFilter({ status: navigationIntent.filter.status ?? "", q: navigationIntent.filter.q ?? "" });
    if (navigationIntent.selectCustomerId !== undefined) setSelectedCustomerId(navigationIntent.selectCustomerId);
    onNavigationHandled(navigationIntent);
  }, [navigationIntent, onNavigationHandled]);

  useEffect(() => {
    if (active) void refreshCustomers();
  }, [active, customersUrl]);

  useEffect(() => {
    if (active && selectedCustomerId !== null) void loadCustomerDetail(selectedCustomerId);
  }, [active, selectedCustomerId]);

  function selectCustomer(id: string): void {
    setSelectedCustomerId(id);
    if (id === selectedCustomerId) void loadCustomerDetail(id);
  }

  async function customerTransition(action: "disable" | "reenable"): Promise<void> {
    if (selectedCustomerId === null) return;
    const id = selectedCustomerId;
    await runMutation(async () => {
      const result = await api<CustomerListItem>(customerTransitionPath(id, action), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(action === "disable" ? { reason: currentReason() } : {}),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setReason("");
        await loadCustomerDetail(id);
        await refreshCustomers();
      }
    });
  }

  if (!active) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return (
    <section className="workspace">
      <section className="tablePane">
        <div className="filters">
          <select value={customerFilter.status} onChange={(event) => setCustomerFilter({ ...customerFilter, status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option></select>
          <input placeholder="search id / email / name" value={customerFilter.q} onChange={(event) => setCustomerFilter({ ...customerFilter, q: event.target.value })} />
          <button type="button" disabled={busy} onClick={() => void downloadCsv(customersUrl, "customers.csv", runMutation, setMessage)}>Export CSV</button>
        </div>
        <table><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Status</th><th>Entitlements</th><th>Active</th></tr></thead><tbody>{customers.map((item) => <tr key={item.id} className={selectedCustomerId === item.id ? "selectedRow" : ""}><td><button type="button" disabled={busy} onClick={() => selectCustomer(item.id)}>{item.id}</button></td><td>{item.name}</td><td>{item.email}</td><td><span className={`status ${item.status}`}>{item.status}</span></td><td>{item.entitlement_count}</td><td>{item.active_entitlement_count}</td></tr>)}</tbody></table>
        <div className="tableFooter"><span className="muted">{customers.length} shown</span>{customersCursor !== null && <button type="button" disabled={busy} onClick={() => void loadMore(customersUrl, customersCursor, setCustomers, setCustomersCursor, setMessage)}>Load more</button>}</div>
      </section>
      <aside>
        {customerDetail === null ? <p className="muted">Select a customer to view details.</p> : (
          <div className="details">
            <h2>{customerDetail.customer.name}</h2><span>{customerDetail.customer.email}</span><span>Status <span className={`status ${customerDetail.customer.status}`}>{customerDetail.customer.status}</span></span><span>External ref {customerDetail.customer.external_ref || "-"}</span><span>Created {formatEpoch(customerDetail.customer.created_at)}</span><span>Updated {formatEpoch(customerDetail.customer.updated_at)}</span>
            <label className="reason">Reason<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
            <div className="actions"><button className="danger" disabled={busy || !canRunCustomerAction(customerDetail.customer.status, "disable")} onClick={() => requestConfirm({ title: "Disable customer", body: disableCustomerConfirm(customerDetail.customer), requiresReason: true, run: () => customerTransition("disable") })}>Disable</button><button disabled={busy || !canRunCustomerAction(customerDetail.customer.status, "reenable")} onClick={() => void customerTransition("reenable")}>Reenable</button></div>
            <h2>Entitlements</h2><table><thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Status</th><th>Seq</th><th>Until</th></tr></thead><tbody>{customerDetail.entitlements.map((ent) => <tr key={`${ent.project}/${ent.feature}/${ent.license_fingerprint}`}><td>{ent.project}</td><td>{ent.feature}</td><td><code>{shortHash(ent.license_fingerprint)}</code></td><td><span className={`status ${ent.status}`}>{ent.status}</span><HealthBadge status={ent.status} validUntil={ent.valid_until} now={nowSeconds} /></td><td>{ent.revocation_seq}</td><td>{formatEpoch(ent.valid_until)}</td></tr>)}</tbody></table>
            <h2>Account tokens</h2><table><thead><tr><th>Prefix</th><th>Name</th><th>Status</th><th>Scopes</th><th>Expires</th><th>Last used</th></tr></thead><tbody>{customerDetail.account_tokens.map((token) => <tr key={token.id}><td><code>{token.token_prefix}</code></td><td>{token.name}</td><td><span className={`status ${token.status}`}>{token.status}</span></td><td>{token.scopes_json}</td><td>{formatEpoch(token.expires_at)}</td><td>{formatEpoch(token.last_used_at)}</td></tr>)}</tbody></table>
            <h2>Licenses</h2><table><thead><tr><th>ID</th><th>Project</th><th>Label</th><th>Created</th></tr></thead><tbody>{customerDetail.licenses.map((license) => <tr key={license.id}><td>{license.id}</td><td>{license.project}</td><td>{license.label}</td><td>{formatEpoch(license.created_at)}</td></tr>)}</tbody></table>
            <h2>Orders</h2><table><thead><tr><th>Subscription</th><th>Project</th><th>Feature</th><th>Seq</th><th>Epoch</th><th>Updated</th></tr></thead><tbody>{customerDetail.orders.map((order) => <tr key={`${order.subscription_id}/${order.project}/${order.feature}`}><td>{order.subscription_id}</td><td>{order.project}</td><td>{order.feature}</td><td>{order.last_seq}</td><td>{order.order_epoch}</td><td>{formatEpoch(order.updated_at)}</td></tr>)}</tbody></table>
            <h2>History</h2><table><thead><tr><th>Time</th><th>Event</th><th>From</th><th>To</th><th>Actor</th><th>Reason</th></tr></thead><tbody>{customerDetail.events.map((event) => <tr key={event.id}><td>{formatEpoch(event.created_at)}</td><td>{event.event_type}</td><td>{event.prev_status}</td><td>{event.next_status}</td><td>{event.actor} <span className="muted">({event.actor_type})</span></td><td className="reason">{event.reason}</td></tr>)}</tbody></table>
          </div>
        )}
      </aside>
    </section>
  );
}
