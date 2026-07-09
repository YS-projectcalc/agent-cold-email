import type { LaunchCampaignInput } from "@coldstart/shared";
import { NotFoundError } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { ONE_DAY_MS } from "./warmup.js";

/**
 * launch_campaign — SPEC.md §6. Every sequence step for every non-suppressed
 * lead is scheduled up front (send_at = campaign start + cumulative
 * delayDays). Enforcement happens at send time in the tick (engine/tick.ts):
 * it re-checks lead status, campaign status, the suppressions table, and the
 * send window on every due row, so a step scheduled days ahead is skipped or
 * deferred if the lead was replied-to/suppressed or the window closed by then.
 * The suppression snapshot below is only a launch-time optimization — the
 * tick's suppressions join is the actual guard.
 */
export function launchCampaign(
  ctx: TenantContext,
  input: LaunchCampaignInput,
  opts: { isDemo?: boolean } = {},
): { campaignId: string } {
  const now = ctx.clock.now();
  const campaignId = newId("camp");

  ctx.sql.exec(
    `INSERT INTO campaigns (id, tenant_id, name, status, sequence_json, stop_on_reply, send_window_json, timezone, is_demo, created_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    campaignId,
    ctx.tenantId,
    input.name,
    JSON.stringify(input.sequence),
    input.stopOnReply ? 1 : 0,
    JSON.stringify(input.sendWindow),
    input.timezone,
    opts.isDemo ? 1 : 0,
    now,
  );

  for (const lead of input.leads) {
    const suppressed = ctx.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) as n FROM suppressions WHERE tenant_id = ? AND email = ?`,
        ctx.tenantId,
        lead.email,
      )
      .one().n;

    const leadId = newId("lead");
    ctx.sql.exec(
      `INSERT INTO leads (id, tenant_id, campaign_id, email, first_name, company, global_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      leadId,
      ctx.tenantId,
      campaignId,
      lead.email,
      lead.firstName,
      lead.company,
      suppressed > 0 ? "suppressed" : "active",
      now,
    );

    if (suppressed > 0) continue;

    const threadId = `t_${campaignId}_${leadId}`;
    let cumulativeDelayMs = 0;
    for (const step of input.sequence) {
      cumulativeDelayMs += step.delayDays * ONE_DAY_MS;
      ctx.sql.exec(
        `INSERT INTO scheduled_sends (id, tenant_id, campaign_id, lead_id, mailbox_id, step, variant, send_at, status, thread_id)
         VALUES (?, ?, ?, ?, NULL, ?, 'a', ?, 'pending', ?)`,
        newId("ss"),
        ctx.tenantId,
        campaignId,
        leadId,
        step.step,
        now + cumulativeDelayMs,
        threadId,
      );
    }
  }

  return { campaignId };
}

export function pauseCampaign(ctx: TenantContext, campaignId: string): void {
  const exists = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM campaigns WHERE id = ? AND tenant_id = ?`,
      campaignId,
      ctx.tenantId,
    )
    .one().n;
  if (exists === 0) throw new NotFoundError(`campaign ${campaignId} not found`);
  ctx.sql.exec(`UPDATE campaigns SET status = 'paused' WHERE id = ? AND tenant_id = ?`, campaignId, ctx.tenantId);
}

export function pauseAllCampaigns(ctx: TenantContext): void {
  ctx.sql.exec(
    `UPDATE campaigns SET status = 'paused' WHERE tenant_id = ? AND status = 'active'`,
    ctx.tenantId,
  );
}
