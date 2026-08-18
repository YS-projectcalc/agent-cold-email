/**
 * The per-mailbox provisioning saga: vendor buy -> wait for the vendor to
 * finish -> start warmup -> insert the local (billable) row -> meter -> push
 * credentials. Extracted from engine/provisioning.ts (CLAUDE.md rule b) so both
 * the lookalike flow and SPEC.md §20.6's managed-mailbox-on-a-BYO-domain shape
 * reuse the exact same sequence.
 *
 * TWO INVARIANTS, both learned from the 2026-08-05 incident:
 *
 * 1. THE BUY IS NEVER REPEATED BLIND. `/mailboxes/buy` takes no idempotency key,
 *    and the request-idempotency claim that used to be the only durable record
 *    is DELETED when the wrapped function throws. The throw was one line later
 *    (uid resolution against an async buy), so a retry re-bought. A durable
 *    intent row (engine/provision-intents.ts) now survives the throw, and when
 *    it is ambiguous the VENDOR is asked what it holds.
 *
 * 2. A LOCAL ROW MEANS A REAL MAILBOX. The `mailboxes` row is inserted only
 *    AFTER the vendor reports the mailbox ready — never on buy-ACCEPT. The
 *    billing meter counts rows (`COUNT(*) WHERE released_at IS NULL`), so a row
 *    written on acceptance bills the customer monthly for a mailbox whose
 *    background provisioning may have failed. Making the row conditional on the
 *    vendor's confirmation is what makes the meter true, rather than teaching
 *    every counter about a new state.
 */

import {
  CapacityPendingError,
  isPaidPlan,
  NotActivatedError,
  NOT_NOTIFIED,
  terminal,
  VendorError,
  type MailboxReadiness,
} from "@coldstart/shared";
import type { OpsMailer } from "../ops-mail/ops-mailer.js";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { customerSafeVendorDetail, logVendorFailure, VENDOR_STEP } from "../vendor-failure.js";
import { logAction } from "./deliverability-actions.js";
import { withRequestIdempotency } from "./idempotency.js";
import { forEachIsolated } from "../isolated-loop.js";
import {
  abandonedPurchaseError,
  alertMailboxRebuyFailed,
  alertMailboxResolved,
  alertMailboxStuck,
  confirmVendorOwnership,
  terminalMailboxError,
  unresolvedPurchaseError,
} from "./mailbox-acquisition.js";
import { maybePushProvisionedMailbox } from "./mailbox-credential-push.js";
import {
  claimBuyDispatch,
  mailboxIntentKey,
  markMailboxIntent,
  MAX_BUY_DISPATCHES,
  readBuyDispatch,
  readMailboxIntent,
  recordMailboxIntent,
  type MailboxIntentRow,
} from "./provision-intents.js";
import { withSpendCeiling } from "./spend-ceiling.js";
import { computeWarmupDay, epochDay, warmupDailyCap, warmupStatus } from "./warmup.js";

// Per-mailbox/mo metering fee (SPEC.md §18 ballpark fully-loaded cost) —
// paid tiers only. Demo/free is structurally 0-real-spend (ARCHITECTURE.md
// #8); sandbox mailboxes are still provisioned there for exploration, but no
// fee accrues (see e2e.test.ts's demo-tenant usageCents assertion).
const MAILBOX_MONTHLY_FEE_CENTS = 600;

// The in-call budget for "has the vendor finished creating this mailbox?".
// Same shape and same reasoning as the DNS budget (engine/domain-dns.ts): one
// quick re-check, then hand the caller a RETRYABLE error rather than parking the
// Durable Object through a vendor's async pipeline. The durable intent row makes
// that safe — the next attempt resumes at the wait, never at the buy.
const MAILBOX_READY_BACKOFF_MS = [2_000];

/** The abstract step label the mailbox legs report (vendor-failure.ts's closed vocabulary). */
const MAILBOX_STEP = VENDOR_STEP.mailboxPurchase;

/**
 * The provider a resumed leg assumes when the interrupted attempt never
 * recorded one, on the REAL vendor path. Never assumed unconditionally: a
 * sandbox-bundle resume derives 'sandbox' from the live adapter identity
 * instead (see acquireMailbox), because mislabelling a sandbox row 'google'
 * would make the wave-2 send-eligibility picker treat a mailbox that exists at
 * no vendor as sendable — the exact failure the provider column exists to
 * close.
 */
