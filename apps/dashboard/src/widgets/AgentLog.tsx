import { useActivity } from "../api/queries";
import { formatIsoTooltip, formatRelativeTime } from "../lib/format";
import { WidgetChrome } from "./WidgetChrome";
import type { WidgetOfType } from "./types";

/**
 * "What my agent did" (§19.1 signature widget) — the B6 deliverability
 * control loop's own actions (throttle/pause/rotate/replace-domain), not
 * inbound mail events. GET /activity has no server-side `kind` filter today
 * (§19.4 lists only limit/cursor) so this widget over-fetches and filters to
 * `kind === "deliverability"` client-side — a documented gap (flagged in the
 * M2 report): a very reply/bounce-heavy tenant could see fewer than
 * `props.limit` agent actions even though more exist further back, since the
 * cursor walks the MERGED feed, not a deliverability-only one. Good enough
 * for v1; a server-side `kind` param would remove the need for the ×4
 * over-fetch entirely.
 */
export function AgentLog({ widget }: { widget: WidgetOfType<"agent_log"> }) {
  const { props } = widget;
  const query = useActivity(Math.min(props.limit * 4, 100), props.refreshSeconds);
  const actions = (query.data?.items ?? []).filter((item) => item.kind === "deliverability").slice(0, props.limit);

  return (
    <WidgetChrome
      title={props.title ?? "Agent log"}
      isLoading={query.isLoading}
      isError={query.isError}
      errorMessage={query.error?.message}
      onRetry={() => void query.refetch()}
      isEmpty={query.isSuccess && actions.length === 0}
      emptyMessage="Your agent hasn't taken any deliverability actions yet."
    >
      <ul className="divide-y divide-line/60">
        {actions.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-3 py-2 text-sm snap-start">
            <div className="min-w-0">
              <span className="text-ink">{item.label}</span>
              {item.target && <span className="text-ink-muted"> · {item.target}</span>}
            </div>
            <time title={formatIsoTooltip(item.ts)} className="shrink-0 whitespace-nowrap tabular-nums text-ink-muted">
              {formatRelativeTime(item.ts)}
            </time>
          </li>
        ))}
      </ul>
    </WidgetChrome>
  );
}
