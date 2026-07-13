import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLabelThread, useMarkThread, useInboxInfinite } from "../api/queries";
import type { InboxRow } from "../api/types";
import { DESKTOP_QUERY, useMediaQuery } from "../lib/useMediaQuery";
import { useInboxFilters } from "../inbox/useInboxFilters";
import { useInboxKeyboard } from "../inbox/useInboxKeyboard";
import { usePendingAction } from "../inbox/usePendingAction";
import { FiltersBar } from "../inbox/FiltersBar";
import { ThreadList } from "../inbox/ThreadList";
import { ThreadDetailPane } from "../inbox/ThreadDetailPane";
import { LabelSheet } from "../inbox/LabelPicker";
import { UndoToast } from "../inbox/UndoToast";
import { CommandPalette } from "../inbox/CommandPalette";
import { NoThreadsYetState } from "../inbox/EmptyStates";

const MAX_AUTO_FETCH_PAGES = 20;

/**
 * The full unified inbox (SPEC.md §19.6), replacing the M2
 * InboxPlaceholderPage. Desktop (≥1024px): split list + detail. Mobile
 * (<768/1024px band, per AppShell's own breakpoint — a dedicated tablet
 * layout is out of scope, matching M2): single pane, detail slides over.
 */
export function InboxPage() {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const { filters, setFilter, selectedThreadId, setSelectedThreadId } = useInboxFilters();

  const infinite = useInboxInfinite(filters);
  const markThread = useMarkThread();
  const labelThread = useLabelThread();
  const pendingAction = usePendingAction();

  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [labelPickerOpen, setLabelPickerOpen] = useState(false);
  const [mobileLabelSheetRow, setMobileLabelSheetRow] = useState<InboxRow | null>(null);
  const [hiddenThreadIds, setHiddenThreadIds] = useState<ReadonlySet<string>>(new Set());
  const [labelOverlay, setLabelOverlay] = useState<Readonly<Record<string, string | null>>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const rawRows = useMemo(() => infinite.data?.pages.flatMap((p) => p.threads) ?? [], [infinite.data]);

  // Backend gaps brief item 1/8 — the server now excludes archived threads
  // itself (`archived=exclude`, api/queries.ts's buildInboxSearch), closing
  // the M3-era gap where this filter was the ONLY thing hiding them (wasting
  // page slots at scale). Kept here too as a cheap belt-and-suspenders
  // backstop: `archiveImmediately` (the `e` shortcut / command palette path,
  // as opposed to the swipe gesture's own `hiddenThreadIds`) relies on
  // useMarkThread's OPTIMISTIC cache patch to hide a row instantly, before
  // the next server refetch — this filter is what makes that patch actually
  // disappear the row rather than just changing its markStatus in place.
  const rows = useMemo(() => {
    return rawRows
      .filter((r) => r.markStatus !== "archived" && !hiddenThreadIds.has(r.threadId))
      .map((r) => (r.threadId in labelOverlay ? { ...r, label: labelOverlay[r.threadId] ?? null } : r));
  }, [rawRows, hiddenThreadIds, labelOverlay]);

  const selectedRow = useMemo(() => rows.find((r) => r.threadId === selectedThreadId) ?? null, [rows, selectedThreadId]);

  // Deep-link (`?thread=…`, e.g. from the dashboard's inbox_preview widget)
  // may point at a row beyond the first loaded page — keep paging until we
  // find it or exhaust the list, rather than silently showing "not found".
  const autoFetchedPages = useRef(0);
  useEffect(() => {
    if (!selectedThreadId || selectedRow || infinite.isFetchingNextPage) return;
    if (!infinite.hasNextPage || autoFetchedPages.current >= MAX_AUTO_FETCH_PAGES) return;
    autoFetchedPages.current += 1;
    void infinite.fetchNextPage();
  }, [selectedThreadId, selectedRow, infinite]);

  const clearFilters = useCallback(() => {
    setFilter({ mailbox: undefined, campaign: undefined, label: undefined, read: undefined, includeNonreply: false });
  }, [setFilter]);

  const unreadCount = useMemo(() => rows.filter((r) => r.markStatus !== "read").length, [rows]);

  const filtersActive = Boolean(filters.mailbox || filters.campaign || filters.label || filters.includeNonreply);
  const emptyReason: "none" | "no-threads-ever" | "no-matches" | "inbox-zero" =
    rows.length > 0
      ? "none"
      : filtersActive
        ? "no-matches"
        : filters.read === false
          ? "inbox-zero"
          : "no-threads-ever";

  function advanceAfterAction(threadId: string) {
    const idx = rows.findIndex((r) => r.threadId === threadId);
    if (idx === -1) return;
    const nextRow = rows[idx + 1] ?? (idx > 0 ? rows[idx - 1] : undefined);
    setSelectedThreadId(nextRow?.threadId ?? null);
    setFocusedIndex(nextRow ? Math.min(idx, rows.length - 2) : -1);
  }

  function selectIndex(index: number) {
    const row = rows[index];
    if (!row) return;
    setFocusedIndex(index);
    setSelectedThreadId(row.threadId);
  }

  // M5 R2 item 6 — shared by the keyboard `e` shortcut / command palette AND
  // mobile swipe: same 5s undo-toast grace window either way (SPEC.md §19.6
  // "Swipe actions get a 5-second UNDO toast" widened to EVERY archive path,
  // not just swipe). Optimistically hides the row immediately; the real
  // mutation only fires once the grace period elapses without an undo.
  function beginArchive(row: InboxRow) {
    setHiddenThreadIds((prev) => new Set(prev).add(row.threadId));
    pendingAction.start({
      threadId: row.threadId,
      message: `Archived ${row.leadEmail}`,
      commit: () => {
        markThread.mutate(
          { threadId: row.threadId, status: "archived" },
          { onError: () => setHiddenThreadIds((prev) => without(prev, row.threadId)) },
        );
      },
    });
  }

  function archiveImmediately(row: InboxRow) {
    beginArchive(row);
    // Auto-advance still happens immediately — only the underlying
    // archive MUTATION is deferred behind the undo window, matching swipe.
    advanceAfterAction(row.threadId);
  }

  function setLabelImmediately(row: InboxRow, label: string | null) {
    labelThread.mutate({ threadId: row.threadId, label });
    setLabelPickerOpen(false);
    advanceAfterAction(row.threadId);
  }

  function startSwipeArchive(row: InboxRow) {
    beginArchive(row);
  }

  function startSwipeLabel(row: InboxRow, label: string | null) {
    setLabelOverlay((prev) => ({ ...prev, [row.threadId]: label }));
    setMobileLabelSheetRow(null);
    pendingAction.start({
      threadId: row.threadId,
      message: label ? `Labeled "${label.replace(/_/g, " ")}"` : "Label cleared",
      commit: () => {
        labelThread.mutate(
          { threadId: row.threadId, label },
          { onSettled: () => setLabelOverlay((prev) => omit(prev, row.threadId)) },
        );
      },
    });
  }

  function handleUndo() {
    const threadId = pendingAction.pending?.threadId;
    pendingAction.undo();
    if (!threadId) return;
    setHiddenThreadIds((prev) => without(prev, threadId));
    setLabelOverlay((prev) => omit(prev, threadId));
  }

  useInboxKeyboard(
    {
      onMoveDown: () => {
        const next = Math.min(focusedIndex + 1, rows.length - 1);
        setFocusedIndex(next);
        if (isDesktop && rows[next]) setSelectedThreadId(rows[next].threadId);
      },
      onMoveUp: () => {
        const next = Math.max(focusedIndex - 1, 0);
        setFocusedIndex(next);
        if (isDesktop && rows[next]) setSelectedThreadId(rows[next].threadId);
      },
      onOpen: () => selectIndex(focusedIndex),
      onArchive: () => selectedRow && archiveImmediately(selectedRow),
      onFocusReply: () => composerRef.current?.focus(),
      onOpenLabelPicker: () => selectedRow && setLabelPickerOpen(true),
      onToggleUnread: () => selectedRow && markThread.mutate({ threadId: selectedRow.threadId, status: selectedRow.markStatus === "read" ? "unread" : "read" }),
      onOpenPalette: () => setPaletteOpen(true),
    },
    !mobileLabelSheetRow,
  );

  return (
    <div className="flex h-full flex-col">
      {/* M5 defect I — a slim mobile-only orientation header (desktop's nav
          rail already labels the section, and the 3-pane layout doesn't
          need it). One line, no wasted vertical space at 390px. */}
      {!isDesktop && (
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
          <h1 className="text-sm font-semibold text-ink">Inbox</h1>
          {unreadCount > 0 && <span className="text-xs text-ink-muted">{unreadCount} unread</span>}
        </div>
      )}
      <FiltersBar filters={filters} onChange={setFilter} />

      <div className="flex min-h-0 flex-1">
        {/* Always mounted (even under the mobile detail overlay below) so the
            virtualizer's scroll position survives a "back" navigation
            instead of remounting to the top — SPEC.md §19.6 "detail slides
            over (back returns to list position)". */}
        <div className={isDesktop ? "w-[380px] shrink-0 border-r border-line" : "flex-1"}>
          {rows.length === 0 && emptyReason === "no-threads-ever" && infinite.isSuccess ? (
            <NoThreadsYetState />
          ) : (
            <ThreadList
              rows={rows}
              selectedThreadId={selectedThreadId}
              focusedIndex={focusedIndex}
              isMobile={!isDesktop}
              onSelectIndex={selectIndex}
              onSwipeArchive={startSwipeArchive}
              onSwipeLabel={(row) => setMobileLabelSheetRow(row)}
              hasNextPage={infinite.hasNextPage}
              isFetchingNextPage={infinite.isFetchingNextPage}
              onLoadMore={() => void infinite.fetchNextPage()}
              isLoading={infinite.isLoading}
              isError={infinite.isError}
              errorMessage={infinite.error instanceof Error ? infinite.error.message : undefined}
              onRetry={() => void infinite.refetch()}
              emptyReason={emptyReason}
              onClearFilters={clearFilters}
            />
          )}
        </div>

        {isDesktop && (
          <div className="min-w-0 flex-1">
            {selectedRow ? (
              <ThreadDetailPane
                ref={composerRef}
                row={selectedRow}
                isMobile={false}
                onBack={() => setSelectedThreadId(null)}
                onSetLabel={(label) => setLabelImmediately(selectedRow, label)}
                labelPickerOpen={labelPickerOpen}
                onToggleLabelPicker={setLabelPickerOpen}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-ink-muted">Select a thread to preview it here.</div>
            )}
          </div>
        )}

        {!isDesktop && selectedRow && (
          // z-20: a true full-screen takeover above BottomTabs (z-10) — the
          // common "reading a thread hides the tab bar" mobile email pattern.
          <div className="fixed inset-0 z-20 bg-canvas">
            <ThreadDetailPane
              ref={composerRef}
              row={selectedRow}
              isMobile
              onBack={() => setSelectedThreadId(null)}
              onSetLabel={(label) => setLabelImmediately(selectedRow, label)}
              labelPickerOpen={labelPickerOpen}
              onToggleLabelPicker={setLabelPickerOpen}
            />
          </div>
        )}
      </div>

      {mobileLabelSheetRow && (
        <LabelSheet
          threadSummary={`${mobileLabelSheetRow.leadEmail} — ${mobileLabelSheetRow.subject ?? "(no subject)"}`}
          currentLabel={mobileLabelSheetRow.label}
          onSelect={(label) => startSwipeLabel(mobileLabelSheetRow, label)}
          onClose={() => setMobileLabelSheetRow(null)}
        />
      )}

      <UndoToast pending={pendingAction.pending} onUndo={handleUndo} graceMs={pendingAction.graceMs} />

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        selectedRow={selectedRow}
        onArchive={() => selectedRow && archiveImmediately(selectedRow)}
        onFocusReply={() => composerRef.current?.focus()}
        onToggleUnread={() => selectedRow && markThread.mutate({ threadId: selectedRow.threadId, status: selectedRow.markStatus === "read" ? "unread" : "read" })}
        onSetLabel={(label) => selectedRow && setLabelImmediately(selectedRow, label)}
        onFilterJump={(patch) => setFilter(patch)}
      />
    </div>
  );
}

function without<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  next.delete(value);
  return next;
}

function omit<T extends Record<string, unknown>>(obj: T, key: string): T {
  const { [key]: _removed, ...rest } = obj;
  return rest as T;
}
