import { useState } from "react";
import { billableMailboxes, monthlyRevenueCents, quoteProvisionedMailboxes, MINIMUM_BILLABLE_MAILBOXES, MAX_SELF_SERVE_MAILBOXES } from "@coldstart/shared";
import { ApiError } from "../api/client";
import { useAccount, useCheckout } from "../api/queries";
import type { ActivationSurfaceState } from "../api/types";
import { card, cardPad, chipClasses, label, type ChipTone } from "../lib/ui";

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat("en-US");

// Adversary golive-ux-review-2026-07-27.md finding 4 (NB#4) — the header chip
// used to be a hardcoded "Preview · paid activation pending" regardless of
// real state; now it reflects the SAME activationState the sandbox banner
// and setup checklist read (engine/activation.ts's deriveActivationState).
const HEADER_CHIP: Record<ActivationSurfaceState, { tone: ChipTone; text: string }> = {
  sandbox: { tone: "warning", text: "Sandbox · go live to activate billing" },
  active: { tone: "success", text: "Live · billing active" },
  pending_provisioning: { tone: "warning", text: "Billing active · provisioning real sending" },
  capacity_pending: { tone: "warning", text: "Billing active · capacity hold" },
  screening_hold: { tone: "info", text: "Under review" },
  suspended: { tone: "danger", text: "Billing needs attention" },
  canceled: { tone: "neutral", text: "Canceled" },
};

// Adversary finding 3 (NB#3, client half) — reactivation from sandbox/
// canceled/suspended is intended; an already-live tenant (active/
// pending_provisioning/capacity_pending) must never see a control that
// re-triggers checkout (the server independently 400s a second checkout for
// billing_state='active' — engine/billing.ts's startCheckout guard).
const GO_LIVE_VISIBLE_STATES: ReadonlySet<ActivationSurfaceState> = new Set(["sandbox", "canceled", "suspended"]);

