import { Link } from "react-router-dom";
import { useAccount } from "../api/queries";
import { DESKTOP_QUERY, useMediaQuery } from "../lib/useMediaQuery";

const BANNER_REFRESH_SECONDS = 30;

function pluralMailboxes(n: number): string {
  return n === 1 ? "1 mailbox" : `${n} mailboxes`;
}

/**
 * SPEC.md §19.6 [F7] — "Health surfacing: persistent banner when any mailbox
 * `paused`/`throttled`." Lives in AppShell (not a page, not a widget), so it
 * renders on dashboard/inbox/settings alike and is structurally impossible
 * for `configure_dashboard` to hide — a widget's `visible: false` only
 * affects DashboardGrid; this failsafe reads the account's own deliverability
 * summary directly. Non-dismissable while `pausedMailboxes`/`throttledMailboxes`
 * is nonzero: there is no close button, by design — the condition itself is
 * what makes it disappear.
 */
export function MailboxHealthBanner() {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const account = useAccount(BANNER_REFRESH_SECONDS);
  const deliverability = account.data?.deliverability;
  const paused = deliverability?.pausedMailboxes ?? 0;
  const throttled = deliverability?.throttledMailboxes ?? 0;

  if (paused === 0 && throttled === 0) return null;

  const severity: "danger" | "warning" = paused > 0 ? "danger" : "warning";
  const parts: string[] = [];
  if (paused > 0) parts.push(`${pluralMailboxes(paused)} paused — sending stopped`);
  if (throttled > 0) parts.push(`${pluralMailboxes(throttled)} throttled — sending slowed`);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
      className={`flex items-center justify-between gap-3 border-b px-4 py-2 text-sm sm:px-6 lg:px-8 ${
        severity === "danger" ? "border-chip-danger-text/30 bg-chip-danger-bg text-chip-danger-text" : "border-chip-warning-text/30 bg-chip-warning-bg text-chip-warning-text"
      }`}
    >
      <p className="min-w-0 truncate font-medium" title={parts.join(" · ")}>
        {parts.join(" · ")}
      </p>
      {/* Shorter label off desktop — frees up room for the message itself
          (the more important half of this row) at 390px, where the two
          together used to truncate the message mid-word. */}
      <Link to="settings" className="shrink-0 whitespace-nowrap font-medium underline underline-offset-2">
        {isDesktop ? "Review mailboxes" : "Review"}
      </Link>
    </div>
  );
}
