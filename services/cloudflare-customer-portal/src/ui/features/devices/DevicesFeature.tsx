import React, { useState } from "react";
import { ProtectedNodes } from "./ProtectedNodes";
import { devicesLocation } from "../../shared/navigation";
import type { EntitlementRow } from "../../types";

// One devices page in customer terms. Connected devices (protected bindings) is now the only
// section: it owns the search box and the route's exact app filter (shown as a removable
// "App: {project}" chip). It loads and paginates independently of the entitlements read, so it
// always renders regardless of whether that read is loading, ready or errored.
export function DevicesFeature({
  customer,
  busy,
  runOnce,
  onSessionExpired,
  project,
  entitlements,
}: {
  customer: string;
  busy: boolean;
  runOnce(work: () => Promise<void>): Promise<void>;
  onSessionExpired(): Promise<boolean>;
  project: string | null;
  entitlements: EntitlementRow[];
}): React.ReactElement {
  const [query, setQuery] = useState("");
  // An app filter naming no app in this account would otherwise show only "No matching ..." sections.
  const unknownApp = project !== null && !entitlements.some((item) => item.project === project);
  return (
    <div>
      <div className="pageHeading"><div><h1>Devices</h1><p>Manage the devices using your licenses.</p></div></div>
      <div className="filterBar">
        <label>Find a device<input type="search" placeholder="Search by name, ID or app" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        {unknownApp
          ? <p className="readNotice" role="status">No app named "{project}" is in your account. <a href={devicesLocation()}>Show all apps</a></p>
          : project !== null && <p className="appFilterChip">App: {project} <a href={devicesLocation()}>Show all apps</a></p>}
      </div>
      <ProtectedNodes customer={customer} busy={busy} runOnce={runOnce} onSessionExpired={onSessionExpired} query={query} project={project} />
    </div>
  );
}
