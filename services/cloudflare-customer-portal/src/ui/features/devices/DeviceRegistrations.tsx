import React, { useState } from "react";
import { DEVICE_RELEASE_ACTION_LABEL, formatTimestamp } from "../../portalWorkflow";
import type { DeviceRow } from "../../types";

export function DeviceRegistrations({ devices, busy, releaseDevice }: {
  devices: DeviceRow[]; busy: boolean; releaseDevice(item: DeviceRow): Promise<void>;
}): React.ReactElement {
  const [project, setProject] = useState("");
  const [search, setSearch] = useState("");
  const projects = [...new Set([...devices.map((item) => item.project), ...(project ? [project] : [])])].sort();
  const visible = devices.filter((item) => (!project || item.project === project) && item.device_key_id.toLowerCase().includes(search.toLowerCase()));
  return <section className="registrations">
    <div className="filterBar"><label>Find a node<input type="search" placeholder="Search by device ID" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label>App<select value={project} onChange={(event) => setProject(event.target.value)}><option value="">All apps</option>{projects.map((name) => <option key={name}>{name}</option>)}</select></label></div>
    <section className="tablePane full"><h2>Registered nodes</h2>
      <p>Registrations returned for your account. Registered time does not indicate whether a machine is online.</p>
      {visible.length > 0 ? <table><thead><tr><th>Node ID</th><th>App</th><th>Feature</th><th>Registered</th><th>Action</th></tr></thead><tbody>
        {visible.map((item, index) => <tr key={`${item.device_key_id}/${index}`}>
          <td data-label="Node ID" className="identifier">{item.device_key_id}</td>
          <td data-label="App">{item.project}</td><td data-label="Feature">{item.feature}</td>
          <td data-label="Registered">{formatTimestamp(item.created_at)}</td>
          <td data-label="Action"><button disabled={busy} onClick={() => void releaseDevice(item)}>{DEVICE_RELEASE_ACTION_LABEL}</button></td>
        </tr>)}
      </tbody></table> : <div className="emptyState"><h3>{devices.length === 0 ? "No nodes registered yet" : "No matching nodes"}</h3><p>{devices.length === 0 ? "Activate a license from your application to register a machine." : "Try another device ID or app."}</p></div>}
      {devices.length >= 500 && <p className="readNotice">Only the first 500 registrations are shown. More may exist.</p>}
    </section>
  </section>;
}
