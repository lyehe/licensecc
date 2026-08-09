import React, { useCallback, useEffect, useState } from "react";

import { api } from "../../shared/api";
import { useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";
import { shortHash } from "../../shared/format";
import { downloadCsv } from "../../shared/pagination";

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
  const [events, setEvents] = useState<EventItem[]>([]);
  const { busy, runMutation, setMessage } = useOperatorControls();
  const { registerCoreRefresh } = useCoreRefresh();

  const refresh = useCallback(async (): Promise<void> => {
    const response = await api<{ items: EventItem[] }>("/api/admin/events");
    if (response.ok && response.data) {
      setEvents(response.data.items);
    } else {
      setMessage(`${response.code} (${response.request_id})`);
    }
  }, [setMessage]);

  useEffect(() => {
    return registerCoreRefresh(refresh);
  }, [refresh, registerCoreRefresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!active) {
    return null;
  }
  return (
    <section className="tablePane full">
      <div className="filters eventsToolbar">
        <button type="button" disabled={busy} onClick={() => void downloadCsv("/api/admin/events", "events.csv", runMutation, setMessage)}>Export CSV</button>
      </div>
      <table>
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
      </table>
      <div className="tableFooter"><span className="muted">{events.length} shown (most recent)</span></div>
    </section>
  );
}
