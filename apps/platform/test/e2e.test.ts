import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

interface InfraStatus {
  domains: number;
  mailboxes: number;
  sendReady: boolean;
  mailboxHealth: { email: string; status: string; warmupDay: number; dailyCap: number; sendReady: boolean }[];
}

interface CampaignResults {
  campaignId: string;
  sent: number;
  reply: number;
  bounce: number;
  complaint: number;
  unsubscribe: number;
  failed: number;
}

interface InboxThread {
  threadId: string;
  leadEmail: string;
  lastEventType: string;
}

interface ThreadDetail {
  threadId: string;
  leadEmail: string;
  messages: { type: string; ts: number }[];
}

interface AccountSummary {
  domains: number;
  mailboxes: number;
  campaigns: number;
  leads: number;
  usageCents: number;
}

const SEQUENCE = [
  { step: 1, subject: "Quick question", body: "Hi {{firstName}}, quick question for you.", delayDays: 0 },
  { step: 2, subject: "Following up", body: "Just checking back in.", delayDays: 2 },
];

describe("B0 walking skeleton — signup through reply/bounce handling", () => {
  it("proves the whole pipe: signup -> provision -> warmup -> send -> reply/bounce -> inbox -> metrics -> account", async () => {
    // 1. signup
    const { tenantId, token } = await signup("Acme Rockets", "founder@acme-rockets.test");
    expect(tenantId).toMatch(/^ten_/);
    expect(token).toMatch(/^cs_test_/);

    // 2. setup_infrastructure — 2 domains x 2 mailboxes each = 4 mailboxes
    const setupRes = await api<{ jobId: string }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Acme Rockets",
        primaryDomain: "acmerockets.com",
        domains: 2,
        inboxesEach: 2,
        persona: "Alex Morgan, Sales",
        physicalAddress: "123 Main St, Springfield, USA",
        senderIdentity: "Alex Morgan <alex@acmerockets.com>",
      }),
    });
    expect(setupRes.status).toBe(202);
    expect(setupRes.body.jobId).toMatch(/^job_/);

    // Immediately: warmup is in progress, not send-ready yet, day-1 caps apply.
    const day1Status = await api<InfraStatus>("/infrastructure-status", { token });
    expect(day1Status.status).toBe(200);
    expect(day1Status.body.domains).toBe(2);
    expect(day1Status.body.mailboxes).toBe(4);
    expect(day1Status.body.sendReady).toBe(false);
    for (const mbx of day1Status.body.mailboxHealth) {
      expect(mbx.status).toBe("warming");
      expect(mbx.warmupDay).toBe(1);
      expect(mbx.dailyCap).toBe(5);
    }

    // 3. advance the virtual clock past the ramp -> warmup progresses to send-ready.
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
    const readyStatus = await api<InfraStatus>("/infrastructure-status", { token });
    expect(readyStatus.body.sendReady).toBe(true);
    for (const mbx of readyStatus.body.mailboxHealth) {
      expect(mbx.status).toBe("active");
      expect(mbx.dailyCap).toBe(40);
    }

    // 4. launch_campaign — 3 leads, 2-step sequence. Sandbox EmailPort keys
    // bounce/reply behavior off the recipient local-part (see
    // src/vendors/sandbox/email-port.ts).
    const launchRes = await api<{ campaignId: string }>("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Launch sequence",
        offer: "Rocket fuel subscriptions",
        leads: [
          { email: "prospect.silent@leads-test.com", firstName: "Sam", company: "Silent Co" },
          { email: "bounce.prospect@leads-test.com", firstName: "Bo", company: "Bounce Co" },
          { email: "reply.prospect@leads-test.com", firstName: "Ray", company: "Reply Co" },
        ],
        sequence: SEQUENCE,
        stopOnReply: true,
      }),
    });
    expect(launchRes.status).toBe(201);
    const campaignId = launchRes.body.campaignId;
    expect(campaignId).toMatch(/^camp_/);

    // 5. engine tick sends step 1 for all 3 leads (well under the 4x40/day cap).
    const tick1 = await tenantStub(tenantId).tick();
    expect(tick1).toEqual({ sent: 3, skipped: 0, deferred: 0 });

    // 6. sandbox poll returns 1 reply + 1 bounce.
    const poll1 = await tenantStub(tenantId).pollInbox();
    expect(poll1).toEqual({ replies: 1, bounces: 1, complaints: 0 });

    let results = await api<CampaignResults>(`/campaigns/${campaignId}/results`, { token });
    expect(results.body.sent).toBe(3);
    expect(results.body.reply).toBe(1);
    expect(results.body.bounce).toBe(1);

    // 7. inbox() shows 3 threads; thread(id) shows the exchange; reply() sends.
    const inbox = await api<InboxThread[]>("/inbox", { token });
    expect(inbox.body).toHaveLength(3);
    const replyThread = inbox.body.find((t) => t.leadEmail === "reply.prospect@leads-test.com");
    const bounceThread = inbox.body.find((t) => t.leadEmail === "bounce.prospect@leads-test.com");
    expect(replyThread?.lastEventType).toBe("reply");
    expect(bounceThread?.lastEventType).toBe("bounce");

    const threadDetail = await api<ThreadDetail>(`/threads/${replyThread!.threadId}`, { token });
    expect(threadDetail.body.messages.map((m) => m.type)).toEqual(["sent", "reply"]);

    const replySendRes = await api<{ messageId: string }>(`/threads/${replyThread!.threadId}/reply`, {
      method: "POST",
      token,
      body: JSON.stringify({ body: "Great, let's talk more." }),
    });
    expect(replySendRes.status).toBe(201);
    // C2: the sandbox now emits RFC 5322 Message-IDs (`<uuid@sandbox.local>`),
    // not the opaque `msg_<uuid>` shape, so real IMAP threading is expressible.
    expect(replySendRes.body.messageId).toMatch(/^<[0-9a-f-]+@sandbox\.local>$/);

    const threadAfterReply = await api<ThreadDetail>(`/threads/${replyThread!.threadId}`, { token });
    expect(threadAfterReply.body.messages.map((m) => m.type)).toEqual(["sent", "reply", "sent"]);

    // stop-on-reply / bounce->suppression: step 2 must NOT be pending for the replied/bounced leads.
    await tenantStub(tenantId).advanceClock(3 * ONE_DAY_MS); // past step 2's 2-day delay
    const tick2 = await tenantStub(tenantId).tick();
    // Only the silent lead's step 2 is still 'pending' and due; replied/bounced steps were already cancelled.
    expect(tick2).toEqual({ sent: 1, skipped: 0, deferred: 0 });

    results = await api<CampaignResults>(`/campaigns/${campaignId}/results`, { token });
    // 3 step-1 sends + 1 step-2 send for the silent lead + 1 manual inbox reply above.
    expect(results.body.sent).toBe(5);
    expect(results.body.reply).toBe(1);
    expect(results.body.bounce).toBe(1);

    // 8. metrics()/campaign_results() report sent/replies/bounces/complaints (never opens).
    // metrics() is the account-wide rollup (no campaignId) — only one campaign exists, so the counts match.
    const metrics = await api<CampaignResults>("/metrics", { token });
    const { campaignId: _campaignId, ...resultsCounts } = results.body;
    expect(metrics.body).toEqual(resultsCounts);
    expect(metrics.body).not.toHaveProperty("opens");

    // 9. account() shows usage: 4 sends x 2c/send.
    const account = await api<AccountSummary>("/account", { token });
    expect(account.body.domains).toBe(2);
    expect(account.body.mailboxes).toBe(4);
    expect(account.body.campaigns).toBe(1);
    expect(account.body.leads).toBe(3);
    expect(account.body.usageCents).toBe(8);
  });

  it("enforces per-mailbox daily send caps (behavior, not just existence)", async () => {
    const { tenantId, token } = await signup("Cap Test Co", "caps@test.example");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Cap Test Co",
        primaryDomain: "captest.com",
        domains: 1,
        inboxesEach: 1, // 1 mailbox, day-1 cap = 5/day
        persona: "Sender",
        physicalAddress: "1 Cap St",
        senderIdentity: "Sender <s@captest.com>",
      }),
    });

    const leads = Array.from({ length: 7 }, (_, i) => ({
      email: `lead${i}@cap-leads-test.com`,
      firstName: `Lead${i}`,
      company: "Co",
    }));
    const launchRes = await api<{ campaignId: string }>("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Cap test campaign",
        offer: "Widgets",
        leads,
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    const campaignId = launchRes.body.campaignId;

    // Day 1 cap is 5 — only 5 of the 7 due sends should go out; 2 stay pending (deferred).
    const tick1 = await tenantStub(tenantId).tick();
    expect(tick1.sent).toBe(5);
    expect(tick1.deferred).toBe(2);

    let results = await api<CampaignResults>(`/campaigns/${campaignId}/results`, { token });
    expect(results.body.sent).toBe(5);

    // Advance one virtual day -> cap resets -> the remaining 2 go out.
    await tenantStub(tenantId).advanceClock(ONE_DAY_MS);
    const tick2 = await tenantStub(tenantId).tick();
    expect(tick2.sent).toBe(2);
    expect(tick2.deferred).toBe(0);

    results = await api<CampaignResults>(`/campaigns/${campaignId}/results`, { token });
    expect(results.body.sent).toBe(7);
  });

  it("pause(campaign) and pause_all() block the tick from sending due steps", async () => {
    const { tenantId, token } = await signup("Pause Co", "pause@test.example");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Pause Co",
        primaryDomain: "pauseco.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 Pause St",
        senderIdentity: "Sender <s@pauseco.com>",
      }),
    });
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);

    const oneStepSequence = [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }];

    const campaignA = await api<{ campaignId: string }>("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Campaign A",
        offer: "x",
        leads: [{ email: "a@pause-leads-test.com", firstName: "A", company: "Co" }],
        sequence: oneStepSequence,
      }),
    });
    await api(`/campaigns/${campaignA.body.campaignId}/pause`, { method: "POST", token });

    const campaignB = await api<{ campaignId: string }>("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Campaign B",
        offer: "x",
        leads: [{ email: "b@pause-leads-test.com", firstName: "B", company: "Co" }],
        sequence: oneStepSequence,
      }),
    });
    await api("/campaigns/pause-all", { method: "POST", token });

    const tick = await tenantStub(tenantId).tick();
    expect(tick.sent).toBe(0);

    const resultsA = await api<CampaignResults>(`/campaigns/${campaignA.body.campaignId}/results`, { token });
    const resultsB = await api<CampaignResults>(`/campaigns/${campaignB.body.campaignId}/results`, { token });
    expect(resultsA.body.sent).toBe(0);
    expect(resultsB.body.sent).toBe(0);
  });
});
