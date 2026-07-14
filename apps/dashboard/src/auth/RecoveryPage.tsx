import { Link } from "react-router-dom";
import { PublicAuthShell } from "./PublicAuthShell";

export function RecoveryPage() {
  return (
    <PublicAuthShell
      eyebrow="Access recovery"
      title="Tokens cannot be emailed back."
      description="Coldrig stores a one-way hash, not a recoverable copy of your tenant token. That protects the rig if the database is exposed, but it changes the recovery path."
      wide
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <section className="rounded-[var(--radius-card)] border border-line bg-canvas p-4">
          <span className="text-[11px] font-bold text-accent">01</span>
          <h2 className="mt-5 text-sm font-semibold text-ink">Check your secure store</h2>
          <p className="mt-2 text-xs leading-5 text-ink-muted">Look in the password manager or environment variable used when the tenant was created.</p>
        </section>
        <section className="rounded-[var(--radius-card)] border border-line bg-canvas p-4">
          <span className="text-[11px] font-bold text-accent">02</span>
          <h2 className="mt-5 text-sm font-semibold text-ink">Sandbox account</h2>
          <p className="mt-2 text-xs leading-5 text-ink-muted">Create a fresh sandbox. It has no real infrastructure or spend to preserve.</p>
          <Link to="/signup" className="mt-3 inline-block text-xs font-semibold text-accent">Create another sandbox →</Link>
        </section>
        <section className="rounded-[var(--radius-card)] border border-line bg-canvas p-4">
          <span className="text-[11px] font-bold text-accent">03</span>
          <h2 className="mt-5 text-sm font-semibold text-ink">Production account</h2>
          <p className="mt-2 text-xs leading-5 text-ink-muted">When production activates, support will verify ownership before rotating access. No token is disclosed by email.</p>
          <a href="mailto:support@coldrig.dev?subject=Coldrig%20access%20recovery" className="mt-3 inline-block text-xs font-semibold text-accent">Contact support →</a>
        </section>
      </div>
      <div className="mt-5 border-t border-line pt-4 text-sm"><Link to="/" className="font-semibold text-accent">← Return to sign in</Link></div>
    </PublicAuthShell>
  );
}
