import { useRef, useState } from "react";
import { deviceReleasePath } from "../../portalWorkflow";
import { api, resultMessage } from "../../shared/api";
import { useNativeDialogFocus } from "./nativeDialog";
import type { DeviceRow, StatusMessage } from "../../types";

// D4: the legacy-release confirmation, replacing `window.confirm`. Extracted the same way D3 fix
// round 1 extracted the floating-seat release confirmation into seatReleaseDialog.ts, but this flow
// stays simple on purpose -- there is no busy/outcome-unknown retry state inside the dialog itself: the
// dialog's only job is the yes/no decision, exactly like the window.confirm() it replaces. Once
// confirmed, it closes immediately and the actual request's result shows in this row's own
// role="status" line (DeviceRegistrations.tsx), same as before.
interface DeviceReleaseDialogOptions {
  // Fix round 2 (Important), carried here from releaseDevice()'s own prior guard: the generation when
  // this action started, compared against the generation when its response arrives, so a response
  // that lands after the customer has left (and possibly returned to) Devices is dropped.
  visitGenerationRef: React.RefObject<number>;
  runOnce(work: () => Promise<void>): Promise<void>;
  refreshData(): Promise<boolean>;
  setDeviceMessage(deviceKeyId: string, message: StatusMessage | null): void;
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
  const { visitGenerationRef, runOnce, refreshData, setDeviceMessage } = options;
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
    await runOnce(async () => {
      const result = await api<Record<string, unknown>>(deviceReleasePath(), {
        method: "POST",
        body: JSON.stringify({ device_key_id: item.device_key_id }),
      });
      if (visitGenerationRef.current === startGeneration) setDeviceMessage(item.device_key_id, resultMessage(result));
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
