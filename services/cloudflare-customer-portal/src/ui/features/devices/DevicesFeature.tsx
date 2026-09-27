import React, { useEffect, useRef, useState } from "react";
import { DeviceRegistrations } from "./DeviceRegistrations";
import { ProtectedNodes } from "./ProtectedNodes";
import { BrowserSeats } from "./BrowserSeats";
import { discardLegacyStoredSeats, randomHex, readStoredSeats, runSeatSignOutReleases, seatPath, writeStoredSeats } from "./seatStorage";
import { type PendingSeatRelease, useSeatReleaseDialog } from "./seatReleaseDialog";
import { useDeviceReleaseDialog } from "./deviceReleaseDialog";

import {
  FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE,
  hydrateSeatSessions,
  PORTAL_STATUS_REFRESH_ACTION_LABEL,
  serializeSeatSessions,
  type SeatSession,
} from "../../portalWorkflow";
import { api, localMessage, resultMessage } from "../../shared/api";
import type { DeviceRow, EntitlementRow, SeatActionResult, SeatOperation, StatusMessage } from "../../types";

export const DEVICES_REFRESH_FAILURE_CODE = FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE;
export const DEVICES_REFRESH_ACTION_LABEL = PORTAL_STATUS_REFRESH_ACTION_LABEL;

interface DeviceFeatureOptions {
  busy: boolean;
  busyRef: React.RefObject<boolean>;
  // D3: the signed-in customer id. Seats persist keyed by this id, re-hydrated on every change.
  customer: string;
  // D3 fix round 1 (Critical): a reactive session epoch (auth.sessionEpoch), bumped on every confirmed
  // sign-in -- including a re-sign-in as this SAME customer after a session-ending 401, when `customer`
  // itself never changes. Part of the hydrate effect's dependency array below alongside `customer`.
  sessionEpoch: number;
  devices: DeviceRow[];
  entitlements: EntitlementRow[];
  refreshData(): Promise<boolean>;
  runOnce(work: () => Promise<void>): Promise<void>;
  setMessage: React.Dispatch<React.SetStateAction<StatusMessage | null>>;
  // Fix round 2 (Important): bumped by App.tsx whenever the Devices page is entered or left. A ref,
  // read (never written) here, so seatAction()/confirmDeviceRelease() can compare "the generation when
  // this action started" against "the generation now" once their response arrives, and drop a result
  // that arrives after the customer has moved on -- see App.tsx's own comment for the full race.
  visitGenerationRef: React.RefObject<number>;
}

// Focus to move once a seat "start" action's re-render lands (the seat's session is now present). D4:
// releasing a seat no longer uses this mechanism -- the native seat-release dialog always returns
// focus to the "Browser seats" heading on close instead (seatReleaseDialog.ts).
interface PendingSeatFocus {
  seatId: string;
}

export interface DevicesController {
  busy: boolean;
  devices: DeviceRow[];
  entitlements: EntitlementRow[];
  pendingSeatRelease: PendingSeatRelease | null;
  seatReleaseError: string | null;
  seatReleaseOutcomeUnknown: boolean;
  // D4: the legacy-device-release confirmation's own pending target (parallels pendingSeatRelease).
  pendingDeviceRelease: DeviceRow | null;
  seatSessions: Record<string, SeatSession>;
  // D2: "show each result next to the control that produced it" -- each seat card's own
  // role="status" line (keyed by entitlement id) and each legacy device row's own (keyed by
  // device_key_id), populated by seatAction()/confirmDeviceRelease() below instead of the page-level
  // setMessage. The page-level line stays reserved for refresh/account-level results.
  seatMessages: Record<string, StatusMessage | null>;
  deviceMessages: Record<string, StatusMessage | null>;
  seatReleaseDialogRef: React.RefObject<HTMLDialogElement | null>;
  deviceReleaseDialogRef: React.RefObject<HTMLDialogElement | null>;
  deviceRegistrationsHeadingRef: React.RefObject<HTMLHeadingElement | null>;
  seatStartButtonRefs: React.RefObject<Record<string, HTMLButtonElement | null>>;
  seatReleaseButtonRefs: React.RefObject<Record<string, HTMLButtonElement | null>>;
  seatCardRefs: React.RefObject<Record<string, HTMLDivElement | null>>;
  panelHeadingRef: React.RefObject<HTMLElement | null>;
  seatAction(item: EntitlementRow, operation: SeatOperation): Promise<SeatActionResult>;
  requestSeatRelease(item: EntitlementRow): void;
  dismissSeatRelease(): void;
  confirmSeatRelease(): Promise<void>;
  requestDeviceRelease(item: DeviceRow): void;
  dismissDeviceRelease(): void;
  confirmDeviceRelease(): Promise<void>;
  // D3: sign-out's best-effort seat release (App.tsx's logout(), before the actual sign-out request).
  releaseSeatsOnSignOut(): Promise<{ released: number; failed: number }>;
  clear(): void;
  // Fix round 1 (Important): seatMessages/deviceMessages live here, one level above DevicesFeature,
  // so they otherwise outlive a visit to the Devices page (DevicesFeature only renders while
  // location.page === "nodes") -- a stale "Seat started." would reappear in a freshly mounted
  // role="status" node on a later visit, and keep the seat panel expanded forever (hasBrowserSession
  // in BrowserSeats.tsx reads seatMessages too). App.tsx calls this when the Devices page is left, so
  // only the CURRENT visit's results ever show; seatSessions/pendingSeatRelease/etc. are untouched --
  // those are meant to survive navigation.
  clearMessages(): void;
}

