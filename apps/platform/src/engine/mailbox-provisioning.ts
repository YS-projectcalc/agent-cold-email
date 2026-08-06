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

import { isPaidPlan, NotActivatedError, VendorError } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { logVendorFailure, VENDOR_STEP } from "../vendor-failure.js";
import { logAction } from "./deliverability-actions.js";
import { withRequestIdempotency } from "./idempotency.js";
import { maybePushProvisionedMailbox } from "./mailbox-credential-push.js";
import {
  mailboxIntentKey,
  markMailboxIntent,
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

/** The provider a resumed leg assumes when the interrupted attempt never recorded one. */
const DEFAULT_PROVIDER = "google";

/** What one completed per-mailbox unit yields — the shape the row insert + credential push consume. */
interface ProvisionedMailboxRecord {
  email: string;
  provider: string;
  provisionedAt: number;
  warmupStartedAt: number;
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
  opts: { domainId: string; domain: string; domainOrdinal: number; personaSlug: string; inboxesEach: number },
): Promise<string[]> {
  const now = ctx.clock.now();
  const mailboxEmails: string[] = [];

  for (let mailboxIndex = 0; mailboxIndex < opts.inboxesEach; mailboxIndex++) {
    const localPart = `${opts.personaSlug}${opts.domainOrdinal + 1}${mailboxIndex + 1}`;
    const email = `${localPart}@${opts.domain}`;
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
    const provisioned = await withRequestIdempotency(ctx, `provision:${intentKey}`, () =>
      runMailboxProvisioningUnit(ctx, { email, localPart, domain: opts.domain, intentKey }),
    );
    mailboxEmails.push(provisioned.email);

    // The row lands only now — after the vendor confirmed the mailbox exists AND
    // its warmup enrolled. See invariant 2 in the module doc: the billing meter
    // counts these rows, so one must never exist ahead of the resource.
    insertProvisionedMailbox(ctx, opts, provisioned.email, provisioned.warmupStartedAt, now);
    markMailboxIntent(ctx, intentKey, "committed");

    await meterProvisionedMailbox(ctx, provisioned.email, intentKey, now);

    // Self-serve I3 credential push (F6): record-then-push the just-provisioned
    // mailbox's credentials to the engine. INERT unless the vendor+engine are
    // armed AND this is a real vendor mailbox (never sandbox). A push failure is
    // swallowed (the mailbox is durably recorded 'pending'; the reconcile sweep
    // retries), so it can never fail a provision whose vendor spend already
    // happened.
    await maybePushProvisionedMailbox(ctx, provisioned);
  }

  return mailboxEmails;
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
  opts: { email: string; localPart: string; domain: string; intentKey: string },
): Promise<ProvisionedMailboxRecord> {
  const intent = recordMailboxIntent(ctx, opts.intentKey, opts.email);
  const bought = await buyMailboxUnlessAlreadyOurs(ctx, intent, opts);

  // L2 — THE GATE. `provision()` returning means the vendor ACCEPTED the order,
  // not that the mailbox exists: InboxKit answers "scheduled". Every next step
  // (warmup enrolment here, plus health/credentials/release later) resolves the
  // mailbox by uid, which throws PERMANENTLY while it is unlistable. Waiting
  // here is what stops that throw from unwinding the whole saga back through a
  // buy that already succeeded.
  await awaitMailboxReady(ctx, opts.email);

  const warmupStartedAt = await startWarmupUnlessAlreadyRunning(ctx, intent, opts);
  return { email: opts.email, provider: bought.provider, provisionedAt: bought.provisionedAt, warmupStartedAt };
}

/**
 * Buys the mailbox unless a prior attempt already did.
 *
 * The three cases mirror the domain flow's adopt-before-buy, because the defect
 * is the same one a step later:
 *  - 'intent'   — no purchase has been attempted. Buy.
 *  - 'dangling' — the buy call THREW; we cannot know whether it landed. ASK the
 *                 vendor. Anything but 'absent' means it landed, so adopt it;
 *                 'absent' means the throw really did precede the order, and
 *                 buying is the only way forward.
 *  - anything further along — the vendor accepted it. NEVER buy again: 'absent'
 *                 here is the async window, not evidence the order was lost.
 */
async function buyMailboxUnlessAlreadyOurs(
  ctx: TenantContext,
  intent: MailboxIntentRow,
  opts: { email: string; localPart: string; domain: string; intentKey: string },
): Promise<{ provider: string; provisionedAt: number }> {
  const alreadyOrdered =
    intent.status === "bought" || intent.status === "warming" || intent.status === "committed";
  if (alreadyOrdered) {
    logAction(ctx, "MAILBOX_PROVISION_RESUMED", opts.email, {
      reason: "a prior attempt already purchased this mailbox — resuming without a second purchase",
      priorStatus: intent.status,
    });
    return { provider: intent.provider ?? DEFAULT_PROVIDER, provisionedAt: ctx.clock.now() };
  }

  if (intent.status === "dangling" && (await ctx.adapters.mailbox.provisioningState(opts.email)) !== "absent") {
    logAction(ctx, "MAILBOX_ADOPTED", opts.email, {
      reason: "the provider already holds this mailbox from an interrupted attempt — recovered instead of re-bought",
    });
    markMailboxIntent(ctx, opts.intentKey, "bought", intent.provider ?? DEFAULT_PROVIDER);
    return { provider: intent.provider ?? DEFAULT_PROVIDER, provisionedAt: ctx.clock.now() };
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
 * G2 money-out site #2. Its cost is already priced into COST_MAILBOX_CENTS at
 * the provision reserve (spendCostCents's 'warmup' branch reserves 0), so this
 * wrap is for choke-point completeness — no money-out vendor call escapes the
 * enumerated inventory — not a second charge.
 */
async function startWarmupUnlessAlreadyRunning(
  ctx: TenantContext,
  intent: MailboxIntentRow,
  opts: { email: string; intentKey: string },
): Promise<number> {
  if (intent.status === "warming" || intent.status === "committed") {
    // The ramp start is re-stamped to now rather than recovered. A resume lands
    // minutes-to-a-day after the real enrolment, and the drift only ever makes
    // the 28-day ramp START LATER — the safe direction for a warmup.
    return ctx.clock.now();
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
 */
async function awaitMailboxReady(ctx: TenantContext, email: string, backoffMs: number[] = MAILBOX_READY_BACKOFF_MS): Promise<void> {
  const attempts = backoffMs.length + 1;
  let lastState = "absent";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      lastState = await ctx.adapters.mailbox.provisioningState(email);
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
    if (lastState === "ready") return;
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
  email: string,
  warmupStartedAt: number,
  now: number,
): void {
  const day = computeWarmupDay(warmupStartedAt, now);
  ctx.sql.exec(
    // poll_cursor starts at -1 (never-polled sentinel, engine.ts's
    // first-contact branch) so runPollInbox's first poll for a brand-new
    // mailbox initializes the cursor at the mailbox's current high-water
    // WITHOUT fetching history, instead of the column's own DEFAULT 0 (an
    // ordinary incremental cursor since the round-2 fix, not a sentinel).
    `INSERT OR IGNORE INTO mailboxes
       (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at, poll_cursor, slot_counted)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, -1, ?)`,
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
  );
}
