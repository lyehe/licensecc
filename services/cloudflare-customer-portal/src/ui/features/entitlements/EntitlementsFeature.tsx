import React from "react";

import { canDownloadLicense, formatWindow, licenseDisplayStatus, NO_ENTITLEMENTS_EMPTY_COPY, shortHash } from "../../portalWorkflow";
import { useLicenseClock } from "../../shared/useLicenseClock";
import type { EntitlementRow } from "../../types";

import { LicenseDownloadAction, type LicenseDownloads } from "../downloads/DownloadsFeature";

export function EntitlementsFeature({ entitlements, downloads, busy }: { entitlements: EntitlementRow[]; downloads:LicenseDownloads; busy:boolean }): React.ReactElement {
  const now = useLicenseClock();
  return (
    <section className="tablePane full">
      <h2>License access</h2>
      <p>Status reflects license dates. Your app also checks device and trial access.</p>
      <table className="licenseTable">
        <thead><tr><th>Feature</th><th>Mode</th><th>Capacity</th><th>Status</th><th>Valid</th><th>Action</th></tr></thead>
        <tbody>
          {entitlements.map((item) => (
            <tr key={item.id}>
              <td data-label="Feature"><div>{item.feature}<details className="referenceDetails"><summary>License details</summary><code>{item.license_fingerprint || item.id}</code></details><span className="licenseReference">{shortHash(item.license_fingerprint || item.id)}</span></div></td>
              <td data-label="Mode">{item.enforcement_mode === "device_bound_v1" ? "Protected device" : item.license_mode === "node_locked" ? "Node-locked" : item.license_mode === "floating" ? "Floating" : "Trial"}</td>
              <td data-label="Capacity">{item.license_mode === "floating" ? `${item.pool_size} seats` : `${item.max_active_devices} ${item.max_active_devices === 1 ? "device" : "devices"}`}</td>
              <td data-label="Status"><span className={`status ${licenseDisplayStatus(item, now)}`}>{licenseDisplayStatus(item, now).replace("_", " ")}</span></td>
              <td data-label="Valid">{formatWindow(item.valid_from, item.valid_until)}</td>
              <td data-label="Action" className="licenseAction">{canDownloadLicense(item)?<LicenseDownloadAction item={item} downloads={downloads} busy={busy} />:<span>{item.enforcement_mode==="device_bound_v1"?"Connect from your app":"Start a session in your app"}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {entitlements.length === 0 && <p className="muted">{NO_ENTITLEMENTS_EMPTY_COPY}</p>}
    </section>
  );
}