const DEFAULT_REAL_PROVIDER = "google";

/** What one completed per-mailbox unit yields — the shape the row insert + credential push consume. */
interface ProvisionedMailboxRecord {
  email: string;
  provider: string;
  provisionedAt: number;
  warmupStartedAt: number;
}

/**
 * The address of ONE managed mailbox slot. Deterministic in the persona and the
 * two ordinals, which is what lets a retry resolve to the SAME address (and so
 * the same address-derived intent) instead of buying a new mailbox — and lets
 * `setup_infrastructure` count, before spending anything, how many of a
 * request's slots are already filled (engine/provisioning.ts's planProvisioning).
 * Derived in one place so those two consumers can never disagree.
 */
export function managedMailboxAddress(
  personaSlug: string,
  domain: string,
  domainOrdinal: number,
  mailboxIndex: number,
): string {
  return `${personaSlug}${domainOrdinal + 1}${mailboxIndex + 1}@${domain}`;
}

/**
 * Provisions `inboxesEach` PLATFORM-OWNED mailboxes on an ALREADY-OWNED domain
 * row. `domainOrdinal` only affects the generated local-part numbering
 * (uniqueness only requires the local part be unique WITHIN this one domain,
 * which the mailboxIndex loop guarantees).
 *
 * There is deliberately no `domainKey` parameter any more: the per-mailbox
 * intent and idempotency keys are derived from the ADDRESS, which is what lets
 * teardown invalidate them (engine/provision-intents.ts).
 */
export async function provisionMailboxesForDomain(
  ctx: TenantContext,
  opts: {
    domainId: string;
    domain: string;
    domainOrdinal: number;
    personaSlug: string;
    inboxesEach: number;
    /** Injectable for the stuck/re-buy founder alerts — defaults to the real (env-dark) OpsMailer. */
    mailer?: OpsMailer;
  },
): Promise<string[]> {
  const now = ctx.clock.now();
  const slots = Array.from({ length: opts.inboxesEach }, (_v, mailboxIndex) => mailboxIndex);

  // HEAD-OF-LINE BLOCKING (class sweep 2026-08-17, IN-5). The addresses are
  // DETERMINISTIC (`persona{ordinal+1}{index+1}@domain`), so a vendor that
  // permanently rejects one of them — or an intent that exhausted
  // MAX_BUY_DISPATCHES — failed identically on every retry, and without
  // isolation that one address stopped every LATER address on the domain from
  // ever being bought. Composed with IN-1's per-ordinal loop it was worse still:
  // the whole tenant's provisioning stalled permanently at whatever the first
  // bad item happened to be. The slots are independently completable (separate
  // purchases, separate address-derived intents), so only the loop tied them.
  const outcome = await forEachIsolated(
    slots,
    (mailboxIndex) => provisionOneMailbox(ctx, opts, mailboxIndex, now),
    {
      onItemError: ({ item, error }) => {
        const email = managedMailboxAddress(opts.personaSlug, opts.domain, opts.domainOrdinal, item);
        logVendorFailure(`provision mailbox ${email}`, error);
        // Customer-readable (account().recentActions), so the ABSTRACT step
        // only — never the adapter's text. This row is what makes the isolation
        // legible: it is the difference between "we stopped here" and "we
        // skipped this one and kept going".
        logAction(
          ctx,
          "MAILBOX_SLOT_FAILED",
          email,
          customerSafeVendorDetail(error, "this mailbox could not be completed — the remaining mailboxes were still attempted", {
            slot: item,
          }),
        );
      },
      // A spend-ceiling breach is a TENANT-level condition, not this address's
      // fault: every remaining slot would reserve against the same exhausted
      // ceiling and re-fire the same one-shot alert.
      abortOn: (err) => err instanceof CapacityPendingError,
    },
  );

  // Report the ABORT CAUSE over an earlier ordinary slot failure (2026-08-18
  // fix). A spend-ceiling breach (abortOn) is a TENANT-level condition the
  // caller's per-ordinal loop (provisioning.ts) has to recognize and stop on
  // — but `outcome.failures[0]` is the FIRST failure in slot order, which is
  // an earlier ordinary rejection whenever one preceded the breach. Rethrowing
  // that instead masked the CapacityPendingError: the outer loop's own
  // abortOn never matched an ordinary VendorError, so it fell through to the
  // next ordinal and burned a reservation attempt against a ceiling that had
  // already refused, instead of leaving the tenant capacity_pending.
  // Falls back to the first ordinary failure when the loop ran to completion
  // without aborting. Either way this happens AFTER every slot has had its
  // chance — throwing rather than returning a partial list is deliberate: the
  // mailbox count is what the customer is billed on, so a short domain must
  // never read to the agent as a completed one.
  const reportedFailure = outcome.abortedAt ?? outcome.failures[0];
  if (reportedFailure) throw reportedFailure.error;

  return outcome.results;
}

