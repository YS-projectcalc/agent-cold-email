// D5 tenant lifecycle — voluntary cancellation, abuse-offboarding teardown,
// and the shared infra reclaim path both drive. SPEC.md §7 (isolation: every
// customer owns dedicated domains/mailboxes — a teardown reclaims exactly that
// tenant's resources, never a shared pool) + site/aup.html §7-§8 (the AUP
// consequence ladder, enforced in code not paper). Stripe stays the billing
// source of truth (ARCHITECTURE.md #3); these functions mirror cancellation
// onto tenant_profile.billing_state and reclaim the provisioned infra.

import { newId } from "../schema.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { TenantContext } from "../tenant-context.js";
import { customerSafeVendorDetail, logVendorFailure } from "../vendor-failure.js";
import { alertUnresolvedDomainConnectionType } from "./byo-teardown-alert.js";
import { pauseAllCampaigns } from "./campaigns.js";
import { logAction } from "./deliverability-actions.js";
import { EngineMailboxClient } from "./engine-mailbox-client.js";
import { forEachIsolated } from "../isolated-loop.js";
import { engineConfigFromEnv, revokePushedMailboxCredentials } from "./mailbox-credential-push.js";
import { suspendTenant } from "./ops-summary.js";
import { markMailboxIntentsReleased } from "./provision-intents.js";
import { releaseMailboxSlots } from "./spend-ceiling.js";
import { ONE_DAY_MS } from "./warmup.js";

// Annual .com registration wholesale cost (SPEC.md §12: "Porkbun .com
// $11.08/yr"). Domains are bought for a FULL YEAR up front; reclaiming one
// mid-term means we eat the unconsumed remainder of that year — the
// annual-domain liability the owner digest surfaces.
const DOMAIN_ANNUAL_CENTS = 1108;
const DOMAIN_TERM_MS = 365 * ONE_DAY_MS;

export type TeardownReason = "voluntary_cancel" | "abuse_terminate";

export interface TeardownSummary {
  reason: TeardownReason;
  /** 'immediate' | 'end_of_period' — how the BILLING side ends (infra reclaim is always immediate). */
  effective: string;
  /** Count of domains reclaimed from this tenant's active set. A vendor
   * release call is only ever issued for a 'purchased' domain (ROADMAP.md:32)
   * — a 'connected'/BYO or 'unknown' domain is counted here too (its LOCAL
   * record is retired) but the vendor is never touched for it. */
  domainsReleased: number;
  mailboxesReleased: number;
  campaignsStopped: number;
  /** Unconsumed remainder of the tenant's annual domain registrations we eat by
   * reclaiming mid-term (integer cents) — 'purchased' domains only; we never
   * paid a registration fee for a 'connected'/BYO/'unknown' domain, so none of
   * those contribute here (ROADMAP.md:32). */
  annualDomainLiabilityCents: number;
  ts: number;
}

/**
 * Unconsumed remainder of a one-year domain registration, prorated by time
 * left in the term (integer cents, clamped to [0, annual]). A domain reclaimed
 * on day 1 costs us nearly the full year; one reclaimed after the term has
 * elapsed costs nothing (renewal was never ours to pay).
 */
export function computeDomainLiabilityCents(purchasedAt: number, now: number): number {
  const remainingMs = Math.max(0, Math.min(DOMAIN_TERM_MS, DOMAIN_TERM_MS - (now - purchasedAt)));
  return Math.round((DOMAIN_ANNUAL_CENTS * remainingMs) / DOMAIN_TERM_MS);
}

function readTeardownRecord(ctx: TenantContext): TeardownSummary | null {
  const row = ctx.sql
    .exec<{
      reason: TeardownReason;
      effective: string;
      domains_released: number;
      mailboxes_released: number;
      campaigns_stopped: number;
      annual_domain_liability_cents: number;
      ts: number;
    }>(
      `SELECT reason, effective, domains_released, mailboxes_released, campaigns_stopped,
              annual_domain_liability_cents, ts
       FROM teardown_records WHERE tenant_id = ?`,
      ctx.tenantId,
    )
    .toArray()[0];
  if (!row) return null;
  return {
    reason: row.reason,
    effective: row.effective,
    domainsReleased: row.domains_released,
    mailboxesReleased: row.mailboxes_released,
    campaignsStopped: row.campaigns_stopped,
    annualDomainLiabilityCents: row.annual_domain_liability_cents,
    ts: row.ts,
  };
}

