import React, { useEffect, useRef, useState } from "react";
import { DeviceRegistrations } from "./DeviceRegistrations";
import { ProtectedNodes } from "./ProtectedNodes";
import { BrowserSeats } from "./BrowserSeats";
import { randomHex, readStoredSeats, seatPath, writeStoredSeats } from "./seatStorage";

import {
  DEVICE_RELEASE_CONFIRM_COPY,
  deviceReleasePath,
  FLOATING_SEAT_RELEASE_NETWORK_ERROR_COPY,
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
  devices: DeviceRow[];
  entitlements: EntitlementRow[];
  refreshData(): Promise<boolean>;
  runOnce(work: () => Promise<void>): Promise<void>;
  setMessage: React.Dispatch<React.SetStateAction<StatusMessage | null>>;
}

interface PendingSeatRelease {
  item: EntitlementRow;
  session: SeatSession;
}

// Focus to move once a seat action's re-render lands: after "start" the seat's session is present,
// after "release" it is gone (and the release dialog has closed).
interface PendingSeatFocus {
  seatId: string;
  after: "start" | "release";
}

export interface DevicesController {
  busy: boolean;
  devices: DeviceRow[];
  entitlements: EntitlementRow[];
  pendingSeatRelease: PendingSeatRelease | null;
  seatReleaseError: string | null;
  seatReleaseOutcomeUnknown: boolean;
  seatSessions: Record<string, SeatSession>;
  // D2: "show each result next to the control that produced it" -- each seat card's own
  // role="status" line (keyed by entitlement id) and each legacy device row's own (keyed by
  // device_key_id), populated by seatAction()/releaseDevice() below instead of the page-level
  // setMessage. The page-level line stays reserved for refresh/account-level results.
  seatMessages: Record<string, StatusMessage | null>;
  deviceMessages: Record<string, StatusMessage | null>;
  seatReleaseDialogRef: React.RefObject<HTMLDivElement | null>;
  seatStartButtonRefs: React.RefObject<Record<string, HTMLButtonElement | null>>;
  seatReleaseButtonRefs: React.RefObject<Record<string, HTMLButtonElement | null>>;
  seatCardRefs: React.RefObject<Record<string, HTMLDivElement | null>>;
  browserSessionsSummaryRef: React.RefObject<HTMLElement | null>;
  panelHeadingRef: React.RefObject<HTMLElement | null>;
  seatAction(item: EntitlementRow, operation: SeatOperation): Promise<SeatActionResult>;
  requestSeatRelease(item: EntitlementRow): void;
  dismissSeatRelease(): void;
  confirmSeatRelease(): Promise<void>;
  releaseDevice(item: DeviceRow): Promise<void>;
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
  const { busy, busyRef, devices, entitlements, refreshData, runOnce, setMessage } = options;
  const [seatSessions, setSeatSessionsRaw] = useState<Record<string, SeatSession>>(
    () => hydrateSeatSessions(readStoredSeats(), Math.floor(Date.now() / 1000)),
  );
  const [pendingSeatRelease, setPendingSeatRelease] = useState<PendingSeatRelease | null>(null);
  const [seatReleaseError, setSeatReleaseError] = useState<string | null>(null);
  const [seatReleaseOutcomeUnknown, setSeatReleaseOutcomeUnknown] = useState(false);
  const [pendingSeatFocus, setPendingSeatFocus] = useState<PendingSeatFocus | null>(null);
  const [seatMessages, setSeatMessages] = useState<Record<string, StatusMessage | null>>({});
  const [deviceMessages, setDeviceMessages] = useState<Record<string, StatusMessage | null>>({});
  const seatReleaseDialogRef = useRef<HTMLDivElement>(null);
  const seatReleaseReturnFocusRef = useRef<HTMLElement | null>(null);
  const seatReleaseDeferredFocusRef = useRef<HTMLElement | null>(null);
  const seatReleaseConfirmingRef = useRef(false);
  const seatStartButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const seatReleaseButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const seatCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const browserSessionsSummaryRef = useRef<HTMLElement | null>(null);
  const panelHeadingRef = useRef<HTMLElement | null>(null);

  function setSeatSessions(update: React.SetStateAction<Record<string, SeatSession>>): void {
    setSeatSessionsRaw((current) => {
      const next = typeof update === "function"
        ? update(current)
        : update;
      writeStoredSeats(serializeSeatSessions(next));
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
      setSeatMessage(item.id, resultMessage(result));
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
      if (checkedOut) setPendingSeatFocus({ seatId: item.id, after: "start" });
    });
    return { succeeded, refreshFailed, networkFailure };
  }

  function requestSeatRelease(item: EntitlementRow): void {
    if (busyRef.current) return;
    const session = seatSessions[item.id];
    if (session === undefined) {
      setSeatMessage(item.id, localMessage("seat_not_checked_out", false));
      return;
    }
    seatReleaseReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSeatReleaseError(null);
    setSeatReleaseOutcomeUnknown(false);
    setPendingSeatRelease({ item, session });
  }

  function dismissSeatRelease(): void {
    if (seatReleaseConfirmingRef.current) return;
    setSeatReleaseError(null);
    setSeatReleaseOutcomeUnknown(false);
    setPendingSeatRelease(null);
    seatReleaseDeferredFocusRef.current = seatReleaseReturnFocusRef.current;
    seatReleaseReturnFocusRef.current = null;
  }

