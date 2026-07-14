import { useState } from "react";
import { quoteProvisionedMailboxes, MINIMUM_BILLABLE_MAILBOXES, MAX_SELF_SERVE_MAILBOXES } from "@coldstart/shared";
import { useAccount } from "../api/queries";
import { card, cardPad, chipClasses, label } from "../lib/ui";

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat("en-US");

export function BillingPage() {
  const account = useAccount(30);
  const [mailboxes, setMailboxes] = useState(MINIMUM_BILLABLE_MAILBOXES);
  const [spendCeiling, setSpendCeiling] = useState(250);
  const quote = quoteProvisionedMailboxes(mailboxes);
  const wouldExceedCeiling = quote.monthlyCents / 100 > spendCeiling;

  return (
    <div className="mx-auto max-w-[1180px] space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className={label}>Owner billing</p><h1 className="mt-1 text-2xl font-semibold tracking-[-0.04em] text-ink">Know the cost before the agent provisions.</h1><p className="mt-2 max-w-[70ch] text-sm leading-6 text-ink-muted">The intended meter is provisioned mailboxes: warming, ready, and temporarily health-paused capacity all count. Sends are not billed separately.</p></div>
        <span className={chipClasses("warning")}>Preview · paid activation pending</span>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_.8fr]">
        <section className={`${card} ${cardPad}`}>
          <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold text-ink">Monthly price calculator</h2><output htmlFor="billing-mailboxes" className="font-mono text-2xl font-semibold text-accent">{mailboxes}</output></div>
          <label htmlFor="billing-mailboxes" className="mt-6 block text-xs font-semibold text-ink">Provisioned mailboxes</label>
          <input id="billing-mailboxes" type="range" min={MINIMUM_BILLABLE_MAILBOXES} max={MAX_SELF_SERVE_MAILBOXES} value={mailboxes} onChange={(event) => setMailboxes(Number(event.target.value))} className="mt-3 w-full accent-[var(--accent)]" />
          <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-muted"><span>5</span><span>60</span></div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <div className="rounded-[var(--radius-card)] bg-surface-inset p-4"><p className={label}>Monthly</p><p className="mt-2 text-2xl font-semibold text-ink">{dollars.format(quote.monthlyCents / 100)}</p></div>
            <div className="rounded-[var(--radius-card)] bg-surface-inset p-4"><p className={label}>Domains</p><p className="mt-2 text-2xl font-semibold text-ink">≈{quote.estimatedDomains}</p></div>
            <div className="rounded-[var(--radius-card)] bg-surface-inset p-4"><p className={label}>Planning capacity</p><p className="mt-2 text-2xl font-semibold text-ink">≈{integer.format(quote.planningSendsPerMonth)}</p><p className="mt-1 text-[10px] text-ink-muted">after warmup · not contractual</p></div>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4 font-mono text-xs text-ink-muted"><span>$49 platform</span><span className="text-accent">+</span><span>$10 × {mailboxes} mailboxes</span><span className="ml-auto font-semibold text-ink">= {dollars.format(quote.monthlyCents / 100)}</span></div>
        </section>

        <aside className={`${card} ${cardPad}`}>
          <div className="flex items-start justify-between gap-3"><div><p className={label}>Current account</p><h2 className="mt-1 text-lg font-semibold capitalize text-ink">{account.data?.plan ?? "Loading"}</h2></div><span className={chipClasses(account.data?.billingState === "active" ? "success" : "neutral")}>{account.data?.billingState ?? "checking"}</span></div>
          <dl className="mt-5 space-y-3 border-y border-line py-4 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-ink-muted">Provisioned now</dt><dd className="font-semibold text-ink">{account.data?.mailboxes ?? "—"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-muted">Payment method</dt><dd className="text-ink">Not collected in sandbox</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-muted">Renewal</dt><dd className="text-ink">Not active</dd></div>
          </dl>
          <label htmlFor="spend-ceiling" className="mt-5 block text-xs font-semibold text-ink">Owner-controlled monthly ceiling</label>
          <div className="mt-2 flex items-center gap-2"><span className="text-sm text-ink-muted">$</span><input id="spend-ceiling" type="number" min="99" step="10" value={spendCeiling} onChange={(event) => setSpendCeiling(Number(event.target.value))} className="w-full rounded-[var(--radius-card)] border border-line bg-canvas px-3 py-2 text-sm text-ink" /></div>
          {wouldExceedCeiling ? <p role="status" className="mt-2 text-xs text-chip-danger-text">This quote exceeds the proposed owner ceiling by {dollars.format((quote.monthlyCents / 100) - spendCeiling)}. Provisioning would be blocked.</p> : <p role="status" className="mt-2 text-xs text-chip-success-text">This quote is within the proposed owner ceiling.</p>}
          <button type="button" disabled className="mt-5 w-full cursor-not-allowed rounded-full bg-ink px-4 py-2.5 text-sm font-semibold text-white opacity-45">Save billing controls at activation</button>
          <p className="mt-3 text-xs leading-5 text-ink-muted">The complete screen is present now; persistence, payment-method changes, and subscription mutations remain disabled until Stripe quantity billing replaces the legacy test tiers.</p>
        </aside>
      </div>

      <section className={`${card} ${cardPad}`}>
        <h2 className="text-sm font-semibold text-ink">Subscription actions</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {[['Change mailbox count','Quoted before provisioning'],['Update payment method','Handled by Stripe-hosted billing'],['Cancel subscription','Clear timing and infrastructure teardown']].map(([title, detail]) => <div key={title} className="rounded-[var(--radius-card)] border border-line bg-canvas p-4"><p className="text-sm font-semibold text-ink">{title}</p><p className="mt-1 text-xs leading-5 text-ink-muted">{detail}</p><button type="button" disabled className="mt-4 text-xs font-semibold text-ink-muted opacity-60">Available at activation</button></div>)}
        </div>
      </section>
    </div>
  );
}
