import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { useNavigationGuard } from "../../app/navigation";
import { StatusActions } from "../../shared/ActionMenu";
import { ReadNotice } from "../../shared/ReadNotice";
import type { WebhookDelivery, WebhookEndpoint } from "../../../shared/api";
import { api, apiFailureDetails, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { confirmMutationUnknown, confirmSuccessWithRefreshFailure, ConfirmRefreshFailure, EXACT_READ_PROOF, focusTargetInRow, type ConfirmActionContext, type ConfirmActionOutcome, type ConfirmActionResolution, type ExactReadProof, useContextGeneration, useOperatorControls } from "../../shared/controls";
import { formatEpoch, shortHash } from "../../shared/format";
import { isRetryableAppendFailure, loadMore, pageAppendError, withCursor } from "../../shared/pagination";
import { hasWebhookData, hasWebhookDeliveryData, hasWebhookDeliveryListData, hasWebhookListData, hasWebhookTransitionData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { useRequestFence } from "../../shared/requestFence";
import { canRunWebhookAction, disableWebhookConfirm, emptyWebhookForm, normalizeWebhookForm, webhookDeliveriesPath, webhookRedrivePath, webhookTransitionPath, webhooksPath, WebhookAction, WebhookDeliveryFilter, WebhookFilter, WebhookFormState } from "./workflow";

export function Webhooks({ active }: { active: boolean }): React.ReactElement | null {
  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [webhookFilter, setWebhookFilter] = useState<WebhookFilter>({ status: "" });
  const [webhooksCursor, setWebhooksCursor] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [readState, setReadState] = useState<{ key: string; loading: boolean; error: string | null }>({ key: "", loading: true, error: null });
  const [deliveryRead, setDeliveryRead] = useState<{ key: string; loading: boolean; error: string | null }>({ key: "", loading: true, error: null });
  const [webhookForm, setWebhookForm] = useState<WebhookFormState>(emptyWebhookForm);
  const [webhookDeliveries, setWebhookDeliveries] = useState<WebhookDelivery[]>([]);
  const [webhookDeliveriesCursor, setWebhookDeliveriesCursor] = useState<string | null>(null);
  const [webhookDeliveryFilter, setWebhookDeliveryFilter] = useState<WebhookDeliveryFilter>({ endpoint_id: "", status: "" });
  const { busy: requestBusy, operationLocked, currentReason, requestConfirm, runConsequenceAction, runKeyedMutation, runMutation, setMessage, setReason } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const { requestLeave } = useNavigationGuard({ when: active && editorOpen && JSON.stringify(webhookForm) !== JSON.stringify(emptyWebhookForm), onDiscard: () => { setWebhookForm(emptyWebhookForm); setEditorOpen(false); } });
  const webhooksUrl = useMemo(() => webhooksPath(webhookFilter), [webhookFilter]);
  const filterContextKey = `${active ? "active" : "inactive"}\u0000${webhookFilter.status}`;
  const { generation: filterGeneration, isCurrent: isFilterGenerationCurrent, currentGeneration: currentFilterGeneration, currentContext: currentFilterContext } = useContextGeneration(filterContextKey);
  const webhookFormContextKey = JSON.stringify(webhookForm);
  const { generation: webhookFormGeneration, isCurrent: isWebhookFormGenerationCurrent } = useContextGeneration(webhookFormContextKey);
  const webhookDeliveriesUrl = useMemo(() => webhookDeliveriesPath(webhookDeliveryFilter), [webhookDeliveryFilter]);
  const deliveryContextKey = `${active ? "active" : "inactive"}\u0000${webhookDeliveryFilter.endpoint_id}\u0000${webhookDeliveryFilter.status}`;
  const { generation: deliveryGeneration, isCurrent: isDeliveryGenerationCurrent } = useContextGeneration(deliveryContextKey);
  const webhooksFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${webhooksUrl}`);
  const deliveriesFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${webhookDeliveriesUrl}`);
  // A mutation/form context may have moved by the time a known-success GET
  // recovery runs.  These refs intentionally dereference the current rendered
  // reader; the reader itself remains fenced to that current filter snapshot.
  const currentWebhooksRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));
  const currentDeliveriesRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));

  async function refreshWebhooks(strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    const ticket = webhooksFence.begin();
    setReadState({ key: filterContextKey, loading: true, error: null });
    const response = await api<{ items: WebhookEndpoint[]; next_cursor: string | null }>(webhooksUrl);
    if (!isCurrent() || !webhooksFence.isCurrent(ticket)) return null;
    setReadState({ key: filterContextKey, loading: false, error: null });
    const parsed = parseExactApiSuccess<{ items: WebhookEndpoint[]; next_cursor: string | null }>(response, "webhooks_listed", hasWebhookListData);
    if (parsed !== null) {
      if (webhooksFence.settle(ticket, parsed.data.next_cursor ?? null)) {
        setWebhooks(parsed.data.items);
        setWebhooksCursor(parsed.data.next_cursor ?? null);
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      setReadState({ key: filterContextKey, loading: false, error: apiFailureMessage(response) });
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setReadState({ key: filterContextKey, loading: false, error: apiFailureMessage(response) });
      setMessage(apiFailureMessage(response));
    }
    return null;
  }

  async function refreshWebhookDeliveries(isCurrent: () => boolean = () => true, strict = false): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    const ticket = deliveriesFence.begin();
    setDeliveryRead({ key: deliveryContextKey, loading: true, error: null });
    const response = await api<{ items: WebhookDelivery[]; next_cursor: string | null }>(webhookDeliveriesUrl);
    if (!isCurrent() || !deliveriesFence.isCurrent(ticket)) return null;
    setDeliveryRead({ key: deliveryContextKey, loading: false, error: null });
    const parsed = parseExactApiSuccess<{ items: WebhookDelivery[]; next_cursor: string | null }>(response, "webhook_deliveries_listed", hasWebhookDeliveryListData);
    if (parsed !== null) {
      if (deliveriesFence.settle(ticket, parsed.data.next_cursor ?? null)) {
        setWebhookDeliveries(parsed.data.items);
        setWebhookDeliveriesCursor(parsed.data.next_cursor ?? null);
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      setDeliveryRead({ key: deliveryContextKey, loading: false, error: apiFailureMessage(response) });
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setDeliveryRead({ key: deliveryContextKey, loading: false, error: apiFailureMessage(response) });
      setMessage(apiFailureMessage(response));
    }
    return null;
  }

  currentWebhooksRefreshRef.current = () => active ? refreshWebhooks(true) : Promise.resolve(null);
  currentDeliveriesRefreshRef.current = () => active ? refreshWebhookDeliveries(() => true, true) : Promise.resolve(null);

  async function loadMoreWebhookDeliveries(): Promise<void> {
    if (webhookDeliveriesCursor === null) return;
    const cursor = webhookDeliveriesCursor;
    const ticket = deliveriesFence.beginLoadMore(cursor);
    if (ticket === null) return;
    let applied = false;
    try {
      const response = await api<{ items: WebhookDelivery[]; next_cursor: string | null }>(withCursor(webhookDeliveriesUrl, cursor));
      if (!deliveriesFence.isLoadMoreCurrent(ticket)) return;
      const parsed = parseExactApiSuccess<{ items: WebhookDelivery[]; next_cursor: string | null }>(response, "webhook_deliveries_listed", hasWebhookDeliveryListData);
      if (parsed !== null) {
        const nextCursor = parsed.data.next_cursor ?? null;
        const appendError = pageAppendError(webhookDeliveries, parsed.data.items, (delivery) => String(delivery.id));
        if (appendError !== null) {
          setMessage(`invalid_api_response (${appendError})`);
          setWebhookDeliveriesCursor((previous) => deliveriesFence.isLoadMoreCurrent(ticket) && previous === cursor ? null : previous);
          deliveriesFence.retireLoadMore(ticket);
        } else if (!deliveriesFence.acceptsNextCursor(ticket, nextCursor)) {
          setMessage("invalid_api_response (repeated_cursor)");
          setWebhookDeliveriesCursor((previous) => deliveriesFence.isLoadMoreCurrent(ticket) && previous === cursor ? null : previous);
          deliveriesFence.retireLoadMore(ticket);
        } else {
          setWebhookDeliveries((previous) => deliveriesFence.isLoadMoreCurrent(ticket) ? [...previous, ...parsed.data.items] : previous);
          setWebhookDeliveriesCursor((previous) => deliveriesFence.isLoadMoreCurrent(ticket) && previous === cursor ? nextCursor : previous);
          applied = true;
          deliveriesFence.finishLoadMore(ticket, true, nextCursor);
        }
      } else {
        setMessage(apiFailureMessage(response));
        if (!isRetryableAppendFailure(response)) {
          setWebhookDeliveriesCursor((previous) => deliveriesFence.isLoadMoreCurrent(ticket) && previous === cursor ? null : previous);
          deliveriesFence.retireLoadMore(ticket);
        }
      }
    } finally {
      if (!applied) deliveriesFence.finishLoadMore(ticket, false);
    }
  }

  useEffect(() => {
    const generation = filterGeneration;
    if (active) void refreshWebhooks(false, () => isFilterGenerationCurrent(generation));
  }, [active, filterGeneration, isFilterGenerationCurrent, webhooksUrl]);

  useEffect(() => {
    const generation = deliveryGeneration;
    if (active) void refreshWebhookDeliveries(() => isDeliveryGenerationCurrent(generation));
  }, [active, deliveryGeneration, isDeliveryGenerationCurrent, webhookDeliveriesUrl]);

  async function submitWebhookCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    const contextGeneration = filterGeneration;
    const formGeneration = webhookFormGeneration;
    const isListCurrent = (): boolean => isFilterGenerationCurrent(contextGeneration);
    const isCurrent = (): boolean =>
      isListCurrent() && isWebhookFormGenerationCurrent(formGeneration);
    let body: ReturnType<typeof normalizeWebhookForm>;
    try {
      body = normalizeWebhookForm(webhookForm);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "invalid_form");
      return;
    }
    const requestBody = JSON.stringify(body);
    await runKeyedMutation({
      request: { method: "POST", path: "/api/admin/webhooks", body: requestBody },
      send: (attempt) => api<WebhookEndpoint>(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (result, phase) => parseMutationResponse(result, "webhook_created", (value): value is WebhookEndpoint => {
        if (!hasWebhookData(value)) return false;
        const endpoint = value as WebhookEndpoint;
        return endpoint.url === body.url && endpoint.status === "active";
      }, mutationFailurePolicies.webhookCreate, phase),
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setMessage(`${parsed.code} (${parsed.requestId})`);
        if (isWebhookFormGenerationCurrent(formGeneration)) setWebhookForm(emptyWebhookForm);
      },
      refresh: async () => await currentWebhooksRefreshRef.current(),
      onUnapplied: (parsed) => {
        if (isCurrent()) {
        setMessage(`${parsed.code} (${parsed.requestId})`);
        }
      },
      isCurrent,
    });
  }

  async function webhookTransition(endpoint: WebhookEndpoint, action: WebhookAction, idempotencyKey: string = crypto.randomUUID()): Promise<ConfirmActionOutcome> {
    const contextGeneration = filterGeneration;
    let reconciliationGeneration = contextGeneration;
    const isCurrent = (): boolean => isFilterGenerationCurrent(reconciliationGeneration);
    const captureRecoveryContext = (): void => {
      if (currentFilterContext() === filterContextKey) {
        reconciliationGeneration = currentFilterGeneration();
      }
    };
    const targetStatus = action === "reenable" ? "active" : "disabled";
    const expectedCode = `webhook_${action}d`;
    const body = JSON.stringify(action === "disable" ? { reason: currentReason() } : {});
    const dataGuard = (value: unknown): value is WebhookEndpoint => hasWebhookTransitionData(value, endpoint.id, targetStatus);
    const refreshStatus = async (): Promise<ExactReadProof | null> => {
      captureRecoveryContext();
      return await currentWebhooksRefreshRef.current();
    };
    const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent).manualRefresh;
    const replay = async (): Promise<ConfirmActionResolution> => {
      captureRecoveryContext();
      const retry = await runMutation(async () => {
        try {
          return await api<unknown>(webhookTransitionPath(endpoint.id, action), {
            method: "POST",
            headers: { "idempotency-key": idempotencyKey },
            body,
          });
        } catch {
          return null;
        }
      }, "recovery");
      if (retry === undefined || retry === null) return "indeterminate";
      const parsed = parseMutationResponse(retry, expectedCode, dataGuard, mutationFailurePolicies.webhookTransition[action], "replay");
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
        return await api<unknown>(webhookTransitionPath(endpoint.id, action), {
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
    const parsed = parseMutationResponse(mutation, expectedCode, dataGuard, mutationFailurePolicies.webhookTransition[action], "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") {
      setMessage(`${parsed.code} (${parsed.requestId})`);
      return { ok: false, message: `${parsed.code} (${parsed.requestId})`, retryable: true };
    }
    setMessage(`${parsed.code} (${parsed.requestId})`);
    setReason("");
    try {
      return (await currentWebhooksRefreshRef.current()) === EXACT_READ_PROOF
        ? { ok: true }
        : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    } catch {
      return confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    }
  }

  async function redriveDelivery(delivery: WebhookDelivery): Promise<void> {
    const contextGeneration = deliveryGeneration;
    const isCurrent = (): boolean => isDeliveryGenerationCurrent(contextGeneration);
    const body = JSON.stringify({});
    await runKeyedMutation({
      request: { method: "POST", path: webhookRedrivePath(String(delivery.id)), body },
      send: (attempt) => api<WebhookDelivery>(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (result, phase) => parseMutationResponse(result, "webhook_delivery_redriven", (value): value is WebhookDelivery => {
        if (!hasWebhookDeliveryData(value)) return false;
        const row = value as WebhookDelivery;
        return row.id === delivery.id && row.status === "pending" && row.attempts === 0;
      }, mutationFailurePolicies.webhookRedrive, phase),
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setMessage(`${parsed.code} (${parsed.requestId})`);
      },
      refresh: async () => await currentDeliveriesRefreshRef.current(),
      onUnapplied: (parsed) => {
        if (isCurrent()) {
        setMessage(`${parsed.code} (${parsed.requestId})`);
        }
      },
      isCurrent,
    });
  }

  const webhooksSettled = webhooksFence.isSettled();
  const deliveriesSettled = deliveriesFence.isSettled();
  const visibleWebhooks = webhooksSettled ? webhooks : [];
  const visibleWebhooksCursor = webhooksFence.canLoadMore() ? webhooksCursor : null;
  const visibleDeliveries = deliveriesSettled ? webhookDeliveries : [];
  const visibleDeliveriesCursor = deliveriesFence.canLoadMore() ? webhookDeliveriesCursor : null;

  if (!active) return null;
  return (
    <section className="listPage">
      <div className="listHeader"><p>Manage event destinations.</p><button className="primary" type="button" disabled={busy} onClick={() => setEditorOpen(true)}>New endpoint</button></div>
      {editorOpen && <aside className="editorLayout">
        <h2>Webhook endpoint</h2>
        <form onSubmit={(event) => void submitWebhookCreate(event)}><fieldset disabled={operationLocked}>
          <label>URL (required)<input required type="url" placeholder="https://hooks.example.com/lcc" value={webhookForm.url} onChange={(event) => setWebhookForm({ ...webhookForm, url: event.target.value })} /></label>
          <label>Event types (csv; blank = all)<input placeholder="entitlement.revoked,customer.disabled" value={webhookForm.event_types} onChange={(event) => setWebhookForm({ ...webhookForm, event_types: event.target.value })} /></label>
          <label>Description<input value={webhookForm.description} onChange={(event) => setWebhookForm({ ...webhookForm, description: event.target.value })} /></label>
          <label>Scope: project (blank = all)<input placeholder="DEFAULT" value={webhookForm.scope_project} onChange={(event) => setWebhookForm({ ...webhookForm, scope_project: event.target.value })} /></label>
          <label>Scope: customer id (blank = all)<input placeholder="cus_..." value={webhookForm.scope_customer_id} onChange={(event) => setWebhookForm({ ...webhookForm, scope_customer_id: event.target.value })} /></label>
          <p className="muted">Set at most one scope dimension. A scoped endpoint receives only matching events; blank = every event.</p>
          <button disabled={busy || operationLocked} type="submit">Create endpoint</button>
        </fieldset></form>
        <button type="button" disabled={busy} onClick={() => requestLeave(() => setEditorOpen(false))}>Close editor</button>
      </aside>}
      <section className="tablePane">
        <ReadNotice label="webhooks" hasData={webhooksFence.isSettled()} loading={readState.key !== filterContextKey || readState.loading} error={readState.key === filterContextKey ? readState.error : null} onRetry={() => void refreshWebhooks()} />
        <div className="filters"><label>Status<select aria-label="Filter endpoints by status" value={webhookFilter.status} onChange={(event) => setWebhookFilter({ status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option></select></label></div>
        <div className="tableScroll" role="region" aria-label="Webhook records" tabIndex={0}><table><caption className="srOnly">Webhook endpoints</caption><thead><tr><th scope="col">URL</th><th scope="col">Events</th><th scope="col">Scope</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Actions</th></tr></thead><tbody>{visibleWebhooks.map((endpoint) => <tr key={endpoint.id} data-focus-row={`webhook:${endpoint.id}`}><td className="mono">{endpoint.url}</td><td>{endpoint.event_types === "" ? "(all)" : endpoint.event_types}</td><td>{endpoint.scope_project !== null && endpoint.scope_project !== "" ? `project:${endpoint.scope_project}` : endpoint.scope_customer_id !== null && endpoint.scope_customer_id !== "" ? `customer:${endpoint.scope_customer_id}` : "(global)"}</td><td><span className={`status ${endpoint.status}`}>{endpoint.status}</span></td><td>{formatEpoch(endpoint.created_at)}</td><td className="actions"><button type="button" disabled={busy || operationLocked} onClick={() => setWebhookDeliveryFilter({ endpoint_id: endpoint.id, status: "" })}>Deliveries</button><StatusActions status={endpoint.status}><button className="danger" disabled={busy || operationLocked || !webhooksFence.canLoadMore() || !canRunWebhookAction(endpoint.status, "disable")} onClick={() => requestConfirm({ title: "Disable webhook", body: disableWebhookConfirm(endpoint), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => webhookTransition(endpoint, "disable", idempotencyKey), successFocusTarget: focusTargetInRow(`webhook:${endpoint.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Disable</button><button data-focus-action="reenable" disabled={busy || operationLocked || !webhooksFence.canLoadMore() || !canRunWebhookAction(endpoint.status, "reenable")} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }: ConfirmActionContext) => webhookTransition(endpoint, "reenable", idempotencyKey), successFocusTarget: focusTargetInRow(`webhook:${endpoint.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Reenable</button></StatusActions></td></tr>)}</tbody></table></div>
        {webhooksFence.isSettled() && visibleWebhooks.length === 0 && <p className="emptyState">No webhooks match this view.</p>}
        <div className="tableFooter"><span className="muted">{webhooksFence.isSettled() ? `${visibleWebhooks.length} shown` : ""}</span>{visibleWebhooksCursor !== null && <button type="button" disabled={busy || operationLocked} onClick={() => void loadMore(webhooksUrl, visibleWebhooksCursor, visibleWebhooks, setWebhooks, setWebhooksCursor, setMessage, hasWebhookListData, "webhooks_listed", webhooksFence, (webhook) => webhook.id)}>Load more</button>}</div>
        <section className="deliveriesPane" aria-label="Recent webhook deliveries">
          <ReadNotice label="deliveries" hasData={deliveriesSettled} loading={deliveryRead.key !== deliveryContextKey || deliveryRead.loading} error={deliveryRead.key === deliveryContextKey ? deliveryRead.error : null} onRetry={() => void refreshWebhookDeliveries()} />
          <h3>Recent deliveries{webhookDeliveryFilter.endpoint_id !== "" ? ` for ${shortHash(webhookDeliveryFilter.endpoint_id)}` : ""}</h3>
          <div className="filters">{webhookDeliveryFilter.endpoint_id !== "" && <button type="button" disabled={busy || operationLocked} onClick={() => setWebhookDeliveryFilter({ endpoint_id: "", status: "" })}>Clear endpoint filter</button>}<label>Delivery status<select aria-label="Filter deliveries by status" value={webhookDeliveryFilter.status} onChange={(event) => setWebhookDeliveryFilter({ ...webhookDeliveryFilter, status: event.target.value })}><option value="">all</option><option value="pending">pending</option><option value="delivered">delivered</option><option value="failed">failed</option></select></label></div>
          <div className="tableScroll" role="region" aria-label="Webhook records" tabIndex={0}><table><caption className="srOnly">Recent webhook deliveries</caption><thead><tr><th scope="col">Time</th><th scope="col">Endpoint</th><th scope="col">Event</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Last</th><th scope="col">Actions</th></tr></thead><tbody>{visibleDeliveries.map((delivery) => <tr key={delivery.id}><td>{formatEpoch(delivery.created_at)}</td><td className="mono">{shortHash(delivery.endpoint_id)}</td><td>{delivery.event_source}.{delivery.event_type}</td><td><span className={`status ${delivery.status}`}>{delivery.status}</span></td><td>{delivery.attempts}</td><td>{delivery.last_status !== 0 ? delivery.last_status : delivery.last_error !== "" ? delivery.last_error : "-"}</td><td className="actions"><button type="button" disabled={busy || operationLocked || !deliveriesFence.canLoadMore() || delivery.status !== "failed"} onClick={() => void redriveDelivery(delivery)}>Redrive</button></td></tr>)}</tbody></table></div>
          <div className="tableFooter"><span className="muted">{deliveriesSettled ? `${visibleDeliveries.length} shown` : ""}</span>{visibleDeliveriesCursor !== null && <button type="button" disabled={busy || operationLocked} onClick={() => void loadMoreWebhookDeliveries()}>Load more</button>}</div>
          {visibleDeliveries.length === 0 && deliveriesSettled && <p className="muted">No deliveries recorded.</p>}
        </section>
      </section>
    </section>
  );
}
