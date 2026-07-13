import { useState } from "react";
import type { Provenance } from "@coldstart/shared";
import { chipClasses } from "../lib/ui";
import { DESKTOP_QUERY, useMediaQuery } from "../lib/useMediaQuery";

/** SPEC.md §19.4 — server-derived provenance, rendered per-VIEW (not per-
 * widget): mcp/api → agent badge with note; dashboard → "by you"; system
 * (the lazy-seeded default view) → no badge at all.
 *
 * M5 R2 item 5 — on desktop the full "Configured by your agent — <note>"
 * label sits in a `title` tooltip on hover, so the visible pill can stay
 * one line. Mobile has no hover: the same long label used to wrap across
 * up to 3 lines inside the header's `flex-wrap` row. Below 1024px this
 * renders instead as a width-capped, truncated, TAPPABLE pill that reveals
 * the full note in a small inline popover — same information, no wrap.
 */
export function ProvenanceBadge({ editedBy, note }: { editedBy: Provenance; note: string | null }) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [expanded, setExpanded] = useState(false);

  if (editedBy === "system") return null;
  if (editedBy === "dashboard") {
    return <span className={chipClasses("neutral")}>Edited by you</span>;
  }

  const label = `Configured by your agent${note ? ` — ${note}` : ""}`;

  if (isDesktop) {
    return (
      <span className={chipClasses("info")} title={note ?? undefined}>
        {label}
      </span>
    );
  }

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => note && setExpanded((v) => !v)}
        aria-expanded={note ? expanded : undefined}
        aria-haspopup={note ? "dialog" : undefined}
        className={`${chipClasses("info")} max-w-[55vw] truncate`}
      >
        {label}
      </button>
      {expanded && note && (
        <div role="dialog" aria-label="Agent note" className="absolute left-0 top-full z-30 mt-1 w-64 max-w-[80vw] rounded-[var(--radius-card)] border border-line bg-surface p-3 text-sm text-ink shadow-sm">
          <p className="whitespace-pre-wrap">{note}</p>
          <button type="button" onClick={() => setExpanded(false)} className="mt-2 text-xs font-medium text-ink-muted underline">
            Close
          </button>
        </div>
      )}
    </span>
  );
}
