import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Widget } from "@coldstart/shared";
import { DESKTOP_QUERY, useMediaQuery } from "../lib/useMediaQuery";
import { CONTENT_FIT_WIDGET_TYPES, WidgetRenderer } from "../widgets/registry";

// Must match the grid's own `gridAutoRows`/`gap-4` below — the row-height
// math both reserves space (CSS) and un-reserves it (measuredRowSpan).
const ROW_HEIGHT_PX = 76;
const ROW_GAP_PX = 16;

/** SPEC.md §19.3: "y is a row index, not a pixel value — the SPA packs
 * widgets top-down; mobile collapses to a single column ordered by (y, x)."
 * Exported (not just used inline) so the ordering rule has one test-covered
 * definition for both the desktop DOM order (which drives dense packing)
 * and the mobile stack order. */
export function sortByYX(widgets: Widget[]): Widget[] {
  return [...widgets].sort((a, b) => a.gridPos.y - b.gridPos.y || a.gridPos.x - b.gridPos.x);
}

/** Desktop grid-item placement: explicit column start/span from gridPos,
 * row SPAN (not an explicit start) so `grid-auto-flow: dense` can pack
 * sparse/duplicate `y` values without opening up empty phantom rows — the
 * DOM order (sortByYX) is what actually drives placement priority. */
export function gridItemStyle(widget: Widget): CSSProperties {
  return {
    gridColumn: `${widget.gridPos.x + 1} / span ${widget.gridPos.w}`,
    gridRow: `span ${widget.gridPos.h}`,
    // M5 defect E: a content-fit widget type shrinks to its own content
    // height (overriding CSS Grid's default `align-items: stretch`) instead
    // of stretching to fill an agent-set slot, so a short note doesn't
    // strand a large empty card below it.
    ...(CONTENT_FIT_WIDGET_TYPES.has(widget.type) ? { alignSelf: "start" } : {}),
  };
}

/**
 * M5 R2 item 2 — the flip side of M5 defect E (widget dead space, fixed via
 * `alignSelf: start` above): that fix shrinks the CARD to its content, but
 * the grid TRACK it sits in still reserved the agent's full `gridPos.h`
 * worth of row height, so a short `agent_note` at h=4 (~102px of real
 * content) left a ~250px dead gap before the next widget the dense-packing
 * algorithm placed after it. Converts a measured pixel height into the
 * smallest row-span that comfortably fits it — never more than the widget's
 * own configured `h` (this COLLAPSES the reservation; it never grows a
 * widget beyond what the agent set).
 */
export function measuredRowSpan(pixelHeight: number, maxRows: number): number {
  const rows = Math.ceil((pixelHeight + ROW_GAP_PX) / (ROW_HEIGHT_PX + ROW_GAP_PX));
  return Math.min(maxRows, Math.max(1, rows));
}

/**
 * Content-fit grid item (agent_note/quota_usage/kpi_row): measures its own
 * rendered height and overrides `gridItemStyle`'s row span with
 * `measuredRowSpan`, collapsing the reserved TRACK around the already-
 * shrunk card so dense packing can place the next widget right behind it
 * instead of `h` rows below. `useLayoutEffect` measures synchronously before
 * paint (no visible flash on first render); the `ResizeObserver` only
 * matters for a LATER content change (e.g. an agent rewriting the note).
 */
function ContentFitGridItem({ widget }: { widget: Widget }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rowSpan, setRowSpan] = useState(widget.gridPos.h);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (height: number) => setRowSpan(measuredRowSpan(height, widget.gridPos.h));
    measure(el.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height !== undefined) measure(height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [widget.gridPos.h]);

  return (
    <div ref={ref} style={{ ...gridItemStyle(widget), gridRow: `span ${rowSpan}` }}>
      <WidgetRenderer widget={widget} />
    </div>
  );
}

export function DashboardGrid({ widgets }: { widgets: Widget[] }) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const visible = widgets.filter((w) => w.visible);
  const ordered = sortByYX(visible);

  if (ordered.length === 0) {
    return (
      <div className="rounded-[var(--radius-card)] border border-dashed border-line px-4 py-10 text-center text-sm text-ink-muted">
        Every widget on this view is hidden. Show one from the view editor to see it here.
      </div>
    );
  }

  if (!isDesktop) {
    return (
      <div className="flex flex-col gap-4">
        {ordered.map((widget) => (
          <div key={widget.id}>
            <WidgetRenderer widget={widget} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-12 gap-4" style={{ gridAutoFlow: "row dense", gridAutoRows: `${ROW_HEIGHT_PX}px` }}>
      {ordered.map((widget) =>
        CONTENT_FIT_WIDGET_TYPES.has(widget.type) ? (
          <ContentFitGridItem key={widget.id} widget={widget} />
        ) : (
          <div key={widget.id} style={gridItemStyle(widget)}>
            <WidgetRenderer widget={widget} />
          </div>
        ),
      )}
    </div>
  );
}
