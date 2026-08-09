import React, { FormEvent, useEffect, useMemo, useState } from "react";

import type { WebhookDelivery, WebhookEndpoint } from "../../../shared/api";
import { api } from "../../shared/api";
import { useOperatorControls } from "../../shared/controls";
import { formatEpoch, shortHash } from "../../shared/format";
import { loadMore } from "../../shared/pagination";
import { canRunWebhookAction, disableWebhookConfirm, emptyWebhookForm, normalizeWebhookForm, webhookDeliveriesPath, webhookRedrivePath, webhookTransitionPath, webhooksPath, WebhookAction, WebhookDeliveryFilter, WebhookFilter, WebhookFormState } from "./workflow";

export function Webhooks({ active }: { active: boolean }): React.ReactElement | null {
  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [webhookFilter, setWebhookFilter] = useState<WebhookFilter>({ status: "" });
  const [webhooksCursor, setWebhooksCursor] = useState<string | null>(null);
  const [webhookForm, setWebhookForm] = useState<WebhookFormState>(emptyWebhookForm);
  const [webhookDeliveries, setWebhookDeliveries] = useState<WebhookDelivery[]>([]);
  const [webhookDeliveryFilter, setWebhookDeliveryFilter] = useState<WebhookDeliveryFilter>({ endpoint_id: "", status: "" });
  const { busy, currentReason, requestConfirm, runMutation, setMessage, setReason } = useOperatorControls();
  const webhooksUrl = useMemo(() => webhooksPath(webhookFilter), [webhookFilter]);
  const webhookDeliveriesUrl = useMemo(() => webhookDeliveriesPath(webhookDeliveryFilter), [webhookDeliveryFilter]);

  async function refreshWebhooks(): Promise<void> {
    const response = await api<{ items: WebhookEndpoint[]; next_cursor: string | null }>(webhooksUrl);
    if (response.ok && response.data) {
      setWebhooks(response.data.items);
      setWebhooksCursor(response.data.next_cursor ?? null);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  async function refreshWebhookDeliveries(): Promise<void> {
    const response = await api<{ items: WebhookDelivery[]; next_cursor: string | null }>(webhookDeliveriesUrl);
    if (response.ok && response.data) setWebhookDeliveries(response.data.items);
    else setMessage(`${response.code} (${response.request_id})`);
  }

  useEffect(() => {
    if (active) void refreshWebhooks();
  }, [active, webhooksUrl]);

  useEffect(() => {
    if (active) void refreshWebhookDeliveries();
  }, [active, webhookDeliveriesUrl]);

  async function submitWebhookCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    await runMutation(async () => {
      let body: ReturnType<typeof normalizeWebhookForm>;
      try {
        body = normalizeWebhookForm(webhookForm);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "invalid_form");
        return;
      }
      const result = await api<WebhookEndpoint>("/api/admin/webhooks", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setWebhookForm(emptyWebhookForm);
        await refreshWebhooks();
      }
    });
  }

  async function webhookTransition(endpoint: WebhookEndpoint, action: WebhookAction): Promise<void> {
    await runMutation(async () => {
      const result = await api<WebhookEndpoint>(webhookTransitionPath(endpoint.id, action), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(action === "disable" ? { reason: currentReason() } : {}),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) {
        setReason("");
        await refreshWebhooks();
      }
    });
  }

  async function redriveDelivery(delivery: WebhookDelivery): Promise<void> {
    await runMutation(async () => {
      const result = await api<WebhookDelivery>(webhookRedrivePath(String(delivery.id)), {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({}),
      });
      setMessage(`${result.code} (${result.request_id})`);
      if (result.ok) await refreshWebhookDeliveries();
    });
  }

  if (!active) return null;
  return (
    <section className="workspace">
      <aside>
        <h2>Webhook endpoint</h2>
        <form onSubmit={(event) => void submitWebhookCreate(event)}>
          <label>URL<input type="url" placeholder="https://hooks.example.com/lcc" value={webhookForm.url} onChange={(event) => setWebhookForm({ ...webhookForm, url: event.target.value })} /></label>
          <label>Event types (csv; blank = all)<input placeholder="entitlement.revoked,customer.disabled" value={webhookForm.event_types} onChange={(event) => setWebhookForm({ ...webhookForm, event_types: event.target.value })} /></label>
          <label>Description<input value={webhookForm.description} onChange={(event) => setWebhookForm({ ...webhookForm, description: event.target.value })} /></label>
          <label>Scope: project (blank = all)<input placeholder="DEFAULT" value={webhookForm.scope_project} onChange={(event) => setWebhookForm({ ...webhookForm, scope_project: event.target.value })} /></label>
          <label>Scope: customer id (blank = all)<input placeholder="cus_..." value={webhookForm.scope_customer_id} onChange={(event) => setWebhookForm({ ...webhookForm, scope_customer_id: event.target.value })} /></label>
          <p className="muted">Set at most one scope dimension. A scoped endpoint receives only matching events; blank = every event.</p>
          <button disabled={busy} type="submit">Create endpoint</button>
        </form>
      </aside>
      <section className="tablePane">
        <div className="filters"><select aria-label="Filter endpoints by status" value={webhookFilter.status} onChange={(event) => setWebhookFilter({ status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option></select></div>
        <table><caption className="srOnly">Webhook endpoints</caption><thead><tr><th scope="col">URL</th><th scope="col">Events</th><th scope="col">Scope</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Actions</th></tr></thead><tbody>{webhooks.map((endpoint) => <tr key={endpoint.id}><td className="mono">{endpoint.url}</td><td>{endpoint.event_types === "" ? "(all)" : endpoint.event_types}</td><td>{endpoint.scope_project !== null && endpoint.scope_project !== "" ? `project:${endpoint.scope_project}` : endpoint.scope_customer_id !== null && endpoint.scope_customer_id !== "" ? `customer:${endpoint.scope_customer_id}` : "(global)"}</td><td><span className={`status ${endpoint.status}`}>{endpoint.status}</span></td><td>{formatEpoch(endpoint.created_at)}</td><td className="actions"><button type="button" disabled={busy} onClick={() => setWebhookDeliveryFilter({ endpoint_id: endpoint.id, status: "" })}>Deliveries</button><button className="danger" disabled={busy || !canRunWebhookAction(endpoint.status, "disable")} onClick={() => requestConfirm({ title: "Disable webhook", body: disableWebhookConfirm(endpoint), requiresReason: true, run: () => webhookTransition(endpoint, "disable") })}>Disable</button><button disabled={busy || !canRunWebhookAction(endpoint.status, "reenable")} onClick={() => void webhookTransition(endpoint, "reenable")}>Reenable</button></td></tr>)}</tbody></table>
        <div className="tableFooter"><span className="muted">{webhooks.length} shown</span>{webhooksCursor !== null && <button type="button" disabled={busy} onClick={() => void loadMore(webhooksUrl, webhooksCursor, setWebhooks, setWebhooksCursor, setMessage)}>Load more</button>}</div>
        <section className="deliveriesPane" aria-label="Recent webhook deliveries">
          <h3>Recent deliveries{webhookDeliveryFilter.endpoint_id !== "" ? ` for ${shortHash(webhookDeliveryFilter.endpoint_id)}` : ""}</h3>
          <div className="filters">{webhookDeliveryFilter.endpoint_id !== "" && <button type="button" disabled={busy} onClick={() => setWebhookDeliveryFilter({ endpoint_id: "", status: "" })}>Clear endpoint filter</button>}<select aria-label="Filter deliveries by status" value={webhookDeliveryFilter.status} onChange={(event) => setWebhookDeliveryFilter({ ...webhookDeliveryFilter, status: event.target.value })}><option value="">all</option><option value="pending">pending</option><option value="delivered">delivered</option><option value="failed">failed</option></select></div>
          <table><caption className="srOnly">Recent webhook deliveries</caption><thead><tr><th scope="col">Time</th><th scope="col">Endpoint</th><th scope="col">Event</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Last</th><th scope="col">Actions</th></tr></thead><tbody>{webhookDeliveries.map((delivery) => <tr key={delivery.id}><td>{formatEpoch(delivery.created_at)}</td><td className="mono">{shortHash(delivery.endpoint_id)}</td><td>{delivery.event_source}.{delivery.event_type}</td><td><span className={`status ${delivery.status}`}>{delivery.status}</span></td><td>{delivery.attempts}</td><td>{delivery.last_status !== 0 ? delivery.last_status : delivery.last_error !== "" ? delivery.last_error : "-"}</td><td className="actions"><button type="button" disabled={busy || delivery.status !== "failed"} onClick={() => void redriveDelivery(delivery)}>Redrive</button></td></tr>)}</tbody></table>
          {webhookDeliveries.length === 0 && <p className="muted">No deliveries recorded.</p>}
        </section>
      </section>
    </section>
  );
}
