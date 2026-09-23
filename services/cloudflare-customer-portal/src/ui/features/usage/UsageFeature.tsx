import React from "react";

import type { UsageRow } from "../../types";

export function UsageFeature({ usage, available, busy, retry }: {
  available: boolean; busy: boolean; retry(): Promise<void>;
  usage: UsageRow[];
}): React.ReactElement {
  if (!available) return <section className="tablePane full"><h2>Recorded usage</h2><p>Usage is unavailable. Your license access and nodes are still available.</p><button disabled={busy} onClick={() => void retry()}>Retry usage</button></section>;
  if(usage.length===0)return <details className="appActivity"><summary>Activity</summary><p>No activity yet.</p></details>;
  return (
    <details className="appActivity"><summary>Activity</summary>
      <section className="tablePane full">
        <p>Event totals returned for this app. These counts do not show current seat availability.</p>
        <table>
          <thead><tr><th>Feature</th><th>Event</th><th>Count</th></tr></thead>
          <tbody>
            {usage.map((item, index) => (
              <tr key={`${item.project}/${item.feature}/${item.event_type}/${index}`}>
                  <td data-label="Feature">{item.feature}</td>
                <td data-label="Event">{item.event_type}</td>
                <td data-label="Count">{item.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </details>
  );
}
