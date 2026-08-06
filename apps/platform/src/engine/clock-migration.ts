// The one-shot virtual->real clock migration (wave-2 design DECISION 2 +
// MIGRATION PLAN, v2 §1b/§2/§3; adversary-gated 2026-08-05).
//
// WHY IT EXISTS. Every tenant signs up as plan 'demo' (routes/signup.ts), so
// every tenant starts on a VirtualClock; the checkout upgrade flips `plan` but
// never touched the clock columns. A paid tenant was therefore stamping rows
// with `base(signup) + offset(every pre-upgrade demo run's advanceVirtual)` —
// a frozen "now" typically far in the real FUTURE (~32 virtual days per demo
// run, up to 20 runs). Flipping such a tenant onto real time without rebasing
// its clock-stamped rows strands them: a send scheduled at frozen+2h is a real
// timestamp ~600 days ahead and never becomes due; an idempotency claim
// stamped ahead of real now can never age out of its 10-minute pending TTL, so
// the key is wedged forever.
//
// SHAPE (adversary finding 5). Everything below — the provider backfill, the
// sandbox mailbox retirement, the sandbox domain retirement (NEW-4), every
// SHIFT, the demo terminalization AND the clock_mode='real' stamp — runs
// inside ONE `storage.transactionSync`. A throw
// anywhere rolls back all of it INCLUDING the marker, so a retry re-enters a
// genuinely virgin state and applying the delta twice is structurally
// impossible. That is why the marker is written inside rather than first: this
// operation is corrupting under partial application, unlike the
// partial-tolerant index back-fills next to it in TenantDO's constructor.
//
// SYNCHRONOUS BY CONSTRUCTION. `transactionSync` takes a synchronous closure —
// no `await` may appear anywhere below. Anything async that the flip implies
// (e.g. re-syncing the billed mailbox quantity after the retirement) is left to
// the next cron reconcile on purpose.

/** What the migration actually did — logged by the caller, not read by product code. */
export interface ClockMigrationSummary {
  /** realNow - frozenNow. EITHER SIGN; negative means the frozen clock was ahead of real time. */
  deltaMs: number;
  migratedAt: number;
  classified: { google: number; byo: number; sandbox: number };
  retiredMailboxes: number;
  retiredDomains: number;
  shiftedSends: number;
  shiftedSendingClaims: number;
  shiftedIdempotencyRows: number;
  shiftedDomainGates: number;
  skippedDemoSends: number;
  pausedDemoCampaigns: number;
}

/**
 * Rebases every clock-stamped row this tenant owns from its frozen virtual
 * clock onto real wall time and stamps `clock_mode='real'`. Call ONCE per
 * tenant, from TenantDO only, guarded by `clock_mode != 'real'`.
 *
 * @param frozenNowMs what the tenant's VirtualClock reads right now — the time
 *   base every row below was stamped against.
 * @param realNowMs real wall time (the caller supplies it so the whole
 *   migration is one consistent instant, and so tests can pin it).
 * @throws whatever the underlying SQL throws — the transaction has already
 *   rolled back by then, so the caller may safely keep the virtual clock and
 *   retry on the next construction.
 */