  async function confirmSeatRelease(): Promise<void> {
    const pending = pendingSeatRelease;
    if (pending === null || seatReleaseConfirmingRef.current || busyRef.current) return;
    const returnFocus = seatReleaseReturnFocusRef.current;
    seatReleaseConfirmingRef.current = true;
    setSeatReleaseError(null);
    seatReleaseDialogRef.current?.focus();
    let closeDialog = false;
    try {
      const outcome = await seatAction(pending.item, "release");
      if (outcome.succeeded) {
        setPendingSeatFocus({ seatId: pending.item.id, after: "release" });
        if (outcome.refreshFailed) setMessage(localMessage(FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE, false));
        setPendingSeatRelease(null);
        closeDialog = true;
      } else if (outcome.networkFailure) {
        // api() no longer throws for a dropped connection (task C2) -- it reports network_unavailable
        // like any other failure code. A release specifically cannot treat that as an ordinary
        // failure: whether the server released the seat before the connection dropped is unknown, so
        // this stays open with the same "outcome is unknown" guidance a thrown exception used to
        // produce here, rather than silently closing as if the release had simply been refused.
        setSeatReleaseError(FLOATING_SEAT_RELEASE_NETWORK_ERROR_COPY);
        setSeatReleaseOutcomeUnknown(true);
        seatReleaseDialogRef.current?.focus();
      } else {
        seatReleaseDeferredFocusRef.current = returnFocus;
        setPendingSeatRelease(null);
        closeDialog = true;
      }
    } catch {
      // Defensive: nothing on this path is expected to throw anymore (api() itself no longer does),
      // but if something truly unexpected does, treat it exactly like the network-failure branch
      // above -- the outcome is equally unknown either way.
      setSeatReleaseError(FLOATING_SEAT_RELEASE_NETWORK_ERROR_COPY);
      setSeatReleaseOutcomeUnknown(true);
      seatReleaseDialogRef.current?.focus();
    } finally {
      seatReleaseConfirmingRef.current = false;
      if (closeDialog) seatReleaseReturnFocusRef.current = null;
    }
  }

  useEffect(() => {
    if (pendingSeatRelease === null) return;
    const dialog = seatReleaseDialogRef.current;
    if (dialog === null) return;
    const selector = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])";
    const focusable = (): HTMLElement[] => Array.from(dialog.querySelectorAll<HTMLElement>(selector));
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !seatReleaseConfirmingRef.current) {
        event.preventDefault();
        dismissSeatRelease();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingSeatRelease]);

  useEffect(() => {
    if (pendingSeatRelease !== null) return;
    const deferredFocus = seatReleaseDeferredFocusRef.current;
    if (deferredFocus !== null) {
      seatReleaseDeferredFocusRef.current = null;
      deferredFocus.focus();
    }
  }, [pendingSeatRelease]);

  useEffect(() => {
    if (pendingSeatFocus === null) return;
    const { seatId, after } = pendingSeatFocus;
    const hasSession = seatSessions[seatId] !== undefined;
    if (after === "start") {
      if (!hasSession) return;
      // Starting a floating seat flips hasBrowserSession and remounts the seat grid (<details> ->
      // <section>), so the just-clicked Start seat button is unmounted and focus would otherwise
      // drop to <body>. Land it on the seat's own Release button or card, falling back to the
      // panel's now-visible heading.
      focusFirstAvailable(seatReleaseButtonRefs.current[seatId], seatCardRefs.current[seatId], panelHeadingRef.current);
    } else {
      if (hasSession || pendingSeatRelease !== null) return;
      // Releasing the last live browser session used to always collapse the panel into a closed
      // <details>; since D2 the panel now also stays open for a seat with a fresh local result to
      // show (its own release/checkout copy), which is normally the case right after a release, so
      // the re-enabled Start seat button usually takes focus directly. The <summary> fallback still
      // covers the case where the panel really has collapsed (e.g. after a later page reload) and
      // neither the start button nor the card can take focus.
      focusFirstAvailable(seatStartButtonRefs.current[seatId], seatCardRefs.current[seatId], browserSessionsSummaryRef.current);
    }
    setPendingSeatFocus(null);
  }, [entitlements, pendingSeatFocus, pendingSeatRelease, seatSessions]);

  // D2: this device row's own role="status" line, keyed by device_key_id (a device row has no more
  // stable id than that -- the same key DeviceRegistrations already keys its buttons by).
  function setDeviceMessage(deviceKeyId: string, deviceMessage: StatusMessage | null): void {
    setDeviceMessages((current) => ({ ...current, [deviceKeyId]: deviceMessage }));
  }

  async function releaseDevice(item: DeviceRow): Promise<void> {
    if (!window.confirm(DEVICE_RELEASE_CONFIRM_COPY)) return;
    await runOnce(async () => {
      const result = await api<Record<string, unknown>>(deviceReleasePath(), {
        method: "POST",
        body: JSON.stringify({ device_key_id: item.device_key_id }),
      });
      setDeviceMessage(item.device_key_id, resultMessage(result));
      if (result.ok) await refreshData();
    });
  }

  function clear(): void {
    setSeatSessions({});
    setPendingSeatRelease(null);
    setSeatReleaseError(null);
    setSeatReleaseOutcomeUnknown(false);
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
    pendingSeatRelease,
    seatReleaseError,
    seatReleaseOutcomeUnknown,
    seatSessions,
    seatMessages,
    deviceMessages,
    seatReleaseDialogRef,
    seatStartButtonRefs,
    seatReleaseButtonRefs,
    seatCardRefs,
    browserSessionsSummaryRef,
    panelHeadingRef,
    seatAction,
    requestSeatRelease,
    dismissSeatRelease,
    confirmSeatRelease,
    releaseDevice,
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
          {controller.devices.length > 0 && <DeviceRegistrations devices={controller.devices} busy={controller.busy} releaseDevice={controller.releaseDevice} messages={controller.deviceMessages} query={query} project={project} />}
          <BrowserSeats controller={controller} query={query} project={project} />
        </>
      )}
    </div>
  );
}
