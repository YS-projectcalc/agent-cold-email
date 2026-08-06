import type { TenantContext } from "../tenant-context.js";
import { customerSafeDetail, customerSafeVendorDetail, customerSafeVendorFailure, logVendorFailure } from "../vendor-failure.js";
import { logAction } from "./deliverability-actions.js";
import { computeWarmupDay, isSendReady } from "./warmup.js";

/**
 * Warmup-pool auto-cancel at ramp completion — founder ruling 2026-08-02
 * (ROADMAP.md:25, option b). Every provisioned mailbox gets InboxKit's warmup
 * pool activated at provisioning as a RECURRING per-mailbox monthly add-on; the
 * ruling is that it runs during the ~28-day ramp and the platform then cancels
 * it, so COGS is roughly one month per mailbox instead of forever.
 *
 * Cancelling does NOT reduce what the mailbox can send: the ramp is ours
 * (engine/warmup.ts), and a mailbox past day 28 is at its full 40/day cap
 * whether or not the vendor pool is still running. Only the synthetic warmup
 * traffic stops, which is precisely the point — after the ramp, reputation
 * rides real sending.
 *
 * SEPARATE from `refreshMailboxWarmupState`, which computes the same day/status
 * transition, for two reasons: that function is SYNCHRONOUS and is called
 * mid-guard-sequence by the send path (engine/guarded-send.ts) where its
 * synchronous shape is what makes the capacity reserve atomic — awaiting a
 * vendor call inside it would reopen the DO input gate between a cap check and
 * its reserve. It is also called on read-adjacent paths that must not perform
 * vendor I/O. So the transition is OBSERVED here instead, from the tick.
 */

// Bounds the retry of a failing cancel. Without it a mailbox whose vendor
// subscription can never be cancelled (already gone, vendor-side data drift)
// would re-attempt one HTTP call every tick forever — the exact infinite-retry
// shape tick.ts's MAX_SEND_ATTEMPTS exists to prevent (A4 CLASS A). At the cap
// the mailbox is marked cancelled so the sweep stops, with an ops-visible
// action row recording that it was given up on rather than confirmed.
const MAX_CANCEL_ATTEMPTS = 5;

interface RampCompleteMailbox {
  id: string;
  email: string;
  warmup_started_at: number;
  warmup_cancel_attempts: number;
  [column: string]: SqlStorageValue;
}

/**
 * Cancels the warmup subscription of every mailbox whose ramp has completed and
 * that has not been cancelled yet. Runs from the tick.
 *
 * CATCH-UP BY CONSTRUCTION: the query selects on "past the ramp AND no marker",
 * not on "crossed day 28 during this tick", so a mailbox that completed its ramp
 * while this feature was undeployed (or during any window where the tick was not
 * running) is still picked up on the next tick. There are ZERO live mailboxes at
 * ship time, so this is a durability property rather than a backfill.
 *
 * NEVER THROWS. A vendor failure must not block or delay sends, so each mailbox
 * is graded independently and the whole sweep is failure-isolated; the caller
 * (runTick) awaits it purely for ordering.
 */
