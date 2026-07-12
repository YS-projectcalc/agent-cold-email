// B6 — the AI deliverability control loop: monitor -> decide (this file) ->
// act (engine/deliverability-actions.ts). SPEC.md §10: the mailbox vendor
// surfaces raw signals (bounces/complaints via EmailPort.poll, reputation via
// MailboxPort.getHealth); OUR loop reacts within the rules — throttle a
// degrading mailbox, pause one crossing Gmail's red line, rotate sending off
// it, and retire+replace a whole burning domain. Honest boundary (SPEC §10):
// this automates the RESPONSE; it cannot change how Gmail/MS judge you.
//
// `evaluate` is a PURE function over already-gathered signals so the decision
// logic is unit-testable in isolation; `gatherMailboxHealth`/`gatherDomainStats`
// assemble those signals from the tenant's own event log (the vendor-fed
// bounce/complaint stream, aggregated exactly as reporting.ts counts events).

import type { TenantContext } from "../tenant-context.js";
import { computeWarmupDay, isSendReady, warmupStatus } from "./warmup.js";

export type DeliverabilityMailboxStatus = "healthy" | "throttled" | "paused";

/**
 * Complaint/bounce RATE as a FRACTION (0-1) — same units as reporting.ts's raw
 * type counts and the MailboxHealth port contract (`complaintRate: // fraction,
 * 0-1`). CRITICAL unit discipline: Gmail's 0.30% spam-complaint red line is
 * **0.003 as a fraction, NOT 0.30**. Every threshold below is a fraction too.
 * The 100x-inflation trap is comparing a percentage (rate*100) against a
 * fraction threshold, or vice-versa — everything here stays in fractions.
 */
export function asRate(count: number, sends: number): number {
  return sends > 0 ? count / sends : 0;
}

export interface DeliverabilityThresholds {
  /** >= this per-mailbox complaint fraction -> PAUSE. Gmail red line = 0.30% = 0.003. */
  hardComplaintRate: number;
  /** >= this per-mailbox complaint fraction -> THROTTLE (well below the red line). */
  warnComplaintRate: number;
  /** >= this per-mailbox bounce fraction -> PAUSE. */
  hardBounceRate: number;
  /** >= this per-mailbox bounce fraction -> THROTTLE. */
  warnBounceRate: number;
  /** >= this DOMAIN-aggregate complaint fraction -> retire + REPLACE_DOMAIN. */
  burnComplaintRate: number;
  /** >= this DOMAIN-aggregate bounce fraction -> retire + REPLACE_DOMAIN. */
  burnBounceRate: number;
  /** Cap a throttled mailbox is dropped to (warmup wk1 level). */
  throttleFloorCap: number;
  /** Below this many sends the rate is statistically meaningless -> take no action. */
  minSampleSends: number;
}

// Grounded in the repo/SPEC rules (§7 caps ~40-50/mbx/day, Gmail 0.30%
// ineligibility; §7/§15 domain burn 8-18%/mo is NORMAL -> auto-retire-replace
// is a feature, so the burn line sits at the top of that band). These are
// built-to-contract defaults; real values are tuned against live Gmail at
// activation (ROADMAP.md hardening-budget rule).
export const DEFAULT_THRESHOLDS: DeliverabilityThresholds = {
  hardComplaintRate: 0.003, // 0.30% — Gmail's delivery-mitigation ineligibility line
  warnComplaintRate: 0.001, // 0.10%
  hardBounceRate: 0.05, // 5%
  warnBounceRate: 0.02, // 2%
  burnComplaintRate: 0.005, // 0.50% domain-wide — the whole domain is compromised
  burnBounceRate: 0.15, // 15% domain-wide — top of the normal 8-18%/mo burn band
  throttleFloorCap: 5,
  minSampleSends: 10,
};

export interface MailboxHealthSignal {
  mailboxId: string;
  email: string;
  domain: string;
  delivStatus: DeliverabilityMailboxStatus;
  warmupStatus: string;
  warmupDay: number;
  dailyCap: number;
  sentToday: number;
  sendReady: boolean;
  sends: number;
  /** HARD (permanent, 5.x.x) bounces only — the count the PAUSE/burn thresholds read (A3). */
  bounces: number;
  complaints: number;
  /** HARD-bounce fraction — soft bounces are deliberately excluded so a transient blip never pauses/burns (A3). */
  bounceRate: number;
  complaintRate: number;
  /** SOFT (transient, 4.x.x) bounces — surfaced for visibility; NEVER feeds a pause/burn/spend decision (A3). */
  softBounces: number;
  softBounceRate: number;
}

export interface DomainStat {
  domainId: string;
  domain: string;
  status: string; // 'active' | 'burning' | 'retired'
  mailboxCount: number;
  sends: number;
  bounces: number;
  complaints: number;
  bounceRate: number;
  complaintRate: number;
}

