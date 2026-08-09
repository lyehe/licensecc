import React, { useEffect, useMemo, useState } from "react";

import type { NavigationIntent } from "../../app/types";
import { api } from "../../shared/api";
import { BarSparkChart } from "../../shared/charts";
import { useOperatorControls } from "../../shared/controls";
import { formatEpoch } from "../../shared/format";
import { withCursor } from "../../shared/pagination";
import { TIMESERIES_RANGE_DAYS } from "../../shared/timeseries";
import { useUsageTimeseries } from "../../shared/usageTimeseries";
import { OrderListFilter, ordersPath } from "./workflow";

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

export function Fulfillment({ active, navigationIntent, onNavigationHandled }: {
  active: boolean;
  navigationIntent: NavigationIntent | null;
  onNavigationHandled: (intent: NavigationIntent) => void;
}): React.ReactElement | null {
  const [orders, setOrders] = useState<OrdersResponse | null>(null);
  const [orderFilter, setOrderFilter] = useState<OrderListFilter>({ status: "", subscription_id: "" });
  const { busy, setMessage } = useOperatorControls();
  const { timeseries, timeseriesRange, setTimeseriesRange } = useUsageTimeseries(active);
  const ordersUrl = useMemo(() => ordersPath(orderFilter), [orderFilter]);

  useEffect(() => {
    if (navigationIntent?.tab !== "fulfillment") return;
    setOrderFilter({ status: navigationIntent.filter.status ?? "", subscription_id: navigationIntent.filter.subscription_id ?? "" });
    onNavigationHandled(navigationIntent);
  }, [navigationIntent, onNavigationHandled]);

  useEffect(() => {
    if (!active) return;
    void (async () => {
      const response = await api<OrdersResponse>(ordersUrl);
      if (response.ok && response.data) setOrders(response.data);
      else setMessage(`${response.code} (${response.request_id})`);
    })();
  }, [active, ordersUrl, setMessage]);

  async function loadMoreOrders(): Promise<void> {
    if (orders === null || orders.next_cursor === null) return;
    const response = await api<OrdersResponse>(withCursor(ordersUrl, orders.next_cursor));
    const data = response.data;
    if (response.ok && data) {
      setOrders((previous) => previous === null ? data : { ...data, items: [...previous.items, ...data.items] });
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  if (!active) return null;
  return (
    <section className="tablePane full">
      <section className="grid metrics reportCards">
        <div><span>Accepted</span><strong>{orders?.summary.accepted ?? 0}</strong></div>
        <div><span>Processed</span><strong>{orders?.summary.processed ?? 0}</strong></div>
        <div><span>Superseded</span><strong>{orders?.summary.superseded ?? 0}</strong></div>
        <div><span>Rejected</span><strong>{orders?.summary.rejected ?? 0}</strong></div>
        <div><span>Stale</span><strong>{orders?.summary.stale_accepted ?? 0}</strong></div>
      </section>
      <div className="chartCard fulfillmentSpark">
        <div className="expiringHead">
          <h3>Fulfillment events over time</h3>
          <div className="rangeSelector" role="group" aria-label="Fulfillment spark range">
            <span className="muted">Window</span>
            {TIMESERIES_RANGE_DAYS.map((days) => <button key={days} type="button" className={timeseriesRange === days ? "active" : ""} onClick={() => setTimeseriesRange(days)}>last {days}d</button>)}
          </div>
        </div>
        <BarSparkChart values={(timeseries?.buckets ?? []).map((bucket) => bucket.fulfillment_events)} label={`Fulfillment (order) events over the last ${timeseriesRange} days`} />
      </div>
      <div className="filters">
        <select value={orderFilter.status} onChange={(event) => setOrderFilter({ ...orderFilter, status: event.target.value })}>
          <option value="">all</option><option value="accepted">accepted</option><option value="processed">processed</option><option value="superseded">superseded</option><option value="rejected">rejected</option>
        </select>
        <input placeholder="subscription_id" value={orderFilter.subscription_id} onChange={(event) => setOrderFilter({ ...orderFilter, subscription_id: event.target.value })} />
      </div>
      <table>
        <thead><tr><th>Received</th><th>Subscription</th><th>Project</th><th>Feature</th><th>Seq</th><th>Intent</th><th>Status</th><th>Processed</th></tr></thead>
        <tbody>{(orders?.items ?? []).map((item) => (
          <tr key={item.event_id} className={item.stale ? "staleRow" : ""}>
            <td>{formatEpoch(item.received_at)}</td><td>{item.subscription_id}</td><td>{item.project}</td><td>{item.feature}</td><td>{item.seq}</td><td>{item.intent}</td>
            <td><span className={`status ${item.status}`}>{item.status}</span>{item.stale && <span className="staleFlag">STALE</span>}</td><td>{formatEpoch(item.processed_at)}</td>
          </tr>
        ))}</tbody>
      </table>
      <div className="tableFooter"><span className="muted">{(orders?.items ?? []).length} shown</span>{orders?.next_cursor != null && <button type="button" disabled={busy} onClick={() => void loadMoreOrders()}>Load more</button>}</div>
    </section>
  );
}
