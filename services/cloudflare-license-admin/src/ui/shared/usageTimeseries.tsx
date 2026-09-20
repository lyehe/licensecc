import React, { ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";

import type { TimeseriesBucket } from "../../shared/api";
import { api, apiFailureMessage, parseExactApiSuccess } from "./api";
import { useOperatorControls } from "./controls";
import { hasTimeseriesData } from "./mutationGuards";
import { useRequestFence } from "./requestFence";
import type { TimeseriesRange } from "./timeseries";
import { timeseriesPath } from "./timeseries";

export interface UsageTimeseriesData {
  from: number;
  to: number;
  bucket_seconds: number;
  buckets: TimeseriesBucket[];
}

interface UsageTimeseriesControls {
  timeseriesLoading: boolean;
  timeseriesError: string | null;
  retryTimeseries: () => void;
  timeseries: UsageTimeseriesData | null;
  timeseriesRange: TimeseriesRange;
  setTimeseriesRange: React.Dispatch<React.SetStateAction<TimeseriesRange>>;
}

interface UsageTimeseriesState extends Omit<UsageTimeseriesControls, "timeseriesLoading" | "timeseriesError" | "retryTimeseries"> {
  setTimeseries: React.Dispatch<React.SetStateAction<UsageTimeseriesData | null>>;
}

const UsageTimeseriesContext = createContext<UsageTimeseriesState | null>(null);

// Reports and Fulfillment have always shared one operator-selected look-back and one response.
// Keeping it here preserves that behavior without making the application shell own report state.
export function UsageTimeseriesProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [timeseriesRange, setTimeseriesRange] = useState<TimeseriesRange>(7);
  const [timeseries, setTimeseries] = useState<UsageTimeseriesData | null>(null);
  const value = useMemo(() => ({ timeseries, timeseriesRange, setTimeseries, setTimeseriesRange }), [timeseries, timeseriesRange]);
  return (
    <UsageTimeseriesContext.Provider value={value}>
      {children}
    </UsageTimeseriesContext.Provider>
  );
}

export function useUsageTimeseries(active: boolean): UsageTimeseriesControls {
  const controls = useContext(UsageTimeseriesContext);
  const { setMessage } = useOperatorControls();
  if (controls === null) {
    throw new Error("usage_timeseries_provider_required");
  }
  const [retryRevision, setRetryRevision] = useState(0);
  const [readState, setReadState] = useState<{ key: string; loading: boolean; error: string | null }>({ key: "", loading: true, error: null });
  const readKey = `${active}:${controls.timeseriesRange}`;
  const timeseriesFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${controls.timeseriesRange}`);

  useEffect(() => {
    if (!active) {
      return;
    }
    void (async () => {
      const ticket = timeseriesFence.begin();
      setReadState({ key: readKey, loading: true, error: null });
      const response = await api<UsageTimeseriesData>(timeseriesPath(controls.timeseriesRange));
      if (!timeseriesFence.isCurrent(ticket)) return;
      setReadState({ key: readKey, loading: false, error: null });
      const parsed = parseExactApiSuccess<UsageTimeseriesData>(response, "report_timeseries", hasTimeseriesData);
      if (parsed !== null) {
        if (timeseriesFence.settle(ticket)) controls.setTimeseries(parsed.data);
      } else {
        setReadState({ key: readKey, loading: false, error: apiFailureMessage(response) });
        setMessage(apiFailureMessage(response));
      }
    })();
  }, [active, controls.setTimeseries, controls.timeseriesRange, setMessage, timeseriesFence, retryRevision, readKey]);

  return { ...controls, timeseriesLoading: readState.key !== readKey || readState.loading, timeseriesError: readState.key === readKey ? readState.error : null, retryTimeseries: () => setRetryRevision((value) => value + 1), timeseries: timeseriesFence.isSettled() ? controls.timeseries : null };
}
