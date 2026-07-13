import { useAccount } from "../api/queries";
import { formatNumber } from "../lib/format";
import { WidgetChrome } from "./WidgetChrome";
import type { WidgetOfType } from "./types";

function UsageBar({ label, used, cap }: { label: string; used: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-ink-muted">{label}</span>
        <span className="tabular-nums text-ink">
          {formatNumber(used)} / {formatNumber(cap)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-inset">
        <div className="h-1.5 rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function QuotaUsage({ widget }: { widget: WidgetOfType<"quota_usage"> }) {
  const { props } = widget;
  const query = useAccount(props.refreshSeconds);
  const account = query.data;

  return (
    <WidgetChrome title={props.title ?? "Plan usage"} isLoading={query.isLoading} isError={query.isError} errorMessage={query.error?.message} onRetry={() => void query.refetch()}>
      {account && (
        <div className="space-y-3">
          <UsageBar label="Domains" used={account.domains} cap={account.quota.domains} />
          <UsageBar label="Mailboxes" used={account.mailboxes} cap={account.quota.mailboxes} />
          <p className="pt-1 text-xs text-ink-muted">
            Plan <span className="font-medium text-ink">{account.plan}</span> · {formatNumber(account.sends)} sends to date
          </p>
        </div>
      )}
    </WidgetChrome>
  );
}