// Verify-then-fallback focus: try the primary target (skipping a disabled button), then the
// secondary target if the primary did not actually take focus, then the fallback if neither did
// (activeElement still null/BODY). Used by the pending-seat-focus effect below, which moves focus
// after a seat start or release remounts the browser-sessions panel.
function focusFirstAvailable(
  primary: HTMLElement | null | undefined,
  secondary: HTMLElement | null | undefined,
  fallback: HTMLElement | null | undefined,
): void {
  if (primary != null && !(primary instanceof HTMLButtonElement && primary.disabled)) primary.focus();
  if (document.activeElement !== primary) secondary?.focus();
  if (document.activeElement === null || document.activeElement === document.body) fallback?.focus();
}

export function useDevicesController(options: DeviceFeatureOptions): DevicesController {
  const { busy, busyRef, customer, devices, entitlements, refreshData, runOnce, sessionEpoch, setMessage, visitGenerationRef } = options;
  // D3: seeded empty rather than hydrated eagerly -- `customer` is not yet known at PortalShell's very
  // first render (auth starts as "loading"), so hydration happens in the effect below, keyed to the
  // customer id once a sign-in actually resolves.
  const [seatSessions, setSeatSessionsRaw] = useState<Record<string, SeatSession>>({});
  const [pendingSeatFocus, setPendingSeatFocus] = useState<PendingSeatFocus | null>(null);
  const [seatMessages, setSeatMessages] = useState<Record<string, StatusMessage | null>>({});
  const [deviceMessages, setDeviceMessages] = useState<Record<string, StatusMessage | null>>({});
  const seatStartButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const seatReleaseButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const seatCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const panelHeadingRef = useRef<HTMLElement | null>(null);

  // D3 (decision 4) / fix round 1 (Critical): re-hydrate on the initial sign-in, a later customer
  // switch, OR a re-sign-in as the SAME customer after a session-ending 401 -- the third case is why
  // sessionEpoch is a dependency too: a session-ending 401 never nulls `customer` (only an explicit
  // sign-out does), so re-signing in as the same customer changes sessionEpoch but not `customer`, and
  // without it this effect would never re-run, leaving a still-server-held seat unlisted.
  useEffect(() => {
    if (customer === "") return;
    discardLegacyStoredSeats();
    setSeatSessionsRaw(hydrateSeatSessions(readStoredSeats(customer), Math.floor(Date.now() / 1000)));
  }, [customer, sessionEpoch]);

  function setSeatSessions(update: React.SetStateAction<Record<string, SeatSession>>): void {
    setSeatSessionsRaw((current) => {
      const next = typeof update === "function"
        ? update(current)
        : update;
      if (customer !== "") writeStoredSeats(customer, serializeSeatSessions(next));
      return next;
    });
  }

  // D2: this seat's own role="status" line -- checkout/heartbeat/release results, and the guards
  // below, all route here instead of the page-level setMessage.
  function setSeatMessage(entitlementId: string, seatMessage: StatusMessage | null): void {
    setSeatMessages((current) => ({ ...current, [entitlementId]: seatMessage }));
  }

  async function seatAction(item: EntitlementRow, operation: SeatOperation): Promise<SeatActionResult> {
    let succeeded = false;
    let refreshFailed = false;
    let checkedOut = false;
    let networkFailure = false;
    // Fix round 2 (Important): captured before the request goes out (and before runOnce may queue
    // it), so a response that arrives after the customer has left (and possibly returned to) Devices
    // can be told apart from one that arrives while they are still on this same visit.
    const startGeneration = visitGenerationRef.current;
    await runOnce(async () => {
      const existing = seatSessions[item.id];
      if ((operation === "heartbeat" || operation === "release") && existing === undefined) {
        setSeatMessage(item.id, localMessage("seat_not_checked_out", false));
        return;
      }
      const clientInstanceId = existing?.client_instance_id ?? crypto.randomUUID();
      const body: Record<string, string> = {
        entitlement_id: item.id,
        client_instance_id: clientInstanceId,
        nonce: randomHex(32),
      };
      if (existing !== undefined) body.seat_id = existing.seat_id;
      const result = await api<Record<string, unknown>>(seatPath(operation), {
        method: "POST",
        body: JSON.stringify(body),
      });
      // The visit has moved on since this action started: the real outcome below (session/storage/
      // refresh) still applies, but this result must not write into a map the customer is no longer
      // looking at, or reappear as if it belonged to a later visit.
      if (visitGenerationRef.current === startGeneration) setSeatMessage(item.id, resultMessage(result));
      const resultData = result.data;
      const leaseExpiresAt = typeof resultData?.expires_at === "number" ? resultData.expires_at : 0;
      const seatId = typeof resultData?.seat_id === "string" ? resultData.seat_id : null;
      if (!result.ok) {
        networkFailure = result.code === "network_unavailable";
        return;
      }
      if (operation === "checkout" && seatId !== null) {
        setSeatSessions((current) => ({
          ...current,
          [item.id]: { seat_id: seatId, client_instance_id: clientInstanceId, expires_at: leaseExpiresAt },
        }));
        checkedOut = true;
      }
      if (operation === "heartbeat" && existing !== undefined) {
        setSeatSessions((current) => {
          const prior = current[item.id];
          return prior === undefined ? current : { ...current, [item.id]: { ...prior, expires_at: leaseExpiresAt } };
        });
      }
      if (operation === "release") {
        setSeatSessions((current) => {
          const next = { ...current };
          delete next[item.id];
          return next;
        });
        succeeded = true;
        try {
          if (!(await refreshData())) refreshFailed = true;
        } catch {
          refreshFailed = true;
        }
        return;
      }
      await refreshData();
      succeeded = true;
    }).finally(() => {
      // Set after runOnce settles (busy has cleared) so the seat's Release button is enabled, and
      // thus focusable, by the time the start-focus effect below runs; a checkout whose follow-up
      // refresh throws still moves focus onto the seat.
      if (checkedOut) setPendingSeatFocus({ seatId: item.id });
    });
    return { succeeded, refreshFailed, networkFailure };
  }

  // D3 fix round 1 (Important 3, hotspot budget): the release confirm dialog's own state, mutation and
  // focus management now live in seatReleaseDialog.ts -- see its own header comment. No behaviour
  // change: this hook still owns seatSessions/seatAction/setMessage, which the dialog flow reaches
  // through these options. D4: focus-on-close now goes straight to panelHeadingRef (passed in as
  // headingRef) via the native dialog pattern, so setPendingSeatFocus is no longer threaded into it.
  const seatReleaseDialog = useSeatReleaseDialog({
    busyRef,
    seatSessions,
    seatAction,
    setSeatMessage,
    setMessage,
    headingRef: panelHeadingRef,
  });

  useEffect(() => {
    if (pendingSeatFocus === null) return;
    const { seatId } = pendingSeatFocus;
    if (seatSessions[seatId] === undefined) return;
    // Starting a floating seat flips hasBrowserSession and remounts the seat grid (<details> ->
    // <section>), so the just-clicked Start seat button is unmounted and focus would otherwise
    // drop to <body>. Land it on the seat's own Release button or card, falling back to the
    // panel's now-visible heading.
    focusFirstAvailable(seatReleaseButtonRefs.current[seatId], seatCardRefs.current[seatId], panelHeadingRef.current);
    setPendingSeatFocus(null);
  }, [pendingSeatFocus, seatSessions]);

  // D2: this device row's own role="status" line, keyed by device_key_id (a device row has no more
  // stable id than that -- the same key DeviceRegistrations already keys its buttons by).
  function setDeviceMessage(deviceKeyId: string, deviceMessage: StatusMessage | null): void {
    setDeviceMessages((current) => ({ ...current, [deviceKeyId]: deviceMessage }));
  }

  // D4: the legacy-release confirmation, replacing window.confirm with the same native <dialog>
  // pattern as the seat release above -- see deviceReleaseDialog.ts's own header comment.
  const deviceReleaseDialog = useDeviceReleaseDialog({
    visitGenerationRef,
    runOnce,
    refreshData,
    setDeviceMessage,
  });

  // D3: sign-out's best-effort seat release, called BEFORE the actual sign-out request. A released
  // seat is removed from seatSessions (and storage, via setSeatSessions above) like a manual release;
  // a failed one is left in place so it survives clear() below and is offered again after re-sign-in.
  async function releaseSeatsOnSignOut(): Promise<{ released: number; failed: number }> {
    const { released, failed } = await runSeatSignOutReleases(seatSessions);
    if (released.length > 0) {
      setSeatSessions((current) => {
        const next = { ...current };
        for (const entitlementId of released) delete next[entitlementId];
        return next;
      });
    }
    return { released: released.length, failed: failed.length };
  }

  // Fix round 1 (CRITICAL) / D3: resets in-memory state only, never storage -- releaseSeatsOnSignOut()
  // may have just written a failed release there, which must survive this call (decision 2).
  function clear(): void {
    setSeatSessionsRaw({});
    seatReleaseDialog.resetForClear();
    deviceReleaseDialog.resetForClear();
    setPendingSeatFocus(null);
    setSeatMessages({});
    setDeviceMessages({});
  }

  // Fix round 1 (Important): called from App.tsx when the Devices page is left, so a stale local
  // result never reappears on a later visit. Deliberately narrower than clear() -- seatSessions and
  // everything else about the live seat state survive navigation, only the shown RESULTS do not.
  function clearMessages(): void {
    setSeatMessages({});
    setDeviceMessages({});
  }

  return {
    busy,
    devices,
    entitlements,
    pendingSeatRelease: seatReleaseDialog.pendingSeatRelease,
    seatReleaseError: seatReleaseDialog.seatReleaseError,
    seatReleaseOutcomeUnknown: seatReleaseDialog.seatReleaseOutcomeUnknown,
    pendingDeviceRelease: deviceReleaseDialog.pendingDeviceRelease,
    seatSessions,
    seatMessages,
    deviceMessages,
    seatReleaseDialogRef: seatReleaseDialog.seatReleaseDialogRef,
    deviceReleaseDialogRef: deviceReleaseDialog.deviceReleaseDialogRef,
    deviceRegistrationsHeadingRef: deviceReleaseDialog.deviceRegistrationsHeadingRef,
    seatStartButtonRefs,
    seatReleaseButtonRefs,
    seatCardRefs,
    panelHeadingRef,
    seatAction,
    requestSeatRelease: seatReleaseDialog.requestSeatRelease,
    dismissSeatRelease: seatReleaseDialog.dismissSeatRelease,
    confirmSeatRelease: seatReleaseDialog.confirmSeatRelease,
    requestDeviceRelease: deviceReleaseDialog.requestDeviceRelease,
    dismissDeviceRelease: deviceReleaseDialog.dismissDeviceRelease,
    confirmDeviceRelease: deviceReleaseDialog.confirmDeviceRelease,
    releaseSeatsOnSignOut,
    clear,
    clearMessages,
  };
}

