import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EntitlementDeviceRecord } from "../../../shared/api";
import { api, apiFailureDetails, parseExactApiSuccess } from "../../shared/api";
import { ConfirmRefreshFailure, EXACT_READ_PROOF, type ExactReadProof, useContextGeneration } from "../../shared/controls";
import { apiFailureFeedback } from "../../shared/messages";
import type { OperatorFeedback } from "../../shared/operatorFeedback";
import { hasDeviceListData, hasMeterStatusData } from "../../shared/mutationGuards";
import { resolvePendingFocus } from "../../shared/operatorFocus";
import { useRequestFence } from "../../shared/requestFence";
import { focusWorkspaceTarget } from "../../shared/workspaceFocus";
import { entitlementDevicesPath, entitlementMeterPath } from "./workflow";

export interface MeterStatus {
  meter_quota: number;
  meter_period_sec: number;
  period_start: number;
  period_end: number;
  units_consumed: number;
  server_time: number;
}

interface ReadState { context: string; loading: boolean; error: OperatorFeedback | null }

interface InspectorFocusEntry { entitlementId: string; invokingElement: HTMLElement | null }

/** The panel rendered inline under its own row carries this marker; the heading inside it takes
 * initial focus, wherever the caller placed the panel (a table row or a narrow-layout card). */
function findInspectorHeading(entitlementId: string): HTMLElement | null {
  for (const panel of Array.from(document.querySelectorAll<HTMLElement>("[data-inspector-row]"))) {
    if (panel.getAttribute("data-inspector-row") === entitlementId) {
      return panel.querySelector<HTMLElement>("[data-inspector-heading]");
    }
  }
  return null;
}

/**
 * Owns read snapshots only; consequence ownership and same-key recovery stay in the controller. A
 * failed read is reported by the inspector's own read notice.
 *
 * Only one of the device or metering panel is ever open (opening one closes the other), and it
 * renders inline under its own entitlement row. Opening or switching rows focuses the panel's
 * heading; closing it (without opening a different one) restores focus to the row control that
 * opened it, reopening a collapsed "More actions" menu around that control if needed.
 */
