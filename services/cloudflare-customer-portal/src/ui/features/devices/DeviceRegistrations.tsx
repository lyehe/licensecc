import React from "react";
import { createPortal } from "react-dom";
import { DEVICE_RELEASE_ACTION_LABEL, DEVICE_RELEASE_CONFIRM_COPY, DEVICE_RELEASE_CONFIRM_TITLE, formatTimestamp } from "../../portalWorkflow";
import { ActionResult } from "../../shared/ActionResult";
import { matchesDeviceSearch } from "./deviceSearch";
import type { DevicesController } from "./DevicesFeature";

// D4: the legacy-release confirm dialog's state/handlers live here, next to its own trigger button and
// section heading, matching ProtectedNodes' own co-location of its disconnect confirm dialog. Replaces
// the window.confirm() this row's Release button used to call directly. The dialog element itself is
// portaled to document.body (see below) -- App.tsx keeps `main` inert by hand while it (or the seat-
// release dialog) is pending, and it must render outside `main`'s subtree or that inert would swallow
// the dialog along with the rest of the page.
export function DeviceRegistrations({ controller, query, project }: {
  controller: DevicesController;
  // D1: the page-level search box and the route's exact app filter, both owned by DevicesFeature.
  query: string; project: string | null;
}): React.ReactElement {
  const { devices, busy, deviceMessages: messages, pendingDeviceRelease: pending } = controller;
  const visible = devices.filter((item) => matchesDeviceSearch([item.device_key_id], item.project, query, project));
  return <section className="registrations">
    <section className="tablePane full">
      <h2 ref={controller.deviceRegistrationsHeadingRef} tabIndex={-1}>Activated devices (older app versions)</h2>
      <p>Registration time does not indicate whether a device is online.</p>
      {visible.length > 0 ? <table><thead><tr><th>Device ID</th><th>App</th><th>Feature</th><th>Registered</th><th>Action</th></tr></thead><tbody>
        {visible.map((item, index) => <tr key={`${item.device_key_id}/${index}`}>
          <td data-label="Device ID" className="identifier">{item.device_key_id}</td>
          <td data-label="App">{item.project}</td><td data-label="Feature">{item.feature}</td>
          <td data-label="Registered">{formatTimestamp(item.created_at)}</td>
          <td data-label="Action"><button disabled={busy} onClick={() => controller.requestDeviceRelease(item)}>{DEVICE_RELEASE_ACTION_LABEL}</button><ActionResult message={messages[item.device_key_id] ?? null} /></td>
        </tr>)}
      </tbody></table> : <div className="emptyState"><h3>No matching devices</h3><p>Try another device ID or app.</p></div>}
      {devices.length >= 500 && <p className="readNotice">Only the first 500 registrations are shown. More may exist.</p>}
    </section>
    {createPortal((
      <dialog
        ref={controller.deviceReleaseDialogRef}
        className="confirmDialog"
        aria-labelledby="deviceReleaseTitle"
        tabIndex={-1}
        onCancel={(event) => { event.preventDefault(); controller.dismissDeviceRelease(); }}
      >
        <h2 id="deviceReleaseTitle">{DEVICE_RELEASE_CONFIRM_TITLE}</h2>
        <p>{pending?.project} · {pending?.feature}<span className="retirementIdentity">Device ID: {pending?.device_key_id}</span></p>
        <p>{DEVICE_RELEASE_CONFIRM_COPY}</p>
        <div className="dialogActions">
          <button type="button" onClick={controller.dismissDeviceRelease}>Cancel</button>
          <button type="button" className="danger" onClick={() => void controller.confirmDeviceRelease()}>Confirm release</button>
        </div>
      </dialog>
    ), document.body)}
  </section>;
}
