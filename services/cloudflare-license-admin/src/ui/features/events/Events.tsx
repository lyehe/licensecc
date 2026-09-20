import React, { useCallback, useEffect, useState } from "react";

import { ReadNotice } from "../../shared/ReadNotice";
import { api, apiFailureDetails, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { ConfirmRefreshFailure, EXACT_READ_PROOF, type ExactReadProof, useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";
import { shortHash } from "../../shared/format";
import { downloadCsv } from "../../shared/pagination";
import { hasEventListData } from "../../shared/mutationGuards";
import { useRequestFence } from "../../shared/requestFence";

interface EventItem {
  id: number;
  event_type: string;
  project: string;
  feature: string;
  license_fingerprint: string;
  source: string;
  actor: string;
  actor_type: string;
  revocation_seq: number;
  detail: string;
  created_at: number;
}

export function Events({ active }: { active: boolean }): React.ReactElement | null {
  const [eventsSnapshot, setEvents] = useState<EventItem[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { busy: requestBusy, operationLocked, runMutation, setMessage } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const { registerCoreRefresh } = useCoreRefresh();
  const eventsFence = useRequestFence(active ? "events:active" : "events:inactive");

  const refresh = useCallback(async (strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> => {
    if (!isCurrent()) return null;
    const ticket = eventsFence.begin();
    setLoading(true); setReadError(null);
    const response = await api<{ items: EventItem[] }>("/api/admin/events");
    if (!isCurrent() || !eventsFence.isCurrent(ticket)) return null;
    setLoading(false);
    const parsed = parseExactApiSuccess<{ items: EventItem[] }>(response, "events_listed", hasEventListData);
    if (parsed !== null) {
      if (eventsFence.settle(ticket)) {
        setEvents(parsed.data.items);
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      setReadError(apiFailureMessage(response));
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setReadError(apiFailureMessage(response));
      setMessage(apiFailureMessage(response));
    }
    return null;
  }, [eventsFence, setMessage]);

  useEffect(() => {
    return registerCoreRefresh(refresh);
  }, [refresh, registerCoreRefresh]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const events = eventsFence.isSettled() ? eventsSnapshot : [];

  if (!active) {
    return null;
  }
  return (
    <section className="tablePane full">
      <ReadNotice label="events" loading={loading} error={readError} hasData={eventsFence.isSettled()} onRetry={() => void refresh()} />
      <div className="filters eventsToolbar">
        <button type="button" disabled={busy || operationLocked} onClick={() => void downloadCsv("/api/admin/events", "events.csv", runMutation, setMessage)}>Export CSV</button>
      </div>
      <div className="tableScroll" role="region" aria-label="Audit event records" tabIndex={0}><table>
        <thead><tr><th>Time</th><th>Event</th><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Source</th><th>Actor</th><th>Detail</th><th>Seq</th></tr></thead>
        <tbody>
          {events.map((item) => (
            <tr key={item.id}>
              <td>{new Date(item.created_at * 1000).toLocaleString()}</td>
              <td>{item.event_type}</td>
              <td>{item.project}</td>
              <td>{item.feature}</td>
              <td><code>{shortHash(item.license_fingerprint)}</code></td>
              <td>{item.source}</td>
              <td>{item.actor} <span className="muted">({item.actor_type})</span></td>
              <td>{item.detail}</td>
              <td>{item.revocation_seq}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {!loading && readError === null && events.length === 0 && <p className="emptyState">No recent events.</p>}
      <div className="tableFooter"><span className="muted">{eventsFence.isSettled() ? `${events.length} shown (most recent)` : ""}</span></div>
    </section>
  );
}
