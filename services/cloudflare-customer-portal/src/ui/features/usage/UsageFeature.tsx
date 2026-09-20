import React from "react";

import { NO_USAGE_EMPTY_COPY } from "../../portalWorkflow";
import type { EntitlementRow, UsageRow } from "../../types";

export function UsageFeature({ usage, available, busy, retry }: {
  available: boolean; busy: boolean; retry(): Promise<void>;
  entitlements: EntitlementRow[];
  usage: UsageRow[];
}): React.ReactElement {
  if (!available) return <section className="tablePane full"><h2>Recorded usage</h2><p>Usage is unavailable. Your license access and nodes are still available.</p><button disabled={busy} onClick={() => void retry()}>Retry usage</button></section>;
  return (
    <section className="usagePane">
      <section className="tablePane full">
        <h2>Recorded usage</h2>
        <p>Event totals returned for this app. These counts do not show current seat availability.</p>
        <table>
          <thead><tr><th>App</th><th>Feature</th><th>Event</th><th>Count</th></tr></thead>
          <tbody>
            {usage.map((item, index) => (
              <tr key={`${item.project}/${item.feature}/${item.event_type}/${index}`}>
                <td data-label="App">{item.project}</td>
                <td data-label="Feature">{item.feature}</td>
                <td data-label="Event">{item.event_type}</td>
                <td data-label="Count">{item.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {usage.length === 0 && <p className="muted">{NO_USAGE_EMPTY_COPY}</p>}
      </section>
    </section>
  );
}