export async function runWarmupCancellationSweep(ctx: TenantContext): Promise<{ cancelled: number; failed: number }> {
  const now = ctx.clock.now();

  // Tenant-scoped (CLAUDE.md rule h). Three exclusions, each for a mailbox that
  // has no subscription for us to cancel:
  //  - `released_at` — teardown already released the whole mailbox vendor-side.
  //  - either marker — already confirmed cancelled, or already given up on.
  //  - `source != 'byo_connected'` — a BYO mailbox the customer connected was
  //    never bought through InboxKit and never had `startWarmup` called on it
  //    (engine/byo-mailbox-composition.ts inserts it with a real
  //    warmup_started_at, so the ramp math alone cannot tell it apart). Without
  //    this the sweep would spend the full attempt budget on
  //    `resolveMailboxUid` failures and file a false give-up per BYO mailbox.
  //    Written as `!=` rather than `= 'provisioned'` deliberately: a future
  //    source value that DOES get a subscription must keep being swept. Missing
  //    a real subscription leaks money forever; sweeping a spurious one costs a
  //    bounded number of failed calls, so this is the safe direction.
  const candidates = ctx.sql
    .exec<RampCompleteMailbox>(
      `SELECT id, email, warmup_started_at, warmup_cancel_attempts FROM mailboxes
       WHERE tenant_id = ? AND warmup_cancelled_at IS NULL AND warmup_cancel_gave_up_at IS NULL
         AND released_at IS NULL AND source != 'byo_connected'
         AND warmup_cancel_attempts < ?`,
      ctx.tenantId,
      MAX_CANCEL_ATTEMPTS,
    )
    .toArray();

  let cancelled = 0;
  let failed = 0;

  for (const mailbox of candidates) {
    // The ramp-completion transition itself — the same day math the warmup
    // status column is derived from, so "cancelled" and "active" flip together
    // rather than drifting apart on separate definitions of day 29.
    if (!isSendReady(computeWarmupDay(mailbox.warmup_started_at, now))) continue;

    try {
      await ctx.adapters.mailbox.cancelWarmup(mailbox.email, `warmup-cancel:${ctx.tenantId}:${mailbox.id}`);
    } catch (err) {
      failed++;
      const attempts = mailbox.warmup_cancel_attempts + 1;
      ctx.sql.exec(
        `UPDATE mailboxes SET warmup_cancel_attempts = ? WHERE id = ? AND tenant_id = ?`,
        attempts,
        mailbox.id,
        ctx.tenantId,
      );
      // Raw text to the Worker log (operators); the customer-readable activity
      // row gets the abstract step + retryability only.
      logVendorFailure(`cancelWarmup ${mailbox.email}`, err);
      if (attempts >= MAX_CANCEL_ATTEMPTS) {
        // Give up rather than retry forever — but record it in its OWN column,
        // never `warmup_cancelled_at` (adversary N-c): that column asserts the
        // vendor confirmed, and a give-up confirms the opposite. Both columns
        // stop the sweep; only one of them is evidence the charge stopped.
        // Ops-visible too — an uncancelled subscription is a live recurring
        // charge, so this must never fail silently.
        ctx.sql.exec(
          `UPDATE mailboxes SET warmup_cancel_gave_up_at = ? WHERE id = ? AND tenant_id = ?`,
          now,
          mailbox.id,
          ctx.tenantId,
        );
        // retryable:FALSE regardless of the underlying grade — the sweep has
        // stopped trying, so telling a reader "retryable" would describe the
        // vendor error rather than what will actually happen next. An
        // uncancelled subscription is a live recurring charge; the honest signal
        // is "this needs a human", not "we'll get it next time".
        logAction(
          ctx,
          "WARMUP_CANCEL_GAVE_UP",
          mailbox.email,
          customerSafeDetail(
            { step: customerSafeVendorFailure(err).step, retryable: false },
            "warmup cancellation needs operator attention",
            { attempts, note: "the warmup subscription may still be billing — an operator must verify it with the provider" },
          ),
        );
        continue;
      }
      logAction(
        ctx,
        "WARMUP_CANCEL_FAILED",
        mailbox.email,
        customerSafeVendorDetail(err, "warmup cancellation is retrying", { attempts, willRetry: true }),
      );
      continue;
    }

    // Marker set only AFTER the vendor confirms (persist-after-confirm): a
    // crash between the call and this write leaves the marker NULL, so the next
    // tick retries. cancelWarmup is safe to repeat, so a duplicate cancel of an
    // already-cancelled subscription is the acceptable direction of that race —
    // the unacceptable one is marking it cancelled when it is still billing.
    ctx.sql.exec(
      `UPDATE mailboxes SET warmup_cancelled_at = ? WHERE id = ? AND tenant_id = ?`,
      now,
      mailbox.id,
      ctx.tenantId,
    );
    logAction(ctx, "WARMUP_CANCELLED", mailbox.email, { warmupDay: computeWarmupDay(mailbox.warmup_started_at, now) });
    cancelled++;
  }

  return { cancelled, failed };
}
