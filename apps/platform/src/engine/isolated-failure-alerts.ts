// THE OPS-SIDE PATH for an item `forEachIsolated` gave up on.
//
// WHY (docs/adversarial/wave-1-2-integration-gate-2026-08-18.md §6): three
// isolated-loop failures — `MAILBOX_RELEASE_FAILED`, `DOMAIN_ORDINAL_FAILED`,
// `MAILBOX_SLOT_FAILED` — reach NO watchtower check. They are customer-visible
// activity rows only, and `ops-summary.ts`'s action-count check does not cover
// them. Two of the three name money that keeps being spent:
//
//  - a mailbox whose release failed is still live at the vendor AND still
//    counted against the plan slot. The vendor keeps billing us and the row
//    keeps billing the customer, forever — `released_at` is never written and
//    `markMailboxIntentsReleased` deliberately skips failed addresses.
//  - a domain ordinal or mailbox slot that failed mid-provision is a PAID
//    resource with no working infrastructure behind it.
//
// The isolation itself is correct and stays: one dead item must not deny
// service to the rest. What was missing is that the platform noticed, wrote it
// where only that customer can read it, and told nobody who can act.
//
// ONE CHECK PER ITEM, not per call. A per-tenant check name would let the
// FIRST failed address suppress every later one inside the 6h cooldown, and
// each of these items is separate money with a separate remedy — the exact
// "a dedup guard keyed wider than the state it protects silences them all"
// mistake. `policyFor` gives these names IMMEDIATE_ALERT_POLICY for the same
// reason it gives it to `mailbox_provisioning:`: nothing re-observes a one-shot
// event, so a debounce would not delay the alert, it would delete it.
//
// REPORTED AFTER THE LOOP, not from `onItemError`. The handlers are synchronous
// and run between per-item awaits inside a Durable Object; adding an I/O await
// in there would open the DO input gate mid-teardown. The failures are already
// carried out of `forEachIsolated` in `outcome.failures`, so the alerting
// happens where the caller was going to await anyway.

import { RealClock } from "../clock.js";
import { forEachIsolated, type IsolatedFailure, type IsolatedOutcome } from "../isolated-loop.js";
import { reportCheck } from "../admin/watchtower.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { TenantContext } from "../tenant-context.js";

export interface IsolatedFailureAlertSpec<TItem> {
  /** The per-item watchtower check name (its own prefix — see watchtower-alerts.ts). */
  checkName: (item: TItem) => string;
  /**
   * This family's materiality key for the item (alert-state design §1.2).
   *
   * A FUNCTION OF THE ITEM'S OWN OUTCOME, not of the loop: `vendor_threw` and
   * `still_slot_counted` are different remedies for a failed release, and
   * `setup_threw` vs `paid_no_infra` is the difference between "retry it" and
   * "money is out and nothing is behind it". Stated by each caller because each
   * caller is the only thing that knows.
   */
  materiality: (failure: IsolatedFailure<TItem>) => string;
  /** What the founder needs to act. Customer-safe by construction: it is the
   * SAME abstract text the activity row carries, never the adapter's, so the
   * vendor-identity source tripwire holds here as everywhere else. */
  detail: (item: TItem) => string;
}

/**
 * Raise one founder alert per item the loop isolated, skipping the item that
 * ABORTED it.
 *
 * An `abortOn` failure (a spend-ceiling breach, an unarmed registrar) is a
 * TENANT-GLOBAL condition that every remaining item would have hit identically
 * — it has its own alert path, and reporting it here would attribute a
 * platform-level condition to whichever address happened to be next in the
 * loop.
 *
 * NEVER THROWS: `reportCheck` swallows its own failures by design, because the
 * caller is mid-teardown or mid-saga around real vendor spend and a D1 hiccup
 * in the notifier must not decide whether that completes.
 */
export async function alertIsolatedFailures<TItem>(
  ctx: TenantContext,
  outcome: IsolatedOutcome<TItem, unknown>,
  spec: IsolatedFailureAlertSpec<TItem>,
  mailer: OpsMailer = createOpsMailer(ctx.env),
): Promise<void> {
  const reportable = outcome.failures.filter((failure) => !(outcome.abortedAt && failure.index === outcome.abortedAt.index));
  if (reportable.length === 0) return;

  const nowMs = new RealClock().now();
  // Through the primitive, not a bare loop: one address's alert failing must
  // not deny the alert for the next address's money. `reportCheck` already
  // swallows its own failures, so this is belt to that brace — and it is what
  // keeps the site off test/loop-isolation-coverage.ts's allowlist, where an
  // exemption would outlive the reasoning behind it.
  await forEachIsolated(
    reportable,
    (failure) =>
      reportCheck(
        ctx.env,
        mailer,
        {
          name: spec.checkName(failure.item),
          healthy: false,
          materiality: spec.materiality(failure),
          detail: `tenant ${ctx.tenantId}: ${spec.detail(failure.item)}`,
        },
        nowMs,
      ),
    {
      onItemError: ({ item, error }) => console.error(`watchtower: could not raise "${spec.checkName(item.item)}"`, error),
    },
  );
}