export type DeliverabilityAction =
  | { type: "THROTTLE"; mailboxId: string; email: string; newCap: number; reason: string }
  | { type: "PAUSE"; mailboxId: string; email: string; reason: string }
  | { type: "ROTATE"; pendingSends: number; healthyTargets: number; reason: string }
  | { type: "REPLACE_DOMAIN"; domainId: string; domain: string; reason: string };

export interface EvaluateContext {
  /** Tenant-wide count of still-pending scheduled sends (drives ROTATE). */
  pendingSends: number;
}

/**
 * PURE decision function — no I/O, no clock, no DB. Given the current health
 * signals + thresholds, returns the actions to take. Idempotent by
 * construction: it never emits PAUSE for an already-paused mailbox, never
 * re-THROTTLEs an already-throttled one, and never re-REPLACEs a domain that is
 * already 'burning'/'retired'. Order matters: domain-burn is decided first so a
 * mailbox on a doomed domain isn't also individually paused (the replace pauses
 * the whole domain), keeping the action log clean.
 */
export function evaluate(
  mailboxes: MailboxHealthSignal[],
  domains: DomainStat[],
  thresholds: DeliverabilityThresholds,
  evalCtx: EvaluateContext,
): DeliverabilityAction[] {
  const actions: DeliverabilityAction[] = [];

  // 1. Domain burn -> retire + replace the whole domain.
  const domainsBeingReplaced = new Set<string>();
  for (const d of domains) {
    if (d.status !== "active") continue; // already burning/retired — idempotent no-op
    if (d.sends < thresholds.minSampleSends) continue;
    if (d.complaintRate >= thresholds.burnComplaintRate || d.bounceRate >= thresholds.burnBounceRate) {
      domainsBeingReplaced.add(d.domain);
      actions.push({
        type: "REPLACE_DOMAIN",
        domainId: d.domainId,
        domain: d.domain,
        reason: `domain burning: complaintRate=${d.complaintRate.toFixed(4)} bounceRate=${d.bounceRate.toFixed(4)} over ${d.sends} sends`,
      });
    }
  }

  // 2. Per-mailbox pause / throttle. A mailbox on a domain being replaced is
  //    left alone here — REPLACE_DOMAIN pauses every mailbox on that domain.
  const newlyPaused = new Set<string>();
  for (const m of mailboxes) {
    if (domainsBeingReplaced.has(m.domain)) continue;
    if (m.delivStatus === "paused") continue; // already paused — idempotent no-op
    if (m.sends < thresholds.minSampleSends) continue;

    if (m.complaintRate >= thresholds.hardComplaintRate || m.bounceRate >= thresholds.hardBounceRate) {
      newlyPaused.add(m.mailboxId);
      actions.push({
        type: "PAUSE",
        mailboxId: m.mailboxId,
        email: m.email,
        reason: `hard threshold crossed: complaintRate=${m.complaintRate.toFixed(4)} bounceRate=${m.bounceRate.toFixed(4)} over ${m.sends} sends`,
      });
    } else if (
      m.delivStatus !== "throttled" &&
      m.dailyCap > thresholds.throttleFloorCap &&
      (m.complaintRate >= thresholds.warnComplaintRate || m.bounceRate >= thresholds.warnBounceRate)
    ) {
      actions.push({
        type: "THROTTLE",
        mailboxId: m.mailboxId,
        email: m.email,
        newCap: thresholds.throttleFloorCap,
        reason: `warn threshold crossed: complaintRate=${m.complaintRate.toFixed(4)} bounceRate=${m.bounceRate.toFixed(4)} — cap ${m.dailyCap}->${thresholds.throttleFloorCap}`,
      });
    }
  }

  // 3. ROTATE: if this sweep took any mailbox out of service (pause or a whole
  //    domain replace) and sends are still pending, record the reroute. Pending
  //    sends aren't pre-bound to a mailbox — the tick's capacity picker (which
  //    excludes paused mailboxes) realizes the reroute — so ROTATE is a
  //    fleet-level decision record, and healthyTargets says whether there is
  //    somewhere to reroute to right now (0 = sends defer until a replacement warms).
  const tookOffline = newlyPaused.size > 0 || domainsBeingReplaced.size > 0;
  if (tookOffline && evalCtx.pendingSends > 0) {
    const healthyTargets = mailboxes.filter(
      (m) =>
        m.delivStatus !== "paused" &&
        !newlyPaused.has(m.mailboxId) &&
        !domainsBeingReplaced.has(m.domain),
    ).length;
    actions.push({
      type: "ROTATE",
      pendingSends: evalCtx.pendingSends,
      healthyTargets,
      reason: `rerouting ${evalCtx.pendingSends} pending send(s) away from ${newlyPaused.size} paused mailbox(es)/${domainsBeingReplaced.size} replaced domain(s)`,
    });
  }

  return actions;
}

