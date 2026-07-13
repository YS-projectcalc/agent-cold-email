import { Link } from "react-router-dom";
import { useInbox } from "../api/queries";
import { chipClasses } from "../lib/ui";
import { formatIsoTooltip, formatRelativeTime } from "../lib/format";
import { WidgetChrome } from "./WidgetChrome";
import type { WidgetOfType } from "./types";

export function InboxPreview({ widget }: { widget: WidgetOfType<"inbox_preview"> }) {
  const { props } = widget;
  const query = useInbox({ limit: props.limit, label: props.label }, props.refreshSeconds);
  const threads = query.data?.threads ?? [];

  return (
    <WidgetChrome
      title={props.title ?? "Inbox"}
      isLoading={query.isLoading}
      isError={query.isError}
      errorMessage={query.error?.message}
      onRetry={() => void query.refetch()}
      isEmpty={query.isSuccess && threads.length === 0}
      emptyMessage="Inbox is empty."
    >
      <ul className="divide-y divide-line/60">
        {threads.map((t) => (
          <li key={t.threadId} className="snap-start">
            <Link to={{ pathname: "/inbox", search: `?thread=${encodeURIComponent(t.threadId)}` }} className="block py-2 hover:bg-surface -mx-1 px-1 rounded">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-ink">{t.subject ?? "(no subject)"}</span>
                <time title={formatIsoTooltip(t.lastEventTs)} className="shrink-0 whitespace-nowrap text-xs tabular-nums text-ink-muted">
                  {formatRelativeTime(t.lastEventTs)}
                </time>
              </div>
              <div className="flex items-center gap-2 text-xs text-ink-muted">
                <span className="truncate">{t.leadEmail}</span>
                <span>·</span>
                <span className="truncate">{t.campaignName}</span>
                {t.label && <span className={chipClasses("info")}>{t.label}</span>}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </WidgetChrome>
  );
}