/** Public read for account()/reporting — the teardown summary, or null if the tenant is still live. */
export function getTeardownSummary(ctx: TenantContext): TeardownSummary | null {
  return readTeardownRecord(ctx);
}

/**
 * Clears the teardown tombstone on REACTIVATION (a re-subscribe via checkout —
 * engine/billing.ts). teardown_records is the idempotency anchor for
 * cancel/terminate; leaving a stale row from a prior cancel means a LATER
 * cancel reads it and no-ops, never releasing the tenant's NEW infra (a
 * vendor-spend leak — adversarial panel-03 finding #4). Dropping it on
 * reactivation re-arms teardown against the current infra. The historical
 * annual-domain LIABILITY already booked (ledger kind='liability') is untouched
 * — that spend really happened; only the reclaim anchor resets.
 */
export function clearTeardownRecord(ctx: TenantContext): void {
  ctx.sql.exec(`DELETE FROM teardown_records WHERE tenant_id = ?`, ctx.tenantId);
}

export interface ReleaseMailboxesResult {
  /** Mailboxes that COMPLETED the release — vendor released, credentials revoked, row marked. */
  releasedCount: number;
  slotCountedReleased: number;
  /**
   * Mailboxes whose release failed and that are therefore STILL LIVE: their
   * `released_at` is un-marked by design, so they keep counting toward what is
   * billed and a later attempt retries them. Never folded into `releasedCount`
   * — the whole point of the split is that a caller sizing a billing decision
   * must not read an attempted release as a completed one.
   */
  failedCount: number;
}

/**
 * The billing meter (design §2/§3): a released mailbox (`released_at` set —
 * see `releaseMailboxes` below) stops counting toward what's billed.
 * Single-sourced here so the CHARGE (engine/billing.ts's
 * `checkoutMailboxQuantity`) and the DISPLAY (engine/reporting.ts's
 * `getAccount`, surfaced to the dashboard's Go-live quote) read the EXACT
 * same count and can never diverge again — adversary golive-ux-review-
 * 2026-07-27.md round-2 finding: `getAccount` used a plain `COUNT(*)`
 * (no `released_at` filter) while checkout used this released_at-aware
 * count, so a tenant with SOFT-released mailboxes (`removeMailboxes`,
 * deliverability auto-replacement, or teardown/cancel releasing ALL —
 * `DELETE FROM mailboxes` never happens, releases are always soft) saw a
 * quote/"provisioned now" figure that didn't match the real charge.
 */
export function billableMailboxCount(ctx: TenantContext): number {
  return ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, ctx.tenantId)
    .one().n;
}