// D1: one devices page in customer terms. This is now the single page-level owner for Connected
// devices, Activated devices (older app versions) and Browser seats: it owns the one search box
// above all three sections and the route's exact app filter (shown as a removable "App: {project}"
// chip), and passes both down. Connected devices loads and paginates independently of the
// entitlements/devices read that gates the other two sections, so it always renders regardless of
// accountDataState -- matching the previous behaviour where a legacy-data failure never blocked
// connected-device management.
export function DevicesFeature({
  controller,
  customer,
  busy,
  runOnce,
  onSessionExpired,
  project,
  accountDataState,
  onRetryAccountData,
}: {
  controller: DevicesController;
  customer: string;
  busy: boolean;
  runOnce(work: () => Promise<void>): Promise<void>;
  onSessionExpired(): Promise<boolean>;
  project: string | null;
  accountDataState: "loading" | "ready" | "error";
  onRetryAccountData(): Promise<void>;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  return (
    <div>
      <div className="pageHeading"><div><h1>Devices</h1><p>Manage the devices using your licenses.</p></div></div>
      <div className="filterBar">
        <label>Find a device<input type="search" placeholder="Search by name, ID or app" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        {project !== null && <p className="appFilterChip">App: {project} <a href="#/nodes">Show all apps</a></p>}
      </div>
      <ProtectedNodes customer={customer} busy={busy} runOnce={runOnce} onSessionExpired={onSessionExpired} query={query} project={project} />
      {accountDataState !== "ready" ? (
        <section className="emptyState">
          <h2>Registered machines unavailable</h2>
          <p>{accountDataState === "loading" ? "Fetching your licenses and devices." : "We could not refresh your account. Retry to see current access."}</p>
          {accountDataState === "error" && <button disabled={busy} onClick={() => void onRetryAccountData()}>Retry</button>}
        </section>
      ) : (
        <>
          {controller.devices.length > 0 && <DeviceRegistrations controller={controller} query={query} project={project} />}
          <BrowserSeats controller={controller} query={query} project={project} />
        </>
      )}
    </div>
  );
}
