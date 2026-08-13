import React from "react";

import { formatWindow, NO_ENTITLEMENTS_EMPTY_COPY, shortHash } from "../../portalWorkflow";
import type { EntitlementRow } from "../../types";

export function EntitlementsFeature({ entitlements }: { entitlements: EntitlementRow[] }): React.ReactElement {
  return (
    <section className="tablePane full">
      <h2>My entitlements</h2>
      <table>
        <thead><tr><th>Project</th><th>Feature</th><th>Mode</th><th>Capacity</th><th>Fingerprint</th><th>Status</th><th>Valid</th></tr></thead>
        <tbody>
          {entitlements.map((item, index) => (
            <tr key={`${item.project}/${item.feature}/${index}`}>
              <td>{item.project}</td>
              <td>{item.feature}</td>
              <td>{item.license_mode}</td>
              <td>{item.license_mode === "floating" ? `pool ${item.pool_size}` : `devices ${item.max_active_devices}`}</td>
              <td><code>{item.license_fingerprint ? shortHash(item.license_fingerprint) : "-"}</code></td>
              <td><span className={`status ${item.status}`}>{item.status}</span></td>
              <td>{formatWindow(item.valid_from, item.valid_until)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {entitlements.length === 0 && <p className="muted">{NO_ENTITLEMENTS_EMPTY_COPY}</p>}
    </section>
  );
}
