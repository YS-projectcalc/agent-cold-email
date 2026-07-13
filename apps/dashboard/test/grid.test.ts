import { describe, expect, it } from "vitest";
import type { Widget } from "@coldstart/shared";
import { gridItemStyle, measuredRowSpan, sortByYX } from "../src/dashboard/Grid";

function widget(id: string, x: number, y: number, w = 6, h = 2): Widget {
  return {
    id,
    type: "quota_usage",
    gridPos: { x, y, w, h },
    visible: true,
    props: { refreshSeconds: 30 },
  };
}

// SPEC.md §19.3: "y is a row index... mobile collapses to a single column
// ordered by (y, x)." Desktop dense-packing relies on this SAME sorted DOM
// order (Grid.tsx's own comment explains why row placement uses `span`, not
// an explicit row-start).
describe("sortByYX", () => {
  it("orders primarily by y, then by x on ties", () => {
    // y=0 row: a(x=0) before b(x=6). y=1 row: d(x=0) before c(x=6).
    const widgets = [widget("c", 6, 1), widget("a", 0, 0), widget("b", 6, 0), widget("d", 0, 1)];
    const ordered = sortByYX(widgets).map((w) => w.id);
    expect(ordered).toEqual(["a", "b", "d", "c"]);
  });

  it("does not mutate the input array", () => {
    const widgets = [widget("b", 0, 1), widget("a", 0, 0)];
    const copy = [...widgets];
    sortByYX(widgets);
    expect(widgets).toEqual(copy);
  });
});

describe("gridItemStyle", () => {
  it("maps gridPos to explicit column start/span and a row span (not a row start)", () => {
    const style = gridItemStyle(widget("a", 3, 5, 4, 6));
    expect(style.gridColumn).toBe("4 / span 4");
    expect(style.gridRow).toBe("span 6");
  });
});

// M5 R2 item 2 — the review's exact repro: an agent_note at h=4 (352px
// reserved: 4*76 + 3*16) whose real content renders ~102px tall left a ~250px
// dead gap before the next widget. `measuredRowSpan` collapses the RESERVED
// track to the smallest span that still fits the measured content.
describe("measuredRowSpan", () => {
  it("collapses the repro's h=4 (352px reserved) span down to fit ~102px of real content", () => {
    const span = measuredRowSpan(102, 4);
    expect(span).toBeLessThan(4);
    expect(span).toBe(2); // 2 rows = 76*2 + 16 = 168px — comfortably fits 102px, nowhere near the original 352px
  });

  it("never grows a widget past its own configured h, even with huge content", () => {
    expect(measuredRowSpan(10_000, 4)).toBe(4);
  });

  it("never collapses below 1 row", () => {
    expect(measuredRowSpan(0, 4)).toBe(1);
  });

  it("leaves an already-tight widget's span unchanged", () => {
    // h=1 (76px reserved) with content that genuinely needs all of it.
    expect(measuredRowSpan(76, 1)).toBe(1);
  });
});
