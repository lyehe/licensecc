import React from "react";

import { NO_USAGE_EMPTY_COPY } from "../../portalWorkflow";
import type { EntitlementRow, UsageRow } from "../../types";

export function UsageFeature({ entitlements, usage }: {
  entitlements: EntitlementRow[];
  usage: UsageRow[];
}): React.ReactElement {
  return (
    <section className="usagePane">
      <section className="grid metrics">
        <div><span>Tracked tuples</span><strong>{usage.length}</strong></div>
        <div><span>Total events</span><strong>{usage.reduce((sum, item) => sum + (Number(item.count) || 0), 0)}</strong></div>
        <div><span>Event types</span><strong>{new Set(usage.map((item) => item.event_type)).size}</strong></div>
        <div><span>Entitlements</span><strong>{entitlements.length}</strong></div>
      </section>
      <section className="tablePane full">
        <h2>Recent usage</h2>
        <table>
          <thead><tr><th>Project</th><th>Feature</th><th>Event</th><th>Count</th></tr></thead>
          <tbody>
            {usage.map((item, index) => (
              <tr key={`${item.project}/${item.feature}/${item.event_type}/${index}`}>
                <td>{item.project}</td>
                <td>{item.feature}</td>
                <td>{item.event_type}</td>
                <td>{item.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {usage.length === 0 && <p className="muted">{NO_USAGE_EMPTY_COPY}</p>}
      </section>
    </section>
  );
}
