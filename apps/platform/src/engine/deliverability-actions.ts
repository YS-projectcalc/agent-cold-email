// B6 — the ACT half of the deliverability control loop (the DECIDE half is
// engine/deliverability.ts). `applyActions` mutates DO state for each action
// the pure `evaluate` produced; `runDeliverabilitySweep` is the one entry point
// the tick calls each cycle (monitor -> decide -> act) BEFORE scheduling sends.

import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { isLifecycleFrozen, readLifecycleState } from "./billing-state.js";
import {
  DEFAULT_THRESHOLDS,
  evaluate,
  gatherDomainStats,
  gatherMailboxHealth,
  type DeliverabilityAction,
  type DeliverabilityThresholds,
} from "./deliverability.js";
import { provisionDomainWithMailboxes, slugify } from "./provisioning.js";
import { ONE_DAY_MS } from "./warmup.js";

// Domain-replacement rate cap: at most this many auto-provisioned replacements
// per rolling window, so a replacement domain that ALSO burns can never spawn
// an infinite chain (SPEC.md §7: burn is normal, replacement is a feature — but
// a runaway is not). Over the cap, the burning domain is still retired + its
// mailboxes paused; only the new-domain provisioning is withheld (+ logged).
const MAX_REPLACEMENTS_PER_WINDOW = 3;
const REPLACEMENT_WINDOW_MS = 30 * ONE_DAY_MS;

function logAction(ctx: TenantContext, action: string, target: string, detail: Record<string, unknown>): void {
  ctx.sql.exec(
    `INSERT INTO deliverability_actions (id, tenant_id, action, target, detail_json, ts) VALUES (?, ?, ?, ?, ?, ?)`,
    newId("dact"),
    ctx.tenantId,
    action,
    target,
    JSON.stringify(detail),
    ctx.clock.now(),
  );
}

function applyThrottle(
  ctx: TenantContext,
  action: Extract<DeliverabilityAction, { type: "THROTTLE" }>,
): void {
  // cap_override persists the throttle so mailbox-state.ts's per-tick warmup
  // recompute can't lift the cap back up; daily_cap is lowered now so the send
  // loop in this very tick already respects it.
  ctx.sql.exec(
    `UPDATE mailboxes SET deliv_status = 'throttled', cap_override = ?, daily_cap = MIN(daily_cap, ?)
     WHERE id = ? AND tenant_id = ?`,
    action.newCap,
    action.newCap,
    action.mailboxId,
    ctx.tenantId,
  );
  logAction(ctx, "THROTTLE", action.email, { mailboxId: action.mailboxId, newCap: action.newCap, reason: action.reason });
}

function applyPause(ctx: TenantContext, action: Extract<DeliverabilityAction, { type: "PAUSE" }>): void {
  // Idempotent: the conditional guard means re-pausing an already-paused
  // mailbox writes nothing and logs nothing (panel #2 lesson).
  const res = ctx.sql.exec(
    `UPDATE mailboxes SET deliv_status = 'paused' WHERE id = ? AND tenant_id = ? AND deliv_status != 'paused'`,
    action.mailboxId,
    ctx.tenantId,
  );
  if (res.rowsWritten > 0) {
    logAction(ctx, "PAUSE", action.email, { mailboxId: action.mailboxId, reason: action.reason });
  }
}

function pauseDomainMailboxes(ctx: TenantContext, domainId: string): void {
  ctx.sql.exec(
    `UPDATE mailboxes SET deliv_status = 'paused' WHERE tenant_id = ? AND domain_id = ? AND deliv_status != 'paused'`,
    ctx.tenantId,
    domainId,
  );
}

