import { useEffect, useState } from "react";

// Keep date labels and controls current without polling the server.
export function useLicenseClock(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
