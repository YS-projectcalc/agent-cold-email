import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PollResult, PolledEvent } from "@coldstart/shared";
import { SandboxEmailPort } from "../src/vendors/sandbox/email-port.js";
import { VirtualClock } from "../src/clock.js";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { SOFT_BOUNCE_SUPPRESS_THRESHOLD } from "../src/engine/reply-processor.js";
import { api, signup, tenantStub } from "./helpers.js";

interface Counts {
  sent: number;
  bounce: number;
  soft_bounce: number;
}

async function setupReadyTenant(brand: string, primaryDomain: string) {
  const { tenantId, token } = await signup(brand, `founder@${primaryDomain}`);
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain,
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: `Sender <s@${primaryDomain}>`,
    }),
  });
  await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
  return { tenantId, token };
}

const THREE_STEP = [
  { step: 1, subject: "One", body: "Hi", delayDays: 0 },
  { step: 2, subject: "Two", body: "Following up", delayDays: 1 },
  { step: 3, subject: "Three", body: "Last note", delayDays: 1 },
];

function launch(token: string, name: string, email: string) {
  return api<{ campaignId: string }>("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({ name, offer: "x", leads: [{ email, firstName: "L", company: "Co" }], sequence: THREE_STEP, stopOnReply: true }),
  });
}

function suppressionCount(tenantId: string, email: string): Promise<number> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM suppressions WHERE email = ?`, email).one().n,
  );
}

function leadStatus(tenantId: string): Promise<string> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql.exec<{ global_status: string }>(`SELECT global_status FROM leads LIMIT 1`).one().global_status,
  );
}

function pendingCount(tenantId: string): Promise<number> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM scheduled_sends WHERE status = 'pending'`).one().n,
  );
}

// G2 — the sandbox emits BOTH bounce branches, keyed off the recipient local-part.
describe("sandbox EmailPort emits both hard and soft bounce branches (A1 / G2)", () => {
  it("classifies a 'softbounce' recipient as a transient 4.x.x soft bounce, and 'bounce' as a permanent 5.x.x hard bounce", async () => {
    const port = new SandboxEmailPort(new VirtualClock(Date.now(), 0, 1));
    const base = { subject: "s", body: "b", threadId: "t", inReplyToMessageId: null };

    await port.send({ ...base, fromEmail: "s@a.com", toEmail: "softbounce@x.com" }, "k-soft");
    await port.send({ ...base, fromEmail: "s@a.com", toEmail: "bounce@x.com" }, "k-hard");
    const { events } = await port.poll("s@a.com", 0);

    const soft = events.find((e) => e.kind === "bounce" && e.toEmail === "softbounce@x.com");
    const hard = events.find((e) => e.kind === "bounce" && e.toEmail === "bounce@x.com");
    expect(soft).toMatchObject({ kind: "bounce", severity: "soft" });
    expect((soft as { reason: string }).reason).toMatch(/4\.2\.2/);
    expect(hard).toMatchObject({ kind: "bounce", severity: "hard" });
    expect((hard as { reason: string }).reason).toMatch(/5\.1\.1/);
  });
});

