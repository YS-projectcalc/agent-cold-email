import type { TenantMessage } from "../api/types";
import { useAckMessage, useMessagesInfinite } from "../api/queries";
import { formatIsoTooltip, formatRelativeTime } from "../lib/format";
import { card, cardPad, chipClasses, label, type ChipTone } from "../lib/ui";

// W-M5 (docs/adversarial/sweep-completeness-pass-2026-08-17.md) — the
// dashboard's human fallback onto the SAME tenant_messages store
// list_messages/infrastructure_status's messages[] read (engine/tenant-
// messages.ts). Before this page existed the dashboard could not render an
// operator message at all; a human logging in here is exactly the person
// who needs this when the tenant's own agent session isn't running to read
// it via MCP.
//
// Uses GET /messages (the SAME endpoint list_messages calls, cursor-
// paginated, unacked-first) rather than infrastructure_status's capped-5
// preview — the human sees the identical full history the agent would, and
// inherits `listMessagesPage`'s existing expiry treatment for free: expired
// rows are filtered out server-side, same as every agent-facing surface
// (customer-continuity wave's `expires_at` semantics — followed here, not
// reinvented).
const SEVERITY_TONE: Record<TenantMessage["severity"], { tone: ChipTone; text: string }> = {
  info: { tone: "info", text: "Info" },
  action_required: { tone: "warning", text: "Action required" },
  operator_pending: { tone: "warning", text: "Awaiting operator" },
  terminal: { tone: "danger", text: "Stopped" },
};

function MessageRow({ message, onAck, isAcking }: { message: TenantMessage; onAck: (id: string) => void; isAcking: boolean }) {
  const severity = SEVERITY_TONE[message.severity];
  const isUnread = message.readAt === null;

  return (
    <li className={`border-b border-line py-4 last:border-b-0 ${isUnread ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={chipClasses(severity.tone)}>{severity.text}</span>
        <span className={chipClasses(message.source === "operator" ? "success" : "neutral")}>{message.source === "operator" ? "From operator" : "System"}</span>
        <time title={formatIsoTooltip(message.createdAt)} className="ml-auto shrink-0 whitespace-nowrap text-xs tabular-nums text-ink-muted">
          {formatRelativeTime(message.createdAt)}
        </time>
      </div>
      <p className={`mt-2 text-sm leading-6 ${isUnread ? "font-medium text-ink" : "text-ink-muted"}`}>{message.body}</p>
      <div className="mt-2 flex items-center gap-3">
        {isUnread ? (
          <button
            type="button"
            onClick={() => onAck(message.id)}
            disabled={isAcking}
            className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink disabled:opacity-50"
          >
            {isAcking ? "Acknowledging…" : "Acknowledge"}
          </button>
        ) : (
          <span className="text-xs text-ink-muted">Acknowledged</span>
        )}
      </div>
    </li>
  );
}

export function MessagesPage() {
  const query = useMessagesInfinite(20);
  const ack = useAckMessage();
  const messages = query.data?.pages.flatMap((page) => page.messages) ?? [];

  return (
    <div className="mx-auto max-w-[900px] space-y-6">
      <header>
        <p className={label}>Messages</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.04em] text-ink">System and operator notices</h1>
        <p className="mt-2 max-w-[68ch] text-sm leading-6 text-ink-muted">
          The same message store your agent reads via <code>list_messages</code> — a setup step that needs a retry, a mailbox credential going live, or a reply from a human operator. Check
          here if your agent isn't running.
        </p>
      </header>

      <section className={`${card} ${cardPad}`}>
        {query.isLoading && <p className="text-sm text-ink-muted">Loading…</p>}
        {query.isError && <p className="text-sm text-chip-danger-text">Couldn't load messages.</p>}
        {!query.isLoading && !query.isError && messages.length === 0 && <p className="text-sm text-ink-muted">No messages yet.</p>}
        {messages.length > 0 && (
          <ul>
            {messages.map((message) => (
              <MessageRow key={message.id} message={message} onAck={(id) => ack.mutate(id)} isAcking={ack.isPending && ack.variables === message.id} />
            ))}
          </ul>
        )}
        {query.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
              className="rounded-full border border-line px-4 py-2 text-xs font-semibold text-ink disabled:opacity-50"
            >
              {query.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