/**
 * ONE mailbox slot: the recorded vendor unit, then the local row, the meter and
 * the credential push. Split out of the loop above so each slot is a single
 * isolated unit with no shared mutable state between iterations.
 */
async function provisionOneMailbox(
  ctx: TenantContext,
  opts: { domainId: string; domain: string; domainOrdinal: number; personaSlug: string; mailer?: OpsMailer },
  mailboxIndex: number,
  now: number,
): Promise<string> {
  const email = managedMailboxAddress(opts.personaSlug, opts.domain, opts.domainOrdinal, mailboxIndex);
  const localPart = email.slice(0, email.indexOf("@"));
  // ADDRESS-DERIVED (N4). The key used to embed the domain ordinal, which made
  // it underivable from the mailbox itself — so teardown could not invalidate
  // the claim, and a re-provision after cancellation replayed a claim about a
  // mailbox the vendor no longer had, inserting a billable row backed by
  // nothing. The address alone identifies the resource.
  const intentKey = mailboxIntentKey(ctx.tenantId, email);

  // G2 money-out site #1 (design §0 inventory) — the mailbox slot buy. The
  // spend reserve composes INSIDE withRequestIdempotency (design §G2 collision
  // note): a replayed provision returns the RECORDED mailbox without re-buying,
  // so it never re-enters withSpendCeiling and never double-reserves.
  //
  // H4: the recorded unit spans the WHOLE per-mailbox vendor effect — buy AND
  // wait AND startWarmup — so a REPLAY re-runs none of it. What the claim
  // cannot do is survive a THROW (it is deleted, by design, so failures are
  // never cached); that half is the intent row's job.
  // TERMINAL: every uncertain branch of acquireMailbox THROWS, and this unit
  // returns only past awaitMailboxReady — the vendor-verdict fix is what made
  // control flow a sound terminality proxy here (the cached-terminal sweep's
  // in-repo template). The claim is also invalidated on teardown
  // (provision-intents.ts), so a re-provision cannot inherit a stale one.
  const provisioned = await withRequestIdempotency(ctx, `provision:${intentKey}`, async () =>
    terminal(await runMailboxProvisioningUnit(ctx, { email, localPart, domain: opts.domain, intentKey, mailer: opts.mailer })),
  );

  // The row lands only now — after the vendor confirmed the mailbox exists AND
  // its warmup enrolled. See invariant 2 in the module doc: the billing meter
  // counts these rows, so one must never exist ahead of the resource.
  insertProvisionedMailbox(ctx, opts, provisioned, now);
  markMailboxIntent(ctx, intentKey, "committed");

  await meterProvisionedMailbox(ctx, provisioned.email, intentKey, now);

  // Self-serve I3 credential push (F6): record-then-push the just-provisioned
  // mailbox's credentials to the engine. INERT unless the vendor+engine are
  // armed AND this is a real vendor mailbox (never sandbox). A push failure is
  // swallowed (the mailbox is durably recorded 'pending'; the reconcile sweep
  // retries), so it can never fail a provision whose vendor spend already
  // happened.
  await maybePushProvisionedMailbox(ctx, provisioned);

  return provisioned.email;
}

