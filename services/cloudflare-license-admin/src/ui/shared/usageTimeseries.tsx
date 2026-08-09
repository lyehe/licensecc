import React, { ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";

import type { TimeseriesBucket } from "../../shared/api";
import { api } from "./api";
import { useOperatorControls } from "./controls";
import type { TimeseriesRange } from "./timeseries";
import { timeseriesPath } from "./timeseries";

export interface UsageTimeseriesData {
  from: number;
  to: number;
  bucket_seconds: number;
  buckets: TimeseriesBucket[];
}

interface UsageTimeseriesControls {
  timeseries: UsageTimeseriesData | null;
  timeseriesRange: TimeseriesRange;
  setTimeseriesRange: React.Dispatch<React.SetStateAction<TimeseriesRange>>;
}

interface UsageTimeseriesState extends UsageTimeseriesControls {
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

  useEffect(() => {
    if (!active) {
      return;
    }
    void (async () => {
      const response = await api<UsageTimeseriesData>(timeseriesPath(controls.timeseriesRange));
      if (response.ok && response.data) {
        controls.setTimeseries(response.data);
      } else {
        setMessage(`${response.code} (${response.request_id})`);
      }
    })();
  }, [active, controls.setTimeseries, controls.timeseriesRange, setMessage]);

  return controls;
}