export function BillingPage() {
  const account = useAccount(30);
  const [mailboxes, setMailboxes] = useState(MINIMUM_BILLABLE_MAILBOXES);
  const [spendCeiling, setSpendCeiling] = useState(250);
  const quote = quoteProvisionedMailboxes(mailboxes);
  const wouldExceedCeiling = quote.monthlyCents / 100 > spendCeiling;

  // Founder-ordered UX fix — a real pilot customer had no human-facing way to
  // start checkout at all (the only prior path was an agent calling POST
  // /checkout directly). This section is the ONE checkout implementation;
  // the sandbox banner and setup checklist LINK here (#go-live) rather than
  // duplicating the button.
  //
  // Adversary BLOCKING #1 (golive-ux-review-2026-07-27.md finding 1) — the
  // server bills `checkoutMailboxQuantity(ctx) = max(5, provisioned)`
  // (engine/billing.ts:89-94,151) and IGNORES `input.mailboxes` entirely; a
  // free-form selector here was a money-path lie (it could show either a
  // higher OR lower price than the real charge). There is NO user-editable
  // count anymore — the quote is derived from the tenant's real provisioned
  // count, using the identical uncapped max(5, provisioned) formula
  // (`billableMailboxes`/`monthlyRevenueCents`, packages/shared/src/
  // pricing.ts — deliberately NOT `quoteProvisionedMailboxes`, which clamps
  // at the 60-mailbox self-serve ceiling and would under-quote a >60
  // tenant's true charge).
  //
  // Round-2 adversary finding — `account.data.mailboxes` is a plain COUNT(*)
  // (includes soft-released rows: removeMailboxes, deliverability auto-
  // replacement, teardown/cancel release ALL but never DELETE), while the
  // server bills `released_at IS NULL`. A canceled tenant with all mailboxes
  // torn down would show "12 provisioned / $169" but be charged $99 on
  // reactivation. `account.data.billableMailboxes` is the SAME released_at-
  // aware count the server bills (engine/lifecycle.ts's
  // `billableMailboxCount`, single-sourced into both engine/billing.ts's
  // checkoutMailboxQuantity and engine/reporting.ts's getAccount) — reading
  // it here means display and charge can never diverge again.
  const provisioned = account.data?.billableMailboxes ?? 0;
  const billedMailboxes = billableMailboxes(provisioned);
  const goLiveMonthlyCents = monthlyRevenueCents(provisioned);
  // CheckoutInput's zod schema requires 5..60 (packages/shared/src/
  // intents.ts) — this seeds that request body ONLY; the server ignores it
  // and re-reads the live provisioned count (see the comment above), so
  // clamping here can never mis-price the tenant, only fail to validate.
  const checkoutSeedMailboxes = Math.max(MINIMUM_BILLABLE_MAILBOXES, Math.min(MAX_SELF_SERVE_MAILBOXES, provisioned));
  const activationState = account.data?.activationState;
  const showGoLive = activationState !== undefined && GO_LIVE_VISIBLE_STATES.has(activationState);
  const checkout = useCheckout();

  function startGoLiveCheckout() {
    checkout.mutate(
      { mailboxes: checkoutSeedMailboxes, interval: "month" },
      { onSuccess: (result) => { window.location.href = result.url; } },
    );
  }

  return (
    <div className="mx-auto max-w-[1180px] space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className={label}>Owner billing</p><h1 className="mt-1 text-2xl font-semibold tracking-[-0.04em] text-ink">Know the cost before the agent provisions.</h1><p className="mt-2 max-w-[70ch] text-sm leading-6 text-ink-muted">The intended meter is provisioned mailboxes: warming, ready, and temporarily health-paused capacity all count. Sends are not billed separately.</p></div>
        <span className={chipClasses(activationState ? HEADER_CHIP[activationState].tone : "neutral")}>{activationState ? HEADER_CHIP[activationState].text : "Checking…"}</span>
      </header>

      {showGoLive && (
        <section id="go-live" aria-label="Go live" className={`${card} ${cardPad}`}>
          <h2 className="text-sm font-semibold text-ink">Go live</h2>
          <p className="mt-2 text-sm leading-6 text-ink-muted">Starts at $99 for 5 mailboxes, +$10 per additional.</p>
          <p className="mt-2 text-sm leading-6 text-ink-muted">
            Going live bills your provisioned mailboxes, minimum 5 — you have {provisioned} provisioned now. Add or remove mailboxes any time after; your bill follows the live count, and every add returns a price quote first.
          </p>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-ink">{dollars.format(goLiveMonthlyCents / 100)}</span>
            <span className="text-xs text-ink-muted">/mo for {billedMailboxes} mailboxes</span>
          </div>
          {checkout.isError && (
            <p role="alert" className="mt-3 text-sm text-chip-danger-text">
              {checkout.error instanceof ApiError ? checkout.error.message : "Could not start checkout. Try again."}
            </p>
          )}
          <button
            type="button"
            onClick={startGoLiveCheckout}
            disabled={checkout.isPending}
            className="mt-4 rounded-full border border-accent bg-accent px-4 py-2.5 text-sm font-semibold text-accent-contrast shadow-[0_9px_22px_rgba(46,92,255,.2)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {checkout.isPending ? "Redirecting…" : "Go live"}
          </button>
          <p className="mt-3 text-xs leading-5 text-ink-muted">Have a promo code? Add it on the payment page — you'll see "Add promotion code" at checkout.</p>
        </section>
      )}

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
            {/* Round-2 adversary finding — renamed from "Provisioned now" and
                re-sourced from `billableMailboxes` (released_at IS NULL): the
                plain count-all `mailboxes` still includes soft-released rows
                (a torn-down canceled tenant would show a stale "12" here). */}
            <div className="flex justify-between gap-3"><dt className="text-ink-muted">Active mailboxes</dt><dd className="font-semibold text-ink">{account.data?.billableMailboxes ?? "—"}</dd></div>
            {/* NB#4 (golive-ux-review-2026-07-27.md finding 4) — these two rows
                were hardcoded sandbox-only strings regardless of real billing
                state; now dynamic on the same billingState the header chip
                reads (we don't track a specific card/interval client-side, so
                this stays intentionally generic rather than fabricating detail
                the dashboard doesn't actually have). */}
            <div className="flex justify-between gap-3"><dt className="text-ink-muted">Payment method</dt><dd className="text-ink">{account.data?.billingState === "active" ? "Managed by Stripe" : "Not collected yet"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-muted">Renewal</dt><dd className="text-ink">{account.data?.billingState === "active" ? "Active" : "Not active"}</dd></div>
          </dl>
          <label htmlFor="spend-ceiling" className="mt-5 block text-xs font-semibold text-ink">Owner-controlled monthly ceiling</label>
          <div className="mt-2 flex items-center gap-2"><span className="text-sm text-ink-muted">$</span><input id="spend-ceiling" type="number" min="99" step="10" value={spendCeiling} onChange={(event) => setSpendCeiling(Number(event.target.value))} className="w-full rounded-[var(--radius-card)] border border-line bg-canvas px-3 py-2 text-sm text-ink" /></div>
          {wouldExceedCeiling ? <p role="status" className="mt-2 text-xs text-chip-danger-text">This quote exceeds the proposed owner ceiling by {dollars.format((quote.monthlyCents / 100) - spendCeiling)}. Provisioning would be blocked.</p> : <p role="status" className="mt-2 text-xs text-chip-success-text">This quote is within the proposed owner ceiling.</p>}
          <button type="button" disabled className="mt-5 w-full cursor-not-allowed rounded-full bg-ink px-4 py-2.5 text-sm font-semibold text-white opacity-45">Save billing controls (not wired up yet)</button>
          <p className="mt-3 text-xs leading-5 text-ink-muted">This ceiling is a preview only — it isn't persisted or enforced yet. Go live above to actually start billing; this control doesn't gate that.</p>
        </aside>
      </div>

      <section className={`${card} ${cardPad}`}>
        <h2 className="text-sm font-semibold text-ink">Subscription actions</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {[['Change mailbox count','Quoted before provisioning'],['Update payment method','Handled by Stripe-hosted billing'],['Cancel subscription','Clear timing and infrastructure teardown']].map(([title, detail]) => <div key={title} className="rounded-[var(--radius-card)] border border-line bg-canvas p-4"><p className="text-sm font-semibold text-ink">{title}</p><p className="mt-1 text-xs leading-5 text-ink-muted">{detail}</p><button type="button" disabled className="mt-4 text-xs font-semibold text-ink-muted opacity-60">Not wired to this dashboard yet</button></div>)}
        </div>
      </section>
    </div>
  );
}
