import { useCampaigns, useInfrastructureStatus, type InboxFilters } from "../api/queries";
import { chipClasses } from "../lib/ui";

interface FiltersBarProps {
  filters: InboxFilters;
  onChange: (patch: Partial<{ mailbox: string | undefined; campaign: string | undefined; label: string | undefined; read: boolean | undefined; includeNonreply: boolean }>) => void;
}

const READ_OPTIONS: { value: boolean | undefined; label: string }[] = [
  { value: undefined, label: "All" },
  { value: false, label: "Unread" },
  { value: true, label: "Read" },
];

/** SPEC.md §19.6 — "Filters bar + palette expose mailbox/campaign/label/read
 * + the explicit 'Bounces & OOO' toggle (backed by `include_nonreply`)." The
 * mailbox/campaign option lists come from widgets this app already fetches
 * (mailbox health, campaigns) rather than a new endpoint — no backend gap
 * here. */
export function FiltersBar({ filters, onChange }: FiltersBarProps) {
  const infra = useInfrastructureStatus(60);
  const campaigns = useCampaigns(60);
  const mailboxes = infra.data?.mailboxHealth ?? [];
  const campaignList = campaigns.data ?? [];

  return (
    // Horizontally-scrolling strip on narrow viewports (`flex-nowrap
    // overflow-x-auto`) rather than wrapping to multiple rows — five filter
    // controls wrapped at 390px left native `<select>`s rendering full-width
    // on their own line, which read as oversized/inconsistent next to the
    // compact label input and chip. A scrolling strip is also the more
    // familiar mobile-mail-app pattern (filters scroll sideways, list scrolls
    // down). `shrink-0` on every control keeps them from being squished.
    //
    // M5 defect B — the scroll worked but had no VISIBLE affordance: at
    // 390px the last control (the "Bounces & OOO" toggle) sat flush against
    // the viewport edge, indistinguishable from a hard clip. The mask-image
    // edge-fade is a standard, JS-free "there's more here" signal (fades
    // in/out regardless of scroll position, so it never needs scroll-event
    // wiring to stay correct).
    <div className="flex flex-nowrap items-center gap-2 overflow-x-auto border-b border-line bg-canvas px-4 py-2.5 [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%_-_12px),transparent)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%_-_12px),transparent)]">
      <select
        aria-label="Filter by mailbox"
        value={filters.mailbox ?? ""}
        onChange={(e) => onChange({ mailbox: e.target.value || undefined })}
        className="w-auto max-w-[9.5rem] shrink-0 rounded-[var(--radius-card)] border border-line bg-canvas px-2 py-1 text-sm text-ink"
      >
        <option value="">All mailboxes</option>
        {mailboxes.map((m) => (
          <option key={m.email} value={m.email}>
            {m.email}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by campaign"
        value={filters.campaign ?? ""}
        onChange={(e) => onChange({ campaign: e.target.value || undefined })}
        className="w-auto max-w-[9.5rem] shrink-0 rounded-[var(--radius-card)] border border-line bg-canvas px-2 py-1 text-sm text-ink"
      >
        <option value="">All campaigns</option>
        {campaignList.map((c) => (
          <option key={c.campaignId} value={c.campaignId}>
            {c.name}
          </option>
        ))}
      </select>

      <input
        aria-label="Filter by label"
        value={filters.label ?? ""}
        onChange={(e) => onChange({ label: e.target.value || undefined })}
        placeholder="Label…"
        className="w-24 shrink-0 rounded-[var(--radius-card)] border border-line bg-canvas px-2 py-1 text-sm text-ink"
      />

      <div role="group" aria-label="Filter by read state" className="flex shrink-0 overflow-hidden rounded-[var(--radius-card)] border border-line">
        {READ_OPTIONS.map((opt) => (
          <button
            key={opt.label}
            type="button"
            aria-pressed={filters.read === opt.value}
            onClick={() => onChange({ read: opt.value })}
            className={`px-2.5 py-1 text-sm font-medium whitespace-nowrap ${filters.read === opt.value ? "bg-accent text-accent-contrast" : "text-ink hover:bg-surface"}`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        aria-pressed={filters.includeNonreply}
        onClick={() => onChange({ includeNonreply: !filters.includeNonreply })}
        className={`${chipClasses(filters.includeNonreply ? "warning" : "neutral")} shrink-0 cursor-pointer whitespace-nowrap border ${filters.includeNonreply ? "border-chip-warning-text/40" : "border-transparent"}`}
        title={filters.includeNonreply ? "Showing bounces & out-of-office replies" : "Bounces & out-of-office replies are hidden"}
      >
        Bounces &amp; OOO {filters.includeNonreply ? "shown" : "hidden"}
      </button>
    </div>
  );
}
