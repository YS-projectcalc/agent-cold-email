// demo_run — the sandbox-only accelerated pipeline run behind POST
// /demo/run (B5 brief). `tick`/`pollInbox`/`advanceClock` are DO-RPC-only
// today (no HTTP facade intent — see tenant-do.ts), so the CLI/demo path
// needs one synchronous HTTP-drivable entry point that advances warmup,
// launches a canned campaign with deterministic reply/bounce leads, sends,
// and polls — all inside one call. TenantDO.demoRun() is the ONLY caller;
// it structurally rejects non-demo/free tenants BEFORE this ever runs
// (ARCHITECTURE.md #8: demo-only surfaces must be a type-level guard, not
// a policy an operator could accidentally relax).

import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { launchCampaign } from "./campaigns.js";
import { runTick } from "./tick.js";
import { runPollInbox } from "./reply-processor.js";
import { getThread, type ThreadDetail } from "./threads.js";
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
  ctx.sql.exec(`DELETE FROM scheduled_sends WHERE tenant_id = ? AND campaign_id IN (${placeholders})`, ...scope);
  ctx.sql.exec(`DELETE FROM events WHERE tenant_id = ? AND campaign_id IN (${placeholders})`, ...scope);
  ctx.sql.exec(`DELETE FROM leads WHERE tenant_id = ? AND campaign_id IN (${placeholders})`, ...scope);
  ctx.sql.exec(`DELETE FROM campaigns WHERE tenant_id = ? AND id IN (${placeholders})`, ...scope);
}

const DEMO_SEQUENCE = [
  { step: 1, subject: "Quick question about {{company}}", body: "Hi {{firstName}}, quick question about your outreach process.", delayDays: 0 },
  { step: 2, subject: "Following up", body: "Just checking back in — any thoughts?", delayDays: 2 },
];

// Local-parts drive the sandbox EmailPort's deterministic behavior
// (vendors/sandbox/email-port.ts: "reply"/"bounce" substrings), so a demo
// run always produces at least one reply and one bounce to prove the whole
// pipe, not just a happy path.
const DEMO_LEADS = [
  { email: "morgan.reply@demo-leads.coldstart.dev", firstName: "Morgan", company: "Reply Co" },
  { email: "casey.bounce@demo-leads.coldstart.dev", firstName: "Casey", company: "Bounce Co" },
  { email: "jordan.prospect@demo-leads.coldstart.dev", firstName: "Jordan", company: "Prospect Co" },
];

export async function runDemo(ctx: TenantContext): Promise<DemoRunSummary> {
  // 0. Reset prior demo state so repeated runs don't grow DO SQLite unbounded
  //    (adversarial panel-02). Only rows from previous DEMO runs (is_demo = 1)
  //    are deleted — a demo/free tenant's own real /campaigns launches are
  //    left untouched. The money ledger + suppressions are intentionally kept.
  resetPriorDemoState(ctx);

  // 1. Advance the virtual clock past the warmup ramp so mailboxes are send-ready.
  advanceClock(ctx, (WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);

  // 2. Launch a canned sample campaign against the deterministic sandbox leads above.
  const { campaignId } = launchCampaign(
    ctx,
    {
      name: `Demo run ${newId("run")}`,
      offer: "A sandbox demo offer — no real product, no real emails sent.",
      leads: DEMO_LEADS,
      sequence: DEMO_SEQUENCE,
      timezone: "UTC",
      sendWindow: { startHour: 0, endHour: 23 },
      stopOnReply: true,
    },
    { isDemo: true },
  );

  // 3. Step-1 send tick, then poll the sandbox inbox for the reply + bounce.
  const tick1 = await runTick(ctx);
  const poll1 = await runPollInbox(ctx);

  // 4. Advance past step 2's delay and tick/poll again — this is the
  // stop-on-reply / bounce-suppression proof: replied/bounced leads must
  // NOT receive step 2, only the silent lead does.
  advanceClock(ctx, 3 * ONE_DAY_MS);
  const tick2 = await runTick(ctx);
  const poll2 = await runPollInbox(ctx);

  const repliedLead = ctx.sql
    .exec<{ id: string; email: string }>(
      `SELECT id, email FROM leads WHERE tenant_id = ? AND campaign_id = ? AND global_status = 'replied' LIMIT 1`,
      ctx.tenantId,
      campaignId,
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
    // The sandbox EmailPort does not yet simulate complaints (only
    // bounce/reply — see vendors/sandbox/email-port.ts); reported honestly
    // as 0 rather than fabricated. Complaint fault-injection is a later,
    // budgeted lane (ROADMAP.md hardening-budget rule), not B5 scope.
    complaints: 0,
    stopOnReplyProof,
    sampleThread,
  };
}
