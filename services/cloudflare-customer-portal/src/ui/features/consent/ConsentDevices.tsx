import React, { useEffect, useRef, useState } from "react";
import { ProtectedNodes } from "../devices/ProtectedNodes";

/** The consent owner stays mounted: a device-management detour must not restart its deadline. */
export function ConsentDevices({ customer, project, active, busy, pending, expired, runOnce, onPendingChange, onSessionExpired, onReturn }: {
  customer: string; project: string; active: boolean; busy: boolean; pending: boolean; expired: boolean;
  runOnce(work: () => Promise<void>): Promise<void>; onPendingChange(pending: boolean): void;
  onSessionExpired(): Promise<boolean>; onReturn(): void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (active) heading.current?.focus(); }, [active]);
  return <section hidden={!active} className="consentDevices" aria-label="Manage app devices">
    <h2 ref={heading} tabIndex={-1}>Devices for {project}</h2>
    <p>Connections for this app may use different licenses. Review the device and feature before disconnecting.</p>
    {expired && <p role="status">This connection request has ended. You can finish checking a saved disconnect here, then restart Connect in your app.</p>}
    <label>Find a device<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name, ID or app" /></label>
    <ProtectedNodes customer={customer} project={project} query={query} busy={busy} runOnce={runOnce} onSessionExpired={onSessionExpired} onPendingChange={onPendingChange} />
    {pending && <p>Finish reviewing the disconnect request before returning to the connection.</p>}
    <button disabled={busy || pending} onClick={onReturn}>{expired ? "Return to connection" : "Return and check again"}</button>
  </section>;
}
