import { CapacityPendingError, isPaidPlanTier, RegistrarUnarmedError, type SetupInfrastructureInput } from "@coldstart/shared";
import { newId } from "../schema.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { TenantContext } from "../tenant-context.js";
import { reportUsageToStripeIfConfigured } from "./billing.js";
import { assertNotLifecycleFrozen } from "./billing-state.js";
import { assertBrandOwnership } from "./brand-guard.js";
import { gatherMailboxHealth } from "./deliverability.js";
import { withRequestIdempotency } from "./idempotency.js";
import { maybePushProvisionedMailbox } from "./mailbox-credential-push.js";
import { computeMailboxWarmupSnapshot } from "./mailbox-state.js";
import { assertWithinProvisioningCap } from "./quota.js";
import { alertRegistrarUnarmed } from "./registrar-alert.js";
import { withSpendCeiling } from "./spend-ceiling.js";
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
    // Gate (c) — provision idempotency via the repo's own withRequestIdempotency
    // (adversary inboxkit-adapters-2026-07-20 finding 3). InboxKit's
    // /mailboxes/buy has no idempotency-key primitive, so a redelivered
    // setup_infrastructure (its outer request-idempotency claim expired mid-run,
    // or the response was lost) would re-buy — a DOUBLE CHARGE on a paid slot.
    // Wrapping the vendor call in withRequestIdempotency keyed by the
    // DETERMINISTIC per-mailbox key makes a re-run return the recorded
    // ProvisionedMailbox WITHOUT a second buy. This is the durable local record
    // that REPLACES the fragile /already exists/i message-substring hack the
    // adapter used to lean on (mailbox-port.ts provision()).
    // G2 money-out site #1 (design §0 inventory) — the mailbox slot buy. The
    // spend reserve composes INSIDE withRequestIdempotency (design §G2 collision
    // note): a replayed provision returns the RECORDED mailbox without re-buying,
    // so it never re-enters withSpendCeiling and never double-reserves — only a
    // true first execution reserves. 'mailbox' consumes one InboxKit plan slot
    // (G4).
    const provisioned = await withRequestIdempotency(ctx, `provision:${provisionIdempotencyKey}`, () =>
      withSpendCeiling(ctx, "mailbox", () =>
        ctx.adapters.mailbox.provision(opts.domain, localPart, provisionIdempotencyKey),
      ),
    );
    // G2 money-out site #2 — the warmup add-on. Its cost is already priced into
    // COST_MAILBOX_CENTS at the provision reserve above (spendCostCents's 'warmup'
    // branch reserves 0), so this wrap is for choke-point completeness (no
    // money-out vendor call escapes the enumerated inventory), not a second charge.
    const warmup = await withSpendCeiling(ctx, "warmup", () =>
      ctx.adapters.mailbox.startWarmup(provisioned.email, `warmup:${ctx.tenantId}:${provisioned.email}`),
    );

    const day = computeWarmupDay(warmup.startedAt, now);
    ctx.sql.exec(
      // poll_cursor starts at -1 (never-polled sentinel, engine.ts's
      // first-contact branch) so runPollInbox's first poll for a brand-new
      // mailbox initializes the cursor at the mailbox's current high-water
      // WITHOUT fetching history, instead of the column's own DEFAULT 0 (an
      // ordinary incremental cursor since the round-2 fix, not a sentinel).
      `INSERT INTO mailboxes
         (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at, poll_cursor, slot_counted)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, -1, ?)`,
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
      // G4 — record whether this consumed a REAL InboxKit plan slot (the
      // withSpendCeiling reserve above incremented vendor_slot_state iff the
      // bundle is real). Read at teardown to decrement the slot counter precisely.
      ctx.adapters.kind === "real" ? 1 : 0,
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

    // Self-serve I3 credential push (F6): record-then-push the just-provisioned
    // mailbox's credentials to the engine. INERT unless the vendor+engine are
    // armed AND this is a real vendor mailbox (never sandbox) — so it is a no-op
    // in the default build and every existing test. A push failure is swallowed
    // (the mailbox is durably recorded 'pending'; the reconcile sweep retries),
    // so it can never fail a provision whose vendor spend already happened.
    await maybePushProvisionedMailbox(ctx, provisioned);
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

  // G2 money-out site #3 (design §0 inventory) — the registrar domain purchase.
  // setDns below is config-only (not spend), so it stays unwrapped. When the
  // registrar is unarmed (G5 gate (a)), domain.buy throws RegistrarUnarmedError
  // INSIDE the wrapper → withSpendCeiling releases the reservation and re-throws,
  // so an unarmed registrar never leaks a reservation.
  const purchased = await withSpendCeiling(ctx, "domain", () =>
    ctx.adapters.domain.buy(opts.domain, `buy:${ctx.tenantId}:${domainKey}`),
  );
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
  // Injectable (default a real/dark-per-env OpsMailer) — same pattern as
  // admin/ops-sweep.ts's runDunningSweep / deliverability-actions.ts's
  // runDeliverabilitySweep, so a test can assert the gate (a) alert content
  // with a SandboxOpsMailer without any production call site needing to change.
  mailer: OpsMailer = createOpsMailer(ctx.env),
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

  // G5 gate (a) — a real (non-sandbox) tenant whose registrar isn't armed
  // hits RegistrarUnarmedError on the very first vendor touch below
  // (searchLookalikes, before any domain is ever bought — see
  // vendors/real/domain-port.ts). Caught here (not left to fall through to
  // index.ts's generic 500) so the founder gets a same-request alert AND the
  // tenant gets the graceful, distinguishable `registrar_unarmed` HTTP
  // response (index.ts onError) instead of an opaque internal error.
  try {
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
  } catch (err) {
    if (err instanceof CapacityPendingError) {
      // G2/G4 graceful back-pressure — NOT a failure. withSpendCeiling already
      // set the tenant's capacity_pending marker, released the reservation, and
      // fired the one-shot founder alert. Return the job normally (never a 500):
      // the account surfaces capacity_pending via G3, and a later provision
      // retries once the founder raises the ceiling / upgrades the plan. Any
      // domains/mailboxes provisioned before the gate stay provisioned.
      return { jobId: newId("job") };
    }
    if (err instanceof RegistrarUnarmedError) {
      await alertRegistrarUnarmed(ctx, input.primaryDomain, err, mailer);
    }
    throw err;
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
  // Gate (d) — display honesty (adversary inboxkit-adapters-2026-07-20 finding
  // 4): these are VENDOR-REPORTED approximations (InboxKit's coarse
  // health_status enum -> a 0-100 score, and the bounce-rate complement as a
  // placement PROXY — NOT a real inbox-placement test), never first-party
  // measurements. The control loop's burn/pause decisions use local counts
  // ONLY; these two are display-only. The `vendor*` prefix carries that
  // provenance so a consuming agent never treats them as measured (the pre-fix
  // `reputationScore`/`placementRate` names read as first-party truth).
  vendorReputationScore: number;
  vendorPlacementRate: number;
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
      // in the real adapter) — display-only, surfaced under `vendor*` names
      // (gate (d)). On-demand here, NOT on the hot tick path.
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
        vendorReputationScore: vendor.reputationScore,
        vendorPlacementRate: vendor.placementRate,
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
