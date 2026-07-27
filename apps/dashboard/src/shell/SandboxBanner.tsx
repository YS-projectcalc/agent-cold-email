import { Link } from "react-router-dom";
import { useAccount } from "../api/queries";

const BANNER_REFRESH_SECONDS = 30;

/**
 * Founder ruling (mid-build addendum, "shouldn't go live be more prominent
 * somewhere?") — a persistent, quiet, non-blocking banner on every dashboard
 * page while the tenant is in sandbox (activationState === 'sandbox', i.e.
 * not on a paid plan), pointing at BillingPage's #go-live section. Derives
 * from the SAME /account activationState field ActivationBanner already
 * reads (no new state fetch) — that banner deliberately excludes 'sandbox'
 * (its own comment: "the expected demo/free context"), so the two never
 * double-message the same tenant. Disappears the moment checkout completes
 * (any non-sandbox activationState), not just once fully 'active' — the
 * confusion this fixes is "how do I even start," which checkout itself
 * resolves.
 */
export function SandboxBanner() {
  const account = useAccount(BANNER_REFRESH_SECONDS);
  if (account.data?.activationState !== "sandbox") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
      className="flex items-center justify-between gap-3 border-b border-chip-neutral-text/30 bg-chip-neutral-bg px-4 py-2 text-sm text-chip-neutral-text sm:px-6 lg:px-8"
    >
      <p className="min-w-0 font-medium">Sandbox mode — sends are simulated</p>
      <Link to="/billing#go-live" className="shrink-0 whitespace-nowrap font-medium underline underline-offset-2">
        Go live
      </Link>
    </div>
  );
}
