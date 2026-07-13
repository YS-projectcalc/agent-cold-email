// Shared Tailwind utility strings (premium-b2b archive: card + chip +
// data-table patterns) — plain className constants, not a CSS component
// layer, so every surface stays "same DOM, different classNames".
export const card = "rounded-[var(--radius-card)] border border-line bg-surface shadow-sm";
export const cardPad = "p-4 sm:p-6";
export const label = "text-[length:var(--text-label)] font-medium uppercase tracking-[0.05em] text-ink-muted";
export const kpiValue = "text-[length:var(--text-kpi)] font-semibold tabular-nums text-ink leading-[var(--text-kpi--line-height)]";
export const tableHeadCell = "px-3 py-2 text-left text-[length:var(--text-label)] font-medium uppercase tracking-[0.05em] text-ink-muted border-b border-line";
export const tableCell = "px-3 py-3 text-sm text-ink border-t border-line/60 align-top";
export const tableRowHover = "hover:bg-surface transition-colors";

export type ChipTone = "danger" | "success" | "warning" | "info" | "neutral";

const chipBase = "inline-flex items-center gap-1 rounded-md px-2.5 py-0.5 text-xs font-medium tabular-nums";

// Full literal class strings per tone — Tailwind's static scanner requires
// complete utility names in source; `bg-chip-${tone}-bg` template-literal
// interpolation would silently fail to generate any CSS at build time.
const chipTones: Record<ChipTone, string> = {
  danger: `${chipBase} bg-chip-danger-bg text-chip-danger-text`,
  success: `${chipBase} bg-chip-success-bg text-chip-success-text`,
  warning: `${chipBase} bg-chip-warning-bg text-chip-warning-text`,
  info: `${chipBase} bg-chip-info-bg text-chip-info-text`,
  neutral: `${chipBase} bg-chip-neutral-bg text-chip-neutral-text`,
};

export function chipClasses(tone: ChipTone): string {
  return chipTones[tone];
}

// M5 defect C — chip length policy, systemwide: every chip that renders
// caller-controlled text (a mailbox address, campaign name, or agent-defined
// label) caps its width and ellipsizes rather than pushing the row onto a
// second line — the full value always survives in a `title` tooltip. Literal
// `ch` values (not a computed helper) for the same static-scanner reason as
// `chipTones` above.
//
// M5 R2 item 7 — widened from 9ch to 11ch: the mailbox chip's text is now
// PRE-truncated in JS (`smartTruncateMiddle`, format.ts — head+ellipsis+tail
// = 11 chars) rather than relying on this CSS end-ellipsis alone, so the
// width needs to comfortably fit that 11-char result without a SECOND,
// mid-string ellipsis kicking in. This class stays as a defensive fallback.
export const chipTruncateMailbox = "max-w-[11ch] truncate";
export const chipTruncateCampaign = "max-w-[12ch] truncate";
export const chipTruncateLabel = "max-w-[14ch] truncate";
