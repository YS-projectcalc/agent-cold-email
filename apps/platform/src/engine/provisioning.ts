import { isPaidPlanTier, type SetupInfrastructureInput } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { reportUsageToStripeIfConfigured } from "./billing.js";
import { assertNotLifecycleFrozen } from "./billing-state.js";
import { assertBrandOwnership } from "./brand-guard.js";
import { gatherMailboxHealth } from "./deliverability.js";
import { computeMailboxWarmupSnapshot } from "./mailbox-state.js";
import { assertWithinProvisioningCap } from "./quota.js";
import { computeWarmupDay, epochDay, warmupDailyCap, warmupStatus } from "./warmup.js";

// Per-mailbox/mo metering fee (SPEC.md §18 ballpark fully-loaded cost) —
// paid tiers only. Demo/free is structurally 0-real-spend (ARCHITECTURE.md
// #8); sandbox mailboxes are still provisioned there for exploration, but no
// fee accrues (see e2e.test.ts's demo-tenant usageCents assertion).
const MAILBOX_MONTHLY_FEE_CENTS = 600;

export function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "hello";
}

/**
 * Provisions `inboxesEach` PLATFORM-OWNED mailboxes on an ALREADY-OWNED
 * domain row (vendor provision + startWarmup + insert mailbox row +
 * per-mailbox/mo metering on paid tiers). Extracted from
 * `provisionDomainWithMailboxes` (CLAUDE.md rule c — no duplicated logic) so
 * SPEC.md §20.6's shape (a) — a managed mailbox provisioned on a BYO domain
 * (`engine/byo-intake.ts`'s `requestManagedByoMailboxes`) — reuses the exact
 * same vendor-call + warmup-bootstrap + metering sequence as the existing
 * lookalike-domain flow and REPLACE_DOMAIN, instead of a parallel
 * implementation. `domainKey` namespaces idempotency keys (distinct domains
 * never collide); `domainOrdinal` only affects the generated local-part
 * numbering (cosmetic — uniqueness only requires the local part be unique
 * WITHIN this one domain, which the mailboxIndex loop already guarantees).
 */
export async function provisionMailboxesForDomain(
  ctx: TenantContext,
  opts: { domainId: string; domain: string; domainKey: string; domainOrdinal: number; personaSlug: string; inboxesEach: number },
): Promise<string[]> {
  const now = ctx.clock.now();
  const mailboxEmails: string[] = [];

  for (let mailboxIndex = 0; mailboxIndex < opts.inboxesEach; mailboxIndex++) {
    const localPart = `${opts.personaSlug}${opts.domainOrdinal + 1}${mailboxIndex + 1}`;
    const provisionIdempotencyKey = `mbx:${ctx.tenantId}:${opts.domainKey}:${localPart}`;
    const provisioned = await ctx.adapters.mailbox.provision(opts.domain, localPart, provisionIdempotencyKey);
    const warmup = await ctx.adapters.mailbox.startWarmup(
      provisioned.email,
      `warmup:${ctx.tenantId}:${provisioned.email}`,
    );

    const day = computeWarmupDay(warmup.startedAt, now);
    ctx.sql.exec(
      // poll_cursor starts at -1 (never-polled sentinel, engine.ts's
      // first-contact branch) so runPollInbox's first poll for a brand-new
      // mailbox initializes the cursor at the mailbox's current high-water
      // WITHOUT fetching history, instead of the column's own DEFAULT 0 (an
      // ordinary incremental cursor since the round-2 fix, not a sentinel).
      `INSERT INTO mailboxes
         (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at, poll_cursor)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, -1)`,
      newId("mbx"),
      ctx.tenantId,
      opts.domainId,
      opts.domain,
      provisioned.email,
      warmupDailyCap(day),
      epochDay(now),
      warmupStatus(day),
      warmup.startedAt,
      now,
    );
    mailboxEmails.push(provisioned.email);

    // Per-mailbox/mo metering — paid tiers only (see MAILBOX_MONTHLY_FEE_CENTS
    // comment above). Reuses the SAME idempotency key as mailbox.provision()
    // as the ledger's source_send_id (a generic idempotency anchor, not
    // send-specific — see schema.ts), so a retried/duplicated provisioning
    // call can never double-charge this mailbox.
    if (isPaidPlanTier(ctx.plan)) {
      await ctx.adapters.billing.recordUsage(
        ctx.tenantId,
        "mailbox provisioned (mo)",
        MAILBOX_MONTHLY_FEE_CENTS,
        provisionIdempotencyKey,
      );
      ctx.sql.exec(
        `INSERT OR IGNORE INTO ledger_entries (id, tenant_id, kind, amount_cents, description, ts, source_send_id)
         VALUES (?, ?, 'usage', ?, 'mailbox provisioned (mo)', ?, ?)`,
        newId("ledg"),
        ctx.tenantId,
        MAILBOX_MONTHLY_FEE_CENTS,
        now,
        provisionIdempotencyKey,
      );
      await reportUsageToStripeIfConfigured(ctx, 1, provisionIdempotencyKey);
    }
  }

  return mailboxEmails;
}

