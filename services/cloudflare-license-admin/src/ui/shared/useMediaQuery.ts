import { useEffect, useState } from "react";

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/**
 * Whether `query` currently matches, updated live as the viewport changes. A caller renders one
 * layout or the other from this value; it never renders both and lets CSS hide one of them, so the
 * DOM only ever holds the markup that is actually shown. Outside a browser (SSR, `node --test`
 * without a DOM) `matchMedia` is unavailable and the default is `false`, the wider/desktop case.
 */
export function useMediaQuery(query: string): boolean {
  const [matched, setMatched] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const onChange = (): void => setMatched(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matched;
}
