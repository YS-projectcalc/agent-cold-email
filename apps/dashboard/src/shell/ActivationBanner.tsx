import { useAccount } from "../api/queries";
import type { ActivationSurfaceState } from "../api/types";

const BANNER_REFRESH_SECONDS = 30;

// G3 (ga-gates-design-2026-07-22.md §G3) — the app-wide HONESTY banner. A PAID
// tenant whose real send path isn't live gets a SandboxEmailPort that SIMULATES
// successful sends; this banner tells the human the truth so "sent" counts on
// the pages below are never mistaken for real delivery. Copy posture (design):
// honest, no fake progress bars, no countdown/ETA we can't honor (arming needs a
// founder session), and NEVER reveal an OFAC match — a review says "account
// review", not "sanctions match" (false-positive dignity).
//
// Rendered only for the provisioning-honesty states this lane owns
// (pending_provisioning / capacity_pending / screening_hold). 'sandbox' is the
// expected demo/free context (no banner); 'suspended'/'canceled' are handled by
// the existing billing/sign-in flows (TokenGate) — kept out of here to avoid
// double-messaging the same condition (signup-auth collision note). Additive:
// sits beside MailboxHealthBanner in AppShell, suppresses no other UI.
const HONESTY_STATES: Record<string, { severity: "warning" | "info"; message: string }> = {
  pending_provisioning: {
    severity: "warning",
    message: "Your account is provisioning — real sending is not live yet. Sends shown are sandbox previews.",
  },
  capacity_pending: {
    severity: "warning",
    message:
      "Provisioning is paused at a capacity limit — our team has been notified. Real sending is not live yet; sends shown are sandbox previews.",
  },
  screening_hold: {
    severity: "info",
    message: "Your account is under review. We'll be in touch — sending is not live yet.",
  },
};

export function ActivationBanner() {
  const account = useAccount(BANNER_REFRESH_SECONDS);
  const state = account.data?.activationState as ActivationSurfaceState | undefined;
  const entry = state ? HONESTY_STATES[state] : undefined;
  if (!entry) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
      className={`flex items-center justify-between gap-3 border-b px-4 py-2 text-sm sm:px-6 lg:px-8 ${
        entry.severity === "warning"
          ? "border-chip-warning-text/30 bg-chip-warning-bg text-chip-warning-text"
          : "border-chip-neutral-text/30 bg-chip-neutral-bg text-chip-neutral-text"
      }`}
    >
      <p className="min-w-0 font-medium" title={entry.message}>
        {entry.message}
      </p>
    </div>
  );
}
