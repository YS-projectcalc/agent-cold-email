// §19.6 — "Timestamps render browser-local with ISO-8601 tooltip." Shared by
// every widget/table that shows a timestamp (activity feed, inbox preview,
// mailbox last-poll) so the relative-time math has one definition.

function toDate(ts: string | number): Date {
  return typeof ts === "number" ? new Date(ts) : new Date(ts);
}

export function formatRelativeTime(ts: string | number, now: number = Date.now()): string {
  const date = toDate(ts);
  const diffMs = now - date.getTime();
  if (!Number.isFinite(diffMs)) return "—";
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${Math.round(diffMonth / 12)}y ago`;
}

export function formatIsoTooltip(ts: string | number): string {
  const date = toDate(ts);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// M5 defect C (chip length policy) — mailbox chips render the local-part
// only (full address moves to a `title` tooltip), since the domain half
// contributes nothing to at-a-glance recognition and is what was blowing
// past a chip's max-width under the inbox row virtualizer.
export function emailLocalPart(email: string): string {
  const at = email.indexOf("@");
  return at === -1 ? email : email.slice(0, at);
}

// M5 R2 item 7 — sandbox mailboxes are named `${personaSlug}${domainIndex+1}
// ${mailboxIndex+1}` (apps/platform/src/engine/provisioning.ts), so a run's
// mailboxes typically share one long prefix and differ only in the last 1-2
// characters. Plain CSS end-truncation (`chipTruncateMailbox`) ellipsizes
// exactly that distinguishing suffix, collapsing every mailbox in a run to
// the SAME-looking chip. Keeps both ends, drops the indistinguishable
// middle instead. The full local-part always survives in the chip's own
// `title` tooltip (ThreadRow.tsx) regardless.
export function smartTruncateMiddle(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}