function countReplacementsInWindow(ctx: TenantContext): number {
  return ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM deliverability_actions
       WHERE tenant_id = ? AND action = 'REPLACE_DOMAIN' AND ts >= ?`,
      ctx.tenantId,
      ctx.clock.now() - REPLACEMENT_WINDOW_MS,
    )
    .one().n;
}

async function pickReplacementDomain(ctx: TenantContext, brand: string, primaryDomain: string): Promise<string> {
  const owned = new Set(
    ctx.sql
      .exec<{ domain: string }>(`SELECT domain FROM domains WHERE tenant_id = ?`, ctx.tenantId)
      .toArray()
      .map((r) => r.domain),
  );
  const candidates = await ctx.adapters.domain.searchLookalikes(brand, primaryDomain, owned.size + 4);
  const fresh = candidates.find((c) => !owned.has(c.domain));
  if (fresh) return fresh.domain;
  // Fallback if the lookalike generator is exhausted — deterministic + unique.
  const slug = slugify(brand);
  let i = 1;
  while (owned.has(`${slug}-r${i}.com`)) i++;
  return `${slug}-r${i}.com`;
}

async function applyReplaceDomain(
  ctx: TenantContext,
  action: Extract<DeliverabilityAction, { type: "REPLACE_DOMAIN" }>,
): Promise<void> {
  // Retire the burning domain + stop all its mailboxes FIRST, unconditionally —
  // even if we can't provision a replacement, we must stop sending from it.
  ctx.sql.exec(
    `UPDATE domains SET status = 'burning' WHERE id = ? AND tenant_id = ? AND status = 'active'`,
    action.domainId,
    ctx.tenantId,
  );
  pauseDomainMailboxes(ctx, action.domainId);

  if (countReplacementsInWindow(ctx) >= MAX_REPLACEMENTS_PER_WINDOW) {
    // Spawn cap hit: retire but do NOT provision — prevents an infinite
    // burn->replace->burn chain. Surfaced so the agent/owner can intervene.
    logAction(ctx, "REPLACE_DOMAIN_CAPPED", action.domain, {
      domainId: action.domainId,
      reason: action.reason,
      cap: MAX_REPLACEMENTS_PER_WINDOW,
      note: "retired + mailboxes paused; replacement withheld (per-window cap reached)",
    });
    return;
  }

  const profile = ctx.sql
    .exec<{ brand: string; primary_domain: string }>(
      `SELECT brand, primary_domain FROM tenant_profile WHERE id = ?`,
      ctx.tenantId,
    )
    .one();

  const inboxesEach = Math.max(
    1,
    ctx.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND domain_id = ?`,
        ctx.tenantId,
        action.domainId,
      )
      .one().n,
  );
  const domainIndex = ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE tenant_id = ?`, ctx.tenantId)
    .one().n;

  const replacementDomain = await pickReplacementDomain(ctx, profile.brand, profile.primary_domain);
  const provisioned = await provisionDomainWithMailboxes(ctx, {
    domain: replacementDomain,
    domainIndex,
    personaSlug: slugify(profile.brand),
    inboxesEach,
  });

  logAction(ctx, "REPLACE_DOMAIN", action.domain, {
    burningDomainId: action.domainId,
    replacementDomain: provisioned.domain,
    replacementDomainId: provisioned.domainId,
    mailboxesProvisioned: provisioned.mailboxEmails.length,
    reason: action.reason,
  });
}

/** Mutates DO state for every action the pure `evaluate` produced, auditing each. */
export async function applyActions(ctx: TenantContext, actions: DeliverabilityAction[]): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case "THROTTLE":
        applyThrottle(ctx, action);
        break;
      case "PAUSE":
        applyPause(ctx, action);
        break;
      case "ROTATE":
        // The reroute itself is realized by the tick's capacity picker (it
        // excludes paused mailboxes); this records the decision + whether there
        // was a healthy target to reroute to right now.
        logAction(ctx, "ROTATE", "fleet", {
          pendingSends: action.pendingSends,
          healthyTargets: action.healthyTargets,
          reason: action.reason,
        });
        break;
      case "REPLACE_DOMAIN":
        await applyReplaceDomain(ctx, action);
        break;
    }
  }
}

/**
 * The control loop's single entry point (monitor -> decide -> act). Called by
 * the tick BEFORE scheduling sends so a degrading mailbox is throttled/paused
 * before it can send more. Gathering is DB-only + synchronous; the sole awaits
 * are inside REPLACE_DOMAIN's replacement provisioning.
 */
export async function runDeliverabilitySweep(
  ctx: TenantContext,
  thresholds: DeliverabilityThresholds = DEFAULT_THRESHOLDS,
): Promise<{ actions: DeliverabilityAction[] }> {
  // Lifecycle freeze — the SAME kill switch the tick has, but enforced INSIDE
  // the sweep so it also covers the standalone TenantDO.deliverabilitySweep()
  // RPC and the cron runDeliverabilitySweepAllTenants lane (adversarial
  // panel-03 finding #3: those bypassed the tick's guard, so a frozen tenant's
  // burning domain still triggered REPLACE_DOMAIN -> buys a new domain +
  // mailboxes = real vendor spend on an account we deliberately froze).
  const { status, billingState } = readLifecycleState(ctx);
  if (isLifecycleFrozen(status, billingState)) {
    return { actions: [] };
  }

  const mailboxes = gatherMailboxHealth(ctx);
  const domains = gatherDomainStats(ctx, mailboxes);
  const pendingSends = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM scheduled_sends WHERE tenant_id = ? AND status = 'pending'`,
      ctx.tenantId,
    )
    .one().n;

  const actions = evaluate(mailboxes, domains, thresholds, { pendingSends });
  await applyActions(ctx, actions);
  return { actions };
}
