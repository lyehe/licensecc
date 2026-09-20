import React from "react";

import { formatWindow, NO_ENTITLEMENTS_EMPTY_COPY, shortHash } from "../../portalWorkflow";
import type { EntitlementRow } from "../../types";

export function EntitlementsFeature({ entitlements }: { entitlements: EntitlementRow[] }): React.ReactElement {
  return (
    <section className="tablePane full">
      <h2>License access</h2>
      <p>Capacity is the configured limit for each license, not the number currently available.</p>
      <table>
        <thead><tr><th>App</th><th>Feature</th><th>Mode</th><th>Capacity</th><th>Fingerprint</th><th>Status</th><th>Valid</th></tr></thead>
        <tbody>
          {entitlements.map((item, index) => (
            <tr key={`${item.project}/${item.feature}/${index}`}>
              <td data-label="App">{item.project}</td>
              <td data-label="Feature">{item.feature}</td>
              <td data-label="Mode">{item.license_mode === "node_locked" ? "Node-locked" : item.license_mode === "floating" ? "Floating" : "Trial"}</td>
              <td data-label="Capacity">{item.license_mode === "floating" ? `${item.pool_size} seats` : `${item.max_active_devices} nodes`}</td>
              <td data-label="Fingerprint"><code title={item.license_fingerprint}>{item.license_fingerprint ? shortHash(item.license_fingerprint) : "Unavailable"}</code></td>
              <td data-label="Status"><span className={`status ${item.status}`}>{item.status}</span></td>
              <td data-label="Valid">{formatWindow(item.valid_from, item.valid_until)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {entitlements.length === 0 && <p className="muted">{NO_ENTITLEMENTS_EMPTY_COPY}</p>}
    </section>
  );
}
