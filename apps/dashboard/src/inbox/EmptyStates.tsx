import { InboxIcon } from "../lib/icons";

/** SPEC.md §19.6/§19.3 — "designed empty (no threads / no matches for filter
 * / all processed — give the 'inbox zero' moment some quiet delight), loading
 * skeletons, error." Three distinct empty states because they mean different
 * things to the user: a brand-new tenant (nothing has happened yet), an
 * over-narrow filter (nothing here, but there IS other mail), and true inbox
 * zero (everything has been triaged — a small win worth acknowledging). */

export function NoThreadsYetState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <InboxIcon className="mb-1 h-8 w-8 text-ink-muted" />
      <p className="text-sm font-medium text-ink">No mail yet</p>
      <p className="max-w-xs text-sm text-ink-muted">Replies, bounces, and out-of-office notices from your campaigns will show up here as they come in.</p>
    </div>
  );
}

export function NoMatchesState({ onClearFilters }: { onClearFilters: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p aria-hidden="true" className="text-2xl text-ink-muted">
        —
      </p>
      <p className="text-sm font-medium text-ink">No threads match these filters</p>
      <button type="button" onClick={onClearFilters} className="text-sm font-medium text-accent hover:underline">
        Clear filters
      </button>
    </div>
  );
}

export function InboxZeroState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p aria-hidden="true" className="text-3xl">
        ✓
      </p>
      <p className="text-sm font-medium text-ink">Inbox zero</p>
      <p className="max-w-xs text-sm text-ink-muted">Every thread here has been read. Nice work — new replies will appear automatically.</p>
    </div>
  );
}

export function InboxErrorState({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="text-sm font-medium text-chip-danger-text">{message ?? "Couldn't load the inbox."}</p>
      <button type="button" onClick={onRetry} className="rounded-[var(--radius-card)] border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface">
        Retry
      </button>
    </div>
  );
}

export function ThreadListSkeleton() {
  return (
    <div className="animate-pulse space-y-3 p-4" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-9 w-9 shrink-0 rounded-full bg-surface-inset" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-2/3 rounded bg-surface-inset" />
            <div className="h-3 w-1/3 rounded bg-surface-inset" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ThreadDetailSkeleton() {
  return (
    <div className="animate-pulse space-y-3 p-6" aria-hidden="true">
      <div className="h-5 w-1/2 rounded bg-surface-inset" />
      <div className="h-3.5 w-1/3 rounded bg-surface-inset" />
      <div className="mt-4 h-24 w-full rounded bg-surface-inset" />
    </div>
  );
}
