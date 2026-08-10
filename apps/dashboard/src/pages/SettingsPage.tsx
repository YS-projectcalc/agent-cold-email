import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useAccount, useInfrastructureStatus, useRotateToken } from "../api/queries";
import { card, cardPad } from "../lib/ui";
import { CopyButton } from "../lib/CopyButton";
import { MailboxHealthTable } from "../widgets/MailboxHealthTable";
import { Link } from "react-router-dom";

const SETTINGS_REFRESH_SECONDS = 30;

export function SettingsPage() {
  const { tenantId, logout } = useAuth();
  const rotateToken = useRotateToken();
  // Rotation now revokes every dashboard session for the tenant, including this
  // one (BLOCKING-3, docs/adversarial/audit-dashboard-idempotency-2026-08-06.md
  // — a leaked token exchanged for a cookie used to outlive its own rotation).
  // So the next poll after a rotation 401s and the global handler bounces the
  // page to the token gate — which would tear down the ONE and ONLY display of
  // the new token, 30 seconds after it appears, while the user is still copying
  // it. Freezing this page's polling the moment a token is on screen is what
  // keeps the credential recoverable; the user leaves deliberately, via Sign out.
  const rotated = rotateToken.data !== undefined;
  const infra = useInfrastructureStatus(SETTINGS_REFRESH_SECONDS, !rotated);
  const account = useAccount(SETTINGS_REFRESH_SECONDS, !rotated);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

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
          <p className="font-semibold text-ink">Rotate API token</p>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            The full token is never stored recoverably — rotation is the only way to regain access if it's lost, or to replace one you suspect leaked. Your old token stops
            working immediately, and every browser session for this account is signed out with it, so a leaked token can't be traded for a session that outlives the
            rotation. Update your MCP config (or any other client) with the new one.
          </p>
          {rotateToken.data ? (
            <div className="mt-3 rounded-[var(--radius-card)] border border-line bg-[#151820] p-4 text-white">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-[.12em] text-[#9fa6b3]">New token — shown once</span>
                <CopyButton value={rotateToken.data.token} label="Copy token" />
              </div>
              <code className="block overflow-x-auto whitespace-nowrap font-mono text-sm text-[#dfe4ef]">{rotateToken.data.token}</code>
              <p className="mt-3 text-xs leading-5 text-[#9fa6b3]">
                Copy this now. Rotating signs out every browser session for this account, including this one — sign back in with the new token when you're done.
              </p>
            </div>
          ) : confirmingRotate ? (
            <div className="mt-3 rounded-[var(--radius-card)] border border-warn-border bg-warn-bg p-3">
              <p className="text-xs leading-5 text-warn-text">Your current token stops working the instant you confirm. Make sure you're ready to update every client before proceeding.</p>
              {rotateToken.isError && (
                <p role="alert" className="mt-2 text-xs text-chip-danger-text">
                  {rotateToken.error instanceof Error ? rotateToken.error.message : "Could not rotate the token right now."}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={rotateToken.isPending}
                  onClick={() => rotateToken.mutate()}
                  className="rounded-[var(--radius-card)] border border-accent bg-accent px-3 py-1.5 text-xs font-semibold text-accent-contrast disabled:opacity-60"
                >
                  {rotateToken.isPending ? "Rotating…" : "Confirm rotation"}
                </button>
                <button type="button" onClick={() => setConfirmingRotate(false)} className="rounded-[var(--radius-card)] border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmingRotate(true)} className="mt-2 text-xs font-semibold text-accent">
              Rotate API token →
            </button>
          )}
          <a href="/app/recover" className="mt-3 inline-block text-xs font-semibold text-accent">Signed out with no session? Email me a sign-in link →</a>
        </div>
        <button type="button" onClick={() => void logout()} className="rounded-[var(--radius-card)] border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface">
          Log out
        </button>
      </section>
    </div>
  );
}
