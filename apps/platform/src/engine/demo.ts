// demo_run — the sandbox-only accelerated pipeline run behind POST
// /demo/run (B5 brief; seed-variety params added by backend gaps brief item
// 3). `tick`/`pollInbox`/`advanceClock` are DO-RPC-only today (no HTTP
// facade intent — see tenant-do.ts), so the CLI/demo path needs one
// synchronous HTTP-drivable entry point that advances warmup, launches
// canned campaign(s) with deterministic reply/bounce/ooo/silent leads,
// sends, and polls — all inside one call. TenantDO.demoRun() is the ONLY
// caller; it structurally rejects non-demo/free tenants BEFORE this ever
// runs (ARCHITECTURE.md #8: demo-only surfaces must be a type-level guard,
// not a policy an operator could accidentally relax).

import type { DemoRunInput } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";
import { launchCampaign } from "./campaigns.js";
import { runTick } from "./tick.js";
import { runPollInbox } from "./reply-processor.js";
import { getThread, type ThreadDetail } from "./threads.js";
import { setThreadLabel } from "./thread-labels.js";
import { buildDemoLeads, friendlyCampaignName, splitIntoCampaignBatches } from "./demo-seed.js";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "./warmup.js";

export interface DemoRunSummary {
  sent: number;
  replies: number;
  bounces: number;
  complaints: number;
  stopOnReplyProof: { leadEmail: string; remainingStepsCancelled: boolean } | null;
  sampleThread: ThreadDetail | null;
}

// Same clock-persistence as TenantDO.advanceClock (tenant-do.ts) — this is
// the sandbox/test-only clock control, deliberately duplicated at the SQL
// level rather than re-entering the DO, since engine/*.ts functions only
// ever see a `TenantContext`, never the DO instance itself.
function advanceClock(ctx: TenantContext, virtualMs: number): void {
  const newOffset = ctx.clock.advanceVirtual(virtualMs);
  ctx.sql.exec(`UPDATE tenant_profile SET clock_offset = ? WHERE id = ?`, newOffset, ctx.tenantId);
}

// Delete every row belonging to PRIOR demo campaigns (is_demo = 1) so demo
// state stays bounded across repeated /demo/run calls. Dependent rows first,
// then the campaigns themselves. Non-demo campaigns/leads/sends and the money
// ledger + suppressions are deliberately preserved.
function resetPriorDemoState(ctx: TenantContext): void {
  const demoCampaignIds = ctx.sql
    .exec<{ id: string }>(`SELECT id FROM campaigns WHERE tenant_id = ? AND is_demo = 1`, ctx.tenantId)
    .toArray()
    .map((r) => r.id);
  if (demoCampaignIds.length === 0) return;

  const placeholders = demoCampaignIds.map(() => "?").join(", ");
  const scope = [ctx.tenantId, ...demoCampaignIds];

  // Backend gaps brief item 3: a richer seed can now WRITE thread_labels rows
  // (the "ooo" bucket below) — capture the demo threads' ids before deleting
  // scheduled_sends (their only source) so those label rows don't outlive
  // their campaign and grow unbounded across repeated runs, the same
  // unbounded-growth guard the deletes below already enforce for every other
  // demo-owned table (adversarial panel-02).
  const demoThreadIds = ctx.sql
    .exec<{ thread_id: string }>(
      `SELECT DISTINCT thread_id FROM scheduled_sends WHERE tenant_id = ? AND campaign_id IN (${placeholders})`,
      ...scope,
    )
    .toArray()
    .map((r) => r.thread_id);

  ctx.sql.exec(`DELETE FROM scheduled_sends WHERE tenant_id = ? AND campaign_id IN (${placeholders})`, ...scope);
  ctx.sql.exec(`DELETE FROM events WHERE tenant_id = ? AND campaign_id IN (${placeholders})`, ...scope);
  ctx.sql.exec(`DELETE FROM leads WHERE tenant_id = ? AND campaign_id IN (${placeholders})`, ...scope);
  ctx.sql.exec(`DELETE FROM campaigns WHERE tenant_id = ? AND id IN (${placeholders})`, ...scope);

  if (demoThreadIds.length > 0) {
    const threadPlaceholders = demoThreadIds.map(() => "?").join(", ");
    ctx.sql.exec(`DELETE FROM thread_labels WHERE thread_id IN (${threadPlaceholders})`, ...demoThreadIds);
  }
}

const DEMO_SEQUENCE = [
  { step: 1, subject: "Quick question about {{company}}", body: "Hi {{firstName}}, quick question about your outreach process.", delayDays: 0 },
  { step: 2, subject: "Following up", body: "Just checking back in — any thoughts?", delayDays: 2 },
];

// A small, virtual-clock-only stagger between each generated campaign's
// launch (never real wall time — SPEC.md §0) so a multi-campaign run
// produces genuinely distinct lastEventTs across campaigns, not just within
// one (the inbox v2 cursor already handles same-ts ties losslessly — this is
// for visual/pagination variety, not correctness).
const CAMPAIGN_STAGGER_MS = 5 * 60 * 1000;