export function useEntitlementInspection(active: boolean, filterContextKey: string) {
  const [deviceEntitlementId, setDeviceEntitlementId] = useState<string | null>(null);
  const [devices, setDevices] = useState<EntitlementDeviceRecord[]>([]);
  const [meterEntitlementId, setMeterEntitlementId] = useState<string | null>(null);
  const [meterStatus, setMeterStatus] = useState<MeterStatus | null>(null);
  const [deviceRead, setDeviceRead] = useState<ReadState>({ context: "", loading: true, error: null });
  const [meterRead, setMeterRead] = useState<ReadState>({ context: "", loading: true, error: null });
  const deviceContextKey = `${filterContextKey}\u0000${deviceEntitlementId ?? ""}`;
  const meterContextKey = `${filterContextKey}\u0000${meterEntitlementId ?? ""}`;
  const { generation: deviceGeneration, isCurrent: isDeviceGenerationCurrent, currentGeneration: currentDeviceGeneration, currentContext: currentDeviceContext } = useContextGeneration(deviceContextKey);
  const devicesFence = useRequestFence(deviceContextKey);
  const meterFence = useRequestFence(meterContextKey);
  const currentDevicesRefreshRef = useRef<() => Promise<ExactReadProof | null>>(() => Promise.resolve(null));
  // Set only when a toggle opens (or switches) a panel, never on the click that closes it, so a
  // close restores focus to the control that opened the panel currently on screen -- never to
  // "Close devices"/"Close metering" itself.
  const pendingCloseFocusRef = useRef<InspectorFocusEntry | null>(null);

  function captureOpenFocus(entitlementId: string): void {
    const activeElement = document.activeElement;
    pendingCloseFocusRef.current = { entitlementId, invokingElement: activeElement instanceof HTMLElement ? activeElement : null };
  }

  async function loadDevices(entitlementId: string, strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> {
    if (!isCurrent()) return null;
    const ticket = devicesFence.begin();
    setDeviceRead({ context: deviceContextKey, loading: true, error: null });
    const response = await api<{ items: EntitlementDeviceRecord[] }>(entitlementDevicesPath(entitlementId));
    if (!isCurrent() || !devicesFence.isCurrent(ticket)) return null;
    const parsed = parseExactApiSuccess<{ items: EntitlementDeviceRecord[] }>(response, "devices_listed", hasDeviceListData);
    if (parsed !== null && devicesFence.settle(ticket)) {
      setDevices(parsed.data.items);
      setDeviceRead({ context: deviceContextKey, loading: false, error: null });
      return EXACT_READ_PROOF;
    }
    setDeviceRead({ context: deviceContextKey, loading: false, error: apiFailureFeedback(response) });
    if (strict) {
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    }
    return null;
  }

  currentDevicesRefreshRef.current = () => active && deviceEntitlementId !== null ? loadDevices(deviceEntitlementId, true) : Promise.resolve(null);

  function toggleDevices(entitlementId: string): void {
    const opening = deviceEntitlementId !== entitlementId;
    if (opening) captureOpenFocus(entitlementId);
    setDeviceEntitlementId(opening ? entitlementId : null);
    setDevices([]);
    // Only one inspector panel is ever open: opening (or switching) the device panel closes an
    // open metering panel, on any row.
    if (meterEntitlementId !== null) {
      setMeterEntitlementId(null);
      setMeterStatus(null);
    }
  }

  useEffect(() => {
    if (active && deviceEntitlementId !== null) void loadDevices(deviceEntitlementId);
  }, [active, deviceEntitlementId, deviceContextKey, devicesFence]);

  async function loadMeterStatus(entitlementId: string): Promise<void> {
    const ticket = meterFence.begin();
    setMeterRead({ context: meterContextKey, loading: true, error: null });
    const response = await api<MeterStatus>(entitlementMeterPath(entitlementId));
    if (!meterFence.isCurrent(ticket)) return;
    const parsed = parseExactApiSuccess<MeterStatus>(response, "meter_status", hasMeterStatusData);
    if (parsed !== null && meterFence.settle(ticket)) {
      setMeterStatus(parsed.data);
      setMeterRead({ context: meterContextKey, loading: false, error: null });
    } else {
      setMeterRead({ context: meterContextKey, loading: false, error: apiFailureFeedback(response) });
    }
  }

  function toggleMeter(entitlementId: string): void {
    const opening = meterEntitlementId !== entitlementId;
    if (opening) captureOpenFocus(entitlementId);
    setMeterEntitlementId(opening ? entitlementId : null);
    setMeterStatus(null);
    if (deviceEntitlementId !== null) {
      setDeviceEntitlementId(null);
      setDevices([]);
    }
  }

  useEffect(() => {
    if (active && meterEntitlementId !== null) void loadMeterStatus(meterEntitlementId);
  }, [active, meterEntitlementId, meterContextKey, meterFence]);

  useLayoutEffect(() => {
    const openEntitlementId = deviceEntitlementId ?? meterEntitlementId;
    if (openEntitlementId !== null) {
      focusWorkspaceTarget(findInspectorHeading(openEntitlementId));
      return;
    }
    const pending = pendingCloseFocusRef.current;
    pendingCloseFocusRef.current = null;
    if (pending === null) return;
    const target = resolvePendingFocus({ invokingElement: pending.invokingElement, rowKey: `entitlement:${pending.entitlementId}`, sectionKey: null });
    focusWorkspaceTarget(target);
  }, [deviceEntitlementId, meterEntitlementId]);

  return {
    deviceEntitlementId, meterEntitlementId, toggleDevices, toggleMeter, loadDevices, loadMeterStatus,
    deviceContextKey, deviceGeneration, isDeviceGenerationCurrent, currentDeviceGeneration, currentDeviceContext, currentDevicesRefreshRef,
    devices: devicesFence.isSettled() ? devices : [], meterStatus: meterFence.isSettled() ? meterStatus : null,
    devicesReady: devicesFence.canLoadMore(), meterReady: meterFence.canLoadMore(),
    deviceRead: deviceRead.context === deviceContextKey ? deviceRead : { loading: true, error: null },
    meterRead: meterRead.context === meterContextKey ? meterRead : { loading: true, error: null },
  };
}