/**
 * Releases mailboxes back to the vendor + marks them `released_at` (design §7.1
 * — extracted from teardown's mailbox loop, CLAUDE.md rule c). The billing
 * meter is `COUNT(*) WHERE released_at IS NULL`, so a released mailbox stops
 * counting. Three scopes via `opts`:
 *   - `{}`            — all this tenant's live mailboxes (teardown).
 *   - `{ domainId }`  — one domain's mailboxes (REPLACE_DOMAIN's burned domain).
 *   - `{ limit }`     — the N newest live mailboxes (a customer downgrade).
 *
 * PRESERVES the revoke-BEFORE-mark ordering (i3i4-r2 crash-safety): a crash
 * between the vendor release and the `released_at` mark leaves the row unmarked,
 * so a retry re-attempts both idempotently. Decrements the G4 account slot
 * counter by the count of REAL plan-slot mailboxes released (mailboxes.slot_counted).
 * Callers that touch billing must `syncMailboxQuantity` afterward.
 *
 * CREDSTORE F2 (wave2-design §"CREDSTORE F2", audit-credstore-2026-08-05
 * finding F2) — per-mailbox order is now: (1) tombstone `mailbox_cred_pushes`
 * FIRST, synchronous SQL, before ANY await; (2) vendor release; (3) engine
 * revoke; (4) mark `released_at`. Tombstone-first (not after revoke) closes
 * the reconcile-in-the-await-gap resurrection window: `reconcileMailboxCredentialPushes`
 * selects `status = 'pending'` with no lifecycle gate, and every await below
 * opens the DO's input gate — a reconcile landing in that gap used to find
 * the row still 'pending'/'pushed' and push (create) fresh credentials for a
 * mailbox we were in the middle of revoking. Retry semantics are unchanged
 * (the loop is driven by `released_at IS NULL`, marked last; the tombstone
 * UPDATE is idempotent on retry, same as the revoke).
 *
 * ROADMAP.md:32's principle extends past domains (orchestrator ruling
 * 2026-08-06): "never issue a vendor-destructive op against a customer-owned
 * resource at teardown" covers a `provider='byo'` mailbox exactly as it
 * covers a connected domain — byo-mailbox-composition.ts's `connectByoMailbox`
 * rows are the customer's OWN pre-existing IMAP/SMTP/OAuth connection,
 * bypassing vendor provisioning entirely, so `MailboxPort.release` for one
 * would call a vendor about a mailbox it never issued. Step (2) below skips
 * the vendor call for those rows ONLY; every other step (tombstone, engine
 * revoke, `released_at` mark, slot accounting, intent release) proceeds
 * unchanged — this closes at the ROOT of the shared function, so every
 * caller (teardownTenant AND deliverability-actions.ts's REPLACE_DOMAIN)
 * inherits it. Deliberately NOT extended to `provider=''` (unclassified) —
 * see the `mailboxes.provider` schema doc comment: that value is a ratified,
 * separate invariant ("'' IS LOAD-BEARING, NOT A BUG... do NOT 'fix' the ''
 * exclusion") resolved by a human via the U2 pre-arm provenance read, and the
 * risk direction is the OPPOSITE of the domain case — most `''` rows predate
 * the discriminator and are genuine vendor-provisioned mailboxes (the one-shot
 * clock migration already backfills the positive 'byo' signal from
 * `source='byo_connected'`, so a persisting `''` row is unlikely to be BYO),
 * so skipping their release would strand a REAL vendor resource, not protect
 * a customer's one.
 */