// G3(i) ANCHOR — a soft bounce must NOT create a permanent suppression and must
// NOT halt the sequence. FAILS on the pre-fix code (processBounce suppressed on
// every bounce, hard or soft). Revert-fail-restore is demonstrated in the task
// report by reverting the processBounce severity branch.
describe("A2 — a single soft bounce is tallied, not permanently suppressed (G3 anchor)", () => {
  it("does NOT suppress, keeps the lead active, and leaves the rest of the sequence pending", async () => {
    const { tenantId, token } = await setupReadyTenant("Soft Co", "softco.com");
    const launched = await launch(token, "soft", "softbounce.prospect@leads-test.com");

    await tenantStub(tenantId).tick(); // sends step 1 to the soft-bounce lead
    const poll = await tenantStub(tenantId).pollInbox();
    expect(poll.bounces).toBe(1); // the soft bounce is observed...

    // ...but it is a TALLY, not a permanent suppression:
    expect(await suppressionCount(tenantId, "softbounce.prospect@leads-test.com")).toBe(0);
    expect(await leadStatus(tenantId)).toBe("active"); // NOT 'bounced'
    expect(await pendingCount(tenantId)).toBe(2); // steps 2 + 3 still pending — the sequence continues

    const results = await api<Counts>(`/campaigns/${launched.body.campaignId}/results`, { token });
    expect(results.body.soft_bounce).toBe(1);
    expect(results.body.bounce).toBe(0); // recorded as a SOFT bounce, not a hard one
  });

  // REAL single-lead flow (replaces the old fixture that faked the streak by
  // loading one address as N separate leads so a single tick fired N sends —
  // which only "worked" because a send reset the streak, the very defect this
  // fix removes). Here ONE lead runs a threshold-length sequence over alternating
  // tick->poll cycles: each send produces exactly one async soft bounce on the
  // next poll, and no send resets the streak, so it accrues to the threshold.
  it("REAL flow: one lead, alternating tick/poll cycles, suppressed only after the threshold-th soft bounce", async () => {
    const { tenantId, token } = await setupReadyTenant("Real Streak Co", "realstreak.com");
    const email = "softbounce.real@leads-test.com";
    // A threshold-length sequence: step 1 is due immediately, each later step one
    // day later — so one send (and thus one soft bounce) becomes due per cycle.
    const sequence = Array.from({ length: SOFT_BOUNCE_SUPPRESS_THRESHOLD }, (_, i) => ({
      step: i + 1,
      subject: `Step ${i + 1}`,
      body: "Hi",
      delayDays: i === 0 ? 0 : 1,
    }));
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "real", offer: "x", leads: [{ email, firstName: "L", company: "Co" }], sequence, stopOnReply: true }),
    });

    for (let cycle = 1; cycle <= SOFT_BOUNCE_SUPPRESS_THRESHOLD; cycle++) {
      if (cycle > 1) await tenantStub(tenantId).advanceClock(ONE_DAY_MS); // make the next step due
      await tenantStub(tenantId).tick(); // sends this cycle's step (no streak reset)
      const poll = await tenantStub(tenantId).pollInbox();
      expect(poll.bounces).toBe(1); // exactly this cycle's async soft bounce

      if (cycle < SOFT_BOUNCE_SUPPRESS_THRESHOLD) {
        expect(await suppressionCount(tenantId, email)).toBe(0); // below threshold: still tallying
        expect(await leadStatus(tenantId)).toBe("active"); // sequence continues
      }
    }

    // The threshold-th soft bounce escalates to a permanent suppression.
    expect(await suppressionCount(tenantId, email)).toBe(1);
    expect(await leadStatus(tenantId)).toBe("bounced");
    const reason = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ reason: string }>(`SELECT reason FROM suppressions WHERE email = ?`, email).one().reason,
    );
    expect(reason).toBe("soft_bounce");
  });

  // A reply is the ONLY signal that restarts the streak. soft x2 -> reply ->
  // soft must NOT suppress (streak restarted at 1, not continued to 3). The
  // sandbox classifier can't make one address BOTH soft-bounce and reply, so we
  // script the inbound poll stream directly (the realistic mixed sequence).
  it("a reply restarts the streak: soft x2, reply, soft => NOT suppressed", async () => {
    const { tenantId } = await setupReadyTenant("Reply Reset Co", "replyreset.com");
    const email = "prospect.reset@leads-test.com"; // neutral local-part: sandbox emits nothing on its own

    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      await instance.launchCampaign({
        name: "reset",
        offer: "x",
        leads: [{ email, firstName: "L", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
        timezone: "UTC",
        sendWindow: { startHour: 0, endHour: 23 },
        stopOnReply: false, // sequence-cancel semantics are irrelevant to the streak assertion
      });
      await instance.tick(); // sends step 1 -> establishes a thread + mailbox (neutral recipient: no auto event)

      const threadId = state.storage.sql
        .exec<{ thread_id: string }>(`SELECT thread_id FROM scheduled_sends LIMIT 1`)
        .one().thread_id;
      const mailboxEmail = state.storage.sql
        .exec<{ email: string }>(`SELECT email FROM mailboxes LIMIT 1`)
        .one().email;

      // Distinct message ids so the events dedupe index counts each soft bounce
      // (a repeated id would be OR IGNORE'd at the event layer and never tallied).
      const soft = (n: number): PolledEvent => ({
        kind: "bounce",
        mailboxEmail,
        threadId,
        originalMessageId: `<soft-${n}@x.com>`,
        toEmail: email,
        reason: "soft bounce 4.2.2 mailbox_full",
        severity: "soft",
        receivedAt: 1000 + n,
      });
      const reply: PolledEvent = {
        kind: "reply",
        mailboxEmail,
        threadId,
        messageId: "<reply-1@x.com>",
        fromEmail: email,
        body: "yes, interested",
        receivedAt: 2000,
      };
      const scripted: PolledEvent[][] = [[soft(1)], [soft(2)], [reply], [soft(3)]];
      let i = 0;
      const port = (instance as unknown as { adapters: { email: { poll: (m: string, c: number) => Promise<PollResult> } } }).adapters.email;
      port.poll = async () => ({ events: scripted[i++] ?? [], cursor: 0 });

      const streak = () =>
        state.storage.sql.exec<{ n: number }>(`SELECT COALESCE((SELECT streak FROM soft_bounces WHERE email = ?), 0) as n`, email).one().n;
      const rows = () =>
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM soft_bounces WHERE email = ?`, email).one().n;

      await instance.pollInbox(); // soft #1 -> streak 1
      await instance.pollInbox(); // soft #2 -> streak 2
      expect(streak()).toBe(2);

      await instance.pollInbox(); // reply -> streak reset (row deleted)
      expect(rows()).toBe(0);

      await instance.pollInbox(); // soft #3 -> streak RESTARTS at 1 (not continues to 3)
      expect(streak()).toBe(1);

      // The whole point: NOT suppressed. Without the reply-reset this would be
      // the 3rd soft in the streak -> a permanent suppression.
      const suppressed = state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM suppressions WHERE email = ?`, email).one().n;
      expect(suppressed).toBe(0);
    });
  });
});
