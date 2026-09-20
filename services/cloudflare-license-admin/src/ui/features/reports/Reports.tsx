import React, { useEffect, useState } from "react";

import type { NavigationTarget } from "../../app/types";
import type { ExpiringEntitlement } from "../../../shared/api";
import { ReadNotice } from "../../shared/ReadNotice";
import { api, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { DenialRateChart, LineAreaChart } from "../../shared/charts";
import { useOperatorControls } from "../../shared/controls";
import { formatEpoch, shortHash } from "../../shared/format";
import { hasExpiringListData, hasReportData } from "../../shared/mutationGuards";
import { isRetryableAppendFailure, pageAppendError, withCursor } from "../../shared/pagination";
import { useRequestFence } from "../../shared/requestFence";
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
  const [retryRevision, setRetryRevision] = useState(0);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(true);
  const [expiringRead, setExpiringRead] = useState<{ days: number; loading: boolean; error: string | null }>({ days: 30, loading: true, error: null });
  const [reportSnapshot, setReport] = useState<Report | null>(null);
  const [expiringWithinDays, setExpiringWithinDays] = useState(30);
  const [expiringSnapshot, setExpiring] = useState<ExpiringEntitlement[]>([]);
  const [expiringCursorSnapshot, setExpiringCursor] = useState<string | null>(null);
  const { busy: requestBusy, operationLocked, setMessage } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const { timeseries, timeseriesRange, setTimeseriesRange, timeseriesLoading, timeseriesError, retryTimeseries } = useUsageTimeseries(active);
  const reportFence = useRequestFence(active ? "report:active" : "report:inactive");
  const expiringFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${expiringWithinDays}`);

  useEffect(() => {
    if (!active) return;
    void (async () => {
      const ticket = reportFence.begin();
      setReportLoading(true); setReportError(null);
      const response = await api<Report>("/api/admin/report");
      if (!reportFence.isCurrent(ticket)) return;
      setReportLoading(false);
      const parsed = parseExactApiSuccess<Report>(response, "report", hasReportData);
      if (parsed !== null) {
        if (reportFence.settle(ticket)) setReport(parsed.data);
      }
      else { setReportError(apiFailureMessage(response)); setMessage(apiFailureMessage(response)); }
    })();
  }, [active, reportFence, retryRevision, setMessage]);

  async function refreshExpiring(): Promise<void> {
    const ticket = expiringFence.begin();
    setExpiringRead({ days: expiringWithinDays, loading: true, error: null });
    const response = await api<ExpiringData>(expiringPath(expiringWithinDays));
    if (!expiringFence.isCurrent(ticket)) return;
    setExpiringRead({ days: expiringWithinDays, loading: false, error: null });
    const parsed = parseExactApiSuccess<ExpiringData>(response, "report_expiring", hasExpiringListData);
    if (parsed !== null) {
      if (expiringFence.settle(ticket, parsed.data.next_cursor ?? null)) {
        setExpiring(parsed.data.items);
        setExpiringCursor(parsed.data.next_cursor ?? null);
      }
    } else {
      setExpiringRead({ days: expiringWithinDays, loading: false, error: apiFailureMessage(response) });
      setMessage(apiFailureMessage(response));
    }
  }

  useEffect(() => {
    if (active) void refreshExpiring();
  }, [active, expiringWithinDays]);

  async function loadMoreExpiring(): Promise<void> {
    const cursor = expiringFence.canLoadMore() ? expiringCursorSnapshot : null;
    if (cursor === null) return;
    const ticket = expiringFence.beginLoadMore(cursor);
    if (ticket === null) return;
    let applied = false;
    try {
      const response = await api<ExpiringData>(withCursor(expiringPath(expiringWithinDays), cursor));
      if (!expiringFence.isLoadMoreCurrent(ticket)) return;
      const parsed = parseExactApiSuccess<ExpiringData>(response, "report_expiring", hasExpiringListData);
      if (parsed !== null) {
        const nextCursor = parsed.data.next_cursor ?? null;
        const appendError = pageAppendError(expiringSnapshot, parsed.data.items, (item) => `${item.project}\u0000${item.feature}\u0000${item.license_fingerprint}`);
        if (appendError !== null) {
          setMessage(`invalid_api_response (${appendError})`);
          setExpiringCursor((previous) => expiringFence.isLoadMoreCurrent(ticket) && previous === cursor ? null : previous);
          expiringFence.retireLoadMore(ticket);
        } else if (!expiringFence.acceptsNextCursor(ticket, nextCursor)) {
          setMessage("invalid_api_response (repeated_cursor)");
          setExpiringCursor((previous) => expiringFence.isLoadMoreCurrent(ticket) && previous === cursor ? null : previous);
          expiringFence.retireLoadMore(ticket);
        } else {
          setExpiring((previous) => expiringFence.isLoadMoreCurrent(ticket) ? [...previous, ...parsed.data.items] : previous);
          setExpiringCursor((previous) => expiringFence.isLoadMoreCurrent(ticket) && previous === cursor ? nextCursor : previous);
          applied = true;
          expiringFence.finishLoadMore(ticket, true, nextCursor);
        }
      } else {
        setMessage(apiFailureMessage(response));
        if (!isRetryableAppendFailure(response)) {
          setExpiringCursor((previous) => expiringFence.isLoadMoreCurrent(ticket) && previous === cursor ? null : previous);
          expiringFence.retireLoadMore(ticket);
        }
      }
    } finally {
      if (!applied) expiringFence.finishLoadMore(ticket, false);
    }
  }

  const report = reportFence.isSettled() ? reportSnapshot : null;
  const expiring = expiringFence.isSettled() ? expiringSnapshot : [];
  const expiringCursor = expiringFence.canLoadMore() ? expiringCursorSnapshot : null;

  if (!active) return null;
  return (
    <section className="reportsTab">
      <ReadNotice label="reports" loading={reportLoading} error={reportError} hasData={report !== null} onRetry={() => setRetryRevision((value) => value + 1)} />
      <section className="grid metrics reportCards">
        <div><span>Entitlements total</span><strong>{report?.entitlements.total ?? "—"}</strong></div><div><span>Entitlements active</span><strong>{report?.entitlements.active ?? "—"}</strong></div><div><span>Entitlements revoked</span><strong>{report?.entitlements.revoked ?? "—"}</strong></div><div><span>Entitlements disabled</span><strong>{report?.entitlements.disabled ?? "—"}</strong></div>
        <div><span>Customers total</span><strong>{report?.customers.total ?? "—"}</strong></div><div><span>Customers active</span><strong>{report?.customers.active ?? "—"}</strong></div><div><span>Customers disabled</span><strong>{report?.customers.disabled ?? "—"}</strong></div><div><span>Active account tokens</span><strong>{report?.account_tokens.active ?? "—"}</strong></div>
        <div><span>Licenses total</span><strong>{report?.licenses.total ?? "—"}</strong></div><div><span>Fulfillment processed</span><strong>{report?.fulfillment.processed ?? "—"}</strong></div><div><span>Fulfillment stale accepted</span><strong>{report?.fulfillment.stale_accepted ?? "—"}</strong></div><div><span>Order events 24h</span><strong>{report?.fulfillment.events_24h ?? "—"}</strong></div><div><span>Order events 7d</span><strong>{report?.fulfillment.events_7d ?? "—"}</strong></div><div><span>Customer suspensions 7d</span><strong>{report?.customer_suspensions_7d ?? "—"}</strong></div>
      </section>
      <section className="chartPanels"><ReadNotice label="usage trends" loading={timeseriesLoading} error={timeseriesError} hasData={timeseries !== null} onRetry={retryTimeseries} />
        <div className="rangeSelector" role="group" aria-label="Time-series range"><span className="muted">Window</span>{TIMESERIES_RANGE_DAYS.map((days) => <button key={days} type="button" className={timeseriesRange === days ? "active" : ""} onClick={() => setTimeseriesRange(days)}>last {days}d</button>)}</div>
        <div className="chartGrid">
          <div className="chartCard"><h3>Checkouts vs denials</h3><LineAreaChart checkouts={(timeseries?.buckets ?? []).map((bucket) => bucket.checkouts)} denials={(timeseries?.buckets ?? []).map((bucket) => bucket.denials)} label={`Checkouts (filled) versus denials over the last ${timeseriesRange} days`} /><div className="chartLegend"><span className="legend checkoutsLegend">checkouts</span><span className="legend denialsLegend">denials</span></div></div>
          <div className="chartCard"><h3>Denial-rate trend</h3><DenialRateChart rates={(timeseries?.buckets ?? []).map((bucket) => bucket.denial_rate)} label={`Denial rate (denials over checkout attempts) over the last ${timeseriesRange} days`} /><p className="muted chartHint">Review denied checkouts to identify capacity or access problems.</p></div>
        </div>
      </section>
      <section className="tablePane full expiringPanel">
        <div className="expiringHead"><h2>Expiring soon</h2><div className="rangeSelector" role="group" aria-label="Expiring horizon">{[7, 30, 90].map((days) => <button key={days} type="button" className={expiringWithinDays === days ? "active" : ""} onClick={() => setExpiringWithinDays(days)}>{days}d</button>)}</div></div>
        <ReadNotice label="expiring access" loading={expiringRead.days !== expiringWithinDays || expiringRead.loading} error={expiringRead.days === expiringWithinDays ? expiringRead.error : null} hasData={expiringFence.isSettled()} onRetry={() => void refreshExpiring()} />
        {!expiringFence.isSettled() ? null : expiring.length === 0 ? <p className="muted">No active entitlements expire within {expiringWithinDays} days.</p> : (
          <div className="tableScroll" role="region" aria-label="Expiring access records" tabIndex={0}><table><thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Customer</th><th>Expires</th><th>Days left</th><th></th></tr></thead><tbody>{expiring.map((row) => <tr key={`${row.project}/${row.feature}/${row.license_fingerprint}`} className={row.days_left <= 7 ? "expiringSoonRow" : ""}><td>{row.project}</td><td>{row.feature}</td><td><code>{shortHash(row.license_fingerprint)}</code></td><td>{row.customer_id ?? "-"}</td><td>{formatEpoch(row.valid_until)}</td><td><span className={`daysLeft ${row.days_left <= 7 ? "urgent" : ""}`}>{row.days_left}</span></td><td className="actions"><button type="button" disabled={busy || operationLocked} onClick={() => onNavigate({ tab: "entitlements", filter: { project: row.project, feature: row.feature, status: "" } })}>View</button></td></tr>)}</tbody></table></div>
        )}
        <div className="tableFooter"><span className="muted">{expiringFence.isSettled() ? `${expiring.length} shown` : ""}</span>{expiringCursor !== null && <button type="button" disabled={busy || operationLocked} onClick={() => void loadMoreExpiring()}>Load more</button>}</div>
      </section>
    </section>
  );
}
