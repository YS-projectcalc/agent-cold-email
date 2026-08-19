import type { LaunchCampaignInput, NextSteps } from "@coldstart/shared";
import { DuplicateCampaignError, NotFoundError } from "@coldstart/shared";
import { RealClock } from "../clock.js";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { assertNotLifecycleFrozen } from "./billing-state.js";
import { deriveNextSteps } from "./next-steps.js";
import { type EventCounts, emptyEventCounts } from "./reporting.js";
import { ONE_DAY_MS } from "./warmup.js";

/**
 * How long an identical launch is treated as a repeat of the one before it
 * rather than a new campaign. Covers the two shapes that produce an accidental
 * duplicate — a double-click (sub-second) and an agent retrying a dropped
 * response (seconds) — while staying far short of any interval over which
 * relaunching a byte-identical campaign to the same lead list is a plausible
 * thing to mean. Deliberate repeats outside it are allowed, unchanged.
 */
const DUPLICATE_LAUNCH_WINDOW_MS = 60_000;

/** FNV-1a, seeded — synchronous by necessity; see campaignFingerprint. */
function fnv1a32(text: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A stable fingerprint of everything a launch actually asks for.
 *
 * SYNCHRONOUS ON PURPOSE. `launchCampaign` performs no I/O, which is exactly why
 * two concurrent launches cannot interleave: a Durable Object's input gate opens
 * on I/O, so the second RPC does not start until the first has committed its
 * row and can therefore see it. Hashing with `crypto.subtle` would make this
 * function async, open the gate mid-launch, and reintroduce the very race the
 * guard exists to close — so a small hand-rolled hash is the correct trade, not
 * a shortcut.
 *
 * Fields are serialized as ordered ARRAYS, never as objects, so the value cannot
 * drift with key ordering. Two seeds plus the input length widen the fingerprint
 * well past a single 32-bit hash; a collision would cost one caller an explicit
 * 409 naming the campaign it collided with, never a lost or merged launch.
 */
function campaignFingerprint(input: LaunchCampaignInput): string {
  const canonical = JSON.stringify([
    input.name,
    input.offer,
    input.timezone,
    input.sendWindow.startHour,
    input.sendWindow.endHour,
    input.stopOnReply,
    input.sequence.map((s) => [s.step, s.subject, s.body, s.delayDays]),
    input.leads.map((l) => [l.email, l.firstName, l.company]),
  ]);
  const a = fnv1a32(canonical, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv1a32(canonical, 0x01000193).toString(16).padStart(8, "0");
  return `${a}${b}${canonical.length.toString(16)}`;
}

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
): { campaignId: string; nextSteps: NextSteps } {
  // Lifecycle freeze — a suspended/disputed/canceled tenant must not launch new
  // sends (adversarial panel-03 finding #5). Demo/free tenants are never frozen,
  // so the sandbox /demo/run path is unaffected.
  assertNotLifecycleFrozen(ctx, "launch_campaign");

  const now = ctx.clock.now();
  const campaignId = newId("camp");
  // Double-submit guard (ELEVATED, audit-dashboard-idempotency-2026-08-06). An
  // idempotency key already made a keyed retry safe on both transports; this is
  // for the caller that sends none — which is every browser caller, and the
  // dashboard does not disable the button while the launch is pending. Skipped
  // for /demo/run: it provisions nothing real, sends nothing real, and being
  // re-runnable on demand is the point of it.
  const contentHash = opts.isDemo ? "" : campaignFingerprint(input);
  const launchedAtReal = new RealClock().now();
  if (contentHash !== "") {
    const duplicate = ctx.sql
      .exec<{ id: string }>(
        `SELECT id FROM campaigns
          WHERE tenant_id = ? AND content_hash = ? AND launched_at_real > ?
          ORDER BY launched_at_real DESC LIMIT 1`,
        ctx.tenantId,
        contentHash,
        launchedAtReal - DUPLICATE_LAUNCH_WINDOW_MS,
      )
      .toArray()[0];
    if (duplicate) {
      throw new DuplicateCampaignError(
        `an identical campaign ("${input.name}", same offer, sequence and lead list) was launched moments ago and is already active — this launch was refused so the same prospects are not contacted twice. Check that campaign before relaunching; to retry a call whose response you lost, resend it with the same idempotencyKey instead.`,
        duplicate.id,
      );
    }
  }

  ctx.sql.exec(
    `INSERT INTO campaigns (id, tenant_id, name, status, sequence_json, stop_on_reply, send_window_json, timezone, is_demo, created_at, content_hash, launched_at_real)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
    campaignId,
    ctx.tenantId,
    input.name,
    JSON.stringify(input.sequence),
    input.stopOnReply ? 1 : 0,
    JSON.stringify(input.sendWindow),
    input.timezone,
    opts.isDemo ? 1 : 0,
    now,
    contentHash,
    launchedAtReal,
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

  // `available` steps only — a launch response never nags (design §7.4).
  return { campaignId, nextSteps: deriveNextSteps(ctx) };
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

export interface CampaignListItem {
  campaignId: string;
  name: string;
  status: string;
  counts: EventCounts;
}

/**
 * GET /campaigns (§19.4, NEW DO method — not a wrapper over an existing one
 * [F9]). Two queries total regardless of campaign count (the campaign rows,
 * then one GROUP BY over `events` for every campaign's counts at once) —
 * never one events query PER campaign.
 */
export function listCampaigns(ctx: TenantContext): CampaignListItem[] {
  const campaigns = ctx.sql
    .exec<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM campaigns WHERE tenant_id = ? ORDER BY created_at DESC`,
      ctx.tenantId,
    )
    .toArray();

  const countRows = ctx.sql
    .exec<{ campaign_id: string; type: keyof EventCounts; n: number }>(
      `SELECT campaign_id, type, COUNT(*) as n FROM events WHERE tenant_id = ? GROUP BY campaign_id, type`,
      ctx.tenantId,
    )
    .toArray();

  const countsByCampaign = new Map<string, EventCounts>();
  for (const row of countRows) {
    const counts = countsByCampaign.get(row.campaign_id) ?? emptyEventCounts();
    counts[row.type] = row.n;
    countsByCampaign.set(row.campaign_id, counts);
  }

  return campaigns.map((c) => ({
    campaignId: c.id,
    name: c.name,
    status: c.status,
    counts: countsByCampaign.get(c.id) ?? emptyEventCounts(),
  }));
}