export async function releaseMailboxes(
  ctx: TenantContext,
  opts: { domainId?: string; limit?: number } = {},
  engineClient: EngineMailboxClient = new EngineMailboxClient(engineConfigFromEnv(ctx.env)),
): Promise<ReleaseMailboxesResult> {
  const now = ctx.clock.now();
  let query = `SELECT id, email, slot_counted, provider FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`;
  const params: (string | number)[] = [ctx.tenantId];
  if (opts.domainId) {
    query += ` AND domain_id = ?`;
    params.push(opts.domainId);
  }
  query += ` ORDER BY created_at DESC`;
  if (opts.limit != null) {
    query += ` LIMIT ?`;
    params.push(opts.limit);
  }
  const mailboxes = ctx.sql.exec<{ id: string; email: string; slot_counted: number; provider: string }>(query, ...params).toArray();

  let slotCountedReleased = 0;

  // HEAD-OF-LINE BLOCKING (class sweep 2026-08-17, IN-3). The vendor release was
  // unguarded and the list is stably ordered, so ONE mailbox the vendor
  // permanently 404s/403s blocked the release of every mailbox behind it — and
  // each retry re-died on the same head row. Those rows keep
  // `released_at IS NULL`, so a cancelling customer stayed billed, indefinitely,
  // for mailboxes the platform believed it still held. Reached from BOTH
  // teardown and REPLACE_DOMAIN, so the fix belongs at this shared root.
  const outcome = await forEachIsolated(
    mailboxes,
    async (m) => {
      // CREDSTORE F2 — tombstone FIRST, synchronous, before any await (closes
      // the reconcile-in-the-await-gap resurrection window; see doc comment
      // above). Only touches a still-live claim ('pending'/'pushed'); an
      // already-'revoked' row (a retry) is left alone.
      ctx.sql.exec(
        `UPDATE mailbox_cred_pushes SET status = 'revoked', updated_at = ? WHERE email = ? AND tenant_id = ? AND status IN ('pending', 'pushed')`,
        now,
        m.email,
        ctx.tenantId,
      );
      // Never release a customer-owned BYO connection at the vendor (see the
      // function doc comment above) — every other step still runs for it.
      if (m.provider !== "byo") {
        await ctx.adapters.mailbox.release(m.email, `release-mbx:${ctx.tenantId}:${m.id}`);
      }
      // Revoke BEFORE marking released_at (i3i4-r2): a crash in between leaves the
      // row unmarked -> a retry re-attempts release + revoke (both idempotent).
      await revokePushedMailboxCredentials(ctx, m.email, engineClient);
      ctx.sql.exec(
        `UPDATE mailboxes SET released_at = ?, deliv_status = 'paused' WHERE id = ? AND tenant_id = ?`,
        now,
        m.id,
        ctx.tenantId,
      );
      if (m.slot_counted) slotCountedReleased++;
      return m.email;
    },
    {
      onItemError: ({ item, error }) => {
        // An unreleased mailbox is a LIVE recurring cost on both sides — we keep
        // billing the customer for it and the vendor keeps billing us — so this
        // must never fail silently. Same shape as warmup-cancel.ts's give-up row:
        // ops-visible, customer-safe, honest about what did not happen.
        logVendorFailure(`release mailbox ${item.email}`, error);
        logAction(
          ctx,
          "MAILBOX_RELEASE_FAILED",
          item.email,
          customerSafeVendorDetail(error, "this mailbox could not be released — it is still live and still counted", {
            note: "the remaining mailboxes were still released; a later release retries this one",
          }),
        );
      },
    },
  );

  // N4 — a released mailbox no longer exists at the provider, so the durable
  // records asserting "we already provisioned this address" must stop saying so.
  // Without this, a cancel-then-resubscribe replayed the per-mailbox
  // idempotency claim, skipped the vendor buy entirely, and still inserted a
  // BILLABLE local row — a mailbox charged for monthly with nothing behind it.
  //
  // Only the SUCCEEDED addresses: an address whose vendor release failed still
  // exists at the provider, so releasing its intent would authorize exactly the
  // phantom-billable-row replay this invalidation exists to prevent.
  markMailboxIntentsReleased(ctx, outcome.results);
  // G4 — decrement the account slot counter by the REAL plan-slot mailboxes just
  // released (precise via slot_counted; no-op when none were slot-counted).
  // `slotCountedReleased` is incremented only on the completed path above, so a
  // failed release never hands a plan slot back that the vendor still holds.
  await releaseMailboxSlots(ctx, slotCountedReleased, now);
  return { releasedCount: outcome.results.length, slotCountedReleased, failedCount: outcome.failures.length };
}

/**
 * Reclaims a tenant's dedicated infrastructure: release every domain +
 * mailbox back to the vendor (DomainPort/MailboxPort.release — sandbox executes
 * it now, the real adapter calls the vendor at activation), stop all campaigns,
 * and book the annual-domain liability. IDEMPOTENT: the teardown_records row is
 * the anchor — a second call reads it and returns the existing summary without
 * re-releasing anything (re-cancel / re-terminate is a no-op). Suppression
 * lists are DELIBERATELY untouched — CAN-SPAM opt-outs survive account
 * teardown (a legal obligation the abuse-offboarding path must honor).
 *
 * `engineClient` is an injectable seam (mirrors mailbox-credential-push.ts's
 * CredentialPushDeps pattern) defaulting to a real client built from
 * `ctx.env` — production callers pass nothing. Each released mailbox's
 * pushed credentials are best-effort revoked on the engine via
 * revokePushedMailboxCredentials: dark unless the engine is configured, and a
 * revoke failure never blocks or fails the teardown itself.
 *
 * `mailer` is a second injectable seam, same pattern, used only for the
 * unresolved-connection-type founder alert below (ROADMAP.md:32).
 */
