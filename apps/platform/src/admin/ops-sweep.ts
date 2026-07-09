// D2/D6 (brief) — the sweep/digest logic shared by the on-demand admin
// routes (routes/admin-ops.ts) AND the cron `scheduled()` handler
// (../scheduled.ts), so cron never re-implements what the HTTP route already
// does (CLAUDE.md rule c). Every function here takes `env` + iterates the D1
// tenants_index, dispatching into each tenant's own DO via RPC — see
// admin/README.md for why this is the aggregation boundary.

import type { Env } from "../env.js";
import { newId } from "../schema.js";
import { countSupportTicketsByStatus, insertDunningEventIfNew, listAllTenantIds } from "./db.js";
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

/** D2 dunning sweep — scans every tenant, actions only the 'past_due' ones, idempotent per (tenant, failure-count cycle). */
export async function runDunningSweep(env: Env, nowMs: number): Promise<DunningSweepSummary> {
  const tenantIds = await listAllTenantIds(env);
  const results: DunningSweepResult[] = [];

  for (const tenantId of tenantIds) {
    const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
    const summary = await stub.opsSummary(nowMs);
    if (summary.billingState !== "past_due") continue;

    const cycle = summary.billingFailureCount;
    const action = decideDunningAction(cycle);
    const applied = await insertDunningEventIfNew(env, {
      id: newId("dun"),
      tenantId,
      cycle,
      action,
      detail: { billingFailureCount: cycle, plan: summary.plan },
      ts: nowMs,
    });
    if (applied && action === "suspend") {
      await stub.suspendForDunning();
    }
    results.push({ tenantId, cycle, action, applied });
  }

  return { scannedTenants: tenantIds.length, pastDueTenants: results.length, results };
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

  for (const s of summaries) {
    if (s.status === "active") activeByPlan[s.plan] = (activeByPlan[s.plan] ?? 0) + 1;
    mrrCents += s.mrrCents;
    totalUsageCents += s.usageCents;
    if (s.billingState === "past_due") pastDueCount++;
    pausedMailboxesTotal += s.deliverability.pausedMailboxes;
    burningDomainsTotal += s.deliverability.burningDomains;
    deliverabilityActionsInWindow += s.actionsInWindow.paused + s.actionsInWindow.replaced;
  }

  const support = await countSupportTicketsByStatus(env);

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

  return {
    windowHours,
    tenants: { total: tenantIds.length, activeByPlan },
    mrrCents,
    totalUsageCents,
    provisioningFailureCount: 0,
    deliverability: { pausedMailboxesTotal, burningDomainsTotal, actionsInWindow: deliverabilityActionsInWindow },
    support,
    pastDueCount,
    watchdogAlerts,
  };
}