/**
 * The recorded unit: every vendor effect for ONE mailbox, resumable at each leg.
 *
 * Ordering is persist-the-INTENT-then-act, and each leg advances the intent only
 * after the vendor confirms it — so a crash anywhere leaves a record that is
 * behind reality (safe: the next attempt asks the vendor and catches up) rather
 * than ahead of it (unsafe: a mailbox we think we own and never bought, or one
 * we bought and buy again).
 */
async function runMailboxProvisioningUnit(
  ctx: TenantContext,
  opts: { email: string; localPart: string; domain: string; intentKey: string; mailer?: OpsMailer },
): Promise<ProvisionedMailboxRecord> {
  const intent = recordMailboxIntent(ctx, opts.intentKey, opts.email);
  const bought = await acquireMailbox(ctx, intent, opts);

  // L2 — THE GATE. `provision()` returning means the vendor ACCEPTED the order,
  // not that the mailbox exists: InboxKit answers "scheduled". Every next step
  // (warmup enrolment here, plus health/credentials/release later) resolves the
  // mailbox by uid, which throws PERMANENTLY while it is unlistable. Waiting
  // here is what stops that throw from unwinding the whole saga back through a
  // buy that already succeeded.
  await awaitMailboxReady(ctx, opts.email);

  // The one point where the mailbox is PROVEN to exist and be usable. Clearing
  // the stuck flag here (rather than when a re-buy is accepted) is what makes the
  // founder's success notification mean something: a re-buy the provider accepted
  // and never fulfilled is the failure being recovered from, not a recovery.
  // Silent for any address that was never flagged.
  await alertMailboxResolved(ctx, opts.email, "the mailbox is confirmed ready at the provider", opts.mailer);

  const warmupStartedAt = await startWarmupUnlessAlreadyRunning(ctx, opts);
  return { email: opts.email, provider: bought.provider, provisionedAt: bought.provisionedAt, warmupStartedAt };
}

/**
 * Acquires the mailbox: resumes it, adopts it, or buys it — with a buy
 * authorized only by the DISPATCH RECORD plus, when anything was ever sent, the
 * provider's own answer. See engine/mailbox-acquisition.ts for why each uncertain
 * branch refuses to spend.
 *
 * The old shape branched on `intent.status` alone, and that is precisely what
 * failed: status is written AFTER the provider replies, so 'intent' meant both
 * "nothing was sent" and "an accepted order whose status write was lost". The
 * dispatch record is written BEFORE the call, so it never conflates the two.
 *
 *  - 'warming'/'committed'  — the mailbox demonstrably exists (its warmup
 *                             resolved a uid / its local row is written).
 *                             Resume; ask nothing, buy nothing.
 *  - zero dispatches        — nothing has ever been sent for this address. Buy.
 *  - any dispatch on record — ASK THE PROVIDER, whatever the status says. It
 *                             holds it -> adopt. It holds it and says it is DEAD
 *                             -> hard stop + alert, never a re-buy (something
 *                             exists and was paid for; a second purchase is not
 *                             a recovery). It cannot be asked, or the dispatch is
 *                             too recent for "no" to mean anything -> retry
 *                             later, spend nothing. It confirms nothing exists
 *                             -> the stuck case: ONE guarded re-buy, or a hard
 *                             stop if that re-buy is already spent.
 */