interface MailboxRow {
  id: string;
  email: string;
  domain: string;
  deliv_status: string;
  daily_cap: number;
  sent_today: number;
  warmup_started_at: number;
  [column: string]: SqlStorageValue;
}

/**
 * Assembles per-mailbox health signals from the tenant's own event log — the
 * vendor-fed bounce/complaint stream (EmailPort.poll -> reply-processor ->
 * events), aggregated the same way reporting.ts counts events. Bounces and
 * complaints are attributed to the exact sending mailbox by joining the event's
 * message id back to the scheduled_send that produced it (message ids are
 * unique per send). Synchronous / DB-only so it is cheap enough to run on every
 * tick before scheduling.
 */
export function gatherMailboxHealth(ctx: TenantContext): MailboxHealthSignal[] {
  const now = ctx.clock.now();

  const mailboxes = ctx.sql
    .exec<MailboxRow>(
      `SELECT id, email, domain, deliv_status, daily_cap, sent_today, warmup_started_at
       FROM mailboxes WHERE tenant_id = ?`,
      ctx.tenantId,
    )
    .toArray();

  const sendsByMailbox = new Map<string, number>();
  for (const row of ctx.sql
    .exec<{ mailbox_id: string; n: number }>(
      `SELECT mailbox_id, COUNT(*) as n FROM scheduled_sends
       WHERE tenant_id = ? AND status = 'sent' AND mailbox_id IS NOT NULL
       GROUP BY mailbox_id`,
      ctx.tenantId,
    )
    .toArray()) {
    sendsByMailbox.set(row.mailbox_id, row.n);
  }

  // A3: 'bounce' = HARD only (soft bounces are recorded as a distinct
  // 'soft_bounce' type by reply-processor.ts). Hard bounces + complaints feed
  // the pause/burn thresholds; soft bounces are counted separately, for
  // visibility only, and NEVER drive an action.
  const bouncesByMailbox = new Map<string, number>();
  const softBouncesByMailbox = new Map<string, number>();
  const complaintsByMailbox = new Map<string, number>();
  for (const row of ctx.sql
    .exec<{ mailbox_id: string; type: string; n: number }>(
      `SELECT ss.mailbox_id as mailbox_id, e.type as type, COUNT(*) as n
       FROM events e
       JOIN scheduled_sends ss ON ss.tenant_id = e.tenant_id AND ss.message_id = e.message_id
       WHERE e.tenant_id = ? AND e.type IN ('bounce', 'soft_bounce', 'complaint') AND ss.mailbox_id IS NOT NULL
       GROUP BY ss.mailbox_id, e.type`,
      ctx.tenantId,
    )
    .toArray()) {
    if (row.type === "bounce") bouncesByMailbox.set(row.mailbox_id, row.n);
    else if (row.type === "soft_bounce") softBouncesByMailbox.set(row.mailbox_id, row.n);
    else complaintsByMailbox.set(row.mailbox_id, row.n);
  }

  return mailboxes.map((m) => {
    const sends = sendsByMailbox.get(m.id) ?? 0;
    const bounces = bouncesByMailbox.get(m.id) ?? 0;
    const softBounces = softBouncesByMailbox.get(m.id) ?? 0;
    const complaints = complaintsByMailbox.get(m.id) ?? 0;
    const warmupDay = computeWarmupDay(m.warmup_started_at, now);
    return {
      mailboxId: m.id,
      email: m.email,
      domain: m.domain,
      delivStatus: (m.deliv_status as DeliverabilityMailboxStatus) ?? "healthy",
      warmupStatus: warmupStatus(warmupDay),
      warmupDay,
      dailyCap: m.daily_cap,
      sentToday: m.sent_today,
      sendReady: isSendReady(warmupDay),
      sends,
      bounces,
      complaints,
      bounceRate: asRate(bounces, sends),
      complaintRate: asRate(complaints, sends),
      softBounces,
      softBounceRate: asRate(softBounces, sends),
    };
  });
}

/** Aggregates per-mailbox signals up to per-domain stats (+ the domain's current status). */
export function gatherDomainStats(ctx: TenantContext, mailboxes: MailboxHealthSignal[]): DomainStat[] {
  const domainRows = ctx.sql
    .exec<{ id: string; domain: string; status: string }>(
      `SELECT id, domain, status FROM domains WHERE tenant_id = ?`,
      ctx.tenantId,
    )
    .toArray();

  return domainRows.map((d) => {
    const boxes = mailboxes.filter((m) => m.domain === d.domain);
    const sends = boxes.reduce((s, m) => s + m.sends, 0);
    const bounces = boxes.reduce((s, m) => s + m.bounces, 0);
    const complaints = boxes.reduce((s, m) => s + m.complaints, 0);
    return {
      domainId: d.id,
      domain: d.domain,
      status: d.status,
      mailboxCount: boxes.length,
      sends,
      bounces,
      complaints,
      bounceRate: asRate(bounces, sends),
      complaintRate: asRate(complaints, sends),
    };
  });
}
