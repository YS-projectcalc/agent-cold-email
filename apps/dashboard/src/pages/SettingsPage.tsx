import { useAuth } from "../auth/AuthProvider";
import { useAccount, useInfrastructureStatus } from "../api/queries";
import { card, cardPad } from "../lib/ui";
import { MailboxHealthTable } from "../widgets/MailboxHealthTable";

const SETTINGS_REFRESH_SECONDS = 30;

export function SettingsPage() {
  const { tenantId, logout } = useAuth();
  const infra = useInfrastructureStatus(SETTINGS_REFRESH_SECONDS);
  const account = useAccount(SETTINGS_REFRESH_SECONDS);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink">Settings</h1>

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
        <button type="button" onClick={() => void logout()} className="rounded-[var(--radius-card)] border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface">
          Log out
        </button>
      </section>
    </div>
  );
}