export async function teardownTenant(
  ctx: TenantContext,
  opts: { reason: TeardownReason; effective: string },
  engineClient: EngineMailboxClient = new EngineMailboxClient(engineConfigFromEnv(ctx.env)),
  mailer: OpsMailer = createOpsMailer(ctx.env),
): Promise<TeardownSummary> {
  const existing = readTeardownRecord(ctx);
  if (existing) return existing;

  const now = ctx.clock.now();

  // 1. Reclaim domains (belt-and-suspenders tenant scope even though a DO is
  //    single-tenant — CLAUDE.md rule h). Book each RELEASED domain's
  //    remaining-term liability as its own idempotent ledger row (keyed on
  //    source_send_id so a retry can never double-book) — the ledger SUM is
  //    the authoritative total the owner digest reads.
  //
  //    ROADMAP.md:32 FOUNDER RULING (2026-08-06) — "NEVER touch a
  //    customer-connected domain at teardown": the vendor release call below
  //    fires ONLY for a domain this platform actually registered
  //    ('purchased'). 'connected' (a customer's own domain, pointed at the
  //    vendor) and 'unknown' (no discriminator — every BYO row, byo-intake.ts's
  //    registerByoDomain never sets this column, AND any pre-existing legacy
  //    row) take the SAME branch: no vendor call, ever — the customer
  //    disconnects their own domain themselves. This is the OPPOSITE default
  //    from domain-dns.ts's setDns branch, which treats 'unknown' as
  //    'purchased': that read is non-destructive (a poll), so guessing wrong
  //    only stalls; release is destructive and irreversible, so the safe
  //    guess flips here — "we can't prove we own it" must mean "don't touch
  //    it", not "assume we do". The annual-domain liability is likewise only
  //    ever booked for a 'purchased' domain: it represents OUR wholesale
  //    registration cost, which was never incurred for a domain we didn't
  //    register.
  const domains = ctx.sql
    .exec<{ id: string; domain: string; purchased_at: number; connection_type: string | null }>(
      `SELECT id, domain, purchased_at, connection_type FROM domains WHERE tenant_id = ? AND status != 'released'`,
      ctx.tenantId,
    )
    .toArray();

  // HEAD-OF-LINE BLOCKING (class sweep 2026-08-17, IN-4). Both awaits below —
  // the vendor release and the unresolved-connection-type alert — were
  // unguarded, and the anchor row that makes teardown idempotent is written only
  // AFTER this loop. So a throw on one domain left no anchor at all: the
  // early-return at the top never fired and the ENTIRE teardown (domains,
  // mailbox release, campaign stop, liability booking) restarted from zero on
  // every attempt and re-died at the same domain. An abuse-terminated or
  // cancelled tenant could therefore never finish being torn down, stranding
  // vendor resources and the liability booking permanently.
  //
  // PER-ITEM PROGRESS is anchored by each domain's OWN `status = 'released'`
  // write, inside the isolated body: the select above excludes released rows, so
  // a resumed teardown (a DO crash mid-loop, the one case the anchor cannot
  // cover) skips the domains already done and never re-releases them. A domain
  // whose release FAILED deliberately keeps its status, so it is retried rather
  // than silently recorded as reclaimed.
  const domainOutcome = await forEachIsolated(
    domains,
    async (d) => {
      const rawType = (d.connection_type ?? "").trim().toLowerCase();
      const connectionType = rawType === "purchased" || rawType === "connected" ? rawType : "unknown";

      let liability = 0;
      if (connectionType === "purchased") {
        await ctx.adapters.domain.release(d.domain, `release-domain:${ctx.tenantId}:${d.id}`);
        liability = computeDomainLiabilityCents(d.purchased_at, now);
        if (liability > 0) {
          ctx.sql.exec(
            `INSERT OR IGNORE INTO ledger_entries (id, tenant_id, kind, amount_cents, description, ts, source_send_id)
             VALUES (?, ?, 'liability', ?, ?, ?, ?)`,
            newId("ledg"),
            ctx.tenantId,
            liability,
            `annual-domain liability: reclaimed ${d.domain} mid-term`,
            now,
            `liability:${ctx.tenantId}:${d.id}`,
          );
        }
      } else if (connectionType === "unknown") {
        // No proof either way — treated as connected (never released), but
        // logged AND alerted so a human resolves the ambiguity by hand.
        logAction(ctx, "DOMAIN_TEARDOWN_UNRESOLVED_CONNECTION_TYPE", d.domain, {
          reason: "teardown reached this domain with no recorded connection type; treated as connected (never released) — a human should confirm at the vendor",
        });
        await alertUnresolvedDomainConnectionType(ctx, d.domain, mailer);
      }
      // connectionType === 'connected': known-BYO, no log/alert needed — this is
      // the expected, unambiguous case the founder ruling exists for.

      ctx.sql.exec(
        `UPDATE domains SET status = 'released' WHERE id = ? AND tenant_id = ?`,
        d.id,
        ctx.tenantId,
      );
      return liability;
    },
    {
      onItemError: ({ item, error }) => {
        // A domain we could not release is a registration that keeps costing us
        // for the rest of its term with no customer behind it — the same
        // "money is still leaking" shape as warmup-cancel.ts's give-up, recorded
        // the same ops-visible way. Its row keeps `status != 'released'`, so the
        // record stays honest about what we still hold.
        logVendorFailure(`release domain ${item.domain}`, error);
        logAction(
          ctx,
          "DOMAIN_RELEASE_FAILED",
          item.domain,
          customerSafeVendorDetail(error, "this domain could not be reclaimed at the provider — it needs a hand", {
            note: "the rest of the teardown completed; this domain is still recorded as held and an operator must release it",
          }),
        );
      },
    },
  );

  // Summed over the domains this teardown actually RECLAIMED. Deliberately NOT
  // read back as `SUM(ledger_entries WHERE kind='liability')`: that is the
  // tenant's LIFETIME liability, and `clearTeardownRecord` keeps the historical
  // rows across a reactivation on purpose — so a second teardown would report
  // the first one's liability again. This field describes THIS reclaim.
  const annualDomainLiabilityCents = domainOutcome.results.reduce((sum, liability) => sum + liability, 0);

  // 2. Release ALL this tenant's mailboxes back to the vendor (shared helper,
  //    CLAUDE.md rule c) — released_at marks the reclaim + deliv_status='paused'
  //    stops the tick's capacity picker immediately, and the G4 account slot
  //    counter is decremented by the real plan-slot mailboxes released. The
  //    revoke-before-mark crash-safety ordering lives in releaseMailboxes.
  const { releasedCount: mailboxesReleased } = await releaseMailboxes(ctx, {}, engineClient);

  // 3. Stop all campaigns (reuse the existing pause-all path — CLAUDE.md rule c).
  const campaignsStopped = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM campaigns WHERE tenant_id = ? AND status = 'active'`,
      ctx.tenantId,
    )
    .one().n;
  pauseAllCampaigns(ctx);

  const summary: TeardownSummary = {
    reason: opts.reason,
    effective: opts.effective,
    // What was actually reclaimed, not what was attempted: a domain whose
    // vendor release failed is still held, still recorded, and must not be
    // counted here (the field's own doc says "reclaimed").
    domainsReleased: domainOutcome.results.length,
    mailboxesReleased,
    campaignsStopped,
    annualDomainLiabilityCents,
    ts: now,
  };

  ctx.sql.exec(
    `INSERT INTO teardown_records
       (tenant_id, reason, effective, domains_released, mailboxes_released, campaigns_stopped, annual_domain_liability_cents, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.tenantId,
    summary.reason,
    summary.effective,
    summary.domainsReleased,
    summary.mailboxesReleased,
    summary.campaignsStopped,
    summary.annualDomainLiabilityCents,
    summary.ts,
  );

  return summary;
}

