import type { InboxRow } from "../api/types";
import { chipClasses, chipTruncateCampaign, chipTruncateLabel, chipTruncateMailbox } from "../lib/ui";
import { emailLocalPart, formatIsoTooltip, formatRelativeTime, smartTruncateMiddle } from "../lib/format";
import { useSwipeAction } from "./useSwipeAction";

interface ThreadRowProps {
  row: InboxRow;
  isSelected: boolean;
  isFocused: boolean;
  isMobile: boolean;
  onSelect: () => void;
  onSwipeArchive: () => void;
  onSwipeLabel: () => void;
}

function delivDotClass(status: string | null): string {
  if (status === "paused") return "bg-chip-danger-text";
  if (status === "throttled") return "bg-chip-warning-text";
  return "bg-chip-success-text";
}

/** SPEC.md §19.6 list row: "unread-weight sender, subject + snippet, chips
 * (mailbox w/ deliv-status dot, campaign, label), relative time w/ ISO
 * tooltip." Row height target ~64-72px desktop (compact professional
 * density per the build brief). */
export function ThreadRow({ row, isSelected, isFocused, isMobile, onSelect, onSwipeArchive, onSwipeLabel }: ThreadRowProps) {
  const isUnread = row.markStatus !== "read";
  const { offsetX, isDragging, handlers } = useSwipeAction({ onSwipeRight: onSwipeArchive, onSwipeLeft: onSwipeLabel });

  const revealRight = isMobile && offsetX > 0;
  const revealLeft = isMobile && offsetX < 0;

  return (
    <div className="relative overflow-hidden">
      {isMobile && (
        <div className="absolute inset-0 flex items-stretch justify-between" aria-hidden="true">
          <div className={`flex w-24 items-center justify-start bg-chip-success-bg pl-4 text-chip-success-text transition-opacity ${revealRight ? "opacity-100" : "opacity-0"}`}>Archive</div>
          <div className={`flex w-24 items-center justify-end bg-chip-info-bg pr-4 text-chip-info-text transition-opacity ${revealLeft ? "opacity-100" : "opacity-0"}`}>Label</div>
        </div>
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-current={isSelected ? "true" : undefined}
        data-focused={isFocused ? "true" : undefined}
        {...(isMobile ? handlers : {})}
        style={isMobile ? { transform: `translateX(${offsetX}px)`, transition: isDragging ? "none" : "transform 150ms ease-out" } : undefined}
        className={`relative block w-full min-h-[64px] border-b border-line/60 bg-canvas px-4 py-2.5 text-left ${
          isSelected ? "bg-surface" : "hover:bg-surface"
        } ${isFocused ? "ring-2 ring-inset ring-accent" : ""}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={`truncate text-sm ${isUnread ? "font-semibold text-ink" : "font-normal text-ink-muted"}`}>{row.leadEmail}</span>
          <time title={formatIsoTooltip(row.lastEventTs)} className="shrink-0 whitespace-nowrap text-xs tabular-nums text-ink-muted">
            {formatRelativeTime(row.lastEventTs)}
          </time>
        </div>
        <p className={`mt-0.5 truncate text-sm ${isUnread ? "text-ink" : "text-ink-muted"}`}>
          <span className={isUnread ? "font-medium" : ""}>{row.subject ?? "(no subject)"}</span>
          {row.snippet && <span className="text-ink-muted"> — {row.snippet}</span>}
        </p>
        {/* M5 defect C — chip length policy: mailbox chips show the
            local-part only (full address in the chip's title tooltip);
            campaign/label chips cap width + ellipsize. `flex-nowrap` +
            `overflow-hidden` make a second line structurally impossible —
            under the row virtualizer (ThreadList.tsx), a wrapped second
            line of chips used to render BEHIND the next absolutely-
            positioned row and simply disappear. */}
        <div className="mt-1 flex flex-nowrap items-center gap-1.5 overflow-hidden">
          {row.mailboxEmail && (
            <span className={`${chipClasses("neutral")} gap-1 shrink-0`} title={row.mailboxEmail}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${delivDotClass(row.mailboxDelivStatus)}`} aria-hidden="true" />
              <span className={chipTruncateMailbox}>{smartTruncateMiddle(emailLocalPart(row.mailboxEmail))}</span>
            </span>
          )}
          <span className={`${chipClasses("neutral")} shrink-0`} title={row.campaignName}>
            <span className={chipTruncateCampaign}>{row.campaignName}</span>
          </span>
          {row.label && (
            <span className={`${chipClasses("info")} shrink-0`} title={row.label.replace(/_/g, " ")}>
              <span className={chipTruncateLabel}>{row.label.replace(/_/g, " ")}</span>
            </span>
          )}
        </div>
      </button>
    </div>
  );
}
