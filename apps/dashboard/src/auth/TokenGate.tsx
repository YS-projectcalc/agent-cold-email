import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthProvider";
import type { UnauthorizedReason } from "../api/unauthorizedBus";
import { BRAND_NAME } from "../lib/brand";
import { card, cardPad } from "../lib/ui";

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
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className={`${card} ${cardPad} w-full max-w-sm`}>
        <p className="mb-1 font-mono text-sm font-bold text-ink">{BRAND_NAME}</p>
        <h1 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-ink">Sign in to your dashboard</h1>
        <p className="mb-4 text-sm text-ink-muted">Paste the tenant token your agent used at signup.</p>

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
            className="mb-3 w-full rounded-[var(--radius-card)] border border-line bg-canvas px-3 py-2 text-sm text-ink"
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
            className="w-full rounded-[var(--radius-card)] border border-accent bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast disabled:opacity-60"
          >
            {loginPending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
