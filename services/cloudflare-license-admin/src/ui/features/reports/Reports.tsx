import React, { useEffect, useState } from "react";

import type { NavigationTarget } from "../../app/types";
import type { ExpiringEntitlement } from "../../../shared/api";
import { api } from "../../shared/api";
import { DenialRateChart, LineAreaChart } from "../../shared/charts";
import { useOperatorControls } from "../../shared/controls";
import { formatEpoch, shortHash } from "../../shared/format";
import { withCursor } from "../../shared/pagination";
import { TIMESERIES_RANGE_DAYS } from "../../shared/timeseries";
import { useUsageTimeseries } from "../../shared/usageTimeseries";
import { expiringPath } from "./workflow";

interface Report {
  generated_at: number;
  entitlements: { total: number; active: number; revoked: number; disabled: number };
  customers: { total: number; active: number; disabled: number };
  account_tokens: { active: number };
  licenses: { total: number };
  fulfillment: { accepted: number; processed: number; superseded: number; rejected: number; stale_accepted: number; events_24h: number; events_7d: number };
  customer_suspensions_7d: number;
}

interface ExpiringData {
  items: ExpiringEntitlement[];
  next_cursor: string | null;
}

export function Reports({ active, onNavigate }: { active: boolean; onNavigate: (target: NavigationTarget) => void }): React.ReactElement | null {
  const [report, setReport] = useState<Report | null>(null);
  const [expiringWithinDays, setExpiringWithinDays] = useState(30);
  const [expiring, setExpiring] = useState<ExpiringEntitlement[]>([]);
  const [expiringCursor, setExpiringCursor] = useState<string | null>(null);
  const { busy, setMessage } = useOperatorControls();
  const { timeseries, timeseriesRange, setTimeseriesRange } = useUsageTimeseries(active);

  useEffect(() => {
    if (!active) return;
    void (async () => {
      const response = await api<Report>("/api/admin/report");
      if (response.ok && response.data) setReport(response.data);
      else setMessage(`${response.code} (${response.request_id})`);
    })();
  }, [active, setMessage]);

  async function refreshExpiring(): Promise<void> {
    const response = await api<ExpiringData>(expiringPath(expiringWithinDays));
    if (response.ok && response.data) {
      setExpiring(response.data.items);
      setExpiringCursor(response.data.next_cursor ?? null);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  useEffect(() => {
    if (active) void refreshExpiring();
  }, [active, expiringWithinDays]);

  async function loadMoreExpiring(): Promise<void> {
    if (expiringCursor === null) return;
    const response = await api<ExpiringData>(withCursor(expiringPath(expiringWithinDays), expiringCursor));
    if (response.ok && response.data) {
      setExpiring((previous) => [...previous, ...response.data.items]);
      setExpiringCursor(response.data.next_cursor ?? null);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }

  if (!active) return null;
  return (
    <section className="reportsTab">
      <section className="grid metrics reportCards">
        <div><span>Entitlements total</span><strong>{report?.entitlements.total ?? 0}</strong></div><div><span>Entitlements active</span><strong>{report?.entitlements.active ?? 0}</strong></div><div><span>Entitlements revoked</span><strong>{report?.entitlements.revoked ?? 0}</strong></div><div><span>Entitlements disabled</span><strong>{report?.entitlements.disabled ?? 0}</strong></div>
        <div><span>Customers total</span><strong>{report?.customers.total ?? 0}</strong></div><div><span>Customers active</span><strong>{report?.customers.active ?? 0}</strong></div><div><span>Customers disabled</span><strong>{report?.customers.disabled ?? 0}</strong></div><div><span>Active account tokens</span><strong>{report?.account_tokens.active ?? 0}</strong></div>
        <div><span>Licenses total</span><strong>{report?.licenses.total ?? 0}</strong></div><div><span>Fulfillment processed</span><strong>{report?.fulfillment.processed ?? 0}</strong></div><div><span>Fulfillment stale accepted</span><strong>{report?.fulfillment.stale_accepted ?? 0}</strong></div><div><span>Order events 24h</span><strong>{report?.fulfillment.events_24h ?? 0}</strong></div><div><span>Order events 7d</span><strong>{report?.fulfillment.events_7d ?? 0}</strong></div><div><span>Customer suspensions 7d</span><strong>{report?.customer_suspensions_7d ?? 0}</strong></div>
      </section>
      <section className="chartPanels">
        <div className="rangeSelector" role="group" aria-label="Time-series range"><span className="muted">Window</span>{TIMESERIES_RANGE_DAYS.map((days) => <button key={days} type="button" className={timeseriesRange === days ? "active" : ""} onClick={() => setTimeseriesRange(days)}>last {days}d</button>)}</div>
        <div className="chartGrid">
          <div className="chartCard"><h3>Checkouts vs denials</h3><LineAreaChart checkouts={(timeseries?.buckets ?? []).map((bucket) => bucket.checkouts)} denials={(timeseries?.buckets ?? []).map((bucket) => bucket.denials)} label={`Checkouts (filled) versus denials over the last ${timeseriesRange} days`} /><div className="chartLegend"><span className="legend checkoutsLegend">checkouts</span><span className="legend denialsLegend">denials</span></div></div>
          <div className="chartCard"><h3>Denial-rate trend</h3><DenialRateChart rates={(timeseries?.buckets ?? []).map((bucket) => bucket.denial_rate)} label={`Denial rate (denials over checkout attempts) over the last ${timeseriesRange} days`} /><p className="muted chartHint">Rising denial rate is the seat-pool upsell signal.</p></div>
        </div>
      </section>
      <section className="tablePane full expiringPanel">
        <div className="expiringHead"><h2>Expiring soon</h2><div className="rangeSelector" role="group" aria-label="Expiring horizon">{[7, 30, 90].map((days) => <button key={days} type="button" className={expiringWithinDays === days ? "active" : ""} onClick={() => setExpiringWithinDays(days)}>{days}d</button>)}</div></div>
        {expiring.length === 0 ? <p className="muted">No active entitlements expire within {expiringWithinDays} days.</p> : (
          <table><thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Customer</th><th>Expires</th><th>Days left</th><th></th></tr></thead><tbody>{expiring.map((row) => <tr key={`${row.project}/${row.feature}/${row.license_fingerprint}`} className={row.days_left <= 7 ? "expiringSoonRow" : ""}><td>{row.project}</td><td>{row.feature}</td><td><code>{shortHash(row.license_fingerprint)}</code></td><td>{row.customer_id ?? "-"}</td><td>{formatEpoch(row.valid_until)}</td><td><span className={`daysLeft ${row.days_left <= 7 ? "urgent" : ""}`}>{row.days_left}</span></td><td className="actions"><button type="button" disabled={busy} onClick={() => onNavigate({ tab: "entitlements", filter: { project: row.project, feature: row.feature, status: "" } })}>View</button></td></tr>)}</tbody></table>
        )}
        <div className="tableFooter"><span className="muted">{expiring.length} shown</span>{expiringCursor !== null && <button type="button" disabled={busy} onClick={() => void loadMoreExpiring()}>Load more</button>}</div>
      </section>
    </section>
  );
}