/**
 * Provisions ONE domain + its mailboxes: buy → DNS → insert domain row → for
 * each mailbox provision + startWarmup + insert mailbox row (+ per-mailbox/mo
 * metering on paid tiers). The single implementation shared by
 * setup_infrastructure (initial provisioning) and the deliverability control
 * loop's REPLACE_DOMAIN (burn replacement) — CLAUDE.md rule c (no duplicated
 * logic). Idempotency keys are namespaced by `domainKey` (`domain#index`) so
 * distinct domains never collide.
 */
export async function provisionDomainWithMailboxes(
  ctx: TenantContext,
  opts: { domain: string; domainIndex: number; personaSlug: string; inboxesEach: number },
): Promise<{ domainId: string; domain: string; mailboxEmails: string[] }> {
  const domainKey = `${opts.domain}#${opts.domainIndex}`;

  const purchased = await ctx.adapters.domain.buy(opts.domain, `buy:${ctx.tenantId}:${domainKey}`);
  await ctx.adapters.domain.setDns(opts.domain, `dns:${ctx.tenantId}:${domainKey}`);

  const domainId = newId("dom");
  ctx.sql.exec(
    `INSERT INTO domains (id, tenant_id, domain, status, purchased_at) VALUES (?, ?, ?, 'active', ?)`,
    domainId,
    ctx.tenantId,
    purchased.domain,
    purchased.purchasedAt,
  );

  const mailboxEmails = await provisionMailboxesForDomain(ctx, {
    domainId,
    domain: purchased.domain,
    domainKey,
    domainOrdinal: opts.domainIndex,
    personaSlug: opts.personaSlug,
    inboxesEach: opts.inboxesEach,
  });

  return { domainId, domain: purchased.domain, mailboxEmails };
}

/**
 * setup_infrastructure — SPEC.md §6 / brief signature. Buys N lookalike
 * domains, DNS them, provisions `inboxesEach` mailboxes per domain, starts
 * warmup. Runs synchronously under the hood in B0 (the sandbox vendor calls
 * are in-memory and instant); the async resumable saga (DO alarms, retries)
 * is B2 scope. The returned jobId reflects the intent's async shape without
 * yet being backed by a tracked job record.
 */
export async function runSetupInfrastructure(
  ctx: TenantContext,
  input: SetupInfrastructureInput,
): Promise<{ jobId: string }> {
  // Lifecycle freeze — BEFORE any spend. A suspended/disputed/canceled tenant
  // must not provision fresh infra (real registrar/mailbox spend at activation
  // on an account we deliberately froze — adversarial panel-03 finding #5).
  assertNotLifecycleFrozen(ctx, "setup_infrastructure");

  // Lookalike third-party-brand hard-reject — BEFORE any searchLookalikes/buy
  // (ARCHITECTURE.md #8 "enforced in code"). Throws ValidationError -> HTTP 400.
  assertBrandOwnership({ brand: input.brand, primaryDomain: input.primaryDomain });

  // Plan quota / provisioning-cap guard (B1 brief) — BEFORE any spend.
  assertWithinProvisioningCap(ctx, { domains: input.domains, mailboxes: input.domains * input.inboxesEach });

  ctx.sql.exec(
    `UPDATE tenant_profile SET brand = ?, primary_domain = ?, physical_address = ?, sender_identity = ? WHERE id = ?`,
    input.brand,
    input.primaryDomain,
    input.physicalAddress,
    input.senderIdentity,
    ctx.tenantId,
  );

  const candidates = await ctx.adapters.domain.searchLookalikes(input.brand, input.primaryDomain, input.domains);
  const personaSlug = slugify(input.persona);

  for (let domainIndex = 0; domainIndex < input.domains; domainIndex++) {
    const candidate = candidates[domainIndex % candidates.length];
    if (!candidate) continue;
    await provisionDomainWithMailboxes(ctx, {
      domain: candidate.domain,
      domainIndex,
      personaSlug,
      inboxesEach: input.inboxesEach,
    });
  }

  return { jobId: newId("job") };
}

