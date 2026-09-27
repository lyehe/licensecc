import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { useAdminNavigation, useNavigationGuard } from "../../app/navigation";
import { StatusActions } from "../../shared/ActionMenu";
import { ReadNotice } from "../../shared/ReadNotice";
import type { WebhookDelivery, WebhookEndpoint } from "../../../shared/api";
import { api, apiFailureDetails, parseExactApiSuccess } from "../../shared/api";
import { confirmMutationUnknown, confirmSuccessWithRefreshFailure, ConfirmRefreshFailure, EXACT_READ_PROOF, focusTargetInRow, type ConfirmActionContext, type ConfirmActionOutcome, type ConfirmActionResolution, type ExactReadProof, useContextGeneration, useOperatorControls } from "../../shared/controls";
import { FormStatus } from "../../shared/FeedbackText";
import { FieldDetails, FieldError, fieldErrorId, fieldProps, useFormFeedback } from "../../shared/fieldErrors";
import { formatEpoch, shortHash } from "../../shared/format";
import { apiFailureFeedback, codeFeedback, failureFeedback, refusalOutcome, validationCode } from "../../shared/messages";
import type { OperatorFeedback } from "../../shared/operatorFeedback";
import { isRetryableAppendFailure, loadMore, pageAppendError, withCursor } from "../../shared/pagination";
import { hasWebhookData, hasWebhookDeliveryData, hasWebhookDeliveryListData, hasWebhookListData, hasWebhookTransitionData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { useDebouncedValue } from "../../shared/useDebouncedValue";
import { useRequestFence } from "../../shared/requestFence";
import { webhookTestOutcome, webhookTestPath, type WebhookTestOutcome } from "./testEvent";
import { canRunWebhookAction, disableWebhookConfirm, emptyWebhookForm, isWebhookEventTypeChecked, normalizeWebhookForm, normalizeWebhookPatch, toggleWebhookEventType, unknownWebhookEventTypes, webhookDeliveriesPath, webhookEventTypesErrorMessage, webhookFieldForCode, webhookFormFromEndpoint, webhookPath, webhookRedrivePath, webhookTransitionPath, webhooksPath, WEBHOOK_EVENT_TYPE_GROUPS, WebhookAction, WebhookDeliveryFilter, WebhookFilter, WebhookFormState } from "./workflow";

const WEBHOOK_FORM = "webhook-editor";

export function Webhooks({ active }: { active: boolean }): React.ReactElement | null {
  const [deliveriesOpen,setDeliveriesOpen]=useState(false);
  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [webhookFilter, setWebhookFilter] = useState<WebhookFilter>({ status: "" });
  const [webhooksCursor, setWebhooksCursor] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  // The endpoint being edited, or null for a new endpoint. Its id is shown but never sent.
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  const [readState, setReadState] = useState<{ key: string; loading: boolean; error: OperatorFeedback | null }>({ key: "", loading: true, error: null });
  const [deliveryRead, setDeliveryRead] = useState<{ key: string; loading: boolean; error: OperatorFeedback | null }>({ key: "", loading: true, error: null });
  const [webhookForm, setWebhookForm] = useState<WebhookFormState>(emptyWebhookForm);
  // The form as loaded from the endpoint (or emptyWebhookForm for a new one). Kept as the actual
  // WebhookFormState -- not a JSON string -- so a PATCH can diff field-by-field and omit anything
  // unchanged (see normalizeWebhookPatch): webhook_endpoints.event_types has no database CHECK, so
  // an existing row's legacy token must never be re-validated just because some OTHER field changed.
  const [baseline, setBaseline] = useState<WebhookFormState>(emptyWebhookForm);
  const [webhookDeliveries, setWebhookDeliveries] = useState<WebhookDelivery[]>([]);
  const [webhookDeliveriesCursor, setWebhookDeliveriesCursor] = useState<string | null>(null);
  const [webhookDeliveryFilter, setWebhookDeliveryFilter] = useState<WebhookDeliveryFilter>({ endpoint_id: "", status: "" });
  // The latest "Send test event" result, keyed by a counter so each new result renders collapsed.
  const [testResult, setTestResult] = useState<(WebhookTestOutcome & { url: string; key: number }) | null>(null);
  const { busy: requestBusy, operationLocked, currentReason, requestConfirm, runConsequenceAction, runKeyedMutation, runMutation, setFeedback, setReason } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const { routeVersion } = useAdminNavigation();
  const formFeedback = useFormFeedback(WEBHOOK_FORM, routeVersion);
  const { requestLeave } = useNavigationGuard({ when: active && editorOpen && JSON.stringify(webhookForm) !== JSON.stringify(baseline), onDiscard: () => closeEditor() });
  const webhooksUrl = useMemo(() => webhooksPath(webhookFilter), [webhookFilter]);
  // The filter alone reloads the endpoint list; active only gates whether a reload may fire, so
  // leaving and returning to this tab with the filter unchanged costs zero requests. The debounce
  // runs over the generation number, not the filter itself: a filter that returns to an earlier
  // value within one debounce window (A -> B -> A) still must reload, and debouncing the value
  // would collapse that back to a value React already holds, silently dropping the reload.
  const filterContextKey = `${webhookFilter.status}`;
  const { generation: filterGeneration, isCurrent: isFilterGenerationCurrent, currentGeneration: currentFilterGeneration, currentContext: currentFilterContext } = useContextGeneration(filterContextKey);
  const webhooksReloadGeneration = useDebouncedValue(filterGeneration, 300);
  const lastRequestedWebhooksGeneration = useRef<number | null>(null);
  const webhookFormContextKey = JSON.stringify(webhookForm);
  const { generation: webhookFormGeneration, isCurrent: isWebhookFormGenerationCurrent } = useContextGeneration(webhookFormContextKey);
  const webhookDeliveriesUrl = useMemo(() => webhookDeliveriesPath(webhookDeliveryFilter), [webhookDeliveryFilter]);
  const deliveryContextKey = `${active ? "active" : "inactive"}\u0000${webhookDeliveryFilter.endpoint_id}\u0000${webhookDeliveryFilter.status}`;
  const { generation: deliveryGeneration, isCurrent: isDeliveryGenerationCurrent } = useContextGeneration(deliveryContextKey);
  const webhooksFence = useRequestFence(webhooksUrl);
  const deliveriesFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${webhookDeliveriesUrl}`);
  // A mutation/form context may have moved by the time a known-success GET
  // recovery runs.  These refs intentionally dereference the current rendered
  // reader; the reader itself remains fenced to that current filter snapshot.
  const currentWebhooksRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));
  const currentDeliveriesRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));
  // A test result describes the endpoint list it was sent from: another filter or page drops it, and a
  // result that arrives after such a change is not shown at all.
  const { generation: testGeneration, isCurrent: isTestGenerationCurrent } = useContextGeneration(`${filterContextKey}\u0000${routeVersion}`);
  useEffect(() => { setTestResult(null); }, [testGeneration]);

  function openEditor(next: WebhookFormState, target: WebhookEndpoint | null): void {
    formFeedback.clear();
    setEditing(target);
    setWebhookForm(next);
    setBaseline(next);
    setEditorOpen(true);
  }

  function closeEditor(): void {
    formFeedback.clear();
    setEditorOpen(false);
    setEditing(null);
    setWebhookForm(emptyWebhookForm);
    setBaseline(emptyWebhookForm);
  }

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
      setReadState({ key: filterContextKey, loading: false, error: apiFailureFeedback(response) });
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setReadState({ key: filterContextKey, loading: false, error: apiFailureFeedback(response) });
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
      setDeliveryRead({ key: deliveryContextKey, loading: false, error: apiFailureFeedback(response) });
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setDeliveryRead({ key: deliveryContextKey, loading: false, error: apiFailureFeedback(response) });
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
          setFeedback(codeFeedback(appendError));
          setWebhookDeliveriesCursor((previous) => deliveriesFence.isLoadMoreCurrent(ticket) && previous === cursor ? null : previous);
          deliveriesFence.retireLoadMore(ticket);
        } else if (!deliveriesFence.acceptsNextCursor(ticket, nextCursor)) {
          setFeedback(codeFeedback("repeated_cursor"));
          setWebhookDeliveriesCursor((previous) => deliveriesFence.isLoadMoreCurrent(ticket) && previous === cursor ? null : previous);
          deliveriesFence.retireLoadMore(ticket);
        } else {
          setWebhookDeliveries((previous) => deliveriesFence.isLoadMoreCurrent(ticket) ? [...previous, ...parsed.data.items] : previous);
          setWebhookDeliveriesCursor((previous) => deliveriesFence.isLoadMoreCurrent(ticket) && previous === cursor ? nextCursor : previous);
          applied = true;
          deliveriesFence.finishLoadMore(ticket, true, nextCursor);
        }
      } else {
        setFeedback(apiFailureFeedback(response));
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
    if (!active || lastRequestedWebhooksGeneration.current === webhooksReloadGeneration) return;
    lastRequestedWebhooksGeneration.current = webhooksReloadGeneration;
    void refreshWebhooks(false, () => isFilterGenerationCurrent(webhooksReloadGeneration));
  }, [active, webhooksReloadGeneration, isFilterGenerationCurrent]);

  useEffect(() => {
    const generation = deliveryGeneration;
    if (active) void refreshWebhookDeliveries(() => isDeliveryGenerationCurrent(generation));
  }, [active, deliveryGeneration, isDeliveryGenerationCurrent, webhookDeliveriesUrl]);

  /** A refused save: the event type list names the allowed types; any other code goes where it belongs. */
  function showRefusal(parsed: { code: string; requestId: string; data?: unknown }): void {
    const eventTypes = parsed.code === "invalid_event_types" ? webhookEventTypesErrorMessage(parsed.data) : null;
    if (eventTypes === null) formFeedback.show(parsed.code, parsed.requestId, webhookFieldForCode);
    else formFeedback.showFields({ event_types: eventTypes }, { code: parsed.code, requestId: parsed.requestId });
  }

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
      formFeedback.show(validationCode(error), null, webhookFieldForCode);
      return;
    }
    formFeedback.clear();
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
        setFeedback(codeFeedback(parsed.code, parsed.requestId));
        // The new endpoint opens in its editor, showing what was saved (also after a reconciled replay).
        if (isWebhookFormGenerationCurrent(formGeneration)) openEditor(webhookFormFromEndpoint(parsed.data), parsed.data);
      },
      refresh: async () => await currentWebhooksRefreshRef.current(),
      onUnapplied: (parsed) => {
        if (isCurrent()) showRefusal(parsed);
      },
      isCurrent,
    });
  }

  async function submitWebhookPatch(event: FormEvent, endpoint: WebhookEndpoint): Promise<void> {
    event.preventDefault();
    const contextGeneration = filterGeneration;
    const formGeneration = webhookFormGeneration;
    const isCurrent = (): boolean => isFilterGenerationCurrent(contextGeneration) && isWebhookFormGenerationCurrent(formGeneration);
    let body: ReturnType<typeof normalizeWebhookPatch>;
    try {
      body = normalizeWebhookPatch(webhookForm, baseline);
    } catch (error) {
      formFeedback.show(validationCode(error), null, webhookFieldForCode);
      return;
    }
    formFeedback.clear();
    await runKeyedMutation({
      request: { method: "PATCH", path: webhookPath(endpoint.id), body: JSON.stringify(body) },
      send: (attempt) => api<WebhookEndpoint>(attempt.path, { method: attempt.method, headers: { "idempotency-key": attempt.idempotencyKey }, body: attempt.body }),
      parse: (result, phase) => parseMutationResponse(result, "webhook_patched", (value): value is WebhookEndpoint => {
        if (!hasWebhookData(value)) return false;
        const row = value as WebhookEndpoint;
        return row.id === endpoint.id;
      }, mutationFailurePolicies.webhookPatch, phase),
      onApplied: async (parsed) => {
        if (!isCurrent()) return;
        setFeedback(codeFeedback(parsed.code, parsed.requestId));
        closeEditor();
      },
      refresh: async () => await currentWebhooksRefreshRef.current(),
      onUnapplied: (parsed) => {
        if (isCurrent()) showRefusal(parsed);
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
    if (mutation === undefined) return refusalOutcome("mutation_busy", null);
    if (mutation === null) return confirmMutationUnknown(reconciliation);
    const parsed = parseMutationResponse(mutation, expectedCode, dataGuard, mutationFailurePolicies.webhookTransition[action], "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") return refusalOutcome(parsed.code, parsed.requestId);
    setFeedback(codeFeedback(parsed.code, parsed.requestId));
    setReason("");
    try {
      return (await currentWebhooksRefreshRef.current()) === EXACT_READ_PROOF
        ? { ok: true }
        : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    } catch {
      return confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    }
  }

  // A diagnostic, not a state change: the backend signs and sends one test event and reports only
  // the receiver's status class. It holds the operation gate while in flight but needs no
  // idempotency key; the backend allows one test per endpoint per minute.
  async function sendTestEvent(endpoint: WebhookEndpoint): Promise<void> {
    const generation = testGeneration;
    const response = await runMutation(() => api<unknown>(webhookTestPath(endpoint.id), { method: "POST", body: "{}" }));
    if (response === undefined || !isTestGenerationCurrent(generation)) return;
    setTestResult((previous) => ({ ...webhookTestOutcome(response), url: endpoint.url, key: (previous?.key ?? 0) + 1 }));
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
        setFeedback(codeFeedback(parsed.code, parsed.requestId));
      },
      refresh: async () => await currentDeliveriesRefreshRef.current(),
      onUnapplied: (parsed) => {
        if (isCurrent()) setFeedback(failureFeedback(parsed.code, parsed.requestId));
      },
      isCurrent,
    });
  }

  const deliveriesSettled = deliveriesFence.isSettled();
  // The previous endpoint rows stay on screen through a reload; the table below is marked
  // aria-busy instead of being emptied.
  const visibleWebhooks = webhooks;
  const visibleWebhooksCursor = webhooksFence.canLoadMore() ? webhooksCursor : null;
  const webhooksLoading = readState.key !== filterContextKey || readState.loading;
  const visibleDeliveries = deliveriesSettled ? webhookDeliveries : [];
  const visibleDeliveriesCursor = deliveriesFence.canLoadMore() ? webhookDeliveriesCursor : null;

  if (!active) return null;
  const editorTitle = editing === null ? "New webhook endpoint" : "Edit webhook endpoint";
  // webhook_endpoints.event_types has no database CHECK, so an existing row can already hold a
  // token outside today's closed set (e.g. a legacy value, or one from before a source's list
  // changed). The checkboxes can only represent known tokens, so name any others explicitly
  // instead of ever dropping them from view without saying so.
  const legacyEventTypes = unknownWebhookEventTypes(webhookForm.event_types);
  const field = (name: keyof WebhookFormState, label: string) => fieldProps(WEBHOOK_FORM, formFeedback.errors, name, label);
  const error = (name: keyof WebhookFormState) => <FieldError form={WEBHOOK_FORM} field={name} errors={formFeedback.errors} />;
  const details = (name: keyof WebhookFormState) => <FieldDetails field={name} feedback={formFeedback} />;
  const update = (name: keyof WebhookFormState, value: string): void => { formFeedback.clearField(name); setWebhookForm((current) => ({ ...current, [name]: value })); };
  const eventTypesInvalid = Object.hasOwn(formFeedback.errors, "event_types");
  return (
    <section className="listPage">
      <div className="listHeader"><button className="primary" type="button" disabled={busy} onClick={() => { if (!editorOpen || editing !== null) requestLeave(() => openEditor(emptyWebhookForm, null)); }}>New endpoint</button></div>
      {editorOpen && <aside className="editorLayout">
        <h2>{editorTitle}</h2>
        <form id={WEBHOOK_FORM} aria-label={editorTitle} onSubmit={(event) => void (editing === null ? submitWebhookCreate(event) : submitWebhookPatch(event, editing))}><fieldset disabled={operationLocked}>
          <label>URL (required)<input required type="url" placeholder="https://hooks.example.com/lcc" {...field("url", "URL (required)")} value={webhookForm.url} onChange={(event) => update("url", event.target.value)} />{error("url")}</label>{details("url")}
          <div className="eventTypesGroup" role="group" aria-label="Event types" data-field="event_types" tabIndex={-1} aria-invalid={eventTypesInvalid || undefined} aria-describedby={eventTypesInvalid ? fieldErrorId(WEBHOOK_FORM, "event_types") : undefined}>
            <p className="muted">Event types (blank = all)</p>
            {WEBHOOK_EVENT_TYPE_GROUPS.map((group) => <fieldset className="trialPanel" key={group.source}>
              <legend>{group.label}</legend>
              {group.tokens.map((token) => <label className="checkboxRow" key={token}>
                <input
                  type="checkbox"
                  aria-label={`${group.label} ${token}`}
                  checked={isWebhookEventTypeChecked(webhookForm.event_types, token)}
                  onChange={(event) => update("event_types", toggleWebhookEventType(webhookForm.event_types, token, event.target.checked))}
                />
                {token}
              </label>)}
            </fieldset>)}
            <p className="muted">"disable" and "reenable" match both entitlement and customer events — checking either box selects the same filter for both sources.</p>
            {legacyEventTypes.length > 0 && <p className="muted" role="note">Legacy event types not in the current list: {legacyEventTypes.join(", ")}. Changing event types will remove them.</p>}
            {error("event_types")}
          </div>{details("event_types")}
          <label>Description<input {...field("description", "Description")} value={webhookForm.description} onChange={(event) => update("description", event.target.value)} />{error("description")}</label>{details("description")}
          <label>Scope: project (blank = all)<input placeholder="DEFAULT" {...field("scope_project", "Scope: project (blank = all)")} value={webhookForm.scope_project} onChange={(event) => update("scope_project", event.target.value)} />{error("scope_project")}</label>{details("scope_project")}
          <label>Scope: customer id (blank = all)<input placeholder="cus_..." {...field("scope_customer_id", "Scope: customer id (blank = all)")} value={webhookForm.scope_customer_id} onChange={(event) => update("scope_customer_id", event.target.value)} />{error("scope_customer_id")}</label>{details("scope_customer_id")}
          <p className="muted">Set at most one scope dimension. A scoped endpoint receives only matching events; blank = every event.</p>
          <FormStatus feedback={formFeedback.status} />
          <button disabled={busy || operationLocked} type="submit">{editing === null ? "Create endpoint" : "Save changes"}</button>
        </fieldset></form>
        <button type="button" disabled={busy} onClick={() => requestLeave(closeEditor)}>Close editor</button>
      </aside>}
      <section className="tablePane">
        <ReadNotice label="webhooks" hasData={webhooksFence.isSettled()} loading={webhooksLoading} error={readState.key === filterContextKey ? readState.error : null} onRetry={() => void refreshWebhooks()} />
        <div role="status" aria-live="polite">{testResult !== null && <div key={testResult.key} className="activityMessage" data-tone={testResult.tone}>
          <p><strong>Test event to {testResult.url}:</strong> {testResult.sentence}</p>
          <details><summary>Technical details</summary><p className="mono">{testResult.code} · {testResult.requestId}</p></details>
        </div>}</div>
        <div className="filters"><label>Status<select aria-label="Filter endpoints by status" value={webhookFilter.status} onChange={(event) => setWebhookFilter({ status: event.target.value })}><option value="">all</option><option value="active">active</option><option value="disabled">disabled</option></select></label></div>
        <div className="tableScroll" role="region" aria-label="Webhook records" tabIndex={0} aria-busy={webhooksLoading}><table><caption className="srOnly">Webhook endpoints</caption><thead><tr><th scope="col">URL</th><th scope="col">Events</th><th scope="col">Scope</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Actions</th></tr></thead><tbody>{visibleWebhooks.map((endpoint) => <tr key={endpoint.id} data-focus-row={`webhook:${endpoint.id}`}><td className="mono">{endpoint.url}</td><td>{endpoint.event_types === "" ? "(all)" : endpoint.event_types}</td><td>{endpoint.scope_project !== null && endpoint.scope_project !== "" ? `project:${endpoint.scope_project}` : endpoint.scope_customer_id !== null && endpoint.scope_customer_id !== "" ? `customer:${endpoint.scope_customer_id}` : "(global)"}</td><td><span className={`status ${endpoint.status}`}>{endpoint.status}</span></td><td>{formatEpoch(endpoint.created_at)}</td><td className="actions"><button type="button" disabled={busy || operationLocked} onClick={() => { setDeliveriesOpen(true); setWebhookDeliveryFilter({ endpoint_id: endpoint.id, status: "" }); }}>Deliveries</button><button type="button" disabled={busy || operationLocked || !webhooksFence.canLoadMore()} onClick={() => requestLeave(() => openEditor(webhookFormFromEndpoint(endpoint), endpoint))}>Edit</button><button type="button" disabled={busy || operationLocked || !webhooksFence.canLoadMore() || endpoint.status !== "active"} onClick={() => void sendTestEvent(endpoint)}>Send test event</button><StatusActions status={endpoint.status}><button className="danger" disabled={busy || operationLocked || !webhooksFence.canLoadMore() || !canRunWebhookAction(endpoint.status, "disable")} onClick={() => requestConfirm({ title: "Disable webhook", body: disableWebhookConfirm(endpoint), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => webhookTransition(endpoint, "disable", idempotencyKey), successFocusTarget: focusTargetInRow(`webhook:${endpoint.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Disable</button><button data-focus-action="reenable" disabled={busy || operationLocked || !webhooksFence.canLoadMore() || !canRunWebhookAction(endpoint.status, "reenable")} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }: ConfirmActionContext) => webhookTransition(endpoint, "reenable", idempotencyKey), successFocusTarget: focusTargetInRow(`webhook:${endpoint.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isFilterGenerationCurrent(filterGeneration) })}>Reenable</button></StatusActions></td></tr>)}</tbody></table></div>
        {webhooksFence.isSettled() && visibleWebhooks.length === 0 && <p className="emptyState">No webhooks match this view.</p>}
        <div className="tableFooter"><span className="muted">{webhooksFence.isSettled() ? `${visibleWebhooks.length} shown` : ""}</span>{visibleWebhooksCursor !== null && <button type="button" disabled={busy || operationLocked} onClick={() => void loadMore(webhooksUrl, visibleWebhooksCursor, visibleWebhooks, setWebhooks, setWebhooksCursor, setFeedback, hasWebhookListData, "webhooks_listed", webhooksFence, (webhook) => webhook.id)}>Load more</button>}</div>
        <details role="region" aria-label="Recent webhook deliveries" className="deliveriesPane" open={deliveriesOpen} onToggle={event=>setDeliveriesOpen(event.currentTarget.open)}><summary>Recent deliveries{webhookDeliveryFilter.endpoint_id !== "" ? ` for ${shortHash(webhookDeliveryFilter.endpoint_id)}` : ""}</summary>
          <ReadNotice label="deliveries" hasData={deliveriesSettled} loading={deliveryRead.key !== deliveryContextKey || deliveryRead.loading} error={deliveryRead.key === deliveryContextKey ? deliveryRead.error : null} onRetry={() => void refreshWebhookDeliveries()} />
          <div className="filters">{webhookDeliveryFilter.endpoint_id !== "" && <button type="button" disabled={busy || operationLocked} onClick={() => setWebhookDeliveryFilter({ endpoint_id: "", status: "" })}>Clear endpoint filter</button>}<label>Delivery status<select aria-label="Filter deliveries by status" value={webhookDeliveryFilter.status} onChange={(event) => setWebhookDeliveryFilter({ ...webhookDeliveryFilter, status: event.target.value })}><option value="">all</option><option value="pending">pending</option><option value="delivered">delivered</option><option value="failed">failed</option></select></label></div>
          <div className="tableScroll" role="region" aria-label="Webhook records" tabIndex={0}><table><caption className="srOnly">Recent webhook deliveries</caption><thead><tr><th scope="col">Time</th><th scope="col">Endpoint</th><th scope="col">Event</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Last</th><th scope="col">Actions</th></tr></thead><tbody>{visibleDeliveries.map((delivery) => <tr key={delivery.id}><td>{formatEpoch(delivery.created_at)}</td><td className="mono">{shortHash(delivery.endpoint_id)}</td><td>{delivery.event_source}.{delivery.event_type}</td><td><span className={`status ${delivery.status}`}>{delivery.status}</span></td><td>{delivery.attempts}</td><td>{delivery.last_status !== 0 ? delivery.last_status : delivery.last_error !== "" ? delivery.last_error : "-"}</td><td className="actions"><button type="button" disabled={busy || operationLocked || !deliveriesFence.canLoadMore() || delivery.status !== "failed"} onClick={() => void redriveDelivery(delivery)}>Retry delivery</button></td></tr>)}</tbody></table></div>
          <div className="tableFooter"><span className="muted">{deliveriesSettled ? `${visibleDeliveries.length} shown` : ""}</span>{visibleDeliveriesCursor !== null && <button type="button" disabled={busy || operationLocked} onClick={() => void loadMoreWebhookDeliveries()}>Load more</button>}</div>
          {visibleDeliveries.length === 0 && deliveriesSettled && <p className="muted">No deliveries recorded.</p>}
        </details>
      </section>
    </section>
  );
}
