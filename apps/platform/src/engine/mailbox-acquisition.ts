/**
 * The GUARDED ACQUISITION of one mailbox: deciding whether a `/mailboxes/buy`
 * may be dispatched at all, and reporting a stuck purchase to the founder.
 * Split out of engine/mailbox-provisioning.ts (CLAUDE.md rule b) — that file
 * owns the saga's sequence, this one owns the money decision inside it.
 *
 * FOUNDER RULING 2026-08-06: an automatic re-buy is authorized ONCE per stuck
 * purchase, only after the provider confirms the first one produced nothing, and
 * an alert fires both on entering the stuck state and on the re-buy's outcome.
 *
 * THE TWO CRASH WINDOWS THIS CLOSES, with one mechanism:
 *
 *  1. A buy the provider ACCEPTED, recorded as 'intent' because the process died
 *     before the status write (wave-integration gate finding #3). The old code
 *     read 'intent' as "no purchase has been attempted" and bought a second paid
 *     mailbox.
 *  2. A buy the provider accepted and never fulfilled ('bought', unlistable
 *     forever). The old code never re-bought on 'bought' — correct for money,
 *     but it wedged the address permanently.
 *
 * Both are the same question — WHAT DOES THE PROVIDER ACTUALLY HOLD? — so both
 * are answered the same way: whenever a dispatch is on record and the intent has
 * not reached a state that proves the mailbox exists, ASK. What differs is only
 * what the answer authorizes.
 *
 * WHY THE NAIVE FORM OF THIS IS A HOLE (the gate's own warning): asking at
 * 'intent' and treating "absent" as proof the order was lost still double-buys,
 * because a just-accepted order is absent from the provider's list until it
 * catches up. So "absent" is not a verdict here until it survives BOTH the
 * in-call re-poll AND a minimum real-world age since the dispatch. Anything less
 * conclusive — including a listing call that simply failed — authorizes nothing.
 * Every uncertain branch fails toward NOT SPENDING.
 */

import { VendorError } from "@coldstart/shared";
import { mailboxProvisioningCheckName, mailboxRebuyCheckName, readCheckStatus, reportCheck } from "../admin/watchtower.js";
import { RealClock } from "../clock.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { TenantContext } from "../tenant-context.js";
import { logVendorFailure, VENDOR_STEP } from "../vendor-failure.js";
import { logAction } from "./deliverability-actions.js";
import type { BuyDispatchRow } from "./provision-intents.js";

/**
 * How long the provider gets to make a dispatched buy visible before its absence
 * from the mailbox list counts as proof that nothing was purchased.
 *
 * This number is the whole money guard, so it is sized like one: generously, at
 * the same 15 minutes engine/spend-ceiling.ts's reaper calls "well above the
 * longest legitimate provision run". Too long only delays a wedged tenant's
 * recovery; too short buys a second mailbox the customer already owns.
 *
 * UNVERIFIED against the live provider: its buy endpoint answers "scheduled" and
 * this platform's own state mapping reads a listed-but-inactive mailbox as
 * 'pending', which implies the record is listable immediately and this window is
 * belt-and-braces. That inference has not been confirmed against a live account,
 * which is exactly why the window is not tuned down.
 */
export const ABSENCE_MIN_AGE_MS = 15 * 60 * 1000;

/**
 * The in-call re-poll before declaring a mailbox absent. Deliberately the same
 * shape as the readiness wait's budget (engine/mailbox-provisioning.ts): one
 * quick second look, then defer to a later attempt rather than parking the
 * Durable Object inside a provider's async pipeline.
 */
const ABSENCE_RECHECK_BACKOFF_MS = [2_000];

const MAILBOX_STEP = VENDOR_STEP.mailboxPurchase;

/** What the provider's own records say about an address we may have bought. */
export type OwnershipVerdict =
  /** The provider lists it (ready or still being created) — it is ours, whoever bought it. */
  | { kind: "present"; state: string }
  /** Corroborated: repeated lookups agree it does not exist, long enough after the dispatch to mean it. */
  | { kind: "absent" }
  /** No verdict. A lookup failed, or the dispatch is too recent for absence to mean anything. */
  | { kind: "unconfirmed"; reason: "lookup_failed" | "too_recent"; cause?: unknown };

/**
 * Asks the provider what it holds for `email`, and grades the answer.
 *
 * The three outcomes are deliberately NOT collapsible into a boolean. "The
 * lookup failed" proves nothing about the mailbox and must never read as
 * "absent" — that is the difference between retrying and buying a second one.
 */
