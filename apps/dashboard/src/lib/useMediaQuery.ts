import { useSyncExternalStore } from "react";

// Desktop (icon nav rail) ≥1024px vs mobile (bottom tabs) <768px — the shell
// breakpoints named in the M2 brief. The 768–1024px band renders the mobile
// shell (single-column content still reads fine there; a dedicated tablet
// layout is out of scope for v1).
export const DESKTOP_QUERY = "(min-width: 1024px)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
