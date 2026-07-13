import { useState } from "react";
import { CANONICAL_THREAD_LABELS } from "@coldstart/shared";
import { chipClasses } from "../lib/ui";

interface LabelPickerPanelProps {
  currentLabel: string | null;
  onSelect: (label: string | null) => void;
  onClose: () => void;
}

/** Canonical chips (packages/shared's CANONICAL_THREAD_LABELS — a UI
 * recommendation, not a server-enforced enum, per SPEC.md §19.2) + free-form
 * input, since an agent's own taxonomy must never be rejected. Shared
 * content between the desktop popover and the mobile label sheet — only the
 * wrapping chrome differs. */
export function LabelPickerPanel({ currentLabel, onSelect, onClose }: LabelPickerPanelProps) {
  const [custom, setCustom] = useState(currentLabel && !(CANONICAL_THREAD_LABELS as readonly string[]).includes(currentLabel) ? currentLabel : "");

  function apply(label: string | null) {
    onSelect(label);
    onClose();
  }

  return (
    <div className="w-full">
      <p className="mb-2 text-xs font-medium uppercase tracking-[0.05em] text-ink-muted">Label this thread</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {CANONICAL_THREAD_LABELS.map((label) => (
          <button
            key={label}
            type="button"
            onClick={() => apply(label)}
            aria-pressed={currentLabel === label}
            className={`${chipClasses(currentLabel === label ? "info" : "neutral")} cursor-pointer border ${currentLabel === label ? "border-accent" : "border-transparent"}`}
          >
            {label.replace(/_/g, " ")}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = custom.trim();
          if (trimmed) apply(trimmed);
        }}
        className="mb-3 flex gap-1.5"
      >
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Custom label…"
          className="min-w-0 flex-1 rounded-[var(--radius-card)] border border-line bg-canvas px-2.5 py-1.5 text-sm text-ink"
        />
        <button type="submit" disabled={!custom.trim()} className="rounded-[var(--radius-card)] border border-accent bg-accent px-2.5 py-1.5 text-xs font-semibold text-accent-contrast disabled:opacity-50">
          Apply
        </button>
      </form>
      <div className="flex justify-between gap-2">
        <button type="button" onClick={() => apply(null)} disabled={!currentLabel} className="text-xs font-medium text-chip-danger-text hover:underline disabled:opacity-40">
          Clear label
        </button>
        <button type="button" onClick={onClose} className="text-xs font-medium text-ink-muted hover:underline">
          Cancel
        </button>
      </div>
    </div>
  );
}

interface LabelSheetProps extends LabelPickerPanelProps {
  threadSummary: string;
}

/** Mobile bottom sheet — opened by swipe-left (SPEC.md §19.6). */
export function LabelSheet({ threadSummary, ...panelProps }: LabelSheetProps) {
  return (
    <div role="dialog" aria-modal="true" aria-label="Label thread" className="fixed inset-0 z-30 flex items-end bg-ink/40" onClick={panelProps.onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full rounded-t-[var(--radius-card)] border-t border-line bg-canvas p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-sm"
      >
        <p className="mb-3 truncate text-sm text-ink-muted">{threadSummary}</p>
        <LabelPickerPanel {...panelProps} />
      </div>
    </div>
  );
}
