import { useCallback, useEffect, useRef, useState } from "react";

import { entitlementsPath } from "../../portalWorkflow";
import { api, localMessage, resultMessage } from "../../shared/api";
import type { EntitlementRow, StatusMessage } from "../../types";

interface PortalDataOptions {
  active: boolean;
  setMessage: React.Dispatch<React.SetStateAction<StatusMessage | null>>;
}

export interface PortalData {
  stale: boolean;
  readState: "loading" | "ready" | "error";
  entitlements: EntitlementRow[];
  refreshData(): Promise<boolean>;
  clear(): void;
}

export function usePortalData({ active, setMessage }: PortalDataOptions): PortalData {
  const [entitlements, setEntitlements] = useState<EntitlementRow[]>([]);
  const [readState, setReadState] = useState<"loading" | "ready" | "error">("loading");
  const [stale, setStale] = useState(false);
  const generation = useRef(0);

  const refreshData = useCallback(async (): Promise<boolean> => {
    const requestGeneration = generation.current;
    setReadState((current) => current === "ready" ? current : "loading");
    try {
      const result = await api<{ items: EntitlementRow[] }>(entitlementsPath());
      if (requestGeneration !== generation.current) return false;
      if (!result.ok || !Array.isArray(result.data?.items)) {
        setMessage(result.ok ? localMessage("invalid_response", false) : resultMessage(result));
        setStale(true);
        setReadState((current) => current === "ready" ? current : "error");
        return false;
      }
      setEntitlements(result.data.items);
      setStale(false);
      setReadState("ready");
      return true;
    } catch {
      // Defensive: api() no longer throws, but we keep this catch in case something unexpected does.
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
  }, []);

  return { entitlements, readState, stale, refreshData, clear };
}