export async function runDemo(ctx: TenantContext, params: DemoRunInput): Promise<DemoRunSummary> {
  // 0. Reset prior demo state so repeated runs don't grow DO SQLite unbounded
  //    (adversarial panel-02). Only rows from previous DEMO runs (is_demo = 1)
  //    are deleted — a demo/free tenant's own real /campaigns launches are
  //    left untouched. The money ledger + suppressions are intentionally kept.
  resetPriorDemoState(ctx);

  // 1. Advance the virtual clock past the warmup ramp so mailboxes are send-ready.
  advanceClock(ctx, (WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);

  // 2. Build the deterministic lead set (backend gaps brief item 3 — default
  //    params.leads=3/params.campaigns=1 reproduce the ORIGINAL 3-lead,
  //    single-campaign shape byte-for-byte) and launch a batch per campaign.
  const leads = buildDemoLeads(params.leads);
  const batches = splitIntoCampaignBatches(leads, params.campaigns);

  const campaignIds: string[] = [];
  batches.forEach((batch, idx) => {
    const { campaignId } = launchCampaign(
      ctx,
      {
        // M5 dashboard-polish defect D: friendlyCampaignName (demo-seed.ts)
        // replaces the old opaque `Demo run ${newId("run")}` id, which
        // clipped/overflowed every chip and table column it appeared in.
        name: friendlyCampaignName(idx, batches.length),
        offer: "A sandbox demo offer — no real product, no real emails sent.",
        leads: batch,
        sequence: DEMO_SEQUENCE,
        timezone: "UTC",
        sendWindow: { startHour: 0, endHour: 23 },
        stopOnReply: true,
      },
      { isDemo: true },
    );
    campaignIds.push(campaignId);
    if (idx < batches.length - 1) advanceClock(ctx, CAMPAIGN_STAGGER_MS);
  });

  // 3. Step-1 send tick, then poll the sandbox inbox for the reply + bounce.
  const tick1 = await runTick(ctx);
  const poll1 = await runPollInbox(ctx);

  // 4. Advance past step 2's delay and tick/poll again — this is the
  // stop-on-reply / bounce-suppression proof: replied/bounced leads must
  // NOT receive step 2, only the silent lead does.
  advanceClock(ctx, 3 * ONE_DAY_MS);
  const tick2 = await runTick(ctx);
  const poll2 = await runPollInbox(ctx);

  // 5. §19.2 label seed: an "ooo" lead's thread is labeled the same way a
  // real customer agent would classify an auto-reply — after the send/poll
  // cycle above actually produced the reply event, not fabricated ahead of
  // the fact.
  const oooEmails = leads.filter((l) => l.kind === "ooo").map((l) => l.email);
  if (oooEmails.length > 0) {
    const emailPlaceholders = oooEmails.map(() => "?").join(", ");
    const oooThreads = ctx.sql
      .exec<{ thread_id: string }>(
        `SELECT DISTINCT ss.thread_id as thread_id FROM scheduled_sends ss
         JOIN leads l ON l.id = ss.lead_id
         WHERE ss.tenant_id = ? AND l.email IN (${emailPlaceholders})`,
        ctx.tenantId,
        ...oooEmails,
      )
      .toArray();
    for (const row of oooThreads) setThreadLabel(ctx, row.thread_id, "out_of_office", "api");
  }

  const campaignPlaceholders = campaignIds.map(() => "?").join(", ");
  const repliedLead = ctx.sql
    .exec<{ id: string; email: string }>(
      `SELECT id, email FROM leads WHERE tenant_id = ? AND campaign_id IN (${campaignPlaceholders}) AND global_status = 'replied' LIMIT 1`,
      ctx.tenantId,
      ...campaignIds,
    )
    .toArray()[0];

  let stopOnReplyProof: DemoRunSummary["stopOnReplyProof"] = null;
  let sampleThread: ThreadDetail | null = null;

  if (repliedLead) {
    const remainingPending = ctx.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) as n FROM scheduled_sends WHERE tenant_id = ? AND lead_id = ? AND status = 'pending'`,
        ctx.tenantId,
        repliedLead.id,
      )
      .one().n;
    stopOnReplyProof = { leadEmail: repliedLead.email, remainingStepsCancelled: remainingPending === 0 };

    const threadRow = ctx.sql
      .exec<{ thread_id: string }>(
        `SELECT thread_id FROM scheduled_sends WHERE tenant_id = ? AND lead_id = ? LIMIT 1`,
        ctx.tenantId,
        repliedLead.id,
      )
      .toArray()[0];
    if (threadRow) sampleThread = getThread(ctx, threadRow.thread_id);
  }

  return {
    sent: tick1.sent + tick2.sent,
    replies: poll1.replies + poll2.replies,
    bounces: poll1.bounces + poll2.bounces,
    // Real complaint count from the poll (the sandbox EmailPort simulates
    // complaints for "complaint"-tagged recipients — B6). The canned DEMO_LEADS
    // below have no complaint lead, so a normal demo reports 0; the number is
    // now observed, not fabricated.
    complaints: poll1.complaints + poll2.complaints,
    stopOnReplyProof,
    sampleThread,
  };
}