async function acquireMailbox(
  ctx: TenantContext,
  intent: MailboxIntentRow,
  opts: { email: string; localPart: string; domain: string; intentKey: string; mailer?: OpsMailer },
): Promise<{ provider: string; provisionedAt: number }> {
  // Derived from the LIVE adapter, not a constant: `intent.provider` is only
  // null when a prior attempt died before the vendor answered, and the bundle
  // this call is running against is the honest answer to "which vendor would
  // have held it".
  const provider = intent.provider ?? (ctx.adapters.kind === "real" ? DEFAULT_REAL_PROVIDER : "sandbox");

  if (intent.status === "warming" || intent.status === "committed") {
    logAction(ctx, "MAILBOX_PROVISION_RESUMED", opts.email, {
      reason: "a prior attempt already purchased this mailbox — resuming without a second purchase",
      priorStatus: intent.status,
    });
    return { provider, provisionedAt: ctx.clock.now() };
  }

  const dispatch = readBuyDispatch(ctx, opts.intentKey, opts.email, intent.status);
  if (dispatch.attempts === 0) return dispatchBuy(ctx, opts);

  const verdict = await confirmVendorOwnership(ctx, opts.email, dispatch);

  if (verdict.kind === "present") {
    logAction(ctx, "MAILBOX_ADOPTED", opts.email, {
      reason: "the provider already holds this mailbox from an interrupted attempt — recovered instead of re-bought",
      priorStatus: intent.status,
      dispatches: dispatch.attempts,
      vendorState: verdict.state,
    });
    markMailboxIntent(ctx, opts.intentKey, "bought", provider);
    return { provider, provisionedAt: ctx.clock.now() };
  }

  // The provider holds it and says it is DEAD (vendor-verdict class fix). Not a
  // resume (warmup-enrolling and billing a mailbox that cannot send), and not a
  // re-buy (it is not absent — something exists and was paid for). A hard,
  // alerted stop, so the address gets replaced by a hand rather than spun on.
  if (verdict.kind === "terminal") {
    // The customer error one line down CITES this result rather than assuming
    // it: a cooldown-suppressed or dark alert means nobody was told, and the
    // agent has to hear that instead of "the operator has been notified".
    const notified = await alertMailboxRebuyFailed(
      ctx,
      opts.email,
      `the provider holds this address and reports it as no longer usable (${verdict.state}) — no re-buy authorized, this address needs a hand`,
      opts.mailer,
    );
    throw terminalMailboxError(ctx, opts.email, verdict.state, notified);
  }

  if (verdict.kind === "unconfirmed") {
    await alertMailboxStuck(
      ctx,
      opts.email,
      verdict.reason === "lookup_failed"
        ? `a purchase is on record but the provider could not be asked what it holds — no re-buy authorized (${dispatch.attempts} dispatch(es) so far)`
        : `a purchase is on record and the provider does not list it yet — too recent for absence to count, no re-buy authorized (${dispatch.attempts} dispatch(es) so far)`,
      opts.mailer,
    );
    throw unresolvedPurchaseError(ctx, opts.email, verdict.reason, verdict.cause);
  }

  // The provider confirms the recorded purchase(s) produced nothing.
  if (dispatch.attempts >= MAX_BUY_DISPATCHES) {
    const notified = await alertMailboxRebuyFailed(
      ctx,
      opts.email,
      `${dispatch.attempts} purchases are on record and the provider confirms none of them exist — the one automatic re-buy is spent, so this address is abandoned and needs a hand`,
      opts.mailer,
    );
    throw abandonedPurchaseError(ctx, opts.email, notified);
  }

  await alertMailboxStuck(
    ctx,
    opts.email,
    `a purchase is on record and the provider confirms it produced nothing — attempting the ONE authorized automatic re-buy`,
    opts.mailer,
  );
  try {
    return await dispatchBuy(ctx, opts);
  } catch (err) {
    await alertMailboxRebuyFailed(
      ctx,
      opts.email,
      `the automatic re-buy failed: ${err instanceof Error ? err.message : String(err)}`,
      opts.mailer,
    );
    throw err;
  }
  // NOTE the absence of a success report here. The provider ACCEPTING the re-buy
  // is not the mailbox existing — that is this module's invariant 1, and it is
  // the whole reason a re-buy was needed. The stuck state is cleared only where
  // the mailbox is proven real, after awaitMailboxReady.
}

/**
 * Dispatches ONE `/mailboxes/buy`, claiming it durably first.
 *
 * The claim before the call is the crash-safety: a kill anywhere after it —
 * including inside the vendor call, which is the window that bought a second
 * mailbox — leaves a record that money MAY have moved, so the next attempt asks
 * instead of buying. It is also what caps the re-buy at one, since the increment
 * happens whether or not the call is ever answered.
 *
 * Both the first buy and the re-buy come through here, so the re-buy reserves
 * against the same spend ceiling and the same plan-slot counter as any other
 * purchase (engine/spend-ceiling.ts) — it is a real second purchase and is
 * accounted as one.
 */
