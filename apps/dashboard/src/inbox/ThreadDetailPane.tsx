import { forwardRef, useEffect } from "react";
import type { InboxRow } from "../api/types";
import { useMarkThread, useThread } from "../api/queries";
import { chipClasses, chipTruncateCampaign, chipTruncateLabel } from "../lib/ui";
import { formatIsoTooltip, formatRelativeTime } from "../lib/format";
import { MessageBody } from "./MessageBody";
import { LabelPickerPanel } from "./LabelPicker";
import { Composer } from "./Composer";
import { ThreadDetailSkeleton } from "./EmptyStates";

interface ThreadDetailPaneProps {
  row: InboxRow;
  isMobile: boolean;
  onBack: () => void;
  onSetLabel: (label: string | null) => void;
  /** Controlled from InboxPage so the `l` keyboard shortcut and this pane's
   * own "Label" button open the same panel. */
  labelPickerOpen: boolean;
  onToggleLabelPicker: (open: boolean) => void;
}

/** Desktop right pane / mobile full-screen slide-over (SPEC.md §19.6).
 * Fetches message history from GET /threads/:id; everything else shown here
 * (subject, label, campaign) comes from the list row already in hand.
 * `mailboxEmail` prefers the thread detail fetch's OWN field (backend gaps
 * brief item 2 — engine/threads.ts's ThreadDetail carries it now) over the
 * list row's, so a deep-linked thread (?thread=<id>) whose list row hasn't
 * loaded yet — or is simply stale — still shows the right "Replying from"
 * address; the row value is only a fallback while the fetch is in flight. */
export const ThreadDetailPane = forwardRef<HTMLTextAreaElement, ThreadDetailPaneProps>(function ThreadDetailPane(
  { row, isMobile, onBack, onSetLabel, labelPickerOpen, onToggleLabelPicker },
  composerRef,
) {
  const thread = useThread(row.threadId);
  const mark = useMarkThread();

  // "Mark read on open" (§19.6). Runs once per thread selection, not on
  // every mark-mutation settle (markStatus flips locally via the optimistic
  // patch, which would otherwise re-trigger this effect in a loop).
  useEffect(() => {
    if (row.markStatus !== "read") mark.mutate({ threadId: row.threadId, status: "read" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed only on threadId, see comment above
  }, [row.threadId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          {isMobile && (
            <button type="button" onClick={onBack} className="mb-1 text-sm font-medium text-accent hover:underline">
              ← Back
            </button>
          )}
          <h2 className="truncate text-base font-semibold text-ink">{row.subject ?? "(no subject)"}</h2>
          <p className="truncate text-sm text-ink-muted">{row.leadEmail}</p>
          {/* M5 defect C — same chip length policy as ThreadRow: capped
              width + ellipsis + `flex-nowrap` so a long campaign name can't
              wrap this header to two lines (M3 report). */}
          <div className="mt-1.5 flex flex-nowrap items-center gap-1.5 overflow-hidden">
            <span className={`${chipClasses("neutral")} shrink-0`} title={row.campaignName}>
              <span className={chipTruncateCampaign}>{row.campaignName}</span>
            </span>
            {row.label && (
              <span className={`${chipClasses("info")} shrink-0`} title={row.label.replace(/_/g, " ")}>
                <span className={chipTruncateLabel}>{row.label.replace(/_/g, " ")}</span>
              </span>
            )}
            <time title={formatIsoTooltip(row.lastEventTs)} className="shrink-0 whitespace-nowrap text-xs tabular-nums text-ink-muted">
              {formatRelativeTime(row.lastEventTs)}
            </time>
          </div>
        </div>
        <div className="relative shrink-0">
          <button type="button" onClick={() => onToggleLabelPicker(!labelPickerOpen)} className="rounded-[var(--radius-card)] border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface">
            Label
          </button>
          {labelPickerOpen && (
            <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-[var(--radius-card)] border border-line bg-canvas p-3 shadow-sm">
              <LabelPickerPanel currentLabel={row.label} onSelect={onSetLabel} onClose={() => onToggleLabelPicker(false)} />
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {thread.isLoading ? (
          <ThreadDetailSkeleton />
        ) : thread.isError ? (
          <div role="alert" className="text-sm text-chip-danger-text">
            Couldn't load this thread.{" "}
            <button type="button" onClick={() => void thread.refetch()} className="underline">
              Retry
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {thread.data?.messages.map((message, i) => (
              <div key={message.messageId ?? i} className="rounded-[var(--radius-card)] border border-line bg-surface p-3">
                <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-ink-muted">
                  <span className="font-medium uppercase tracking-[0.05em]">{message.type}</span>
                  <time title={formatIsoTooltip(message.ts)}>{formatRelativeTime(message.ts)}</time>
                </div>
                <MessageBody message={message} />
              </div>
            ))}
          </div>
        )}
      </div>

      <Composer ref={composerRef} threadId={row.threadId} mailboxEmail={thread.data?.mailboxEmail ?? row.mailboxEmail} onSent={() => void thread.refetch()} />
    </div>
  );
});
