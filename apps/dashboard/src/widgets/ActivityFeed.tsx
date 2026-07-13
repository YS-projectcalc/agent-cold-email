import { useState } from "react";
import { useActivity } from "../api/queries";
import { formatIsoTooltip, formatRelativeTime } from "../lib/format";
import { WidgetChrome } from "./WidgetChrome";
import type { WidgetOfType } from "./types";

const KIND_LABEL: Record<string, string> = { event: "Event", deliverability: "Agent action" };

export function ActivityFeed({ widget }: { widget: WidgetOfType<"activity_feed"> }) {
  const { props } = widget;
  const [limit, setLimit] = useState(props.limit);
  const query = useActivity(limit, props.refreshSeconds);
  const items = query.data?.items ?? [];

  return (
    <WidgetChrome
      title={props.title ?? "Activity"}
      isLoading={query.isLoading}
      isError={query.isError}
      errorMessage={query.error?.message}
      onRetry={() => void query.refetch()}
      isEmpty={query.isSuccess && items.length === 0}
      emptyMessage="No activity yet."
    >
      <ul className="divide-y divide-line/60">
        {items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-3 py-2 text-sm snap-start">
            <div className="min-w-0">
              <span className="mr-1.5 rounded bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                {KIND_LABEL[item.kind] ?? item.kind}
              </span>
              <span className="text-ink">{item.label}</span>
              {item.target && <span className="text-ink-muted"> · {item.target}</span>}
            </div>
            <time title={formatIsoTooltip(item.ts)} className="shrink-0 whitespace-nowrap tabular-nums text-ink-muted">
              {formatRelativeTime(item.ts)}
            </time>
          </li>
        ))}
      </ul>
      {query.data?.nextCursor && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + props.limit)}
          className="mt-2 w-full rounded-[var(--radius-card)] border border-line py-1.5 text-xs font-medium text-ink hover:bg-surface"
        >
          Load more
        </button>
      )}
    </WidgetChrome>
  );
}
