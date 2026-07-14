import { useAuth } from "../auth/AuthProvider";
import { useAccount, useInfrastructureStatus } from "../api/queries";
import { card, cardPad } from "../lib/ui";
import { MailboxHealthTable } from "../widgets/MailboxHealthTable";
import { Link } from "react-router-dom";

const SETTINGS_REFRESH_SECONDS = 30;

export function SettingsPage() {
  const { tenantId, logout } = useAuth();
  const infra = useInfrastructureStatus(SETTINGS_REFRESH_SECONDS);
  const account = useAccount(SETTINGS_REFRESH_SECONDS);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink">Settings</h1>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Link to="/setup" className={`${card} ${cardPad} no-underline`}><p className="text-sm font-semibold text-ink">Agent connection</p><p className="mt-2 text-xs leading-5 text-ink-muted">Client-specific MCP setup and readiness checklist.</p></Link>
        <Link to="/billing" className={`${card} ${cardPad} no-underline`}><p className="text-sm font-semibold text-ink">Billing &amp; spend</p><p className="mt-2 text-xs leading-5 text-ink-muted">Price projection, mailbox quantity, and owner ceiling.</p></Link>
        <a href="https://coldrig.dev/security" className={`${card} ${cardPad} no-underline`}><p className="text-sm font-semibold text-ink">Security &amp; trust</p><p className="mt-2 text-xs leading-5 text-ink-muted">Architecture, access boundaries, and current evidence.</p></a>
        <a href="https://coldrig.dev/support" className={`${card} ${cardPad} no-underline`}><p className="text-sm font-semibold text-ink">Support</p><p className="mt-2 text-xs leading-5 text-ink-muted">Troubleshooting, status, and responsible-abuse reporting.</p></a>
      </section>

      <section className={`${card} ${cardPad}`}>
        <h2 className="mb-3 text-sm font-semibold text-ink">Mailboxes</h2>
        {infra.isLoading ? (
          <div className="animate-pulse space-y-2" aria-hidden="true">
            <div className="h-4 w-full rounded bg-surface-inset" />
            <div className="h-4 w-5/6 rounded bg-surface-inset" />
          </div>
        ) : infra.isError ? (
          <div role="alert" className="text-sm text-chip-danger-text">
            Couldn't load mailboxes.{" "}
            <button type="button" onClick={() => void infra.refetch()} className="underline">
              Retry
            </button>
          </div>
        ) : (
          <MailboxHealthTable mailboxes={infra.data?.mailboxHealth ?? []} />
        )}
      </section>

      <section className={`${card} ${cardPad}`}>
        <h2 className="mb-3 text-sm font-semibold text-ink">Account &amp; session</h2>
        <dl className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-[length:var(--text-label)] font-medium uppercase tracking-[0.05em] text-ink-muted">Tenant ID</dt>
            <dd className="font-mono text-sm text-ink">{tenantId ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[length:var(--text-label)] font-medium uppercase tracking-[0.05em] text-ink-muted">Plan</dt>
            <dd className="text-sm text-ink">{account.data?.plan ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[length:var(--text-label)] font-medium uppercase tracking-[0.05em] text-ink-muted">Account status</dt>
            <dd className="text-sm text-ink">{account.data?.status ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-[length:var(--text-label)] font-medium uppercase tracking-[0.05em] text-ink-muted">Billing state</dt>
            <dd className="text-sm text-ink">{account.data?.billingState ?? "—"}</dd>
          </div>
        </dl>
        <p className="mb-4 text-sm text-ink-muted">
          You're signed in via a secure, httpOnly session cookie tied to your tenant token — the token itself is never stored in this browser. Signing out clears
          the session everywhere it's used from this device.
        </p>
        <div className="mb-4 rounded-[var(--radius-card)] border border-line bg-canvas p-3 text-sm">
          <p className="font-semibold text-ink">Lost-token recovery</p>
          <p className="mt-1 text-xs leading-5 text-ink-muted">The full token is never stored recoverably. Secure-store lookup, sandbox replacement, and verified production rotation are explained in the recovery flow.</p>
          <a href="/app/recover" className="mt-2 inline-block text-xs font-semibold text-accent">Open recovery guidance →</a>
        </div>
        <button type="button" onClick={() => void logout()} className="rounded-[var(--radius-card)] border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface">
          Log out
        </button>
      </section>
    </div>
  );
}
