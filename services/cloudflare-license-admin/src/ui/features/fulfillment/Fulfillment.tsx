import React, { useEffect, useMemo, useState } from "react";

import type { NavigationIntent } from "../../app/types";
import { useAdminNavigation } from "../../app/navigation";
import { ReadNotice } from "../../shared/ReadNotice";
import { api, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { BarSparkChart } from "../../shared/charts";
import { useOperatorControls } from "../../shared/controls";
import { formatEpoch } from "../../shared/format";
import { hasOrdersListData } from "../../shared/mutationGuards";
import { isRetryableAppendFailure, pageAppendError, withCursor } from "../../shared/pagination";
import { useRequestFence } from "../../shared/requestFence";
import { TIMESERIES_RANGE_DAYS } from "../../shared/timeseries";
import { useUsageTimeseries } from "../../shared/usageTimeseries";
import { OrderListFilter, ordersPath } from "./workflow";

interface OrderEventItem {
  event_id: string;
  subscription_id: string;
  project: string;
  feature: string;
  order_epoch: number;
  seq: number;
  intent: string;
  key_id: string | null;
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

export function Fulfillment({ active, navigationIntent, onNavigationHandled }: {
  active: boolean;
  navigationIntent: NavigationIntent | null;
  onNavigationHandled: (intent: NavigationIntent) => void;
}): React.ReactElement | null {
  const [retryRevision, setRetryRevision] = useState(0);
  const [readState, setReadState] = useState<{ key: string; loading: boolean; error: string | null }>({ key: "", loading: true, error: null });
  const [ordersSnapshot, setOrders] = useState<OrdersResponse | null>(null);
  const [orderFilter, setOrderFilter] = useState<OrderListFilter>({ status: "", subscription_id: "" });
  const { rememberFilters } = useAdminNavigation();
  const { busy: requestBusy, operationLocked, setMessage } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const { timeseries, timeseriesRange, setTimeseriesRange, timeseriesLoading, timeseriesError, retryTimeseries } = useUsageTimeseries(active);
  const ordersUrl = useMemo(() => ordersPath(orderFilter), [orderFilter]);
  const ordersFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${ordersUrl}`);

  useEffect(() => {
    if (navigationIntent?.tab !== "fulfillment") return;
    setOrderFilter({ status: navigationIntent.filter.status ?? "", subscription_id: navigationIntent.filter.subscription_id ?? "" });
    onNavigationHandled(navigationIntent);
  }, [navigationIntent, onNavigationHandled]);

  useEffect(() => {
    if (!active || navigationIntent?.tab === "fulfillment") return;
    rememberFilters("fulfillment", { ...orderFilter });
  }, [active, navigationIntent, orderFilter, rememberFilters]);

  useEffect(() => {
    if (!active) return;
    void (async () => {
      const ticket = ordersFence.begin();
      setReadState({ key: ordersUrl, loading: true, error: null });
      const response = await api<OrdersResponse>(ordersUrl);
      if (!ordersFence.isCurrent(ticket)) return;
      setReadState({ key: ordersUrl, loading: false, error: null });
      const parsed = parseExactApiSuccess<OrdersResponse>(response, "orders_listed", hasOrdersListData);
      if (parsed !== null) {
        if (ordersFence.settle(ticket, parsed.data.next_cursor ?? null)) setOrders(parsed.data);
      }
      else { setReadState({ key: ordersUrl, loading: false, error: apiFailureMessage(response) }); setMessage(apiFailureMessage(response)); }
    })();
  }, [active, ordersFence, ordersUrl, retryRevision, setMessage]);

  async function loadMoreOrders(): Promise<void> {
    const settledOrders = ordersFence.canLoadMore() ? ordersSnapshot : null;
    const cursor = settledOrders?.next_cursor ?? null;
    if (cursor === null) return;
    if (settledOrders === null) return;
    const baseItems = settledOrders.items;
    const ticket = ordersFence.beginLoadMore(cursor);
    if (ticket === null) return;
    let applied = false;
    try {
      const response = await api<OrdersResponse>(withCursor(ordersUrl, cursor));
      if (!ordersFence.isLoadMoreCurrent(ticket)) return;
      const parsed = parseExactApiSuccess<OrdersResponse>(response, "orders_listed", hasOrdersListData);
      if (parsed !== null) {
        const nextCursor = parsed.data.next_cursor ?? null;
        const appendError = pageAppendError(baseItems, parsed.data.items, (item) => item.event_id);
        if (appendError !== null) {
          setMessage(`invalid_api_response (${appendError})`);
          setOrders((previous) => ordersFence.isLoadMoreCurrent(ticket) && previous !== null && previous.next_cursor === cursor ? { ...previous, next_cursor: null } : previous);
          ordersFence.retireLoadMore(ticket);
        } else if (!ordersFence.acceptsNextCursor(ticket, nextCursor)) {
          setMessage("invalid_api_response (repeated_cursor)");
          setOrders((previous) => ordersFence.isLoadMoreCurrent(ticket) && previous !== null && previous.next_cursor === cursor ? { ...previous, next_cursor: null } : previous);
          ordersFence.retireLoadMore(ticket);
        } else {
          setOrders((previous) => ordersFence.isLoadMoreCurrent(ticket) && previous !== null && previous.next_cursor === cursor ? { ...parsed.data, items: [...previous.items, ...parsed.data.items] } : previous);
          applied = true;
          ordersFence.finishLoadMore(ticket, true, nextCursor);
        }
      } else {
        setMessage(apiFailureMessage(response));
        if (!isRetryableAppendFailure(response)) {
          setOrders((previous) => ordersFence.isLoadMoreCurrent(ticket) && previous !== null && previous.next_cursor === cursor ? { ...previous, next_cursor: null } : previous);
          ordersFence.retireLoadMore(ticket);
        }
      }
    } finally {
      if (!applied) ordersFence.finishLoadMore(ticket, false);
    }
  }

  const orders = ordersFence.isSettled() ? ordersSnapshot : null;

  if (!active) return null;
  return (
    <section className="tablePane full">
      <ReadNotice label="fulfillment events" hasData={orders !== null} loading={readState.key !== ordersUrl || readState.loading} error={readState.key === ordersUrl ? readState.error : null} onRetry={() => setRetryRevision((value) => value + 1)} />
      <div className="filters">
        <label>Status<select value={orderFilter.status} onChange={(event) => setOrderFilter({ ...orderFilter, status: event.target.value })}>
          <option value="">all</option><option value="accepted">accepted</option><option value="processed">processed</option><option value="superseded">superseded</option><option value="rejected">rejected</option>
        </select></label>
        <label>Subscription ID<input placeholder="subscription_id" value={orderFilter.subscription_id} onChange={(event) => setOrderFilter({ ...orderFilter, subscription_id: event.target.value })} /></label>
        <button type="button" onClick={() => setOrderFilter({ status: "", subscription_id: "" })}>Clear filters</button>
      </div>
      <div className="tableScroll" role="region" aria-label="Fulfillment event records" tabIndex={0}><table>
        <thead><tr><th>Received</th><th>Subscription</th><th>Project</th><th>Feature</th><th>Seq</th><th>Intent</th><th>Status</th><th>Processed</th></tr></thead>
        <tbody>{(orders?.items ?? []).map((item) => (
          <tr key={item.event_id} className={item.stale ? "staleRow" : ""}>
            <td>{formatEpoch(item.received_at)}</td><td>{item.subscription_id}</td><td>{item.project}</td><td>{item.feature}</td><td>{item.seq}</td><td>{item.intent}</td>
            <td><span className={`status ${item.status}`}>{item.status}</span>{item.stale && <span className="staleFlag">STALE</span>}</td><td>{formatEpoch(item.processed_at)}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <div className="tableFooter"><span className="muted">{orders === null ? "" : `${orders.items.length} shown`}</span>{ordersFence.canLoadMore() && orders?.next_cursor != null && <button type="button" disabled={busy || operationLocked} onClick={() => void loadMoreOrders()}>Load more</button>}</div>
      {orders !== null && orders.items.length === 0 && <p className="emptyState">No fulfillment events match this view.</p>}
      <details className="activitySummary"><summary>Activity summary and trends</summary>
      <section className="grid metrics reportCards">
        <div><span>Accepted</span><strong>{orders?.summary.accepted ?? "—"}</strong></div>
        <div><span>Processed</span><strong>{orders?.summary.processed ?? "—"}</strong></div>
        <div><span>Superseded</span><strong>{orders?.summary.superseded ?? "—"}</strong></div>
        <div><span>Rejected</span><strong>{orders?.summary.rejected ?? "—"}</strong></div>
        <div><span>Stale</span><strong>{orders?.summary.stale_accepted ?? "—"}</strong></div>
      </section>
      <div className="chartCard fulfillmentSpark"><ReadNotice label="fulfillment trends" loading={timeseriesLoading} error={timeseriesError} hasData={timeseries !== null} onRetry={retryTimeseries} />
        <div className="expiringHead">
          <h3>Fulfillment events over time</h3>
          <div className="rangeSelector" role="group" aria-label="Fulfillment spark range">
            <span className="muted">Window</span>
            {TIMESERIES_RANGE_DAYS.map((days) => <button key={days} type="button" className={timeseriesRange === days ? "active" : ""} onClick={() => setTimeseriesRange(days)}>last {days}d</button>)}
          </div>
        </div>
        <BarSparkChart values={(timeseries?.buckets ?? []).map((bucket) => bucket.fulfillment_events)} label={`Fulfillment (order) events over the last ${timeseriesRange} days`} />
      </div>
      </details>
    </section>
  );
}