export interface MailboxHealthReport {
  email: string;
  domain: string;
  status: string;
  warmupDay: number;
  dailyCap: number;
  sentToday: number;
  sendReady: boolean;
  // B6 deliverability signals surfaced so the customer's agent can see the
  // control loop working: our own throttle/pause state + observed first-party
  // rates (fractions, 0-1) + the vendor-reported reputation/placement.
  delivStatus: string;
  sends: number;
  complaintRate: number;
  bounceRate: number;
  /** Soft (transient 4.x.x) bounce fraction — visible here but never triggers pause/burn (A3). */
  softBounceRate: number;
  reputationScore: number;
  placementRate: number;
  /** SPEC.md §19.2/§19.6 [F7] — last time runPollInbox() polled this mailbox (engine/reply-processor.ts); null before the first poll. Backs the Settings→Mailboxes "last polled" UI claim. */
  lastPolledAt: number | null;
}

export interface InfrastructureStatus {
  domains: number;
  mailboxes: number;
  mailboxHealth: MailboxHealthReport[];
  sendReady: boolean;
}

export async function getInfrastructureStatus(ctx: TenantContext): Promise<InfrastructureStatus> {
  // Read-only: computes the same live warmup dailyCap/sentToday the tick
  // would persist, WITHOUT writing (MCP readOnlyHint: true — see
  // mailbox-state.ts's computeMailboxWarmupSnapshot doc). `s.warmupStatus`
  // below is already freshly computed by gatherMailboxHealth (never read
  // from the possibly-stale DB `status` column), so only dailyCap/sentToday
  // need overriding from the snapshot.
  const warmupSnapshot = computeMailboxWarmupSnapshot(ctx);
  const domainCount = ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE tenant_id = ?`, ctx.tenantId)
    .one().n;

  const signals = gatherMailboxHealth(ctx);
  const mailboxHealth: MailboxHealthReport[] = await Promise.all(
    signals.map(async (s) => {
      // Vendor-reported reputation/placement (SPEC.md §10 raw signal, Inboxkit
      // in the real adapter). On-demand here, NOT on the hot tick path.
      const vendor = await ctx.adapters.mailbox.getHealth(s.email);
      const snapshot = warmupSnapshot.get(s.mailboxId);
      return {
        email: s.email,
        domain: s.domain,
        status: s.warmupStatus,
        warmupDay: s.warmupDay,
        dailyCap: snapshot?.dailyCap ?? s.dailyCap,
        sentToday: snapshot?.sentToday ?? s.sentToday,
        sendReady: s.sendReady,
        delivStatus: s.delivStatus,
        sends: s.sends,
        complaintRate: s.complaintRate,
        bounceRate: s.bounceRate,
        softBounceRate: s.softBounceRate,
        reputationScore: vendor.reputationScore,
        placementRate: vendor.placementRate,
        lastPolledAt: s.lastPolledAt,
      };
    }),
  );

  return {
    domains: domainCount,
    mailboxes: mailboxHealth.length,
    mailboxHealth,
    // Send-readiness ignores paused/throttled state (it's a warmup concept);
    // a paused mailbox still counts as warmed. delivStatus surfaces the pause.
    sendReady: mailboxHealth.length > 0 && mailboxHealth.every((m) => m.sendReady),
  };
}
