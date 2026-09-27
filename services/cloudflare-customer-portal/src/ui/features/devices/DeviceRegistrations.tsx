import React from "react";
import { DEVICE_RELEASE_ACTION_LABEL, formatTimestamp } from "../../portalWorkflow";
import { matchesDeviceSearch } from "./deviceSearch";
import type { DeviceRow } from "../../types";

export function DeviceRegistrations({ devices, busy, releaseDevice, query, project }: {
  devices: DeviceRow[]; busy: boolean; releaseDevice(item: DeviceRow): Promise<void>;
  // D1: the page-level search box and the route's exact app filter, both owned by DevicesFeature.
  query: string; project: string | null;
}): React.ReactElement {
  const visible = devices.filter((item) => matchesDeviceSearch([item.device_key_id], item.project, query, project));
  return <section className="registrations">
    <section className="tablePane full"><h2>Activated devices (older app versions)</h2>
      <p>Registration time does not indicate whether a device is online.</p>
      {visible.length > 0 ? <table><thead><tr><th>Device ID</th><th>App</th><th>Feature</th><th>Registered</th><th>Action</th></tr></thead><tbody>
        {visible.map((item, index) => <tr key={`${item.device_key_id}/${index}`}>
          <td data-label="Device ID" className="identifier">{item.device_key_id}</td>
          <td data-label="App">{item.project}</td><td data-label="Feature">{item.feature}</td>
          <td data-label="Registered">{formatTimestamp(item.created_at)}</td>
          <td data-label="Action"><button disabled={busy} onClick={() => void releaseDevice(item)}>{DEVICE_RELEASE_ACTION_LABEL}</button></td>
        </tr>)}
      </tbody></table> : <div className="emptyState"><h3>No matching devices</h3><p>Try another device ID or app.</p></div>}
      {devices.length >= 500 && <p className="readNotice">Only the first 500 registrations are shown. More may exist.</p>}
    </section>
  </section>;
}