async function dispatchBuy(
  ctx: TenantContext,
  opts: { email: string; localPart: string; domain: string; intentKey: string },
): Promise<{ provider: string; provisionedAt: number }> {
  const attempt = claimBuyDispatch(ctx, opts.intentKey, opts.email);
  if (attempt > MAX_BUY_DISPATCHES) {
    // Only two provisions racing the same address reach this: the claim, not the
    // budget check above it, is the arbiter, so the loser stops before spending.
    // NOT_NOTIFIED because THIS path told nobody — whether the winning caller
    // alerted is not knowable from here, and guessing that it did is the exact
    // false claim this argument exists to prevent.
    throw abandonedPurchaseError(ctx, opts.email, NOT_NOTIFIED);
  }

  let bought;
  try {
    bought = await withSpendCeiling(ctx, "mailbox", () =>
      ctx.adapters.mailbox.provision(opts.domain, opts.localPart, opts.intentKey),
    );
  } catch (err) {
    // We CANNOT know whether the vendor completed it. Leave the intent
    // 'dangling' so the next attempt asks the vendor instead of buying again.
    markMailboxIntent(ctx, opts.intentKey, "dangling");
    throw err;
  }
  markMailboxIntent(ctx, opts.intentKey, "bought", bought.provider);
  return { provider: bought.provider, provisionedAt: bought.provisionedAt };
}

/**
 * Enrols warmup unless a prior attempt already did — `/warmup/add` creates a
 * BILLED recurring subscription, so repeating it is a second monthly charge
 * (the H4 defect, whose replay half the idempotency claim closed and whose
 * crash half needs this durable marker).
 *
 * ⚠ A MARKER CANNOT CLOSE THE WINDOW IT IS WRITTEN AFTER (class E member E1,
 * docs/adversarial/class-sweep-vendor-truth-2026-08-18.md). The only guard here
 * used to be the local `'warming'` status, and that status is written AFTER the
 * vendor call returns. A crash inside that window — or a lost status write —
 * leaves a paid subscription at the vendor and no record of it, and the next
 * attempt reads "not warming yet" and enrols again, at $3/month, forever. The
 * shape is now PRE-CHECK-THEN-ACT, the same shape the buy leg already uses:
 * consult the durable marker, and when it does not settle the question, ASK THE
 * VENDOR. `absent` is the only answer that authorizes the charge; a lookup that
 * did not finish buys nothing and costs one retry.
 *
 * A vendor-confirmed ACTIVE subscription also WRITES the missing marker, which
 * is the crash recovery: without it every subsequent attempt would re-ask, and
 * the record would stay behind reality indefinitely.
 *
 * THE INTENT IS RE-READ HERE, never taken from the saga's opening snapshot
 * (E2). `acquireMailbox` runs in between and writes this very row, so the
 * snapshot is stale by construction at exactly the moment it is consulted.
 *
 * G2 money-out site #2. Its cost is already priced into COST_MAILBOX_CENTS at
 * the provision reserve (spendCostCents's 'warmup' branch reserves 0), so this
 * wrap is for choke-point completeness — no money-out vendor call escapes the
 * enumerated inventory — not a second charge.
 */
async function startWarmupUnlessAlreadyRunning(ctx: TenantContext, opts: { email: string; intentKey: string }): Promise<number> {
  const intent = readMailboxIntent(ctx, opts.intentKey);
  if (intent?.status === "warming" || intent?.status === "committed") {
    // The ramp start is re-stamped to now rather than recovered. A resume lands
    // minutes-to-a-day after the real enrolment, and the drift only ever makes
    // the 28-day ramp START LATER — the safe direction for a warmup.
    return ctx.clock.now();
  }

  const vendorState = await ctx.adapters.mailbox.warmupSubscriptionState(opts.email);
  if (vendorState === "active") {
    // The vendor holds a subscription our records do not. Record it — the
    // marker this branch exists because of was never written — and charge
    // nothing.
    markMailboxIntent(ctx, opts.intentKey, "warming");
    logAction(ctx, "MAILBOX_WARMUP_ADOPTED", opts.email, {
      reason: "the provider already has a warmup subscription for this mailbox from an interrupted attempt — recorded instead of re-enrolled",
      priorStatus: intent?.status ?? "unknown",
    });
    return ctx.clock.now();
  }
  if (vendorState === "inconclusive") {
    // NOT folded into 'absent' (the vendor-verdict discipline). An unfinished
    // search is not proof there is no subscription, and enrolling on it is a
    // real recurring charge. RETRYABLE: the durable intent means the next
    // attempt resumes here rather than re-buying anything upstream.
    throw new VendorError(
      `mailbox ${opts.email} was purchased, but whether its warmup is already running could not be confirmed. ` +
        `Nothing was charged for the failed step — retry to finish it.`,
      true,
      { step: MAILBOX_STEP },
    );
  }

  const warmup = await withSpendCeiling(ctx, "warmup", () =>
    ctx.adapters.mailbox.startWarmup(opts.email, `warmup:${ctx.tenantId}:${opts.email}`),
  );
  markMailboxIntent(ctx, opts.intentKey, "warming");
  return warmup.startedAt;
}

