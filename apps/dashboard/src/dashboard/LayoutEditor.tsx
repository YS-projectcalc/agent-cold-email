import { useState } from "react";
import type { Widget } from "@coldstart/shared";
import { DASHBOARD_LAYOUT_SCHEMA_VERSION } from "@coldstart/shared";
import { ApiError } from "../api/client";
import { useUpdateDashboardView } from "../api/queries";
import type { DashboardViewDetail, RevConflictBody } from "../api/types";
import { sortByYX } from "./Grid";
import { widgetLabel } from "./widgetLabels";

interface LayoutEditorProps {
  view: DashboardViewDetail;
  onClose: () => void;
}

/** §19.8/[F10] — human layout editing v1: show/hide toggles + up/down
 * reorder, NO drag-drop (the agent is the primary 2D layout editor via MCP's
 * `configure_dashboard`, which sets full gridPos x/w/h). A human reorder here
 * intentionally collapses the saved layout to a single linear column (x=0,
 * w=12, y=list-index) — simplest predictable v1 behavior for a "move up/
 * move down" tool; each widget's own `h` and everything in `props` survive
 * untouched, so the agent can always reintroduce a richer 2D arrangement
 * later. */
function linearize(widgets: Widget[]): Widget[] {
  return widgets.map((widget, index) => ({
    ...widget,
    gridPos: { x: 0, y: index, w: 12, h: widget.gridPos.h },
  }));
}

export function LayoutEditor({ view, onClose }: LayoutEditorProps) {
  const [originalOrder, setOriginalOrder] = useState<string[]>(() => sortByYX(view.layout.widgets).map((w) => w.id));
  const [draft, setDraft] = useState<Widget[]>(() => sortByYX(view.layout.widgets));
  const [rev, setRev] = useState(view.rev);
  const [conflict, setConflict] = useState<RevConflictBody | null>(null);
  const updateView = useUpdateDashboardView(view.id);

  function swap(index: number, other: number) {
    setDraft((prev) => {
      if (other < 0 || other >= prev.length) return prev;
      const a = prev[index];
      const b = prev[other];
      if (!a || !b) return prev;
      const next = [...prev];
      next[index] = b;
      next[other] = a;
      return next;
    });
  }

  function moveUp(index: number) {
    swap(index, index - 1);
  }

  function moveDown(index: number) {
    swap(index, index + 1);
  }

  function toggleVisible(id: string) {
    setDraft((prev) => prev.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w)));
  }

  async function handleSave() {
    setConflict(null);
    // Only an ACTUAL reorder (the id order changed from what this editor
    // opened with) linearizes to a single column. A show/hide-only edit
    // must preserve every widget's original 2D gridPos untouched — collapsing
    // the agent's whole arrangement just because one widget got hidden would
    // be a surprising, destructive side effect of an otherwise small edit.
    const reordered = draft.some((w, i) => w.id !== originalOrder[i]);
    const widgets = reordered ? linearize(draft) : draft;
    try {
      await updateView.mutateAsync({ rev, layout: { schemaVersion: DASHBOARD_LAYOUT_SCHEMA_VERSION, widgets } });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(err.body as RevConflictBody);
      }
      // Non-409 errors surface via updateView.error below, editor stays open.
    }
  }

  function handleReloadFromConflict() {
    if (!conflict) return;
    const reloaded = sortByYX(conflict.currentLayout.widgets);
    setDraft(reloaded);
    setOriginalOrder(reloaded.map((w) => w.id));
    setRev(conflict.currentRev);
    setConflict(null);
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Edit view layout" className="fixed inset-0 z-20 flex items-center justify-center bg-ink/40 p-4">
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-[var(--radius-card)] border border-line bg-canvas p-5 shadow-sm">
        <h2 className="mb-1 text-base font-semibold text-ink">Edit "{view.name}"</h2>
        <p className="mb-4 text-sm text-ink-muted">Show, hide, and reorder widgets. Your agent can still set a richer layout via MCP.</p>

        {conflict && (
          <div role="alert" className="mb-4 rounded-[var(--radius-card)] border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn-text">
            <strong className="block">This view changed by your agent.</strong>
            <p className="mb-2">Reload the latest layout before saving your edit, or your changes may conflict.</p>
            <button type="button" onClick={handleReloadFromConflict} className="rounded-[var(--radius-card)] border border-warn-border px-2.5 py-1 text-xs font-semibold text-warn-text hover:bg-canvas">
              Reload latest layout
            </button>
          </div>
        )}

        {updateView.isError && !conflict && (
          <p role="alert" className="mb-3 text-sm text-chip-danger-text">
            {updateView.error instanceof Error ? updateView.error.message : "Couldn't save this view."}
          </p>
        )}

        <ul className="mb-4 space-y-1.5">
          {draft.map((widget, index) => (
            <li key={widget.id} className="flex items-center gap-2 rounded-[var(--radius-card)] border border-line px-2.5 py-2">
              <span className={`min-w-0 flex-1 truncate text-sm ${widget.visible ? "text-ink" : "text-ink-muted line-through"}`}>{widgetLabel(widget)}</span>
              <button type="button" onClick={() => moveUp(index)} disabled={index === 0} aria-label={`Move ${widgetLabel(widget)} up`} className="rounded px-1.5 py-1 text-ink-muted hover:bg-surface disabled:opacity-30">
                ↑
              </button>
              <button
                type="button"
                onClick={() => moveDown(index)}
                disabled={index === draft.length - 1}
                aria-label={`Move ${widgetLabel(widget)} down`}
                className="rounded px-1.5 py-1 text-ink-muted hover:bg-surface disabled:opacity-30"
              >
                ↓
              </button>
              <button type="button" onClick={() => toggleVisible(widget.id)} aria-pressed={widget.visible} className="rounded-[var(--radius-card)] border border-line px-2 py-1 text-xs font-medium text-ink hover:bg-surface">
                {widget.visible ? "Hide" : "Show"}
              </button>
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-[var(--radius-card)] border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={updateView.isPending}
            className="rounded-[var(--radius-card)] border border-accent bg-accent px-3 py-1.5 text-sm font-semibold text-accent-contrast disabled:opacity-60"
          >
            {updateView.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
