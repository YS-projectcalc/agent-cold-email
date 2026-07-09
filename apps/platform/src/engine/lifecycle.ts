// D5 tenant lifecycle — voluntary cancellation, abuse-offboarding teardown,
// and the shared infra reclaim path both drive. SPEC.md §7 (isolation: every
// customer owns dedicated domains/mailboxes — a teardown reclaims exactly that
// tenant's resources, never a shared pool) + site/aup.html §7-§8 (the AUP
// consequence ladder, enforced in code not paper). Stripe stays the billing
// source of truth (ARCHITECTURE.md #3); these functions mirror cancellation
// onto tenant_profile.billing_state and reclaim the provisioned infra.

import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { pauseAllCampaigns } from "./campaigns.js";
import { suspendTenant } from "./ops-summary.js";
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
  domainsReleased: number;
  mailboxesReleased: number;
  campaignsStopped: number;
  /** Unconsumed remainder of the tenant's annual domain registrations we eat by reclaiming mid-term (integer cents). */
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

/**
 * Reclaims a tenant's dedicated infrastructure: release every domain +
 * mailbox back to the vendor (DomainPort/MailboxPort.release — sandbox executes
 * it now, the real adapter calls the vendor at activation), stop all campaigns,
 * and book the annual-domain liability. IDEMPOTENT: the teardown_records row is
 * the anchor — a second call reads it and returns the existing summary without
 * re-releasing anything (re-cancel / re-terminate is a no-op). Suppression
 * lists are DELIBERATELY untouched — CAN-SPAM opt-outs survive account
 * teardown (a legal obligation the abuse-offboarding path must honor).
 */
export async function teardownTenant(
  ctx: TenantContext,
  opts: { reason: TeardownReason; effective: string },
): Promise<TeardownSummary> {
  const existing = readTeardownRecord(ctx);
  if (existing) return existing;

  const now = ctx.clock.now();

  // 1. Release domains (belt-and-suspenders tenant scope even though a DO is
  //    single-tenant — CLAUDE.md rule h). Book each domain's remaining-term
  //    liability as its own idempotent ledger row (keyed on source_send_id so a
  //    retry can never double-book) — the ledger SUM is the authoritative total
  //    the owner digest reads.
  const domains = ctx.sql
    .exec<{ id: string; domain: string; purchased_at: number }>(
      `SELECT id, domain, purchased_at FROM domains WHERE tenant_id = ? AND status != 'released'`,
      ctx.tenantId,
    )
    .toArray();

  let annualDomainLiabilityCents = 0;
  for (const d of domains) {
    await ctx.adapters.domain.release(d.domain, `release-domain:${ctx.tenantId}:${d.id}`);
    const liability = computeDomainLiabilityCents(d.purchased_at, now);
    annualDomainLiabilityCents += liability;
    ctx.sql.exec(
      `UPDATE domains SET status = 'released' WHERE id = ? AND tenant_id = ?`,
      d.id,
      ctx.tenantId,
    );
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
  }

  // 2. Release mailboxes back to the vendor. released_at marks the reclaim;
  //    deliv_status='paused' stops the tick's capacity picker from sending
  //    from them immediately (the send-side kill — see engine/tick.ts).
  const mailboxes = ctx.sql
    .exec<{ id: string; email: string }>(
      `SELECT id, email FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`,
      ctx.tenantId,
    )
    .toArray();

  for (const m of mailboxes) {
    await ctx.adapters.mailbox.release(m.email, `release-mbx:${ctx.tenantId}:${m.id}`);
    ctx.sql.exec(
      `UPDATE mailboxes SET released_at = ?, deliv_status = 'paused' WHERE id = ? AND tenant_id = ?`,
      now,
      m.id,
      ctx.tenantId,
    );
  }

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
    domainsReleased: domains.length,
    mailboxesReleased: mailboxes.length,
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
