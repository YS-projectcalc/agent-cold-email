import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { InboxRow } from "../api/types";
import { ThreadRow } from "./ThreadRow";
import { InboxErrorState, InboxZeroState, NoMatchesState, NoThreadsYetState, ThreadListSkeleton } from "./EmptyStates";

interface ThreadListProps {
  rows: InboxRow[];
  selectedThreadId: string | null;
  focusedIndex: number;
  isMobile: boolean;
  onSelectIndex: (index: number) => void;
  onSwipeArchive: (row: InboxRow) => void;
  onSwipeLabel: (row: InboxRow) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
  /** Distinguishes "nothing has ever arrived" from "filters hide everything"
   * from "unread filter + fully triaged" — three different empty stories
   * (SPEC.md §19.6). */
  emptyReason: "none" | "no-threads-ever" | "no-matches" | "inbox-zero";
  onClearFilters: () => void;
}

const ROW_HEIGHT_ESTIMATE = 80;
const LOAD_MORE_THRESHOLD = 6;

/** Virtualized (TanStack Virtual), cursor-paginated thread list — the
 * desktop split-view left pane and the mobile single-pane list share this
 * component. */
export function ThreadList({
  rows,
  selectedThreadId,
  focusedIndex,
  isMobile,
  onSelectIndex,
  onSwipeArchive,
  onSwipeLabel,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  emptyReason,
  onClearFilters,
}: ThreadListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  // M5 defect C systemic guard: `estimateSize` alone is a STATIC guess used
  // for absolute positioning — without real per-row measurement, a row that
  // renders even slightly taller than the estimate (long subject/snippet
  // wrap, a chip row) gets positioned as if it were exactly
  // `ROW_HEIGHT_ESTIMATE`, so the next row's opaque background renders on
  // top of and hides the overflow. Wiring the default `measureElement` ref
  // (via ResizeObserver, below) onto each row replaces the guess with the
  // real rendered height, so no future content variation can reproduce this
  // class of clip regardless of chip-length tuning.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 8,
  });

  // Keyboard j/k moves `focusedIndex` in the parent; keep the virtualizer's
  // viewport following it so the focus ring is never scrolled off-screen.
  useEffect(() => {
    if (focusedIndex >= 0 && focusedIndex < rows.length) virtualizer.scrollToIndex(focusedIndex, { align: "auto" });
  }, [focusedIndex, rows.length, virtualizer]);

  function handleScroll() {
    const el = parentRef.current;
    if (!el || !hasNextPage || isFetchingNextPage) return;
    const items = virtualizer.getVirtualItems();
    const last = items[items.length - 1];
    if (last && last.index >= rows.length - LOAD_MORE_THRESHOLD) onLoadMore();
  }

  if (isLoading) return <ThreadListSkeleton />;
  if (isError) return <InboxErrorState message={errorMessage} onRetry={onRetry} />;
  if (rows.length === 0) {
    if (emptyReason === "no-threads-ever") return <NoThreadsYetState />;
    if (emptyReason === "inbox-zero") return <InboxZeroState />;
    return <NoMatchesState onClearFilters={onClearFilters} />;
  }

  return (
    <div ref={parentRef} onScroll={handleScroll} className="h-full overflow-y-auto" aria-label="Thread list" role="list">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          return (
            <div
              key={row.threadId}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              role="listitem"
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
            >
              <ThreadRow
                row={row}
                isSelected={row.threadId === selectedThreadId}
                isFocused={virtualRow.index === focusedIndex}
                isMobile={isMobile}
                onSelect={() => onSelectIndex(virtualRow.index)}
                onSwipeArchive={() => onSwipeArchive(row)}
                onSwipeLabel={() => onSwipeLabel(row)}
              />
            </div>
          );
        })}
      </div>
      {isFetchingNextPage && <div className="p-3 text-center text-xs text-ink-muted">Loading more…</div>}
    </div>
  );
}
