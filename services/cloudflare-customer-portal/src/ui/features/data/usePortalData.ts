import { useCallback, useEffect, useRef, useState } from "react";

import { devicesPath, entitlementsPath, usagePath } from "../../portalWorkflow";
import { api, localMessage, resultMessage } from "../../shared/api";
import type { DeviceRow, EntitlementRow, StatusMessage, UsageRow } from "../../types";

interface PortalDataOptions {
  active: boolean;
  setMessage: React.Dispatch<React.SetStateAction<StatusMessage | null>>;
}

export interface PortalData {
  usageAvailable: boolean;
  stale: boolean;
  readState: "loading" | "ready" | "error";
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
  const [usageAvailable, setUsageAvailable] = useState(false);
  const [readState, setReadState] = useState<"loading" | "ready" | "error">("loading");
  const [stale, setStale] = useState(false);
  const generation = useRef(0);

  const refreshData = useCallback(async (): Promise<boolean> => {
    const requestGeneration = generation.current;
    setReadState((current) => current === "ready" ? current : "loading");
    try {
      const [entitlementResponse, deviceResponse, usageResponse] = await Promise.all([
        api<{ items: EntitlementRow[] }>(entitlementsPath()),
        api<{ items: DeviceRow[] }>(devicesPath()),
        api<{ items: UsageRow[] }>(usagePath()).catch(() => ({ ok: false, code: "usage_unavailable", request_id: "", data: undefined })),
      ]);
      if (requestGeneration !== generation.current) return false;
      const usageOk = usageResponse.ok && Array.isArray(usageResponse.data?.items);
      setUsageAvailable(usageOk);
      if (usageOk) setUsage(usageResponse.data!.items);
      const failed = [entitlementResponse, deviceResponse].find((item) => !item.ok || !Array.isArray(item.data?.items));
      if (failed) {
        setMessage(failed.ok ? localMessage("invalid_response", false) : resultMessage(failed));
        setStale(true);
        setReadState((current) => current === "ready" ? current : "error");
        return false;
      }
      setEntitlements(entitlementResponse.data!.items);
      setDevices(deviceResponse.data!.items);
      setStale(false);
      setReadState("ready");
      return true;
    } catch {
      if (requestGeneration !== generation.current) return false;
      setStale(true);
      setReadState((current) => current === "ready" ? current : "error");
      setMessage(localMessage("account_refresh_failed", false));
      return false;
    }
  }, [setMessage]);

  useEffect(() => {
    if (active) void refreshData();
  }, [active, refreshData]);

  const clear = useCallback((): void => {
    generation.current += 1;
    setReadState("loading");
    setStale(false);
    setEntitlements([]);
    setDevices([]);
    setUsage([]);
    setUsageAvailable(false);
  }, []);

  return { entitlements, devices, usage, usageAvailable, readState, stale, refreshData, clear };
}
