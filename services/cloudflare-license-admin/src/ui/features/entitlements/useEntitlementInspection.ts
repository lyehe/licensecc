import { useEffect, useRef, useState } from "react";
import type { EntitlementDeviceRecord } from "../../../shared/api";
import { api, apiFailureDetails, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { ConfirmRefreshFailure, EXACT_READ_PROOF, type ExactReadProof, useContextGeneration } from "../../shared/controls";
import { hasDeviceListData, hasMeterStatusData } from "../../shared/mutationGuards";
import { useRequestFence } from "../../shared/requestFence";
import { entitlementDevicesPath, entitlementMeterPath } from "./workflow";

export interface MeterStatus {
  meter_quota: number;
  meter_period_sec: number;
  period_start: number;
  period_end: number;
  units_consumed: number;
  server_time: number;
}

interface ReadState { context: string; loading: boolean; error: string | null }

/** Owns read snapshots only; consequence ownership and same-key recovery stay in the controller. */
export function useEntitlementInspection(active: boolean, filterContextKey: string, setMessage: (message: string) => void) {
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
    setDeviceRead({ context: deviceContextKey, loading: false, error: apiFailureMessage(response) });
    if (strict) {
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    }
    setMessage(apiFailureMessage(response));
    return null;
  }

  currentDevicesRefreshRef.current = () => active && deviceEntitlementId !== null ? loadDevices(deviceEntitlementId, true) : Promise.resolve(null);

  function toggleDevices(entitlementId: string): void {
    setDeviceEntitlementId(deviceEntitlementId === entitlementId ? null : entitlementId);
    setDevices([]);
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
      setMeterRead({ context: meterContextKey, loading: false, error: apiFailureMessage(response) });
      setMessage(apiFailureMessage(response));
    }
  }

  function toggleMeter(entitlementId: string): void {
    setMeterEntitlementId(meterEntitlementId === entitlementId ? null : entitlementId);
    setMeterStatus(null);
  }

  useEffect(() => {
    if (active && meterEntitlementId !== null) void loadMeterStatus(meterEntitlementId);
  }, [active, meterEntitlementId, meterContextKey, meterFence]);

  return {
    deviceEntitlementId, meterEntitlementId, toggleDevices, toggleMeter, loadDevices, loadMeterStatus,
    deviceContextKey, deviceGeneration, isDeviceGenerationCurrent, currentDeviceGeneration, currentDeviceContext, currentDevicesRefreshRef,
    devices: devicesFence.isSettled() ? devices : [], meterStatus: meterFence.isSettled() ? meterStatus : null,
    devicesReady: devicesFence.canLoadMore(), meterReady: meterFence.canLoadMore(),
    deviceRead: deviceRead.context === deviceContextKey ? deviceRead : { loading: true, error: null },
    meterRead: meterRead.context === meterContextKey ? meterRead : { loading: true, error: null },
  };
}
