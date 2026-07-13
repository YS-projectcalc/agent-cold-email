import { chipClasses, tableCell, tableHeadCell, tableRowHover } from "../lib/ui";
import { formatIsoTooltip, formatRelativeTime } from "../lib/format";
import type { MailboxHealthReport } from "../api/types";

function delivStatusChip(status: string) {
  if (status === "paused") return { tone: "danger" as const, text: "Paused" };
  if (status === "throttled") return { tone: "warning" as const, text: "Throttled" };
  return { tone: "success" as const, text: "Healthy" };
}

function warmupLabel(m: MailboxHealthReport): string {
  return m.status === "warming" ? `Warming · day ${m.warmupDay}` : "Warmed";
}

interface MailboxHealthTableProps {
  mailboxes: MailboxHealthReport[];
  showWarmup?: boolean;
}

/**
 * Shared by the mailbox_health WIDGET and Settings→Mailboxes (SPEC.md
 * §19.6) — same data, same columns, one definition (CLAUDE.md rule c: this
 * table used to be hand-duplicated in both places).
 *
 * M5 defect A root cause: the original table hid the Warmup/Last-polled
 * columns behind VIEWPORT breakpoints (`sm:`/`md:`) and let the mailbox
 * email un-truncate past `sm:`. A widget's rendered width is a FRACTION of
 * the viewport (`gridPos.w` of 12 columns) — at a 1440px desktop viewport
 * those viewport breakpoints are true even when the widget itself is only
 * ~600px wide, so the email ran unbounded and the Warmup column clipped
 * against the card edge. `@container` queries the widget's OWN rendered
 * width instead, so the same column-priority rule holds at any `gridPos.w`
 * (verified at w=4/6/7/12) AND inside Settings' full-width card.
 *
 * Column priority: Mailbox + Status + Sent today always shown; Warmup drops
 * below `@lg` (512px) container width; Last polled drops below `@3xl`
 * (768px). Every row's `title` tooltip always carries both, regardless of
 * which columns are currently visible.
 */
export function MailboxHealthTable({ mailboxes, showWarmup = true }: MailboxHealthTableProps) {
  if (mailboxes.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-muted">No mailboxes provisioned yet.</p>;
  }

  return (
    <div className="@container overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={tableHeadCell}>Mailbox</th>
            <th className={tableHeadCell}>Status</th>
            {showWarmup && <th className={`${tableHeadCell} hidden @lg:table-cell`}>Warmup</th>}
            <th className={`${tableHeadCell} text-right`}>Sent today</th>
            <th className={`${tableHeadCell} hidden @3xl:table-cell`}>Last polled</th>
          </tr>
        </thead>
        <tbody>
          {mailboxes.map((m) => {
            const chip = delivStatusChip(m.delivStatus);
            const tooltip = [warmupLabel(m), m.lastPolledAt != null ? `Last polled ${formatRelativeTime(m.lastPolledAt)}` : "Not yet polled"].join(" · ");
            return (
              <tr key={m.email} className={`${tableRowHover} snap-start`} title={tooltip}>
                <td className={`${tableCell} max-w-[8rem] @sm:max-w-[13rem] @lg:max-w-[18rem] @3xl:max-w-none`}>
                  <div className="truncate font-medium text-ink" title={m.email}>
                    {m.email}
                  </div>
                  <div className="truncate text-xs text-ink-muted">{m.domain}</div>
                </td>
                <td className={tableCell}>
                  <span className={chipClasses(chip.tone)}>{chip.text}</span>
                </td>
                {showWarmup && <td className={`${tableCell} hidden @lg:table-cell`}>{warmupLabel(m)}</td>}
                <td className={`${tableCell} text-right tabular-nums`}>
                  {m.sentToday} / {m.dailyCap}
                </td>
                <td className={`${tableCell} hidden @3xl:table-cell`}>
                  {m.lastPolledAt != null ? (
                    <span title={formatIsoTooltip(m.lastPolledAt)}>{formatRelativeTime(m.lastPolledAt)}</span>
                  ) : (
                    <span title="Not yet surfaced by the API" className="text-ink-muted">
                      —
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