export interface CancelResult {
  alreadyCanceled: boolean;
  billingState: string;
  /** 'immediate' | 'end_of_period' — the requested billing-cancellation timing. */
  effective: string;
  /** The infra reclaim summary. `null` for an END-OF-PERIOD cancel: teardown is
   *  DEFERRED to the period boundary (the paid-through period keeps infra live)
   *  — see the cancelTenant doc. Non-null only for an immediate cancel. */
  teardown: TeardownSummary | null;
}

/**
 * Voluntary cancellation (POST /cancel).
 *
 *  - immediate:true  -> billing_state='canceled' AND teardown NOW (the customer
 *    gave up the remaining paid period, so we reclaim infra immediately).
 *  - immediate:false (default) -> billing_state='canceling' ONLY. Teardown is
 *    DEFERRED to the end of the paid period (adversarial panel-03 finding #7):
 *    the OLD code tore everything down immediately while the response claimed
 *    'effective:end_of_period', so the customer paid for a period during which
 *    they had zero infra. The infra now stays LIVE until the period actually
 *    elapses; the tick/sweep/setup freeze ('canceling' is a frozen state) stops
 *    any NEW spend meanwhile. Reclaiming at the boundary is a DO-alarm / D2 cron
 *    reaper job wired at activation (B2) — noted, not built here.
 *
 * Idempotent: once a teardown record exists (immediate cancel), a re-cancel
 * returns it without re-releasing anything. A repeated end-of-period cancel is
 * likewise a no-op re-flip of 'canceling'.
 */
