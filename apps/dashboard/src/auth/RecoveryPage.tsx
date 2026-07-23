import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useRequestLoginLink } from "../api/queries";
import { PublicAuthShell } from "./PublicAuthShell";

// Magic-link login request (design docs/research/human-signup-magic-link-
// design-2026-07-22.md §2.2 item 1) — replaces the prior "tokens cannot be
// emailed back" dead end with a working email-a-link form. The token itself
// is still never emailed (auth.ts stores only its hash) — only a single-use
// session link is.
export function RecoveryPage() {
  const requestLink = useRequestLoginLink();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    requestLink.mutate({ email: email.trim() }, { onSuccess: () => setSubmitted(true) });
  }

  if (submitted) {
    return (
      <PublicAuthShell
        eyebrow="Check your inbox"
        title="If an account exists for that email, a sign-in link is on its way."
        description="The link expires in 15 minutes and works once — it signs you straight into your dashboard, no token to copy or paste."
      >
        <p className="text-sm text-ink-muted">
          Didn't get it?{" "}
          <button type="button" onClick={() => setSubmitted(false)} className="font-semibold text-accent">
            Try again
          </button>
          .
        </p>
        <div className="mt-5 border-t border-line pt-4 text-sm">
          <Link to="/" className="font-semibold text-accent">
            ← Back to token sign-in
          </Link>
        </div>
      </PublicAuthShell>
    );
  }

  return (
    <PublicAuthShell
      eyebrow="Access recovery"
      title="Email yourself a sign-in link."
      description="Coldrig stores a one-way hash of your tenant token, never a recoverable copy — so the token itself can't be emailed back. We CAN email a single-use link that signs you in directly."
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="recovery-email" className="mb-1 block text-sm font-medium text-ink">
            Account email
          </label>
          <input
            id="recovery-email"
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            className="w-full rounded-[var(--radius-card)] border border-line bg-canvas px-3 py-2.5 text-sm text-ink"
          />
        </div>
        {requestLink.isError && (
          <p role="alert" className="text-sm text-chip-danger-text">
            {requestLink.error instanceof Error ? requestLink.error.message : "Could not send a sign-in link right now."}
          </p>
        )}
        <button
          type="submit"
          disabled={requestLink.isPending || !email.trim()}
          className="w-full rounded-full border border-accent bg-accent px-4 py-2.5 text-sm font-semibold text-accent-contrast shadow-[0_9px_22px_rgba(46,92,255,.2)] disabled:opacity-45"
        >
          {requestLink.isPending ? "Sending…" : "Email me a sign-in link"}
        </button>
      </form>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <section className="rounded-[var(--radius-card)] border border-line bg-canvas p-4">
          <span className="text-[11px] font-bold text-accent">No account yet?</span>
          <p className="mt-2 text-xs leading-5 text-ink-muted">Create a fresh sandbox — no real infrastructure or spend to preserve.</p>
          <Link to="/signup" className="mt-3 inline-block text-xs font-semibold text-accent">
            Create a free sandbox →
          </Link>
        </section>
        <section className="rounded-[var(--radius-card)] border border-line bg-canvas p-4">
          <span className="text-[11px] font-bold text-accent">Have your token?</span>
          <p className="mt-2 text-xs leading-5 text-ink-muted">Paste it directly instead of waiting on email.</p>
          <Link to="/" className="mt-3 inline-block text-xs font-semibold text-accent">
            Sign in with token →
          </Link>
        </section>
      </div>
    </PublicAuthShell>
  );
}