export function migrateTenantClockToReal(
  storage: DurableObjectStorage,
  tenantId: string,
  frozenNowMs: number,
  realNowMs: number,
): ClockMigrationSummary {
  const deltaMs = realNowMs - frozenNowMs;

  return storage.transactionSync(() => {
    const sql = storage.sql;

    // --- 1. PROVENANCE BACKFILL (v2 §1b) ------------------------------------
    // Order is load-bearing: 'byo' and 'google' claim their rows first, and
    // 'sandbox' is the catch-all. That ordering is what guarantees every row
    // the retirement below touches has slot_counted=0, so retiring it can never
    // leak a real InboxKit plan slot. `provider = ''` scopes each statement to
    // rows nothing has classified yet, so a row already stamped by the insert
    // path is never reclassified.
    const byo = sql.exec(
      `UPDATE mailboxes SET provider = 'byo' WHERE tenant_id = ? AND provider = '' AND source = 'byo_connected'`,
      tenantId,
    ).rowsWritten;
    const google = sql.exec(
      `UPDATE mailboxes SET provider = 'google' WHERE tenant_id = ? AND provider = '' AND slot_counted = 1`,
      tenantId,
    ).rowsWritten;
    const sandbox = sql.exec(
      `UPDATE mailboxes SET provider = 'sandbox' WHERE tenant_id = ? AND provider = ''`,
      tenantId,
    ).rowsWritten;

    // --- 2. RETIRE THE SANDBOX-ORIGIN MAILBOXES (v2 §1b) --------------------
    // A tenant who explored before paying holds real `mailboxes` rows created
    // by the SANDBOX bundle: nothing exists at any vendor for them, yet they
    // are live, healthy and (having never sent) permanently the least-loaded
    // candidate the capacity picker sees. Retiring them at the flip is what
    // stops a newly-paid tenant routing every real send at a phantom mailbox.
    // No vendor call: there is nothing to release.
    //
    // BOTH columns, and `deliv_status='paused'` is NOT decorative (adversary
    // round-2, finding 1): the manual-reply path picks its mailbox from thread
    // history (engine/threads.ts's resolveSendingMailbox) with no eligibility
    // filter at all, and the ONLY thing that stops a reply to a demo-era thread
    // going out through a retired mailbox is guarded-send's refusal to send
    // from a paused one. A build that sets only `released_at` reopens that hole.
    // Sticky by construction — nothing anywhere writes deliv_status back to
    // 'healthy'.
    const retiredMailboxes = sql.exec(
      `UPDATE mailboxes SET released_at = ?, deliv_status = 'paused'
       WHERE tenant_id = ? AND provider = 'sandbox' AND released_at IS NULL`,
      realNowMs,
      tenantId,
    ).rowsWritten;

    // --- 2b. RETIRE THE SANDBOX-ORIGIN `domains` ROWS (NEW-4, wave-2 design
    // review round 2) ---------------------------------------------------------
    // The mailbox retirement above has a sibling gap one table up: a tenant who
    // explored before paying can also hold `domains` rows the SANDBOX registrar
    // "purchased" (SandboxDomainPort.buy, vendors/sandbox/domain-port.ts,
    // `purchasedAt: this.clock.now()`) — nothing is registered at any real
    // registrar for them. Left at status='active' forever, gatherDomainStats
    // (engine/deliverability.ts) folds it into per-domain aggregates and the
    // evaluate() burn/breaker loop (which only skips a domain whose status is
    // already non-'active') can reach a real REPLACE_DOMAIN/HARD_PAUSE_DOMAIN
    // decision for a domain the platform never actually owns.
    //
    // DISCRIMINATOR. `source = 'byo'` is NEVER a candidate — a customer's own
    // domain is never ours to retire, mirroring the mailbox retirement's own
    // BYO carve-out one level down (provider backfill above never touches
    // `byo_connected` rows either). Among `source = 'provisioned'` domains,
    // retire one only if it now has ZERO currently-live (`released_at IS
    // NULL`) NON-sandbox mailboxes attached — checked here, AFTER step 1's
    // provenance backfill and the retirement directly above have both already
    // run in THIS transaction, so `provider` is fully classified and every
    // purely-sandbox domain's mailboxes are already released.
    //
    // WHY THE MAILBOX-ATTACHMENT CHECK, NOT JUST `source = 'provisioned'`
    // outright: by the time this migration can run at all (guarded by
    // `clock_mode != 'real'`), `plan` has already flipped to a paid tier (its
    // own precondition — vendors/factory.ts only ever selects real adapters
    // for a paid plan), so ordinarily no real 'provisioned' domain could exist
    // yet. But the plan-write and this flip are not the same SQL statement
    // (tenant-do.ts's reconcileClockWithDurablePlan runs this AFTER awaiting
    // the webhook handler that wrote `plan`), so a `setup_infrastructure` call
    // landing in that narrow window would use real adapters and mint a
    // genuinely real domain+mailboxes while `clock_mode` is still 'virtual'.
    // That race is unconfirmed to ever have fired (production has never
    // migrated a tenant with any real mailbox provisioned), but the asymmetric
    // cost — wrongly retiring a domain carrying live customer sends is far
    // worse than leaving a harmless phantom domain 'active' — means this must
    // fail toward NOT retiring on that ambiguity. A domain with even one live
    // non-sandbox mailbox is left alone.
    const retiredDomains = sql.exec(
      `UPDATE domains SET status = 'retired'
       WHERE tenant_id = ? AND source = 'provisioned' AND status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM mailboxes m
           WHERE m.domain_id = domains.id AND m.provider != 'sandbox' AND m.released_at IS NULL
         )`,
      tenantId,
    ).rowsWritten;

    // --- 3. SHIFT every column stamped EXCLUSIVELY by ctx.clock -------------
    // Adding the delta preserves relative offsets, so a campaign's step spacing
    // and send windows survive the rebase intact.

    // Non-demo scheduled sends. 'sending' is included as well as 'pending'
    // (adversary finding 4): a 'sending' row carries send_at too, and the
    // stuck-'sending' TTL reclaim restores the STATUS only — it never touches
    // send_at (engine/tick.ts) — so a future-stamped row reclaimed back to
    // 'pending' would sit undeliverable until real time caught up. Terminal
    // rows are audit history and stay as stamped.
    const shiftedSends = sql.exec(
      `UPDATE scheduled_sends SET send_at = send_at + ?
       WHERE tenant_id = ? AND status IN ('pending', 'sending')
         AND campaign_id IN (SELECT id FROM campaigns WHERE tenant_id = ? AND is_demo = 0)`,
      deltaMs,
      tenantId,
      tenantId,
    ).rowsWritten;

    // The claim marker itself, so the reclaim TTL measures a real interval.
    // Deliberately NOT limited to non-demo campaigns: a stuck demo row must
    // still become reclaimable rather than dead-lettered in 'sending' forever.
    const shiftedSendingClaims = sql.exec(
      `UPDATE scheduled_sends SET sending_since = sending_since + ?
       WHERE tenant_id = ? AND status = 'sending' AND sending_since IS NOT NULL`,
      deltaMs,
      tenantId,
    ).rowsWritten;

    // ALL request_idempotency rows. A 'pending' claim stamped ahead of real now
    // gives `now - created_at < 0`, which is always below the 10-minute pending
    // TTL — i.e. a permanently unreclaimable setup key. 'done' rows shift too so
    // the 30-day eviction keeps working. (The table is per-DO and has no
    // tenant_id column; a DO is single-tenant.)
    const shiftedIdempotencyRows = sql.exec(
      `UPDATE request_idempotency SET created_at = created_at + ?`,
      deltaMs,
    ).rowsWritten;

    // BYO domain gates — both are ctx.clock-stamped, and shifting preserves
    // whatever remains of the mandatory DMARC observation window rather than
    // granting or re-imposing one.
    const shiftedEligible = sql.exec(
      `UPDATE domains SET first_send_eligible_at = first_send_eligible_at + ?
       WHERE tenant_id = ? AND first_send_eligible_at IS NOT NULL`,
      deltaMs,
      tenantId,
    ).rowsWritten;
    const shiftedDnsChecked = sql.exec(
      `UPDATE domains SET dns_first_checked_at = dns_first_checked_at + ?
       WHERE tenant_id = ? AND dns_first_checked_at IS NOT NULL`,
      deltaMs,
      tenantId,
    ).rowsWritten;

    // NOTHING shifts mailboxes.warmup_started_at, and nothing resets it. The
    // retirement above replaced the design's original reset: sandbox-origin
    // rows are retired outright, real rows (slot_counted=1) carry a
    // VENDOR-stamped real timestamp already (vendors/real/mailbox-port.ts never
    // reads ctx.clock), and a BYO row keeps the genuine ramp it is part-way
    // through. Resetting any of those would be wrong in both directions.

    // --- 4. TERMINALIZE the demo seed data ---------------------------------
    // Without this, the first real tick of a newly-paid tenant attempts its
    // leftover demo-seed rows against the REAL engine and drains them to
    // 'failed'. Skipping is the honest terminal state: they were never real
    // sends and never will be.
    const skippedDemoSends = sql.exec(
      `UPDATE scheduled_sends SET status = 'skipped'
       WHERE tenant_id = ? AND status = 'pending'
         AND campaign_id IN (SELECT id FROM campaigns WHERE tenant_id = ? AND is_demo = 1)`,
      tenantId,
      tenantId,
    ).rowsWritten;
    const pausedDemoCampaigns = sql.exec(
      `UPDATE campaigns SET status = 'paused' WHERE tenant_id = ? AND is_demo = 1 AND status != 'paused'`,
      tenantId,
    ).rowsWritten;

    // --- 5. STAMP, inside the same transaction ------------------------------
    // The marker and the delta commit with the work or not at all.
    sql.exec(
      `UPDATE tenant_profile SET clock_mode = 'real', clock_migration_delta_ms = ?, clock_migrated_at = ? WHERE id = ?`,
      deltaMs,
      realNowMs,
      tenantId,
    );

    return {
      deltaMs,
      migratedAt: realNowMs,
      classified: { google, byo, sandbox },
      retiredMailboxes,
      retiredDomains,
      shiftedSends,
      shiftedSendingClaims,
      shiftedIdempotencyRows,
      shiftedDomainGates: shiftedEligible + shiftedDnsChecked,
      skippedDemoSends,
      pausedDemoCampaigns,
    };
  });
}
