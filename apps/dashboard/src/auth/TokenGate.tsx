import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthProvider";
import type { UnauthorizedReason } from "../api/unauthorizedBus";
import { BRAND_NAME } from "../lib/brand";
import { card, cardPad } from "../lib/ui";
import { LogoMark } from "../lib/LogoMark";

// SPEC.md §19.1/§19.6 — token-gate screen: paste-token login, with distinct
// error states for "that token was rejected just now" (this form's own
// submit error) vs "you were signed in and got dropped" (AuthProvider's
// `reason`, set by a mid-session 401 anywhere in the app). Backend gaps brief
// item 4: every 401 now carries a machine-readable `code`
// (apps/platform/src/require-auth.ts's AuthFailureCode) — `reason` renders a
// DISTINCT, honest explanation per code below, closing the M2 report's note
// that this used to be a single generic "session ended" banner.
const REASON_COPY: Record<UnauthorizedReason, string> = {
  invalid_token: "Your session is no longer valid. Sign back in with your tenant token.",
  expired_session: "Your session expired. Sign back in to continue.",
  account_suspended: "This account has been suspended. Sign back in to see why, or reach out for help.",
};

export function TokenGate() {
  const { login, loginPending, reason } = useAuth();
  const [token, setToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const trimmed = token.trim();
    if (!trimmed) {
      setFormError("Paste your tenant token to continue.");
      return;
    }
    const result = await login(trimmed);
    if (!result.ok) setFormError(result.message);
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas px-4">
      <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(circle_at_68%_22%,rgba(46,92,255,.13),transparent_34%),linear-gradient(rgba(217,218,211,.45)_1px,transparent_1px),linear-gradient(90deg,rgba(217,218,211,.45)_1px,transparent_1px)] bg-[size:auto,40px_40px,40px_40px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_78%)]" />
      <div className={`${card} ${cardPad} relative w-full max-w-[420px] border-line bg-surface shadow-[0_28px_80px_rgba(23,27,37,.12)]`}>
        <div className="mb-7 flex items-center gap-3"><LogoMark className="h-9 w-9" /><p className="font-semibold tracking-[-0.03em] text-ink">{BRAND_NAME}</p></div>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[.14em] text-accent">Human control room</p>
        <h1 aria-label="Sign in to your dashboard" className="mb-2 text-2xl font-semibold tracking-[-0.04em] text-ink">See what your agent is running.</h1>
        <p className="mb-6 text-sm leading-6 text-ink-muted">Use the tenant token created at signup. It connects this control room to the same isolated rig your agent operates.</p>

        {reason && (
          <div role="alert" className="mb-4 rounded-[var(--radius-card)] border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn-text">
            <strong className="block">Your session ended.</strong>
            {REASON_COPY[reason]}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <label htmlFor="token" className="mb-1 block text-sm font-medium text-ink">
            Tenant token
          </label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="cr_live_…"
            className="mb-3 w-full rounded-[var(--radius-card)] border border-line bg-canvas px-3 py-2.5 font-mono text-sm text-ink placeholder:text-ink-muted/50"
            aria-invalid={formError ? true : undefined}
            aria-describedby={formError ? "token-error" : undefined}
          />
          {formError && (
            <p id="token-error" role="alert" className="mb-3 text-sm text-chip-danger-text">
              {formError}
            </p>
          )}
          <button
            type="submit"
            disabled={loginPending}
            className="w-full rounded-full border border-accent bg-accent px-4 py-2.5 text-sm font-semibold text-accent-contrast shadow-[0_9px_22px_rgba(46,92,255,.2)] transition hover:bg-[#1839af] disabled:opacity-60"
          >
            {loginPending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
