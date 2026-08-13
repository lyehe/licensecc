import { useCallback, useEffect, useState } from "react";

import { devicesPath, entitlementsPath, usagePath } from "../../portalWorkflow";
import { api, resultMessage } from "../../shared/api";
import type { DeviceRow, EntitlementRow, StatusMessage, UsageRow } from "../../types";

interface PortalDataOptions {
  active: boolean;
  setMessage: React.Dispatch<React.SetStateAction<StatusMessage | null>>;
}

export interface PortalData {
  entitlements: EntitlementRow[];
  devices: DeviceRow[];
  usage: UsageRow[];
  refreshData(): Promise<boolean>;
  clear(): void;
}

export function usePortalData({ active, setMessage }: PortalDataOptions): PortalData {
  const [entitlements, setEntitlements] = useState<EntitlementRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);

  const refreshData = useCallback(async (): Promise<boolean> => {
    const [entitlementResponse, deviceResponse, usageResponse] = await Promise.all([
      api<{ items: EntitlementRow[] }>(entitlementsPath()),
      api<{ items: DeviceRow[] }>(devicesPath()),
      api<{ items: UsageRow[] }>(usagePath()),
    ]);
    if (entitlementResponse.ok && entitlementResponse.data) setEntitlements(entitlementResponse.data.items);
    if (deviceResponse.ok && deviceResponse.data) setDevices(deviceResponse.data.items);
    if (usageResponse.ok && usageResponse.data) setUsage(usageResponse.data.items);
    const failed = [entitlementResponse, deviceResponse, usageResponse].find((item) => !item.ok);
    if (failed) {
      setMessage(resultMessage(failed));
      return false;
    }
    return true;
  }, [setMessage]);

  useEffect(() => {
    if (active) void refreshData();
  }, [active, refreshData]);

  const clear = useCallback((): void => {
    setEntitlements([]);
    setDevices([]);
    setUsage([]);
  }, []);

  return { entitlements, devices, usage, refreshData, clear };
}