export async function confirmVendorOwnership(
  ctx: TenantContext,
  email: string,
  dispatch: BuyDispatchRow,
  backoffMs: number[] = ABSENCE_RECHECK_BACKOFF_MS,
): Promise<OwnershipVerdict> {
  const attempts = backoffMs.length + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let state: string;
    try {
      state = await ctx.adapters.mailbox.provisioningState(email);
    } catch (err) {
      logVendorFailure(`mailbox ownership check ${email}`, err);
      return { kind: "unconfirmed", reason: "lookup_failed", cause: err };
    }
    // Anything the provider can name is the provider holding it. Only a total
    // absence from its records is evidence that a buy produced nothing.
    if (state !== "absent") return { kind: "present", state };
    const pause = backoffMs[attempt - 1];
    if (pause !== undefined && pause > 0) {
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }

  // Every look agreed it is absent — but a just-dispatched order is absent too.
  const ageMs = new RealClock().now() - dispatch.lastDispatchedAt;
  if (ageMs < ABSENCE_MIN_AGE_MS) return { kind: "unconfirmed", reason: "too_recent" };
  return { kind: "absent" };
}

/**
 * The founder alert for a mailbox whose purchase is stuck. Fires on ENTERING the
 * state; the watchtower's own dedup keeps a tenant retrying every minute from
 * turning it into a storm.
 */
export async function alertMailboxStuck(
  ctx: TenantContext,
  email: string,
  detail: string,
  mailer: OpsMailer = createOpsMailer(ctx.env),
): Promise<void> {
  await reportCheck(
    ctx.env,
    mailer,
    { name: mailboxProvisioningCheckName(email), healthy: false, detail: `tenant ${ctx.tenantId}: ${detail}` },
    new RealClock().now(),
  );
}

/**
 * Clears the stuck state for a mailbox, which is what emails the founder the
 * re-buy's SUCCESS: the state machine's healthy-after-unhealthy transition is a
 * recovery email.
 *
 * An address that was never flagged reports NOTHING — not even a healthy row.
 * This runs on every ordinary provision, and the watchtower table holds a handful
 * of platform-wide checks; filing a row per mailbox ever provisioned would drown
 * them. A D1 read failure here is treated as "not flagged", because the fallback
 * has to be the silent one.
 */
export async function alertMailboxResolved(
  ctx: TenantContext,
  email: string,
  detail: string,
  mailer: OpsMailer = createOpsMailer(ctx.env),
): Promise<void> {
  const name = mailboxProvisioningCheckName(email);
  try {
    if ((await readCheckStatus(ctx.env, name)) !== "unhealthy") return;
  } catch (err) {
    console.error(`watchtower: could not read check "${name}"`, err);
    return;
  }
  await reportCheck(ctx.env, mailer, { name, healthy: true, detail: `tenant ${ctx.tenantId}: ${detail}` }, new RealClock().now());
}

/**
 * The founder alert for a re-buy that did not work — either the re-buy call
 * itself failed, or the one-re-buy budget is spent and the address is being
 * abandoned. Its own check name, so the stuck alert that fired moments earlier
 * cannot suppress it (see admin/watchtower.ts's naming comment).
 */
export async function alertMailboxRebuyFailed(
  ctx: TenantContext,
  email: string,
  detail: string,
  mailer: OpsMailer = createOpsMailer(ctx.env),
): Promise<void> {
  await reportCheck(
    ctx.env,
    mailer,
    { name: mailboxRebuyCheckName(email), healthy: false, detail: `tenant ${ctx.tenantId}: ${detail}` },
    new RealClock().now(),
  );
}

/**
 * The customer-visible error for a purchase we cannot yet resolve. RETRYABLE and
 * provider-blind: the tenant's agent should come back, and nothing it can read
 * names a vendor or our position with one.
 */
export function unresolvedPurchaseError(ctx: TenantContext, email: string, reason: "lookup_failed" | "too_recent", cause?: unknown): VendorError {
  const detail =
    reason === "lookup_failed"
      ? "its status could not be confirmed with the provider"
      : "the provider has not finished confirming it";
  logAction(ctx, "MAILBOX_PURCHASE_UNCONFIRMED", email, {
    reason: `a purchase for this address is on record and ${detail} — no second purchase was made`,
    step: MAILBOX_STEP,
    retryable: true,
    verdict: reason,
  });
  return new VendorError(
    `mailbox ${email} has a purchase on record and ${detail}. Nothing was lost and no second purchase was made — retry to finish it.`,
    true,
    { step: MAILBOX_STEP, cause },
  );
}

/**
 * The customer-visible error for an address that has used its one automatic
 * re-buy and still does not exist. PERMANENT: a third purchase is not
 * authorized, so telling the agent to keep retrying would be a lie.
 */
export function abandonedPurchaseError(ctx: TenantContext, email: string): VendorError {
  logAction(ctx, "MAILBOX_PURCHASE_ABANDONED", email, {
    reason: "the automatic retry for this address was already used and the provider still reports nothing — no further purchase will be attempted",
    step: MAILBOX_STEP,
    retryable: false,
  });
  return new VendorError(
    `mailbox ${email} could not be created after an automatic retry, and no further purchase will be attempted for it. The operator has been notified.`,
    false,
    { step: MAILBOX_STEP },
  );
}
