import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useConsumeLoginLink } from "../api/queries";
import { useAuth } from "./AuthProvider";
import { PublicAuthShell } from "./PublicAuthShell";

// Magic-link verification landing (design docs/research/human-signup-magic-
// link-design-2026-07-22.md §1.4). The email client GET-loads this page —
// a GET must never consume the token (Outlook SafeLinks / Gmail / corporate
// scanners prefetch links with a GET); consumption happens only via the JS
// POST below, which a link-prefetcher never executes. No third-party
// assets load here (Referrer-Policy: no-referrer is set globally in
// index.html) — this page is entirely same-origin.

type ViewState =
  | { kind: "verifying" }
  | { kind: "picker"; tenants: { tenantId: string; brand: string }[] }
  | { kind: "error"; message: string }
  | { kind: "missing" };

export function LoginVerifyPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { completeMagicLinkSession } = useAuth();
  const consume = useConsumeLoginLink();
  const [state, setState] = useState<ViewState>({ kind: "verifying" });
  const tokenRef = useRef<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    const token = searchParams.get("token");
    // Strip ?token from the URL immediately, on load — it must never linger
    // in browser history / survive a back-button re-navigation (§1.4/§1.8).
    if (token) {
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    tokenRef.current = token;

    if (!token) {
      setState({ kind: "missing" });
      return;
    }
    // Guards against React StrictMode's double-effect-invocation firing this
    // POST twice with the same single-use token (the second call would 401
    // "already used" and clobber the first call's success).
    if (startedRef.current) return;
    startedRef.current = true;

    consume.mutate(
      { token },
      {
        onSuccess: (result) => {
          if ("tenantId" in result) {
            completeMagicLinkSession(result.tenantId);
            navigate("/dashboard", { replace: true });
          } else {
            setState({ kind: "picker", tenants: result.tenants });
          }
        },
        onError: (err) => {
          setState({ kind: "error", message: err instanceof Error ? err.message : "This sign-in link is invalid or has expired." });
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(tenantId: string) {
    const token = tokenRef.current;
    if (!token) return;
    consume.mutate(
      { token, tenantId },
      {
        onSuccess: (result) => {
          if ("tenantId" in result) {
            completeMagicLinkSession(result.tenantId);
            navigate("/dashboard", { replace: true });
          }
        },
        onError: (err) => {
          setState({ kind: "error", message: err instanceof Error ? err.message : "This sign-in link is invalid or has expired." });
        },
      },
    );
  }

  const recoverAndTokenLinks = (
    <div className="flex flex-wrap gap-3 text-sm">
      <Link to="/recover" className="font-semibold text-accent">
        Request a new link →
      </Link>
      <Link to="/" className="text-ink-muted underline underline-offset-4">
        Sign in with token
      </Link>
    </div>
  );

  if (state.kind === "missing") {
    return (
      <PublicAuthShell eyebrow="Sign-in link" title="This link is missing its token." description="Open the link directly from the email — copying just the page URL won't work.">
        {recoverAndTokenLinks}
      </PublicAuthShell>
    );
  }

  if (state.kind === "error") {
    return (
      <PublicAuthShell eyebrow="Sign-in link" title="This link is invalid or has expired." description={state.message}>
        {recoverAndTokenLinks}
      </PublicAuthShell>
    );
  }

  if (state.kind === "picker") {
    return (
      <PublicAuthShell eyebrow="Sign-in link" title="Which account?" description="This email is on more than one Coldrig tenant. Pick the one you want to open.">
        <div className="space-y-2">
          {state.tenants.map((t) => (
            <button
              key={t.tenantId}
              type="button"
              onClick={() => pick(t.tenantId)}
              disabled={consume.isPending}
              className="w-full rounded-[var(--radius-card)] border border-line bg-canvas px-4 py-3 text-left text-sm font-medium text-ink hover:border-accent disabled:opacity-60"
            >
              {t.brand}
              <span className="ml-2 font-mono text-xs text-ink-muted">{t.tenantId}</span>
            </button>
          ))}
        </div>
      </PublicAuthShell>
    );
  }

  return (
    <PublicAuthShell eyebrow="Sign-in link" title="Signing you in…" description="Verifying your sign-in link.">
      <div role="status" aria-live="polite" className="text-sm text-ink-muted">
        One moment…
      </div>
    </PublicAuthShell>
  );
}
