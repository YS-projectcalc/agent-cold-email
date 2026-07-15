// D2/D6 (brief) — the sweep/digest logic shared by the on-demand admin
// routes (routes/admin-ops.ts) AND the cron `scheduled()` handler
// (../scheduled.ts), so cron never re-implements what the HTTP route already
// does (CLAUDE.md rule c). Every function here takes `env` + iterates the D1
// tenants_index, dispatching into each tenant's own DO via RPC — see
// admin/README.md for why this is the aggregation boundary.

import { countWaitlistEmails, lookupTenantContactEmail } from "../db.js";
import type { Env } from "../env.js";
import { escapeHtml } from "../html-escape.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import { newId } from "../schema.js";
import { countSupportTicketsByStatus, countTerminatedTenants, insertDunningEventIfNew, listAllTenantIds } from "./db.js";
import { decideDunningAction } from "./dunning.js";

export interface DunningSweepResult {
  tenantId: string;
  cycle: number;
  action: string;
  applied: boolean;
}

export interface DunningSweepSummary {
  scannedTenants: number;
  pastDueTenants: number;
  results: DunningSweepResult[];
}

/** D2 dunning sweep — scans every tenant, actions only the 'past_due' ones,
 * idempotent per (tenant, failure-count cycle). On a NEWLY-applied suspend it
 * emails the tenant a plain honest notice + the founder a copy via the
 * OpsMailer (`mailer` is injectable for tests; production builds a real/dark
 * one). Email failure NEVER blocks the suspend — the suspend commits first. */
export async function runDunningSweep(
  env: Env,
  nowMs: number,
  mailer: OpsMailer = createOpsMailer(env),
): Promise<DunningSweepSummary> {
  const tenantIds = await listAllTenantIds(env);
  const results: DunningSweepResult[] = [];

  for (const tenantId of tenantIds) {
    const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
    const summary = await stub.opsSummary(nowMs);
    if (summary.billingState !== "past_due") continue;

    const cycle = summary.billingFailureCount;
    // A5: a permanent decline code makes this suspend immediately, regardless
    // of cycle count (see admin/dunning.ts).
    const action = decideDunningAction(cycle, summary.lastDeclineCode);
    const applied = await insertDunningEventIfNew(env, {
      id: newId("dun"),
      tenantId,
      cycle,
      action,
      detail: { billingFailureCount: cycle, plan: summary.plan, declineCode: summary.lastDeclineCode },
      ts: nowMs,
    });
    if (applied && action === "suspend") {
      // Suspend commits FIRST; the notice is strictly best-effort after it.
      await stub.suspendForDunning();
      await sendDunningSuspendNotice(env, mailer, { tenantId, brand: summary.brand, cycle, declineCode: summary.lastDeclineCode });
    }
    results.push({ tenantId, cycle, action, applied });
  }

  return { scannedTenants: tenantIds.length, pastDueTenants: results.length, results };
}

/**
 * Best-effort dunning-suspend notification: a plain honest notice to the
 * tenant's contact email (from D1 — captured at signup, migrations/0007) plus
 * a founder copy. If no contact email is on file (a tenant that predates the
 * column, or the test-only mintTenant path) the tenant notice is FLAGGED, not
 * faked — the founder copy still goes out and says so. Every send is wrapped:
 * a dark/unconfigured OpsMailer must never break the sweep.
 */
async function sendDunningSuspendNotice(
  env: Env,
  mailer: OpsMailer,
  params: { tenantId: string; brand: string; cycle: number; declineCode: string | null },
): Promise<void> {
  const { tenantId, brand, cycle, declineCode } = params;
  let contactEmail: string | null = null;
  try {
    contactEmail = await lookupTenantContactEmail(env, tenantId);
  } catch (err) {
    console.error(`dunning notice: contact-email lookup failed for tenant ${tenantId}`, err);
  }

  if (contactEmail) {
    const text =
      `Your coldrig account "${brand}" has been suspended after ${cycle} failed payment attempt(s).\n\n` +
      `Sending is paused. To restore your account, update your payment method and complete checkout again — ` +
      `it reactivates automatically once payment succeeds.\n\n` +
      `If you believe this is a mistake, reply to this email and it will reach our team.`;
    await trySendNotice(mailer, {
      to: contactEmail,
      subject: `[coldrig] Your account "${brand}" has been suspended for non-payment`,
      text,
      html: `<p>Your coldrig account <strong>${escapeHtml(brand)}</strong> has been suspended after ${cycle} failed payment attempt(s).</p>` +
        `<p>Sending is paused. To restore your account, update your payment method and complete checkout again — it reactivates automatically once payment succeeds.</p>` +
        `<p>If you believe this is a mistake, reply to this email and it will reach our team.</p>`,
    });
  }

  if (env.OPS_ALERT_EMAIL) {
    const notified = contactEmail ? `tenant notified at ${contactEmail}` : `NO contact email on file — tenant NOT notified (flag)`;
    const text =
      `Tenant "${brand}" (${tenantId}) was suspended by the dunning sweep.\n` +
      `Cycle: ${cycle}. Decline code: ${declineCode ?? "none/unknown"}.\n` +
      `${notified}.`;
    await trySendNotice(mailer, {
      to: env.OPS_ALERT_EMAIL,
      subject: `[coldrig] tenant "${brand}" suspended (dunning)`,
      text,
      html: `<p>Tenant <strong>${escapeHtml(brand)}</strong> (<code>${escapeHtml(tenantId)}</code>) was suspended by the dunning sweep.</p>` +
        `<p>Cycle: ${cycle}. Decline code: ${escapeHtml(declineCode ?? "none/unknown")}.</p>` +
        `<p>${escapeHtml(notified)}.</p>`,
    });
  }
}

