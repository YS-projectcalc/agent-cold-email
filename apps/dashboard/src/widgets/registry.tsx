import type { Widget } from "@coldstart/shared";
import { KpiRow } from "./KpiRow";
import { MailboxHealth } from "./MailboxHealth";
import { CampaignPerformance } from "./CampaignPerformance";
import { ActivityFeed } from "./ActivityFeed";
import { InboxPreview } from "./InboxPreview";
import { AgentLog } from "./AgentLog";
import { AgentNote } from "./AgentNote";
import { QuotaUsage } from "./QuotaUsage";
import { UnsupportedWidget } from "./UnsupportedWidget";

/** SPEC.md §19.3 widget registry v1 — exactly the 8 WIDGET_TYPES entries from
 * @coldstart/shared. `widget` is typed as the shared `Widget` union (never
 * client-side zod-revalidated — the server is trusted, same as every other
 * route response), so an ACTUAL unrecognized `type` string (schema drift: a
 * newer agent/MCP tool wrote a 9th type this build doesn't know) only
 * reaches the `default` branch at runtime, not at the type level — that's
 * what makes "stored-but-unknown type renders a graceful 'unsupported
 * widget' card" (§19.3) possible without a redundant client-side schema. */
/**
 * M5 defect E — widgets whose natural content height is often SHORTER than
 * whatever grid slot height (`gridPos.h`) an agent happened to set: a short
 * agent_note, the two usage bars in quota_usage, or a KPI row. Grid.tsx
 * gives these `align-self: start` so the CARD shrinks to its content instead
 * of stretching (default CSS Grid behavior) to fill the slot and stranding
 * a large empty area below the content. Data-table/list widgets
 * (mailbox_health, campaign_performance, activity_feed, inbox_preview,
 * agent_log) are deliberately excluded — more rows should fill the space an
 * agent gave them.
 */
export const CONTENT_FIT_WIDGET_TYPES: ReadonlySet<Widget["type"]> = new Set(["agent_note", "quota_usage", "kpi_row"]);

export function WidgetRenderer({ widget }: { widget: Widget }) {
  switch (widget.type) {
    case "kpi_row":
      return <KpiRow widget={widget} />;
    case "mailbox_health":
      return <MailboxHealth widget={widget} />;
    case "campaign_performance":
      return <CampaignPerformance widget={widget} />;
    case "activity_feed":
      return <ActivityFeed widget={widget} />;
    case "inbox_preview":
      return <InboxPreview widget={widget} />;
    case "agent_log":
      return <AgentLog widget={widget} />;
    case "agent_note":
      return <AgentNote widget={widget} />;
    case "quota_usage":
      return <QuotaUsage widget={widget} />;
    default:
      return <UnsupportedWidget type={(widget as { type: string }).type} />;
  }
}
