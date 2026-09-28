import React from "react";
import {
  DEVICE_RELEASE_CONFIRM_COPY,
  DEVICE_RELEASE_CONFIRM_TITLE,
  FLOATING_SEAT_RELEASE_CONFIRM_COPY,
  FLOATING_SEAT_RELEASE_CONFIRM_TITLE,
} from "../../portalWorkflow";
import type { DevicesController } from "./DevicesFeature";

// The two release confirmations of the Devices page (a seat's Release seat, and an activated device's
// Release). App.tsx renders them next to `main`, not inside the Devices page, for two reasons:
//
// - `main` is made inert and aria-hidden by hand while either is pending (a modal <dialog> alone does
//   not reliably take the rest of the page out of the accessibility tree or out of scripted-click
//   reach), so a dialog inside `main` would be made inert along with it;
// - their pending state lives in the device controller, which outlives the Devices page. Browser Back
//   and Forward are not blocked by that inert `main`, so a dialog owned by the Devices page would
//   unmount on Back while `main` stayed inert, leaving nothing on screen that could close it.
//
// Rendered from App, each dialog stays open and usable on whatever page history navigation lands on,
// and every way of closing it clears the pending state that keeps `main` inert. Opening, closing and
// the return of focus follow the native <dialog> pattern in nativeDialog.ts; Escape goes through
// onCancel to the same dismiss as the Cancel button, so a request in flight can refuse it.
export function ReleaseDialogs({ controller }: { controller: DevicesController }): React.ReactElement {
  const seat = controller.pendingSeatRelease;
  const device = controller.pendingDeviceRelease;
  return (
    <>
      <dialog
        ref={controller.seatReleaseDialogRef}
        className="confirmDialog"
        aria-labelledby="floatingSeatReleaseTitle"
        aria-busy={controller.busy}
        tabIndex={-1}
        onCancel={(event) => { event.preventDefault(); controller.dismissSeatRelease(); }}
      >
        <h2 id="floatingSeatReleaseTitle">{FLOATING_SEAT_RELEASE_CONFIRM_TITLE}</h2>
        <p>{seat?.item.project} · {seat?.item.feature}<span className="retirementIdentity"><span>This browser</span>: <code>{seat?.session.client_instance_id}</code></span></p>
        <p>{FLOATING_SEAT_RELEASE_CONFIRM_COPY}</p>
        {controller.busy && <p role="status" aria-live="polite">Releasing…</p>}
        {controller.seatReleaseError !== null && <p role="alert">{controller.seatReleaseError}</p>}
        <div className="dialogActions">
          <button type="button" disabled={controller.busy} onClick={controller.dismissSeatRelease}>Cancel</button>
          <button type="button" className="danger" disabled={controller.busy || controller.seatReleaseOutcomeUnknown} onClick={() => void controller.confirmSeatRelease()}>Confirm release</button>
        </div>
      </dialog>
      <dialog
        ref={controller.deviceReleaseDialogRef}
        className="confirmDialog"
        aria-labelledby="deviceReleaseTitle"
        tabIndex={-1}
        onCancel={(event) => { event.preventDefault(); controller.dismissDeviceRelease(); }}
      >
        <h2 id="deviceReleaseTitle">{DEVICE_RELEASE_CONFIRM_TITLE}</h2>
        <p>{device?.project} · {device?.feature}<span className="retirementIdentity">Device ID: {device?.device_key_id}</span></p>
        <p>{DEVICE_RELEASE_CONFIRM_COPY}</p>
        <div className="dialogActions">
          <button type="button" onClick={controller.dismissDeviceRelease}>Cancel</button>
          <button type="button" className="danger" onClick={() => void controller.confirmDeviceRelease()}>Confirm release</button>
        </div>
      </dialog>
    </>
  );
}
