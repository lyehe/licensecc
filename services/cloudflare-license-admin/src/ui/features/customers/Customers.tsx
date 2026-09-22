import { CustomerAccess } from "./CustomerAccess";
import { ProtectedConnections } from "./ProtectedConnections";
import { AddUser } from "./AddUser";
import React, { useEffect, useMemo, useRef, useState } from "react";

import { useAdminNavigation } from "../../app/navigation";
import type { CustomerSection, NavigationIntent } from "../../app/types";
import { api, apiFailureDetails, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { confirmMutationUnknown, confirmSuccessWithRefreshFailure, ConfirmRefreshFailure, EXACT_READ_PROOF, focusTargetInRow, type ConfirmActionContext, type ConfirmActionOutcome, type ConfirmActionResolution, type ExactReadProof, useContextGeneration, useOperatorControls } from "../../shared/controls";
import { formatEpoch, shortHash } from "../../shared/format";
import { hasCustomerDetailData, hasCustomerListData, hasCustomerTransitionData, mutationFailurePolicies, parseMutationResponse } from "../../shared/mutationGuards";
import { downloadCsv, loadMore } from "../../shared/pagination";
import { useRequestFence } from "../../shared/requestFence";
import { canRunCustomerAction, customerDetailPath, customerTransitionPath, customersPath, CustomerListFilter, disableCustomerConfirm } from "./workflow";

interface CustomerListItem {
  id: string;
  name: string;
  email: string;
  login_email?: string | null;
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
    login_email?: string | null;
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

const customerSections: ReadonlyArray<CustomerSection> = ["access", "history", "tokens"];

function customerDisplayName(customer: Pick<CustomerListItem, "id" | "name" | "email">): string {
  return customer.name.trim() || customer.email.trim() || customer.id;
}

function readableScopes(scopes: string): string {
  try {
    const parsed: unknown = JSON.parse(scopes);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([key, value]) => `${key.replaceAll("_", " ")}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
        .join(" · ") || "No scopes recorded";
    }
  } catch {
    // Older records can contain a non-JSON scope representation. Keep it readable.
  }
  return scopes || "No scopes recorded";
}

function safeMetadata(metadata: string): string {
  try {
    return JSON.stringify(JSON.parse(metadata), null, 2);
  } catch {
    return metadata || "No metadata recorded";
  }
}

export function Customers({ active, navigationIntent, onNavigationHandled }: {
  active: boolean;
  navigationIntent: NavigationIntent | null;
  onNavigationHandled: (intent: NavigationIntent) => void;
}): React.ReactElement | null {
  const [customersSnapshot, setCustomers] = useState<CustomerListItem[]>([]);
  const [addingUser, setAddingUser] = useState(false);
  const [customerFilter, setCustomerFilter] = useState<CustomerListFilter>({ status: "", q: "" });
  const [customersCursorSnapshot, setCustomersCursor] = useState<string | null>(null);
  const [customerDetailSnapshot, setCustomerDetail] = useState<CustomerDetail | null>(null);
  const [listFailure, setListFailure] = useState<string | null>(null);
  const [detailFailure, setDetailFailure] = useState<"failed" | "not-found" | null>(null);
  const { selectedCustomerId, customerSection, openCustomer, showCustomerList, setCustomerSection, navigate, rememberFilters } = useAdminNavigation();
  const { busy: requestBusy, operationLocked, currentReason, requestConfirm, runConsequenceAction, runMutation, setMessage, setReason } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const customersUrl = useMemo(() => customersPath(customerFilter), [customerFilter]);
  const filterContextKey = `${active ? "active" : "inactive"}\u0000${customerFilter.status}\u0000${customerFilter.q}`;
  const { generation: filterGeneration, isCurrent: isFilterGenerationCurrent } = useContextGeneration(filterContextKey);
  const customerContextKey = `${filterContextKey}\u0000${selectedCustomerId ?? ""}`;
  const { generation: customerGeneration, isCurrent: isCustomerGenerationCurrent, currentGeneration: currentCustomerGeneration, currentContext: currentCustomerContext } = useContextGeneration(customerContextKey);
  const customersFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${customersUrl}`);
  const customerDetailFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${customerContextKey}`);
  const currentCustomerRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));

  async function loadCustomerDetail(id: string, strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    const ticket = customerDetailFence.begin();
    const response = await api<CustomerDetail>(customerDetailPath(id));
    if (!isCurrent() || !customerDetailFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<CustomerDetail>(response, "customer", (value) => hasCustomerDetailData(value, id));
    if (parsed !== null) {
      if (customerDetailFence.settle(ticket)) {
        setCustomerDetail(parsed.data);
        setDetailFailure(null);
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setCustomerDetail(null);
      setDetailFailure(apiFailureDetails(response).code === "not_found" ? "not-found" : "failed");
      setMessage(apiFailureMessage(response));
    }
    return null;
  }

  async function refreshCustomers(strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    const ticket = customersFence.begin();
    const response = await api<{ items: CustomerListItem[]; next_cursor: string | null }>(customersUrl);
    if (!isCurrent() || !customersFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<{ items: CustomerListItem[]; next_cursor: string | null }>(response, "customers_listed", hasCustomerListData);
    if (parsed !== null) {
      if (customersFence.settle(ticket, parsed.data.next_cursor ?? null)) {
        setCustomers(parsed.data.items);
        setCustomersCursor(parsed.data.next_cursor ?? null);
        setListFailure(null);
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setListFailure(apiFailureMessage(response));
      setMessage(apiFailureMessage(response));
    }
    return null;
  }

  currentCustomerRefreshRef.current = async () => {
    if (!active) return null;
    // A retained transition can be reconciled after its detail view closes.
    // Prove the current list, or both current detail and list when selected.
    if (selectedCustomerId !== null && (await loadCustomerDetail(selectedCustomerId, true)) !== EXACT_READ_PROOF) return null;
    return await refreshCustomers(true);
  };

  useEffect(() => {
    if (navigationIntent?.tab !== "customers") return;
    if (navigationIntent.selectCustomerId !== undefined) {
      setDetailFailure(null);
    } else {
      setCustomerFilter({ status: navigationIntent.filter.status ?? "", q: navigationIntent.filter.q ?? "" });
    }
    onNavigationHandled(navigationIntent);
  }, [navigationIntent, onNavigationHandled]);

  useEffect(() => {
    if (!active || selectedCustomerId !== null || navigationIntent?.tab === "customers") return;
    rememberFilters("customers", { ...customerFilter });
  }, [active, customerFilter, navigationIntent, rememberFilters, selectedCustomerId]);

  useEffect(() => {
    const generation = filterGeneration;
    if (active) {
      setListFailure(null);
      void refreshCustomers(false, () => isFilterGenerationCurrent(generation));
    }
  }, [active, customersUrl, filterGeneration, isFilterGenerationCurrent]);

  useEffect(() => {
    const generation = customerGeneration;
    if (active && selectedCustomerId !== null) {
      setDetailFailure(null);
      void loadCustomerDetail(selectedCustomerId, false, () => isCustomerGenerationCurrent(generation));
    }
  }, [active, customerGeneration, isCustomerGenerationCurrent, selectedCustomerId]);

  function selectCustomer(id: string): void {
    setCustomerDetail(null);
    setDetailFailure(null);
    openCustomer(id);
    if (id === selectedCustomerId) void loadCustomerDetail(id);
  }

  function returnToList(): void {
    setCustomerDetail(null);
    setDetailFailure(null);
    showCustomerList();
  }

  async function customerTransition(action: "disable" | "reenable", idempotencyKey: string = crypto.randomUUID()): Promise<ConfirmActionOutcome> {
    if (selectedCustomerId === null) return { ok: false, message: "customer_not_selected" };
    const id = selectedCustomerId;
    const contextGeneration = customerGeneration;
    let reconciliationGeneration = contextGeneration;
    const isCurrent = (): boolean => isCustomerGenerationCurrent(reconciliationGeneration);
    const captureRecoveryContext = (): void => {
      if (currentCustomerContext() === customerContextKey) {
        reconciliationGeneration = currentCustomerGeneration();
      }
    };
    const targetStatus = action === "reenable" ? "active" : "disabled";
    const expectedCode = `customer_${action}d`;
    const body = JSON.stringify(action === "disable" ? { reason: currentReason() } : {});
    const dataGuard = (value: unknown): value is CustomerListItem => hasCustomerTransitionData(value, id, targetStatus);
    const refreshStatus = async (): Promise<ExactReadProof | null> => {
      captureRecoveryContext();
      return await currentCustomerRefreshRef.current();
    };
    const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent).manualRefresh;
    const replay = async (): Promise<ConfirmActionResolution> => {
      captureRecoveryContext();
      const retry = await runMutation(async () => {
        try {
          return await api<unknown>(customerTransitionPath(id, action), {
            method: "POST",
            headers: { "idempotency-key": idempotencyKey },
            body,
          });
        } catch {
          return null;
        }
      }, "recovery");
      if (retry === undefined || retry === null) return "indeterminate";
      const parsed = parseMutationResponse(retry, expectedCode, dataGuard, mutationFailurePolicies.customerTransition[action], "replay");
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
        return await api<unknown>(customerTransitionPath(id, action), {
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
    const parsed = parseMutationResponse(mutation, expectedCode, dataGuard, mutationFailurePolicies.customerTransition[action], "initial");
    if (parsed.kind === "invalid") return confirmMutationUnknown(reconciliation);
    if (parsed.kind === "failure") {
      setMessage(`${parsed.code} (${parsed.requestId})`);
      return { ok: false, message: `${parsed.code} (${parsed.requestId})`, retryable: true };
    }
    setMessage(`${parsed.code} (${parsed.requestId})`);
    setReason("");
    try {
      return (await refreshStatus()) === EXACT_READ_PROOF
        ? { ok: true }
        : confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    } catch {
      return confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
    }
  }

  const customers = customersFence.isSettled() ? customersSnapshot : [];
  const customersCursor = customersFence.canLoadMore() ? customersCursorSnapshot : null;
  const customerDetail = customerDetailFence.isSettled() ? customerDetailSnapshot : null;

  if (!active) return null;

  const listLoading = !customersFence.isSettled() && listFailure === null;
  const listUpdating = customersFence.isSettled() && !customersFence.canLoadMore();
  const detailLoading = selectedCustomerId !== null && !customerDetailFence.isSettled() && detailFailure === null;
  const sectionLabel: Record<CustomerSection, string> = {
    overview: "Apps & access", access: "Apps & access", licenses: "Apps & access",
    tokens: "Account", orders: "Activity", history: "Activity",
  };
  const primarySection = customerSection === "overview" || customerSection === "licenses" ? "access"
    : customerSection === "orders" ? "history" : customerSection;
  if (selectedCustomerId !== null) {
    return (
      <section className="recordDetail listPage" aria-labelledby="customer-detail-title">
        <button className="backLink" type="button" onClick={returnToList}><span aria-hidden="true">←</span>Back to customers</button>
        <header className="detailHeader customerHeader" data-focus-row={customerDetail === null ? undefined : `customer:${customerDetail.customer.id}`}>
          {detailLoading && <p className="readState" role="status">Loading customer…</p>}
          {detailFailure === "not-found" && <div className="readState error" role="alert"><p>Customer not found.</p><button type="button" onClick={returnToList}>Return to customers</button></div>}
          {detailFailure === "failed" && <div className="readState error" role="alert"><p>Could not load this customer.</p><button type="button" onClick={() => void loadCustomerDetail(selectedCustomerId)}>Retry</button></div>}
          {customerDetail !== null && <>
            <div className="customerIdentity">
              <div className="customerTitle"><h2 id="customer-detail-title">{customerDisplayName(customerDetail.customer)}</h2><span className={`status ${customerDetail.customer.status}`}>{customerDetail.customer.status}</span></div>
              <p>{customerDetail.customer.email || customerDetail.customer.id}</p>
            </div>
            <div className="actions customerActions" data-status={customerDetail.customer.status}>
                <button className="danger" disabled={busy || !customerDetailFence.canLoadMore() || !canRunCustomerAction(customerDetail.customer.status, "disable")} onClick={() => requestConfirm({ title: "Disable customer", body: disableCustomerConfirm(customerDetail.customer), requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => customerTransition("disable", idempotencyKey), successFocusTarget: focusTargetInRow(`customer:${customerDetail.customer.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isCustomerGenerationCurrent(customerGeneration) })}>Disable</button>
                <button data-focus-action="reenable" disabled={busy || !customerDetailFence.canLoadMore() || !canRunCustomerAction(customerDetail.customer.status, "reenable")} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }: ConfirmActionContext) => customerTransition("reenable", idempotencyKey), successFocusTarget: focusTargetInRow(`customer:${customerDetail.customer.id}`, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: () => isCustomerGenerationCurrent(customerGeneration) })}>Reenable</button>
            </div>
          </>}
        </header>
        {customerDetail !== null && <>
          <nav className="sectionTabs" aria-label="Customer detail sections">
            {customerSections.map((section) => <button type="button" key={section} className={primarySection === section ? "active" : ""} aria-current={primarySection === section ? "page" : undefined} onClick={() => setCustomerSection(section)}>{sectionLabel[section]}</button>)}
          </nav>
          {primarySection === "access" && <div className="actions"><button type="button" onClick={() => setCustomerSection(customerSection === "licenses" ? "access" : "licenses")}>{customerSection === "licenses" ? "Back to app access" : "Issued license records"}</button></div>}
          {primarySection === "history" && <div className="actions"><button type="button" onClick={() => setCustomerSection(customerSection === "orders" ? "history" : "orders")}>{customerSection === "orders" ? "Back to activity" : "Orders"}</button></div>}
          {customerSection === "tokens" && <section className="customerAccountDetails">
            {customerDetail.customer.login_email && <p>Login email: {customerDetail.customer.login_email}</p>}
            <details><summary>Technical details</summary><dl className="recordMeta"><div><dt>Customer ID</dt><dd><code>{customerDetail.customer.id}</code></dd></div><div><dt>External reference</dt><dd>{customerDetail.customer.external_ref || "—"}</dd></div><div><dt>Created</dt><dd>{formatEpoch(customerDetail.customer.created_at)}</dd></div><div><dt>Updated</dt><dd>{formatEpoch(customerDetail.customer.updated_at)}</dd></div></dl><pre>{safeMetadata(customerDetail.customer.metadata_json)}</pre></details>
          </section>}
          {(customerSection === "access" || customerSection === "overview") && <CustomerAccess key={customerDetail.customer.id} customerId={customerDetail.customer.id} />}
          {customerSection === "licenses" && <DetailTable caption="Customer licenses" empty="No licenses are shown for this customer." limit="100" headers={["License", "Project", "Label", "Created", "Open"]}>
            {customerDetail.licenses.map((license) => <tr key={license.id}><td><code>{license.id}</code></td><td>{license.project}</td><td>{license.label || "—"}</td><td>{formatEpoch(license.created_at)}</td><td><button type="button" onClick={() => navigate({ tab: "licenses", filter: { project: license.project, customer_id: customerDetail.customer.id, q: license.id } })}>View licenses</button></td></tr>)}
          </DetailTable>}
          {customerSection === "tokens" && <DetailTable caption="Account tokens" empty="No account tokens are shown for this customer." limit="100" headers={["Prefix", "Name", "Status", "Scopes", "Expires", "Last used"]}>
            {customerDetail.account_tokens.map((token) => <tr key={token.id}><td><code>{token.token_prefix}</code></td><td>{token.name || "—"}</td><td><span className={`status ${token.status}`}>{token.status}</span></td><td><span>{readableScopes(token.scopes_json)}</span><details><summary>Raw scopes</summary><code>{token.scopes_json}</code></details></td><td>{formatEpoch(token.expires_at)}</td><td>{formatEpoch(token.last_used_at)}</td></tr>)}
          </DetailTable>}
          {customerSection === "orders" && <DetailTable caption="Customer orders" empty="No orders are shown for this customer." limit="100" headers={["Subscription", "Project", "Feature", "Fingerprint", "Sequence", "Updated"]}>
            {customerDetail.orders.map((order) => <tr key={`${order.subscription_id}/${order.project}/${order.feature}`}><td>{order.subscription_id}</td><td>{order.project}</td><td>{order.feature}</td><td><code>{shortHash(order.license_fingerprint)}</code></td><td>{order.last_seq}</td><td>{formatEpoch(order.updated_at)}</td></tr>)}
          </DetailTable>}
          {customerSection === "history" && <DetailTable caption="Recent customer history" empty="No recent customer history is shown." limit="50" headers={["Time", "Event", "From", "To", "Actor", "Reason"]}>
            {customerDetail.events.map((event) => <tr key={event.id}><td>{formatEpoch(event.created_at)}</td><td>{event.event_type}</td><td>{event.prev_status || "—"}</td><td>{event.next_status || "—"}</td><td>{event.actor} <span className="muted">({event.actor_type})</span></td><td>{event.reason || "—"}</td></tr>)}
          </DetailTable>}
        </>}
        <ProtectedConnections key={selectedCustomerId} customer={selectedCustomerId} active={customerSection === "access" || customerSection === "overview"} />
      </section>
    );
  }

  return (
    <section className="listPage" aria-labelledby="customers-list-title">
      <header className="listHeader listStatusHeader"><div><h2 id="customers-list-title" className="srOnly">Customers</h2></div><button className="primary" disabled={busy} onClick={() => setAddingUser(true)}>Add user</button>{listUpdating && <p className="readState" role="status">Updating customers…</p>}</header>
      {addingUser && <AddUser onCancel={() => setAddingUser(false)} onOpen={id => { setAddingUser(false); void refreshCustomers(); selectCustomer(id); }} />}
      <div className="filters filterBar" aria-label="Customer filters">
        <label>Status<select value={customerFilter.status} onChange={(event) => setCustomerFilter({ ...customerFilter, status: event.target.value })}><option value="">All statuses</option><option value="active">Active</option><option value="disabled">Disabled</option></select></label>
        <label>Search customers<input placeholder="Name, email, or customer ID" value={customerFilter.q} onChange={(event) => setCustomerFilter({ ...customerFilter, q: event.target.value })} /></label>
        <button type="button" disabled={customerFilter.status === "" && customerFilter.q === ""} onClick={() => setCustomerFilter({ status: "", q: "" })}>Clear filters</button>
        <button type="button" disabled={busy} onClick={() => void downloadCsv(customersUrl, "customers.csv", runMutation, setMessage)}>Export CSV</button>
      </div>
      {listLoading && <p className="readState" role="status">Loading customers…</p>}
      {listFailure !== null && <div className="readState error" role="alert"><p>Could not load customers: {listFailure}</p><button type="button" onClick={() => void refreshCustomers()}>Retry</button></div>}
      {customers.length === 0 && customersFence.isSettled() && <div className="emptyState"><h3>No customers found</h3><p>Try clearing or changing the filters.</p></div>}
      {customers.length > 0 && <>
        <div className="desktopRecords tableScroll"><table><thead><tr><th>Customer</th><th>Status</th><th>Access</th><th>Updated</th><th><span className="srOnly">Open</span></th></tr></thead><tbody>{customers.map((item) => <tr key={item.id} data-focus-row={`customer:${item.id}`}><td><strong>{customerDisplayName(item)}</strong><br /><span className="muted">{item.login_email ? `Login: ${item.login_email}` : item.email || "No email recorded"}</span>{customerDisplayName(item) !== item.id && <div><code>{item.id}</code></div>}</td><td><span className={`status ${item.status}`}>{item.status}</span></td><td>{item.active_entitlement_count} active / {item.entitlement_count} total</td><td>{formatEpoch(item.updated_at)}</td><td><button data-navigation-focus id={`customer-open-${item.id}`} type="button" disabled={busy} onClick={() => selectCustomer(item.id)}>Open</button></td></tr>)}</tbody></table></div>
        <div className="recordCards">{customers.map((item) => <article className="recordCard" data-focus-row={`customer:${item.id}`} key={item.id}><h3>{customerDisplayName(item)}</h3><p>{item.login_email ? `Login: ${item.login_email}` : item.email || item.id}</p><code>{item.id}</code><p><span className={`status ${item.status}`}>{item.status}</span> {item.active_entitlement_count} active / {item.entitlement_count} total access</p><button data-navigation-focus id={`customer-open-card-${item.id}`} type="button" disabled={busy} onClick={() => selectCustomer(item.id)}>Open details</button></article>)}</div>
      </>}
      {customersFence.isSettled() && <div className="tableFooter"><span className="muted">{customers.length} shown</span>{customersCursor !== null && <button type="button" disabled={busy} onClick={() => void loadMore(customersUrl, customersCursor, customers, setCustomers, setCustomersCursor, setMessage, hasCustomerListData, "customers_listed", customersFence, (customer) => customer.id)}>Load more</button>}</div>}
    </section>
  );
}

function DetailTable({ caption, empty, limit, headers, children }: { caption: string; empty: string; limit: string; headers: string[]; children: React.ReactNode }): React.ReactElement {
  const rows = React.Children.count(children);
  return <section className="tableScroll" role="region" aria-label={caption} tabIndex={0}><h3>{caption}</h3><p className="muted">{rows} shown{rows >= Number(limit) ? `. Limit ${limit}; more may exist.` : ""}</p>{rows === 0 ? <div className="emptyState"><p>{empty}</p></div> : <table><caption className="srOnly">{caption}</caption><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table>}</section>;
}
