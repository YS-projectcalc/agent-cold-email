import type { ReactNode } from "react";
import { card, cardPad } from "../lib/ui";

interface WidgetChromeProps {
  title: string;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  isEmpty?: boolean;
  emptyMessage?: string;
  children: ReactNode;
  className?: string;
}

function SkeletonBars() {
  return (
    <div className="animate-pulse space-y-2" aria-hidden="true">
      <div className="h-4 w-2/3 rounded bg-surface-inset" />
      <div className="h-4 w-full rounded bg-surface-inset" />
      <div className="h-4 w-5/6 rounded bg-surface-inset" />
    </div>
  );
}

/** Every widget's shared frame — SPEC.md §19.3: "Every widget defines
 * loading skeleton, error, and empty states (design-reviewed, not just
 * empty)." One component so all eight widgets look and behave consistently. */
export function WidgetChrome({ title, isLoading, isError, errorMessage, onRetry, isEmpty, emptyMessage, children, className }: WidgetChromeProps) {
  return (
    <section className={`${card} ${cardPad} flex h-full flex-col ${className ?? ""}`} aria-label={title}>
      <h2 className="mb-3 text-sm font-semibold text-ink">{title}</h2>
      {/* M5 defect A/E class — the flip side of widget dead space: MORE
          content than an agent-set `gridPos.h` allocated (e.g. more
          mailboxes than the row height fits) used to overflow this box's
          bottom edge with no containing overflow anywhere in the ancestor
          chain, visually spilling into the widget below it. `overflow-y-auto`
          turns that into an internal scroll — never a fill-and-spill — and
          is a no-op (no scrollbar) whenever content already fits.

          M5 R2 item 4 — `scroll-fade-b` softens that clipped bottom edge
          with a CSS-only fade that disappears once scrolled to the true end
          (see index.css). `snap-y snap-proximity` (paired with each row-level
          component's own `snap-start`) settles a mouse-wheel/trackpad scroll
          on a row boundary rather than mid-row — a no-op for widgets with no
          snap-aligned children (kpi_row/quota_usage/agent_note). */}
      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-b snap-y snap-proximity">
        {isLoading ? (
          <SkeletonBars />
        ) : isError ? (
          <div role="alert" className="flex h-full flex-col items-start justify-center gap-2 text-sm">
            <p className="text-chip-danger-text">{errorMessage ?? "Couldn't load this widget."}</p>
            {onRetry && (
              <button type="button" onClick={onRetry} className="rounded-[var(--radius-card)] border border-line px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface">
                Retry
              </button>
            )}
          </div>
        ) : isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 py-6 text-center">
            <p aria-hidden="true" className="text-2xl text-ink-muted">
              —
            </p>
            <p className="text-sm text-ink-muted">{emptyMessage ?? "No data yet."}</p>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
