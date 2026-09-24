import { useEffect, useState } from "react";

/**
 * The value once it has stayed unchanged for `delayMs`. The first value is returned at once, so a
 * lookup driven by it loads immediately on open, then once per pause in typing rather than once
 * per keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
