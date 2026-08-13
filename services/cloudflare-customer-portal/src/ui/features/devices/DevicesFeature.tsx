import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  checkoutPath,
  DEVICE_RELEASE_ACTION_LABEL,
  DEVICE_RELEASE_CONFIRM_COPY,
  deviceReleasePath,
  FLOATING_SEAT_RELEASE_CONFIRM_COPY,
  FLOATING_SEAT_RELEASE_CONFIRM_TITLE,
  FLOATING_SEAT_RELEASE_NETWORK_ERROR_COPY,
  FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE,
  formatTimestamp,
  heartbeatPath,
  hydrateSeatSessions,
  NO_DEVICES_EMPTY_COPY,
  PORTAL_STATUS_REFRESH_ACTION_LABEL,
  releasePath,
  SEATS_KEY,
  serializeSeatSessions,
  shortHash,
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

export interface DevicesController {
  busy: boolean;
  devices: DeviceRow[];
  entitlements: EntitlementRow[];
  pendingSeatRelease: PendingSeatRelease | null;
  seatReleaseError: string | null;
  seatReleaseOutcomeUnknown: boolean;
  seatSessions: Record<string, SeatSession>;
  seatReleaseDialogRef: React.RefObject<HTMLDivElement | null>;
  seatStartButtonRefs: React.RefObject<Record<string, HTMLButtonElement | null>>;
  seatCardRefs: React.RefObject<Record<string, HTMLDivElement | null>>;
  seatAction(item: EntitlementRow, operation: SeatOperation): Promise<SeatActionResult>;
  requestSeatRelease(item: EntitlementRow): void;
  dismissSeatRelease(): void;
  confirmSeatRelease(): Promise<void>;
  releaseDevice(item: DeviceRow): Promise<void>;
  clear(): void;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function seatPath(operation: SeatOperation): string {
  if (operation === "checkout") return checkoutPath();
  if (operation === "heartbeat") return heartbeatPath();
  return releasePath();
}

function readStoredSeats(): string | null {
  try {
    return window.localStorage.getItem(SEATS_KEY);
  } catch {
    return null;
  }
}

function writeStoredSeats(json: string): void {
  try {
    window.localStorage.setItem(SEATS_KEY, json);
  } catch {
    // Storage is best-effort. The in-memory map remains authoritative for this page lifetime.
  }
}

export function useDevicesController(options: DeviceFeatureOptions): DevicesController {
  const { busy, busyRef, devices, entitlements, refreshData, runOnce, setMessage } = options;
  const [seatSessions, setSeatSessionsRaw] = useState<Record<string, SeatSession>>(
    () => hydrateSeatSessions(readStoredSeats(), Math.floor(Date.now() / 1000)),
  );
  const [pendingSeatRelease, setPendingSeatRelease] = useState<PendingSeatRelease | null>(null);
  const [seatReleaseError, setSeatReleaseError] = useState<string | null>(null);
  const [seatReleaseOutcomeUnknown, setSeatReleaseOutcomeUnknown] = useState(false);
  const [seatReleaseFocusId, setSeatReleaseFocusId] = useState<string | null>(null);
  const seatReleaseDialogRef = useRef<HTMLDivElement>(null);
  const seatReleaseReturnFocusRef = useRef<HTMLElement | null>(null);
  const seatReleaseDeferredFocusRef = useRef<HTMLElement | null>(null);
  const seatReleaseConfirmingRef = useRef(false);
  const seatStartButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const seatCardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  function setSeatSessions(update: React.SetStateAction<Record<string, SeatSession>>): void {
    setSeatSessionsRaw((current) => {
      const next = typeof update === "function"
        ? (update as (previous: Record<string, SeatSession>) => Record<string, SeatSession>)(current)
        : update;
      writeStoredSeats(serializeSeatSessions(next));
      return next;
    });
  }

  async function seatAction(item: EntitlementRow, operation: SeatOperation): Promise<SeatActionResult> {
    let succeeded = false;
    let refreshFailed = false;
    await runOnce(async () => {
      const existing = seatSessions[item.id];
      if ((operation === "heartbeat" || operation === "release") && existing === undefined) {
        setMessage(localMessage("seat_not_checked_out", false));
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
      setMessage(resultMessage(result));
      const resultData = result.data;
      const leaseExpiresAt = typeof resultData?.expires_at === "number" ? resultData.expires_at : 0;
      const seatId = typeof resultData?.seat_id === "string" ? resultData.seat_id : null;
      if (!result.ok) return;
      if (operation === "checkout" && seatId !== null) {
        setSeatSessions((current) => ({
          ...current,
          [item.id]: { seat_id: seatId, client_instance_id: clientInstanceId, expires_at: leaseExpiresAt },
        }));
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
    });
    return { succeeded, refreshFailed };
  }

  function requestSeatRelease(item: EntitlementRow): void {
    if (busyRef.current) return;
    const session = seatSessions[item.id];
    if (session === undefined) {
      setMessage(localMessage("seat_not_checked_out", false));
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
      try {
        const outcome = await seatAction(pending.item, "release");
        if (outcome.succeeded) {
          setSeatReleaseFocusId(pending.item.id);
          if (outcome.refreshFailed) setMessage(localMessage(FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE, false));
        } else {
          seatReleaseDeferredFocusRef.current = returnFocus;
        }
        setPendingSeatRelease(null);
        closeDialog = true;
      } catch {
        setSeatReleaseError(FLOATING_SEAT_RELEASE_NETWORK_ERROR_COPY);
        setSeatReleaseOutcomeUnknown(true);
        seatReleaseDialogRef.current?.focus();
      }
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
    if (seatReleaseFocusId === null || pendingSeatRelease !== null || seatSessions[seatReleaseFocusId] !== undefined) return;
    const startButton = seatStartButtonRefs.current[seatReleaseFocusId];
    if (startButton !== null && !startButton.disabled) startButton.focus();
    else seatCardRefs.current[seatReleaseFocusId]?.focus();
    setSeatReleaseFocusId(null);
  }, [entitlements, pendingSeatRelease, seatReleaseFocusId, seatSessions]);

  async function releaseDevice(item: DeviceRow): Promise<void> {
    if (!window.confirm(DEVICE_RELEASE_CONFIRM_COPY)) return;
    await runOnce(async () => {
      const result = await api<Record<string, unknown>>(deviceReleasePath(), {
        method: "POST",
        body: JSON.stringify({ device_key_id: item.device_key_id }),
      });
      setMessage(resultMessage(result));
      if (result.ok) await refreshData();
    });
  }

  function clear(): void {
    setSeatSessions({});
    setPendingSeatRelease(null);
    setSeatReleaseError(null);
    setSeatReleaseOutcomeUnknown(false);
    setSeatReleaseFocusId(null);
  }

  return {
    busy,
    devices,
    entitlements,
    pendingSeatRelease,
    seatReleaseError,
    seatReleaseOutcomeUnknown,
    seatSessions,
    seatReleaseDialogRef,
    seatStartButtonRefs,
    seatCardRefs,
    seatAction,
    requestSeatRelease,
    dismissSeatRelease,
    confirmSeatRelease,
    releaseDevice,
    clear,
  };
}

export function DevicesFeature({ controller }: { controller: DevicesController }): React.ReactElement {
  const floatingEntitlements = controller.entitlements.filter((item) => item.license_mode === "floating");
  return (
    <section className="tablePane full">
      <h2>My devices &amp; seats</h2>
      <table>
        <thead><tr><th>Project</th><th>Feature</th><th>Fingerprint</th><th>Device</th><th>Since</th><th>Actions</th></tr></thead>
        <tbody>
          {controller.devices.map((item, index) => (
            <tr key={`${item.device_key_id}/${index}`}>
              <td>{item.project}</td>
              <td>{item.feature}</td>
              <td><code>{shortHash(item.license_fingerprint)}</code></td>
              <td><code>{shortHash(item.device_key_id)}</code></td>
              <td>{formatTimestamp(item.created_at)}</td>
              <td className="actions">
                <button disabled={controller.busy} onClick={() => void controller.releaseDevice(item)}>{DEVICE_RELEASE_ACTION_LABEL}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {controller.devices.length === 0 && <p className="muted">{NO_DEVICES_EMPTY_COPY}</p>}
      {floatingEntitlements.length > 0 && (
        <div className="seatGrid">
          <h2>Seats by entitlement</h2>
          {floatingEntitlements.map((item, index) => (
            <div
              className="seatCard"
              key={`seat/${item.id}/${index}`}
              ref={(element) => { controller.seatCardRefs.current[item.id] = element; }}
              tabIndex={-1}
            >
              <div>
                <strong>{item.project}</strong>
                <span className="muted"> / {item.feature}</span>
                <span className="muted"> pool {item.pool_size}</span>
              </div>
              <div className="actions">
                <button
                  ref={(element) => { controller.seatStartButtonRefs.current[item.id] = element; }}
                  disabled={controller.busy || item.status !== "active" || controller.seatSessions[item.id] !== undefined}
                  onClick={() => void controller.seatAction(item, "checkout")}
                >Start seat</button>
                <button disabled={controller.busy || item.status !== "active" || controller.seatSessions[item.id] === undefined} onClick={() => void controller.seatAction(item, "heartbeat")}>Refresh</button>
                <button disabled={controller.busy || controller.seatSessions[item.id] === undefined} onClick={() => controller.requestSeatRelease(item)}>Release</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
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
          <div><dt>Device</dt><dd><code>{pending.session.client_instance_id}</code></dd></div>
        </dl>
        <div className="actions">
          <button type="button" disabled={controller.busy} onClick={controller.dismissSeatRelease}>Cancel</button>
          <button type="button" className="danger" disabled={controller.busy || controller.seatReleaseOutcomeUnknown} onClick={() => void controller.confirmSeatRelease()}>Confirm release</button>
        </div>
      </div>
    </div>
  ), document.body);
}
