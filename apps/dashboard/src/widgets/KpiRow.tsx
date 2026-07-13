import { useMetrics } from "../api/queries";
import { formatNumber } from "../lib/format";
import { WidgetChrome } from "./WidgetChrome";
import type { WidgetOfType } from "./types";

const METRIC_LABELS: Record<string, string> = {
  sent: "Sent",
  reply: "Replies",
  bounce: "Bounces",
  soft_bounce: "Soft bounces",
  complaint: "Complaints",
  unsubscribe: "Unsubscribes",
  failed: "Failed",
};

export function KpiRow({ widget }: { widget: WidgetOfType<"kpi_row"> }) {
  const { props } = widget;
  const query = useMetrics(props.refreshSeconds);

  // Counts of 0 are real data (a fresh tenant genuinely sent 0 emails) — not
  // an "empty" state, so this widget never shows the WidgetChrome empty
  // treatment, only loading/error/loaded.
  return (
    <WidgetChrome title={props.title ?? "Overview"} isLoading={query.isLoading} isError={query.isError} errorMessage={query.error?.message} onRetry={() => void query.refetch()}>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {props.metrics.map((metric) => (
          <div key={metric}>
            <p className="text-[length:var(--text-label)] font-medium uppercase tracking-[0.05em] text-ink-muted">{METRIC_LABELS[metric] ?? metric}</p>
            <p className="text-2xl font-semibold tabular-nums text-ink">{query.data ? formatNumber(query.data[metric as keyof typeof query.data]) : "—"}</p>
          </div>
        ))}
      </div>
    </WidgetChrome>
  );
}
