import type { PendingAction } from "./usePendingAction";

interface UndoToastProps {
  pending: PendingAction | null;
  onUndo: () => void;
  graceMs: number;
}

/** Fixed-position toast for the mobile swipe-archive/label undo window
 * (SPEC.md §19.6). The progress bar is a pure-CSS width transition timed to
 * the same grace period the hook's timer uses, so the visual countdown and
 * the actual commit deadline can never drift apart. */
export function UndoToast({ pending, onUndo, graceMs }: UndoToastProps) {
  if (!pending) return null;

  return (
    <div role="status" className="fixed inset-x-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-30 overflow-hidden rounded-[var(--radius-card)] border border-line bg-canvas shadow-sm md:inset-x-auto md:right-6 md:w-80">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <p className="text-sm text-ink">{pending.message}</p>
        <button type="button" onClick={onUndo} className="shrink-0 rounded-[var(--radius-card)] border border-line px-2.5 py-1 text-xs font-semibold text-ink hover:bg-surface">
          Undo
        </button>
      </div>
      <div className="h-1 w-full bg-surface-inset">
        <div key={pending.threadId} className="h-full bg-accent" style={{ animation: `undo-countdown ${graceMs}ms linear forwards` }} />
      </div>
      <style>{`@keyframes undo-countdown { from { width: 100%; } to { width: 0%; } }`}</style>
    </div>
  );
}