export async function cancelTenant(ctx: TenantContext, input: { immediate: boolean }): Promise<CancelResult> {
  const existing = readTeardownRecord(ctx);
  if (existing) {
    const state = ctx.sql
      .exec<{ billing_state: string }>(`SELECT billing_state FROM tenant_profile WHERE id = ?`, ctx.tenantId)
      .one().billing_state;
    return { alreadyCanceled: true, billingState: state, effective: existing.effective, teardown: existing };
  }

  const billingState = input.immediate ? "canceled" : "canceling";
  const effective = input.immediate ? "immediate" : "end_of_period";
  ctx.sql.exec(`UPDATE tenant_profile SET billing_state = ? WHERE id = ?`, billingState, ctx.tenantId);

  // End-of-period: DEFER teardown — infra stays live through the paid period.
  if (!input.immediate) {
    return { alreadyCanceled: false, billingState, effective, teardown: null };
  }

  const teardown = await teardownTenant(ctx, { reason: "voluntary_cancel", effective });
  return { alreadyCanceled: false, billingState, effective, teardown };
}

export interface TerminateResult {
  suspended: boolean;
  alreadyTornDown: boolean;
  teardown: TeardownSummary;
}

/**
 * Abuse offboarding (POST /admin/tenants/:id/terminate) — the terminal rung of
 * the AUP consequence ladder. Immediately suspends the tenant (status ->
 * 'suspended', which the tick's freeze guard reads to stop all sends) and
 * reclaims its infra via the SAME teardown path #1 uses. The enforcement_actions
 * audit row (reason + evidence) is written by the admin route in D1 — the DO
 * never writes D1 (engine/ops-summary.ts invariant). Suppression lists survive
 * (teardownTenant never deletes them).
 */
export async function terminateTenant(ctx: TenantContext): Promise<TerminateResult> {
  const alreadyTornDown = readTeardownRecord(ctx) !== null;
  suspendTenant(ctx, "terminate");
  const teardown = await teardownTenant(ctx, { reason: "abuse_terminate", effective: "immediate" });
  return { suspended: true, alreadyTornDown, teardown };
}