/**
 * Waits (briefly) for the vendor to finish creating the mailbox, then throws a
 * RETRYABLE, vendor-blind error if it has not. Reporting "still working on it"
 * is the honest answer, and the durable intent means the retry costs nothing
 * but a poll.
 *
 * ⚠ EXCEPT WHEN IT IS NOT STILL WORKING ON IT (vendor-verdict class fix,
 * mailbox half). The port used to fold every non-'active' vendor status into
 * 'pending', so a SUSPENDED or CANCELLED mailbox was reported here as "still
 * being created" and this function told the caller to retry — forever. A
 * terminal verdict now stops the saga NON-retryably, which is the only grade
 * that makes an agent escalate instead of spin.
 */
async function awaitMailboxReady(ctx: TenantContext, email: string, backoffMs: number[] = MAILBOX_READY_BACKOFF_MS): Promise<void> {
  const attempts = backoffMs.length + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let verdict: MailboxReadiness;
    try {
      verdict = await ctx.adapters.mailbox.provisioningState(email);
    } catch (err) {
      // The lookup itself failed — that proves NOTHING about the mailbox, so it
      // must not be read as "not ready" and definitely not as "absent" (which
      // would invite a re-buy on the next attempt). Surface it with its own grade.
      logVendorFailure(`mailbox provisioningState ${email}`, err);
      if (err instanceof VendorError && !err.retryable) throw err;
      throw new VendorError(
        `mailbox ${email} was purchased, but its provisioning status could not be confirmed. Nothing was lost — retry to finish it.`,
        true,
        { step: MAILBOX_STEP, cause: err },
      );
    }
    // Exhaustive (guard D2): a new verdict arm must be classified here rather
    // than silently joining the benign wait.
    switch (verdict.kind) {
      case "ready":
        return;
      case "terminal":
        logAction(ctx, "MAILBOX_PROVISION_TERMINAL", email, {
          reason:
            "the provider reports this mailbox is no longer usable — it was NOT billed or enrolled in warmup, and no replacement was purchased",
          step: MAILBOX_STEP,
          retryable: false,
          vendorState: verdict.vendorState,
        });
        throw new VendorError(
          `mailbox ${email} was purchased, but the provider now reports it as no longer usable. It was NOT billed or enrolled in ` +
            `warmup, and no second purchase was made. Retrying will not help — this address needs a hand; call contact_operator to reach a human.`,
          false,
          { step: MAILBOX_STEP },
        );
      case "absent":
      case "not_yet":
      case "inconclusive":
        // Still waiting, or an answer that proves nothing. Both cost exactly one
        // retry and neither authorizes anything.
        break;
      default: {
        const exhaustive: never = verdict;
        throw new Error(`unhandled mailbox readiness verdict: ${JSON.stringify(exhaustive)}`);
      }
    }
    const pause = backoffMs[attempt - 1];
    if (pause !== undefined && pause > 0) {
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }

  logAction(ctx, "MAILBOX_PROVISION_PENDING", email, {
    reason: "the mailbox was purchased and is still being created by the provider — retry to complete setup",
    step: MAILBOX_STEP,
    retryable: true,
    attempts,
  });
  throw new VendorError(
    `mailbox ${email} was purchased and is still being created by the provider — it was NOT billed or enrolled in warmup. Nothing was lost, and no second purchase will be made. Retry to finish it.`,
    true,
    { step: MAILBOX_STEP },
  );
}

