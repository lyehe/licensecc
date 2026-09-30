import React, { useEffect, useState } from "react";

import type { NavigationTarget } from "../../app/types";
import type { ExpiringEntitlement } from "../../../shared/api";
import { ReadNotice } from "../../shared/ReadNotice";
import { api, parseExactApiSuccess } from "../../shared/api";
import { apiFailureFeedback, codeFeedback } from "../../shared/messages";
import type { OperatorFeedback } from "../../shared/operatorFeedback";
import { LineAreaChart } from "../../shared/charts";
import { useOperatorControls } from "../../shared/controls";
import { formatUtcDate, shortHash } from "../../shared/format";
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
  const [reportError, setReportError] = useState<OperatorFeedback | null>(null);
  const [reportLoading, setReportLoading] = useState(true);
  const [expiringRead, setExpiringRead] = useState<{ days: number; loading: boolean; error: OperatorFeedback | null }>({ days: 30, loading: true, error: null });
  const [reportSnapshot, setReport] = useState<Report | null>(null);
  const [expiringWithinDays, setExpiringWithinDays] = useState(30);
  const [expiringSnapshot, setExpiring] = useState<ExpiringEntitlement[]>([]);
  const [expiringCursorSnapshot, setExpiringCursor] = useState<string | null>(null);
  const { busy: requestBusy, operationLocked, setFeedback } = useOperatorControls();
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
      else setReportError(apiFailureFeedback(response));
    })();
  }, [active, reportFence, retryRevision]);

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
      setExpiringRead({ days: expiringWithinDays, loading: false, error: apiFailureFeedback(response) });
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
          setFeedback(codeFeedback(appendError));
          setExpiringCursor((previous) => expiringFence.isLoadMoreCurrent(ticket) && previous === cursor ? null : previous);
          expiringFence.retireLoadMore(ticket);
        } else if (!expiringFence.acceptsNextCursor(ticket, nextCursor)) {
          setFeedback(codeFeedback("repeated_cursor"));
          setExpiringCursor((previous) => expiringFence.isLoadMoreCurrent(ticket) && previous === cursor ? null : previous);
          expiringFence.retireLoadMore(ticket);
        } else {
          setExpiring((previous) => expiringFence.isLoadMoreCurrent(ticket) ? [...previous, ...parsed.data.items] : previous);
          setExpiringCursor((previous) => expiringFence.isLoadMoreCurrent(ticket) && previous === cursor ? nextCursor : previous);
          applied = true;
          expiringFence.finishLoadMore(ticket, true, nextCursor);
        }
      } else {
        setFeedback(apiFailureFeedback(response));
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
        <div><span>Customers total</span><strong>{report?.customers.total ?? "—"}</strong></div><div><span>Customers active</span><strong>{report?.customers.active ?? "—"}</strong></div><div><span>Customers suspended</span><strong>{report?.customers.disabled ?? "—"}</strong></div>
        <div><span>Licenses total</span><strong>{report?.licenses.total ?? "—"}</strong></div><div><span>Fulfillment processed</span><strong>{report?.fulfillment.processed ?? "—"}</strong></div><div><span>Fulfillment stale accepted</span><strong>{report?.fulfillment.stale_accepted ?? "—"}</strong></div><div><span>Order events 24h</span><strong>{report?.fulfillment.events_24h ?? "—"}</strong></div><div><span>Order events 7d</span><strong>{report?.fulfillment.events_7d ?? "—"}</strong></div><div><span>Customer suspensions 7d</span><strong>{report?.customer_suspensions_7d ?? "—"}</strong></div>
      </section>
      <section className="chartPanels"><ReadNotice label="refused-connection trends" loading={timeseriesLoading} error={timeseriesError} hasData={timeseries !== null} onRetry={retryTimeseries} />
        <div className="rangeSelector" role="group" aria-label="Time-series range"><span className="muted">Window</span>{TIMESERIES_RANGE_DAYS.map((days) => <button key={days} type="button" aria-pressed={timeseriesRange === days} className={timeseriesRange === days ? "active" : ""} onClick={() => setTimeseriesRange(days)}>last {days}d</button>)}</div>
        <div className="chartCard"><h3>Refused connections</h3><LineAreaChart values={(timeseries?.buckets ?? []).map((bucket) => bucket.denials)} bucketStarts={(timeseries?.buckets ?? []).map((bucket) => bucket.start)} unit="refused connections per interval" empty="No refused connections in this window." label={`Connections refused at the device limit over the last ${timeseriesRange} days`} /><p className="muted chartHint">A connection is refused when its license already has as many devices connected as its device limit allows.</p></div>
      </section>
      <section className="tablePane full expiringPanel">
        <div className="expiringHead"><h2>Expiring soon</h2><div className="rangeSelector" role="group" aria-label="Expiring horizon">{[7, 30, 90].map((days) => <button key={days} type="button" aria-pressed={expiringWithinDays === days} className={expiringWithinDays === days ? "active" : ""} onClick={() => setExpiringWithinDays(days)}>{days}d</button>)}</div></div>
        <ReadNotice label="expiring access" loading={expiringRead.days !== expiringWithinDays || expiringRead.loading} error={expiringRead.days === expiringWithinDays ? expiringRead.error : null} hasData={expiringFence.isSettled()} onRetry={() => void refreshExpiring()} />
        {!expiringFence.isSettled() ? null : expiring.length === 0 ? <p className="muted">No active entitlements expire within {expiringWithinDays} days.</p> : (
          <div className="tableScroll" role="region" aria-label="Expiring access records" tabIndex={0}><table><thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Customer</th><th>Expires</th><th>Days left</th><th></th></tr></thead><tbody>{expiring.map((row) => <tr key={row.id} className={row.days_left <= 7 ? "expiringSoonRow" : ""}><td>{row.project}</td><td>{row.feature}</td><td><code>{shortHash(row.license_fingerprint)}</code></td><td>{row.customer_name ?? row.customer_id}</td><td>{formatUtcDate(row.valid_until)}</td><td><span className={`daysLeft ${row.days_left <= 7 ? "urgent" : ""}`}>{row.days_left}</span></td><td className="actions"><button type="button" disabled={busy || operationLocked} onClick={() => onNavigate({ tab: "entitlements", filter: { id: row.id, customer_id: row.customer_id, project: "", feature: "", status: "" } })}>View</button></td></tr>)}</tbody></table></div>
        )}
        <div className="tableFooter"><span className="muted">{expiringFence.isSettled() ? `${expiring.length} shown` : ""}</span>{expiringCursor !== null && <button type="button" disabled={busy || operationLocked} onClick={() => void loadMoreExpiring()}>Load more</button>}</div>
      </section>
    </section>
  );
}
