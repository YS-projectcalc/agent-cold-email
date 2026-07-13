import { useCampaignResults, useCampaigns } from "../api/queries";
import { chipClasses, tableCell, tableHeadCell, tableRowHover } from "../lib/ui";
import { formatNumber } from "../lib/format";
import { WidgetChrome } from "./WidgetChrome";
import type { WidgetOfType } from "./types";

function statusChipTone(status: string): "success" | "neutral" | "danger" {
  if (status === "active") return "success";
  if (status === "paused") return "neutral";
  return "danger";
}

function SingleCampaignBody({ sent, reply, bounce }: { sent: number; reply: number; bounce: number }) {
  return (
    <div className="grid grid-cols-3 gap-4">
      {([
        ["Sent", sent],
        ["Replies", reply],
        ["Bounces", bounce],
      ] as const).map(([label, value]) => (
        <div key={label}>
          <p className="text-[length:var(--text-label)] font-medium uppercase tracking-[0.05em] text-ink-muted">{label}</p>
          <p className="text-2xl font-semibold tabular-nums text-ink">{formatNumber(value)}</p>
        </div>
      ))}
    </div>
  );
}

export function CampaignPerformance({ widget }: { widget: WidgetOfType<"campaign_performance"> }) {
  const { props } = widget;

  if (props.campaignId) {
    const campaignId = props.campaignId;
    const query = useCampaignResults(campaignId, props.refreshSeconds);
    return (
      <WidgetChrome
        title={props.title ?? `Campaign ${campaignId}`}
        isLoading={query.isLoading}
        isError={query.isError}
        errorMessage={query.error?.message}
        onRetry={() => void query.refetch()}
      >
        {query.data && <SingleCampaignBody sent={query.data.sent} reply={query.data.reply} bounce={query.data.bounce} />}
      </WidgetChrome>
    );
  }

  const query = useCampaigns(props.refreshSeconds);
  const campaigns = query.data ?? [];
  return (
    <WidgetChrome
      title={props.title ?? "Campaigns"}
      isLoading={query.isLoading}
      isError={query.isError}
      errorMessage={query.error?.message}
      onRetry={() => void query.refetch()}
      isEmpty={query.isSuccess && campaigns.length === 0}
      emptyMessage="No campaigns launched yet."
    >
      {/* M5 defect A — same `@container` column-priority pattern as
          MailboxHealthTable: Campaign + Status + Sent always shown; Replies
          and Bounces (both narrow tabular-nums columns) drop below `@lg`
          (512px) container width rather than clipping against the card
          edge at a narrow `gridPos.w`. Every row's title tooltip always
          carries the full reply/bounce counts regardless of which columns
          are visible. */}
      <div className="@container overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={tableHeadCell}>Campaign</th>
              <th className={tableHeadCell}>Status</th>
              <th className={`${tableHeadCell} text-right`}>Sent</th>
              <th className={`${tableHeadCell} hidden @lg:table-cell text-right`}>Replies</th>
              <th className={`${tableHeadCell} hidden @lg:table-cell text-right`}>Bounces</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.campaignId} className={`${tableRowHover} snap-start`} title={`${formatNumber(c.counts.reply)} replies · ${formatNumber(c.counts.bounce)} bounces`}>
                <td className={`${tableCell} max-w-[9rem] @sm:max-w-[14rem] @lg:max-w-[20rem] @3xl:max-w-none truncate`} title={c.name}>
                  {c.name}
                </td>
                <td className={tableCell}>
                  <span className={chipClasses(statusChipTone(c.status))}>{c.status}</span>
                </td>
                <td className={`${tableCell} text-right tabular-nums`}>{formatNumber(c.counts.sent)}</td>
                <td className={`${tableCell} hidden @lg:table-cell text-right tabular-nums`}>{formatNumber(c.counts.reply)}</td>
                <td className={`${tableCell} hidden @lg:table-cell text-right tabular-nums`}>{formatNumber(c.counts.bounce)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </WidgetChrome>
  );
}
