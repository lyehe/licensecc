import React from "react";
import { createPortal } from "react-dom";
import {
  FLOATING_SEAT_RELEASE_CONFIRM_COPY,
  FLOATING_SEAT_RELEASE_CONFIRM_TITLE,
  formatTimestamp,
  licenseDisplayStatus,
} from "../../portalWorkflow";
import { ActionResult } from "../../shared/ActionResult";
import { useLicenseClock } from "../../shared/useLicenseClock";
import { matchesDeviceSearch } from "./deviceSearch";
import type { DevicesController } from "./DevicesFeature";

// The "Browser seats" section of the devices page (D1 hotspot budget: split out of
// DevicesFeature.tsx alongside the release dialog, which shares this file since both operate on
// the same controller.pendingSeatRelease state).
export function BrowserSeats({ controller, query, project }: {
  controller: DevicesController;
  // D1: the page-level search box and the route's exact app filter, both owned by DevicesFeature.
  query: string; project: string | null;
}): React.ReactElement | null {
  const now = useLicenseClock();
  // D2: once a seat has shown its own result, keep the panel expanded so that result stays visible
  // (and in the mobile viewport) rather than collapsing into a closed <details> the customer would
  // have to reopen to see it -- e.g. releasing the only live session used to always collapse this.
  const hasBrowserSession = Object.keys(controller.seatSessions).length > 0
    || controller.pendingSeatRelease !== null
    || Object.values(controller.seatMessages).some((message) => message !== null);
  const floatingEntitlements = controller.entitlements.filter((item) => item.license_mode === "floating");
  // D4 review (carried, Minor 1): keep the release dialog mounted while a release is pending even if
  // floatingEntitlements ever shrinks to zero in the meantime -- App.tsx keeps `main` inert for as
  // long as controller.pendingSeatRelease is set, and an inert main with no dialog left to close it
  // would strand the customer.
  if (floatingEntitlements.length === 0 && controller.pendingSeatRelease === null) return null;
  const visibleEntitlements = floatingEntitlements.filter((item) => matchesDeviceSearch(
    [item.feature, controller.seatSessions[item.id]?.seat_id],
    item.project,
    query,
    project,
  ));
  const seatGridContent = (
    <div className="seatGrid">
      <div className="seatHeading"><p>These controls manage seats created in this browser. They do not list or control native app sessions on other machines.</p></div>
      {visibleEntitlements.length === 0 ? (
        <div className="emptyState"><h3>No matching seats</h3><p>Try another name, seat ID or app.</p></div>
      ) : visibleEntitlements.map((item, index) => {
        const session = controller.seatSessions[item.id];
        // Carried from C5 (Minor 3b): the wire `status` alone is not enough to offer Start/Renew --
        // an expired or not-yet-valid floating license must not, even while status still says
        // "active" (it only flips once the backend enforces it on the next action).
        const licenseUsable = licenseDisplayStatus(item, now) === "active";
        return (
        <div
          className="seatCard"
          key={`seat/${item.id}/${index}`}
          ref={(element) => { controller.seatCardRefs.current[item.id] = element; }}
          tabIndex={-1}
        >
          <div>
            <strong>{item.project}</strong>
            <span className="muted"> / {item.feature}</span>
          </div>
          {/* D2: seat state visible -- what starting a seat means while none is held, and when the
              held one stops working once one is. D5 carried (decision 8): its own class, not
              `.muted` -- this is live state, not secondary copy. */}
          {session === undefined ? (
            <p className="seatState">Uses 1 of {item.pool_size} shared seats until released or it expires.</p>
          ) : session.expires_at > 0 ? (
            <p className="seatState">Active until {formatTimestamp(session.expires_at)}.</p>
          ) : null}
          <div className="actions">
            <button
              ref={(element) => { controller.seatStartButtonRefs.current[item.id] = element; }}
              disabled={controller.busy || !licenseUsable || session !== undefined}
              onClick={() => void controller.seatAction(item, "checkout")}
            >Start seat</button>
            <button disabled={controller.busy || !licenseUsable || session === undefined} onClick={() => void controller.seatAction(item, "heartbeat")}>Renew seat</button>
            <button
              ref={(element) => { controller.seatReleaseButtonRefs.current[item.id] = element; }}
              disabled={controller.busy || session === undefined}
              onClick={() => controller.requestSeatRelease(item)}
            >Release seat</button>
          </div>
          <ActionResult message={controller.seatMessages[item.id] ?? null} />
        </div>
        );
      })}
    </div>
  );
  return (
    <div>
      {hasBrowserSession ? (
        <section className="browserSessions" aria-labelledby="browser-sessions-heading">
          <h3
            id="browser-sessions-heading"
            ref={(element) => { controller.panelHeadingRef.current = element; }}
            tabIndex={-1}
          >Browser seats</h3>
          {seatGridContent}
          <SeatReleaseDialog controller={controller} />
        </section>
      ) : (
        <details className="browserSessions"><summary>Browser seats</summary>{seatGridContent}</details>
      )}
    </div>
  );
}

// D4: the native <dialog> pattern from nativeDialog.ts/ProtectedNodes.tsx (showModal()/close(), Escape
// via onCancel, focus returned to the "Browser seats" heading on close). Still portaled to
// document.body, same as the manual overlay it replaces -- App.tsx keeps `main` inert by hand while
// this dialog (or the device-release one) is pending (decision 4: a modal <dialog> alone does not
// reliably remove sibling content from the accessibility tree), and this dialog must therefore render
// OUTSIDE `main`'s subtree, or `main`'s own inert would swallow the dialog along with everything else.
function SeatReleaseDialog({ controller }: { controller: DevicesController }): React.ReactElement {
  const pending = controller.pendingSeatRelease;
  return createPortal((
    <dialog
      ref={controller.seatReleaseDialogRef}
      className="confirmDialog"
      aria-labelledby="floatingSeatReleaseTitle"
      aria-busy={controller.busy}
      tabIndex={-1}
      onCancel={(event) => { event.preventDefault(); controller.dismissSeatRelease(); }}
    >
      <h2 id="floatingSeatReleaseTitle">{FLOATING_SEAT_RELEASE_CONFIRM_TITLE}</h2>
      <p>{pending?.item.project} · {pending?.item.feature}<span className="retirementIdentity"><span>This browser</span>: <code>{pending?.session.client_instance_id}</code></span></p>
      <p>{FLOATING_SEAT_RELEASE_CONFIRM_COPY}</p>
      {controller.busy && <p role="status" aria-live="polite">Releasing…</p>}
      {controller.seatReleaseError !== null && <p role="alert">{controller.seatReleaseError}</p>}
      <div className="dialogActions">
        <button type="button" disabled={controller.busy} onClick={controller.dismissSeatRelease}>Cancel</button>
        <button type="button" className="danger" disabled={controller.busy || controller.seatReleaseOutcomeUnknown} onClick={() => void controller.confirmSeatRelease()}>Confirm release</button>
      </div>
    </dialog>
  ), document.body);
}