/**
 * Per-mailbox/mo INTERNAL COGS metering — paid plan only. The local ledger
 * 'usage' write is the founder's internal cost tracking (account().usageCents);
 * it is NOT the customer's bill (they are billed by the licensed Stripe
 * QUANTITY, design §2). Reuses the per-mailbox idempotency key as the ledger's
 * source_send_id so a retried provision can never double-count.
 */
async function meterProvisionedMailbox(ctx: TenantContext, email: string, idempotencyKey: string, now: number): Promise<void> {
  if (!isPaidPlan(ctx.plan)) return;
  // H5 — this sits AFTER the money already moved, and the real billing port
  // throws NotActivatedError unconditionally (vendors/real/billing-port.ts): it
  // was the guaranteed NEXT 500 once the domain legs were fixed, failing a
  // provision whose vendor spend had already happened. The metering is INTERNAL
  // COGS tracking, so an unarmed usage reporter must not destroy a successful
  // provision. Narrow by design: only NotActivatedError is absorbed — a genuine
  // billing failure still propagates.
  try {
    await ctx.adapters.billing.recordUsage(ctx.tenantId, "mailbox provisioned (mo)", MAILBOX_MONTHLY_FEE_CENTS, idempotencyKey);
  } catch (err) {
    if (!(err instanceof NotActivatedError)) throw err;
    logAction(ctx, "USAGE_METERING_SKIPPED", email, {
      reason: "billing usage reporter is not activated — local ledger entry still recorded",
    });
  }
  ctx.sql.exec(
    `INSERT OR IGNORE INTO ledger_entries (id, tenant_id, kind, amount_cents, description, ts, source_send_id)
     VALUES (?, ?, 'usage', ?, 'mailbox provisioned (mo)', ?, ?)`,
    newId("ledg"),
    ctx.tenantId,
    MAILBOX_MONTHLY_FEE_CENTS,
    now,
    idempotencyKey,
  );
}

/**
 * The `mailboxes` row for a just-provisioned mailbox.
 *
 * OR IGNORE against idx_mailboxes_live_email: a duplicate live row would be
 * BILLED by syncMailboxQuantity, so the partial unique index — not just the
 * recorded unit — is what makes double-billing structurally impossible.
 */
function insertProvisionedMailbox(
  ctx: TenantContext,
  opts: { domainId: string; domain: string },
  provisioned: ProvisionedMailboxRecord,
  now: number,
): void {
  const { email, warmupStartedAt } = provisioned;
  const day = computeWarmupDay(warmupStartedAt, now);
  ctx.sql.exec(
    // poll_cursor starts at -1 (never-polled sentinel, engine.ts's
    // first-contact branch) so runPollInbox's first poll for a brand-new
    // mailbox initializes the cursor at the mailbox's current high-water
    // WITHOUT fetching history, instead of the column's own DEFAULT 0 (an
    // ordinary incremental cursor since the round-2 fix, not a sentinel).
    `INSERT OR IGNORE INTO mailboxes
       (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at, poll_cursor, slot_counted, provider)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, -1, ?, ?)`,
    newId("mbx"),
    ctx.tenantId,
    opts.domainId,
    opts.domain,
    email,
    warmupDailyCap(day),
    epochDay(now),
    warmupStatus(day),
    warmupStartedAt,
    now,
    // G4 — record whether this consumed a REAL InboxKit plan slot (the
    // withSpendCeiling reserve above incremented vendor_slot_state iff the
    // bundle is real). Read at teardown to decrement the slot counter precisely.
    ctx.adapters.kind === "real" ? 1 : 0,
    // Wave-2 §1a — WHICH VENDOR holds it, straight from the port's own answer
    // ('google' from RealMailboxPort, 'sandbox' from the sandbox one). This
    // value used to be computed and then DROPPED at the insert, which is what
    // left the send-eligibility picker unable to tell a real mailbox from a
    // demo-era phantom. `slot_counted` beside it is NOT a substitute: a BYO
    // mailbox and any real row predating that column both read 0.
    provisioned.provider,
  );
}
