import { forwardRef, useState } from "react";
import { useReplyToThread } from "../api/queries";

interface ComposerProps {
  threadId: string;
  /** The mailbox that will send this reply — ThreadDetailPane resolves this
   * from GET /threads/:id's own `mailboxEmail` (falling back to the list
   * row's while that fetch is in flight). Feature-detected as possibly-null
   * rather than assumed present. */
  mailboxEmail: string | null;
  onSent: () => void;
}

/** SPEC.md §19.6 — "explicitly states which mailbox it sends from." Forward
 * a ref so the `r` keyboard shortcut (InboxPage) can focus the textarea. */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer({ threadId, mailboxEmail, onSent }, ref) {
  const [body, setBody] = useState("");
  const reply = useReplyToThread(threadId);

  function handleSend() {
    const trimmed = body.trim();
    if (!trimmed || reply.isPending) return;
    reply.mutate(trimmed, {
      onSuccess: () => {
        setBody("");
        onSent();
      },
    });
  }

  return (
    <div className="border-t border-line bg-canvas p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
      <p className="mb-1.5 text-xs text-ink-muted">
        {mailboxEmail ? (
          <>
            Replying from <span className="font-medium text-ink">{mailboxEmail}</span> — the mailbox that owns this thread
          </>
        ) : (
          "No sending mailbox on record for this thread yet."
        )}
      </p>
      <textarea
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleSend();
        }}
        placeholder="Write a reply…"
        rows={3}
        disabled={!mailboxEmail}
        className="w-full resize-none rounded-[var(--radius-card)] border border-line bg-canvas px-3 py-2 text-sm text-ink disabled:opacity-60"
      />
      {reply.isError && (
        <p role="alert" className="mt-1.5 text-xs text-chip-danger-text">
          {reply.error instanceof Error ? reply.error.message : "Couldn't send this reply."}
        </p>
      )}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={handleSend}
          disabled={!body.trim() || reply.isPending || !mailboxEmail}
          className="rounded-[var(--radius-card)] border border-accent bg-accent px-3 py-1.5 text-sm font-semibold text-accent-contrast disabled:opacity-50"
        >
          {reply.isPending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
});
