import type { Widget, WidgetType } from "@coldstart/shared";

const TYPE_LABELS: Record<WidgetType, string> = {
  kpi_row: "Overview KPIs",
  mailbox_health: "Mailbox health",
  campaign_performance: "Campaign performance",
  activity_feed: "Activity feed",
  inbox_preview: "Inbox preview",
  agent_log: "Agent log",
  agent_note: "Agent note",
  quota_usage: "Plan usage",
};

export function widgetLabel(widget: Widget): string {
  return widget.props.title || TYPE_LABELS[widget.type] || widget.type;
}