async function trySendNotice(mailer: OpsMailer, msg: { to: string; subject: string; text: string; html: string }): Promise<void> {
  try {
    await mailer.send(msg);
  } catch (err) {
    console.error(`dunning notice: send to ${msg.to} failed (dark or transient)`, err);
  }
}

export interface DeliverabilitySweepAllSummary {
  tenantsSwept: number;
  errors: number;
}

/** Runs the deliverability monitor->decide->act loop for EVERY tenant — the cron lane (no send scheduling, that's tick()/B2). */
export async function runDeliverabilitySweepAllTenants(env: Env): Promise<DeliverabilitySweepAllSummary> {
  const tenantIds = await listAllTenantIds(env);
  let errors = 0;
  for (const tenantId of tenantIds) {
    try {
      const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
      await stub.deliverabilitySweep();
    } catch (err) {
      // One tenant's failure must not abort the sweep for every other tenant.
      errors++;
      console.error(`deliverability sweep failed for tenant ${tenantId}`, err);
    }
  }
  return { tenantsSwept: tenantIds.length, errors };
}

export interface OpsDigest {
  windowHours: number;
  tenants: { total: number; activeByPlan: Record<string, number> };
  mrrCents: number;
  totalUsageCents: number;
  provisioningFailureCount: number;
  deliverability: { pausedMailboxesTotal: number; burningDomainsTotal: number; actionsInWindow: number };
  support: { open: number; escalated: number };
  pastDueCount: number;
  /** D5 lifecycle health — canceled/terminated/disputed tenant counts + total annual-domain liability (integer cents). */
  lifecycle: { canceled: number; terminated: number; disputed: number; annualDomainLiabilityCents: number };
  /** C6 — total durable waitlist leads (adversarial panel-03 finding #9: owner visibility into the funnel). */
  waitlist: { count: number };
  watchdogAlerts: string[];
}

/** D6 — the owner's single cross-tenant business-health rollup (SPEC.md §0.10). */
export async function buildOpsDigest(env: Env, nowMs: number, windowHours: number): Promise<OpsDigest> {
  const sinceMs = nowMs - windowHours * 60 * 60 * 1000;
  const tenantIds = await listAllTenantIds(env);
  const summaries = await Promise.all(
    tenantIds.map((id) => env.TENANT.get(env.TENANT.idFromName(id)).opsSummary(sinceMs)),
  );

  const activeByPlan: Record<string, number> = {};
  let mrrCents = 0;
  let totalUsageCents = 0;
  let pastDueCount = 0;
  let pausedMailboxesTotal = 0;
  let burningDomainsTotal = 0;
  let deliverabilityActionsInWindow = 0;
  let canceledCount = 0;
  let disputedCount = 0;
  let annualDomainLiabilityCents = 0;

  for (const s of summaries) {
    if (s.status === "active") activeByPlan[s.plan] = (activeByPlan[s.plan] ?? 0) + 1;
    mrrCents += s.mrrCents;
    totalUsageCents += s.usageCents;
    if (s.billingState === "past_due") pastDueCount++;
    // 'canceling' (end-of-period) and 'canceled' (immediate / Stripe-finalized)
    // both count as lifecycle-canceled for the owner's view.
    if (s.billingState === "canceling" || s.billingState === "canceled") canceledCount++;
    if (s.billingState === "disputed") disputedCount++;
    annualDomainLiabilityCents += s.annualDomainLiabilityCents;
    pausedMailboxesTotal += s.deliverability.pausedMailboxes;
    burningDomainsTotal += s.deliverability.burningDomains;
    deliverabilityActionsInWindow += s.actionsInWindow.paused + s.actionsInWindow.replaced;
  }

  // Terminated tenants come from the D1 enforcement_actions audit log (an
  // abuse TERMINATE is orthogonal to billing_state — see admin/db.ts).
  const terminatedCount = await countTerminatedTenants(env);
  const support = await countSupportTicketsByStatus(env);
  const waitlistCount = await countWaitlistEmails(env);

  // Watchdog alerts — simple threshold-crossing prose, not a separate
  // alerting system (YAGNI, CLAUDE.md rule i). "Stuck jobs" (provisioning
  // sagas) has no signal to alert on yet: B2's resumable alarm-driven sagas
  // aren't built (ROADMAP.md), so provisioningFailureCount is honestly 0
  // rather than fabricated.
  const watchdogAlerts: string[] = [];
  if (pausedMailboxesTotal > 0) {
    watchdogAlerts.push(`${pausedMailboxesTotal} mailbox(es) paused by the deliverability loop across all tenants`);
  }
  if (pastDueCount > 0) {
    watchdogAlerts.push(`${pastDueCount} tenant(s) past_due — run POST /admin/ops/dunning-sweep`);
  }
  if (support.escalated > 0) {
    watchdogAlerts.push(`${support.escalated} support ticket(s) escalated, awaiting owner review`);
  }
  if (disputedCount > 0) {
    watchdogAlerts.push(`${disputedCount} tenant(s) frozen by an open chargeback dispute`);
  }

  return {
    windowHours,
    tenants: { total: tenantIds.length, activeByPlan },
    mrrCents,
    totalUsageCents,
    provisioningFailureCount: 0,
    deliverability: { pausedMailboxesTotal, burningDomainsTotal, actionsInWindow: deliverabilityActionsInWindow },
    support,
    pastDueCount,
    lifecycle: { canceled: canceledCount, terminated: terminatedCount, disputed: disputedCount, annualDomainLiabilityCents },
    waitlist: { count: waitlistCount },
    watchdogAlerts,
  };
}
