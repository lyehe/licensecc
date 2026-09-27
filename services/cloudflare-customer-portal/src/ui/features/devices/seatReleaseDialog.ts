import { useEffect, useRef, useState } from "react";
import { FLOATING_SEAT_RELEASE_NETWORK_ERROR_COPY, FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE, type SeatSession } from "../../portalWorkflow";
import { localMessage } from "../../shared/api";
import type { EntitlementRow, SeatActionResult, SeatOperation, StatusMessage } from "../../types";

// D3 fix round 1 (Important 3, hotspot budget): the floating-seat release confirm dialog's state,
// mutation and focus management, split out of DevicesFeature.tsx's useDevicesController. This is a
// cohesive, self-contained flow (open/confirm/dismiss plus the dialog's own focus trap and
// return-focus restoration) that only reaches into the parent hook via the options below -- never any
// other DevicesFeature.tsx state. No behaviour change: useDevicesController calls this hook and
// spreads its return value into the exact same DevicesController shape it always returned.
export interface PendingSeatRelease {
  item: EntitlementRow;
  session: SeatSession;
}

interface SeatReleaseDialogOptions {
  busyRef: React.RefObject<boolean>;
  seatSessions: Record<string, SeatSession>;
  seatAction(item: EntitlementRow, operation: SeatOperation): Promise<SeatActionResult>;
  setSeatMessage(entitlementId: string, message: StatusMessage | null): void;
  setMessage: React.Dispatch<React.SetStateAction<StatusMessage | null>>;
  // Untyped by name (not a shared PendingSeatFocus import) to avoid a cross-file type dependency back
  // onto DevicesFeature.tsx -- the shape is small and stable, and this is the only place it is used.
  setPendingSeatFocus(focus: { seatId: string; after: "start" | "release" } | null): void;
}

export interface SeatReleaseDialogState {
  pendingSeatRelease: PendingSeatRelease | null;
  seatReleaseError: string | null;
  seatReleaseOutcomeUnknown: boolean;
  seatReleaseDialogRef: React.RefObject<HTMLDivElement | null>;
  requestSeatRelease(item: EntitlementRow): void;
  dismissSeatRelease(): void;
  confirmSeatRelease(): Promise<void>;
  // D3 fix round 1: lets useDevicesController's own clear() reset this flow's state too, without this
  // hook needing its own storage-aware clear() -- clear() must never touch storage (decision 2), and
  // none of this flow's state is storage-backed anyway.
  resetForClear(): void;
}

export function useSeatReleaseDialog(options: SeatReleaseDialogOptions): SeatReleaseDialogState {
  const { busyRef, seatSessions, seatAction, setSeatMessage, setMessage, setPendingSeatFocus } = options;
  const [pendingSeatRelease, setPendingSeatRelease] = useState<PendingSeatRelease | null>(null);
  const [seatReleaseError, setSeatReleaseError] = useState<string | null>(null);
  const [seatReleaseOutcomeUnknown, setSeatReleaseOutcomeUnknown] = useState(false);
  const seatReleaseDialogRef = useRef<HTMLDivElement>(null);
  const seatReleaseReturnFocusRef = useRef<HTMLElement | null>(null);
  const seatReleaseDeferredFocusRef = useRef<HTMLElement | null>(null);
  const seatReleaseConfirmingRef = useRef(false);

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

  function resetForClear(): void {
    setPendingSeatRelease(null);
    setSeatReleaseError(null);
    setSeatReleaseOutcomeUnknown(false);
  }

  return {
    pendingSeatRelease,
    seatReleaseError,
    seatReleaseOutcomeUnknown,
    seatReleaseDialogRef,
    requestSeatRelease,
    dismissSeatRelease,
    confirmSeatRelease,
    resetForClear,
  };
}
