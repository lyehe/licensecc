import { useCallback, useRef, useState } from "react";

export interface SingleFlight {
  busy: boolean;
  busyRef: React.RefObject<boolean>;
  runOnce(work: () => Promise<void>): Promise<void>;
}

export function useSingleFlight(): SingleFlight {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const runOnce = useCallback(async (work: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, busyRef, runOnce };
}
