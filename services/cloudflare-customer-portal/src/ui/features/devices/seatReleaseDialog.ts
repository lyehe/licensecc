import { useRef, useState } from "react";
import { FLOATING_SEAT_RELEASE_NETWORK_ERROR_COPY, FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE, type SeatSession } from "../../portalWorkflow";
import { localMessage } from "../../shared/api";
import { useNativeDialogFocus } from "./nativeDialog";
import type { EntitlementRow, SeatActionResult, SeatOperation, StatusMessage } from "../../types";

// D3 fix round 1 (Important 3, hotspot budget): the floating-seat release confirm dialog's state,
// mutation and focus management, split out of DevicesFeature.tsx's useDevicesController. This is a
// cohesive, self-contained flow that only reaches into the parent hook via the options below -- never
// any other DevicesFeature.tsx state. No behaviour change beyond D4 (below): useDevicesController calls
// this hook and spreads its return value into the exact same DevicesController shape it always
// returned.
//
// D4: replaced the manual overlay/div modal (its own focus trap and a return-to-trigger-button focus
// restoration) with the native <dialog> pattern from nativeDialog.ts/ProtectedNodes.tsx. Verified
// directly against this Chromium build: a modally-invoked <dialog> keeps real Tab/keyboard focus from
// reaching background content on its own, so the manual keydown Tab-trap is gone -- but it does NOT by
// itself remove that background from the accessibility tree or from a scripted click, which is why
// App.tsx still makes `main` inert by hand, and renders the dialog itself next to `main`
// (ReleaseDialogs.tsx). Every close -- Cancel, Escape, a successful release, or an ordinary
// (non-network) failure -- returns focus to the "Browser seats" heading, or to the page content when
// history navigation has left the Devices page.
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
  // The "Browser seats" section heading (BrowserSeats.tsx, DevicesFeature's panelHeadingRef) that
  // focus returns to on every close, matching ProtectedNodes' own heading-focus pattern.
  headingRef: React.RefObject<HTMLElement | null>;
}

export interface SeatReleaseDialogState {
  pendingSeatRelease: PendingSeatRelease | null;
  seatReleaseError: string | null;
  seatReleaseOutcomeUnknown: boolean;
  seatReleaseDialogRef: React.RefObject<HTMLDialogElement | null>;
  requestSeatRelease(item: EntitlementRow): void;
  dismissSeatRelease(): void;
  confirmSeatRelease(): Promise<void>;
  // D3 fix round 1: lets useDevicesController's own clear() reset this flow's state too, without this
  // hook needing its own storage-aware clear() -- clear() must never touch storage (decision 2), and
  // none of this flow's state is storage-backed anyway.
  resetForClear(): void;
}

export function useSeatReleaseDialog(options: SeatReleaseDialogOptions): SeatReleaseDialogState {
  const { busyRef, seatSessions, seatAction, setSeatMessage, setMessage, headingRef } = options;
  const [pendingSeatRelease, setPendingSeatRelease] = useState<PendingSeatRelease | null>(null);
  const [seatReleaseError, setSeatReleaseError] = useState<string | null>(null);
  const [seatReleaseOutcomeUnknown, setSeatReleaseOutcomeUnknown] = useState(false);
  const seatReleaseDialogRef = useNativeDialogFocus(pendingSeatRelease !== null, headingRef);
  const seatReleaseConfirmingRef = useRef(false);

  function requestSeatRelease(item: EntitlementRow): void {
    if (busyRef.current) return;
    const session = seatSessions[item.id];
    if (session === undefined) {
      setSeatMessage(item.id, localMessage("seat_not_checked_out", false));
      return;
    }
    setSeatReleaseError(null);
    setSeatReleaseOutcomeUnknown(false);
    setPendingSeatRelease({ item, session });
  }

  function dismissSeatRelease(): void {
    if (seatReleaseConfirmingRef.current) return;
    setSeatReleaseError(null);
    setSeatReleaseOutcomeUnknown(false);
    setPendingSeatRelease(null);
  }

  async function confirmSeatRelease(): Promise<void> {
    const pending = pendingSeatRelease;
    if (pending === null || seatReleaseConfirmingRef.current || busyRef.current) return;
    seatReleaseConfirmingRef.current = true;
    setSeatReleaseError(null);
    // Keep focus inside the dialog while the request is in flight: Confirm is about to become disabled
    // (aria-busy), which would otherwise drop focus to <body>.
    seatReleaseDialogRef.current?.focus();
    try {
      const outcome = await seatAction(pending.item, "release");
      // These setters run after an await with no visit-generation guard, and need none: they only
      // change the dialog's own state, and App.tsx renders the dialog whatever page is showing (browser
      // Back and Forward still work while `main` is inert). The seat's own result line is guarded
      // inside seatAction(), and the page-level refresh-failed message belongs on every page.
      if (outcome.succeeded) {
        if (outcome.refreshFailed) setMessage(localMessage(FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE, false));
        setPendingSeatRelease(null);
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
        setPendingSeatRelease(null);
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
    }
  }

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
