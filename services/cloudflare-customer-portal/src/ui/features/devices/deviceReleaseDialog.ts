import { useRef, useState } from "react";
import { deviceReleasePath } from "../../portalWorkflow";
import { api, resultMessage } from "../../shared/api";
import { useNativeDialogFocus } from "./nativeDialog";
import type { DeviceRow, StatusMessage } from "../../types";

// The activated-device release confirmation, replacing `window.confirm`. It stays simple on purpose --
// there is no busy/outcome-unknown retry state inside the dialog itself: the dialog's only job is the
// yes/no decision, exactly like the window.confirm() it replaces. Once confirmed, it closes immediately
// and the request's result shows in the Activated devices section (DeviceRegistrations.tsx): in the
// device's row when the release fails, under the list when it succeeds and the row goes away. When
// that section is not on screen, a failure shows in the page-level line instead (see below).
interface DeviceReleaseDialogOptions {
  // Fix round 2 (Important), carried here from releaseDevice()'s own prior guard: the generation when
  // this action started, compared against the generation when its response arrives, so a response
  // that lands after the customer has left (and possibly returned to) Devices is dropped.
  visitGenerationRef: React.RefObject<number>;
  // Bumped when the session's state is cleared (sign-out, session end).
  sessionGenerationRef: React.RefObject<number>;
  runOnce(work: () => Promise<void>): Promise<void>;
  refreshData(): Promise<boolean>;
  setDeviceMessage(deviceKeyId: string, message: StatusMessage | null): void;
  showOffPageResult(message: StatusMessage): void;
}

export interface DeviceReleaseDialogState {
  pendingDeviceRelease: DeviceRow | null;
  deviceReleaseDialogRef: React.RefObject<HTMLDialogElement | null>;
  deviceRegistrationsHeadingRef: React.RefObject<HTMLHeadingElement | null>;
  requestDeviceRelease(item: DeviceRow): void;
  dismissDeviceRelease(): void;
  confirmDeviceRelease(): Promise<void>;
  // Mirrors seatReleaseDialog's resetForClear(): lets useDevicesController's own clear() drop any
  // pending confirmation on a customer switch, without this hook needing its own storage-aware clear.
  resetForClear(): void;
}

export function useDeviceReleaseDialog(options: DeviceReleaseDialogOptions): DeviceReleaseDialogState {
  const { visitGenerationRef, sessionGenerationRef, runOnce, refreshData, setDeviceMessage, showOffPageResult } = options;
  const [pendingDeviceRelease, setPendingDeviceRelease] = useState<DeviceRow | null>(null);
  const deviceRegistrationsHeadingRef = useRef<HTMLHeadingElement>(null);
  const deviceReleaseDialogRef = useNativeDialogFocus(pendingDeviceRelease !== null, deviceRegistrationsHeadingRef);

  function requestDeviceRelease(item: DeviceRow): void {
    setPendingDeviceRelease(item);
  }

  function dismissDeviceRelease(): void {
    setPendingDeviceRelease(null);
  }

  async function confirmDeviceRelease(): Promise<void> {
    const item = pendingDeviceRelease;
    if (item === null) return;
    // Close right away -- exactly like window.confirm() returning true handed control straight back to
    // releaseDevice() before. The request's own result still shows in the row's local status line,
    // never inside the dialog.
    setPendingDeviceRelease(null);
    const startGeneration = visitGenerationRef.current;
    const startSession = sessionGenerationRef.current;
    await runOnce(async () => {
      const result = await api<Record<string, unknown>>(deviceReleasePath(), {
        method: "POST",
        body: JSON.stringify({ device_key_id: item.device_key_id }),
      });
      // The result shows in the Activated devices section when that section is on screen in the same
      // visit. Otherwise (browser Back left the confirmation open on another page, or the customer
      // moved on after confirming) a failure goes to the page-level line where the customer is, never
      // nowhere; a success needs no line, since the next Devices visit lists the device as gone.
      const heading = deviceRegistrationsHeadingRef.current;
      if (visitGenerationRef.current === startGeneration && heading !== null && heading.isConnected) {
        setDeviceMessage(item.device_key_id, resultMessage(result));
      } else if (!result.ok && sessionGenerationRef.current === startSession) {
        showOffPageResult(resultMessage(result));
      }
      if (result.ok) await refreshData();
    });
  }

  function resetForClear(): void {
    setPendingDeviceRelease(null);
  }

  return {
    pendingDeviceRelease,
    deviceReleaseDialogRef,
    deviceRegistrationsHeadingRef,
    requestDeviceRelease,
    dismissDeviceRelease,
    confirmDeviceRelease,
    resetForClear,
  };
}
