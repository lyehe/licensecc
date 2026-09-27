import React from "react";
import { createPortal } from "react-dom";
import {
  FLOATING_SEAT_RELEASE_CONFIRM_COPY,
  FLOATING_SEAT_RELEASE_CONFIRM_TITLE,
  formatTimestamp,
  licenseDisplayStatus,
  shortHash,
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
  if (floatingEntitlements.length === 0) return null;
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
              held one stops working once one is. */}
          {session === undefined ? (
            <p className="muted">Uses 1 of {item.pool_size} shared seats until released or it expires.</p>
          ) : session.expires_at > 0 ? (
            <p className="muted">Active until {formatTimestamp(session.expires_at)}.</p>
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
        </section>
      ) : (
        <details className="browserSessions"><summary ref={(element) => { controller.browserSessionsSummaryRef.current = element; }}>Browser seats</summary>{seatGridContent}</details>
      )}
    </div>
  );
}

export function SeatReleaseDialog({ controller }: { controller: DevicesController }): React.ReactElement | null {
  const pending = controller.pendingSeatRelease;
  if (pending === null) return null;
  return createPortal((
    <div className="modalOverlay" role="presentation">
      <div
        ref={controller.seatReleaseDialogRef}
        className="modal danger"
        role="dialog"
        aria-modal="true"
        aria-labelledby="floatingSeatReleaseTitle"
        aria-describedby="floatingSeatReleaseDescription"
        aria-busy={controller.busy}
        tabIndex={-1}
      >
        <h2 id="floatingSeatReleaseTitle">{FLOATING_SEAT_RELEASE_CONFIRM_TITLE}</h2>
        <p id="floatingSeatReleaseDescription">{FLOATING_SEAT_RELEASE_CONFIRM_COPY}</p>
        {controller.busy && <p className="modalProgress" role="status" aria-live="polite">Releasing…</p>}
        {controller.seatReleaseError !== null && <p className="modalError" role="alert">{controller.seatReleaseError}</p>}
        <dl className="releaseContext">
          <div><dt>License</dt><dd>{pending.item.project} / {pending.item.feature}</dd></div>
          <div><dt>License fingerprint</dt><dd><code>{pending.item.license_fingerprint ? shortHash(pending.item.license_fingerprint) : "-"}</code></dd></div>
          <div><dt>Seat</dt><dd><code>{pending.session.seat_id}</code></dd></div>
          <div><dt>This browser</dt><dd><code>{pending.session.client_instance_id}</code></dd></div>
        </dl>
        <div className="actions">
          <button type="button" disabled={controller.busy} onClick={controller.dismissSeatRelease}>Cancel</button>
          <button type="button" className="danger" disabled={controller.busy || controller.seatReleaseOutcomeUnknown} onClick={() => void controller.confirmSeatRelease()}>Confirm release</button>
        </div>
      </div>
    </div>
  ), document.body);
}
