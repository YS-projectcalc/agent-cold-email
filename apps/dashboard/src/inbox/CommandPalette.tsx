import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import { CANONICAL_THREAD_LABELS } from "@coldstart/shared";
import { useDashboardViews } from "../api/queries";
import type { InboxRow } from "../api/types";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedRow: InboxRow | null;
  onArchive: () => void;
  onFocusReply: () => void;
  onToggleUnread: () => void;
  onSetLabel: (label: string | null) => void;
  onFilterJump: (patch: { read?: boolean | undefined; includeNonreply?: boolean }) => void;
}

/** `Command.Group`'s `className` wraps BOTH the heading and its items —
 * `text-transform: uppercase` set there would inherit down into every item
 * label too (a real bug caught in a live screenshot: every command read
 * "ARCHIVE THREAD" instead of "Archive thread"). `heading` accepts a
 * ReactNode, so the section-label styling lives here instead, scoped to
 * only the heading text. */
function GroupHeading({ children }: { children: string }) {
  return <span className="text-xs font-medium uppercase tracking-[0.05em] text-ink-muted">{children}</span>;
}

/** SPEC.md §19.6 Cmd+K palette: "actions on the selected thread, filter
 * jumps, saved-view switch, page nav." Dashboard views are fetched lazily
 * (only while the palette is open) since they're otherwise unrelated to the
 * inbox route. */
export function CommandPalette({ open, onOpenChange, selectedRow, onArchive, onFocusReply, onToggleUnread, onSetLabel, onFilterJump }: CommandPaletteProps) {
  const navigate = useNavigate();
  const views = useDashboardViews({ enabled: open });

  function run(action: () => void) {
    action();
    onOpenChange(false);
  }

  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="Command palette" className="fixed inset-0 z-40 flex items-start justify-center bg-ink/40 pt-[15vh]">
      <div className="w-full max-w-lg overflow-hidden rounded-[var(--radius-card)] border border-line bg-canvas shadow-sm">
        <Command.Input autoFocus placeholder="Type a command…" className="w-full border-b border-line bg-canvas px-4 py-3 text-sm text-ink outline-none" />
        <Command.List className="max-h-96 overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-sm text-ink-muted">No matching command.</Command.Empty>

          {selectedRow && (
            <Command.Group heading={<GroupHeading>Selected thread</GroupHeading>} className="px-2 py-1 [&_[cmdk-group-items]]:mt-1">
              <Command.Item onSelect={() => run(onArchive)} className="cursor-pointer rounded-[var(--radius-card)] px-2.5 py-2 text-sm text-ink aria-selected:bg-surface">
                Archive thread
              </Command.Item>
              <Command.Item onSelect={() => run(onFocusReply)} className="cursor-pointer rounded-[var(--radius-card)] px-2.5 py-2 text-sm text-ink aria-selected:bg-surface">
                Reply to thread
              </Command.Item>
              <Command.Item onSelect={() => run(onToggleUnread)} className="cursor-pointer rounded-[var(--radius-card)] px-2.5 py-2 text-sm text-ink aria-selected:bg-surface">
                {selectedRow.markStatus === "read" ? "Mark as unread" : "Mark as read"}
              </Command.Item>
              {CANONICAL_THREAD_LABELS.map((label) => (
                <Command.Item key={label} onSelect={() => run(() => onSetLabel(label))} className="cursor-pointer rounded-[var(--radius-card)] px-2.5 py-2 text-sm text-ink aria-selected:bg-surface">
                  Label as {label.replace(/_/g, " ")}
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group heading={<GroupHeading>Filters</GroupHeading>} className="px-2 py-1 [&_[cmdk-group-items]]:mt-1">
            <Command.Item onSelect={() => run(() => onFilterJump({ read: undefined }))} className="cursor-pointer rounded-[var(--radius-card)] px-2.5 py-2 text-sm text-ink aria-selected:bg-surface">
              Show all threads
            </Command.Item>
            <Command.Item onSelect={() => run(() => onFilterJump({ read: false }))} className="cursor-pointer rounded-[var(--radius-card)] px-2.5 py-2 text-sm text-ink aria-selected:bg-surface">
              Show unread only
            </Command.Item>
            <Command.Item onSelect={() => run(() => onFilterJump({ includeNonreply: true }))} className="cursor-pointer rounded-[var(--radius-card)] px-2.5 py-2 text-sm text-ink aria-selected:bg-surface">
              Show bounces &amp; OOO
            </Command.Item>
          </Command.Group>

          {views.data && views.data.length > 0 && (
            <Command.Group heading={<GroupHeading>Dashboard views</GroupHeading>} className="px-2 py-1 [&_[cmdk-group-items]]:mt-1">
              {views.data.map((v) => (
                <Command.Item key={v.id} onSelect={() => run(() => navigate(`/dashboard?view=${encodeURIComponent(v.id)}`))} className="cursor-pointer rounded-[var(--radius-card)] px-2.5 py-2 text-sm text-ink aria-selected:bg-surface">
                  Switch to view: {v.name}
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group heading={<GroupHeading>Go to</GroupHeading>} className="px-2 py-1 [&_[cmdk-group-items]]:mt-1">
            <Command.Item onSelect={() => run(() => navigate("/dashboard"))} className="cursor-pointer rounded-[var(--radius-card)] px-2.5 py-2 text-sm text-ink aria-selected:bg-surface">
              Dashboard
            </Command.Item>
            <Command.Item onSelect={() => run(() => navigate("/inbox"))} className="cursor-pointer rounded-[var(--radius-card)] px-2.5 py-2 text-sm text-ink aria-selected:bg-surface">
              Inbox
            </Command.Item>
            <Command.Item onSelect={() => run(() => navigate("/settings"))} className="cursor-pointer rounded-[var(--radius-card)] px-2.5 py-2 text-sm text-ink aria-selected:bg-surface">
              Settings
            </Command.Item>
          </Command.Group>
        </Command.List>
      </div>
    </Command.Dialog>
  );
}
