import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

// Backend gaps brief item 2 / M4 — GET /threads/:id gains `mailboxEmail`.
// Without it, the composer's "Replying from X" line (apps/dashboard) depended
// on the inbox LIST row already being loaded client-side; a deep-link
// (?thread=<id>) that opens the thread detail directly (no list row in
// memory) had nothing to read it from. `getThread` resolves it the SAME way
// `replyToThread` already does (the mailbox that sent the thread's last step),
// not a parallel lookup.
interface ThreadDetail {
  threadId: string;
  campaignId: string;
  leadId: string;
  leadEmail: string;
  mailboxEmail: string | null;
  messages: { type: string }[];
}

describe("GET /threads/:id — mailboxEmail (backend gaps brief item 2)", () => {
  it("returns the sending mailbox's email once a step has actually sent", async () => {
    const { tenantId, token } = await signup("Thread Mailbox Co", "founder@threadmailboxco.com");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Thread Mailbox Co",
        primaryDomain: "threadmailboxco.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 Test St",
        senderIdentity: "Sender <s@threadmailboxco.com>",
      }),
    });
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email: "lead@threadmailboxco-leads.com", firstName: "L", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    await tenantStub(tenantId).tick();

    const inbox = await api<{ threads: { threadId: string; mailboxEmail: string | null }[] }>("/inbox", { token });
    const row = inbox.body.threads[0]!;

    const thread = await api<ThreadDetail>(`/threads/${row.threadId}`, { token });
    expect(thread.status).toBe(200);
    expect(thread.body.mailboxEmail).toBe(row.mailboxEmail);
    expect(thread.body.mailboxEmail).toMatch(/^.+@.+\..+$/);
  });

  it("is null before any step has sent (scheduled_sends has no mailbox_id yet)", async () => {
    const { tenantId, token } = await signup("Thread Mailbox Presend Co", "founder@threadmailboxpresendco.com");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Thread Mailbox Presend Co",
        primaryDomain: "threadmailboxpresendco.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 Test St",
        senderIdentity: "Sender <s@threadmailboxpresendco.com>",
      }),
    });
    // NOT ticked yet — the campaign's scheduled_sends row exists but no
    // mailbox_id has been assigned (that only happens at send time), so no
    // thread has a recorded event and no inbox row exists to read the id
    // from. Pull the thread id straight out of scheduled_sends (test-harness
    // DO-internals access, same pattern as test/demo-run.test.ts).
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email: "lead@threadmailboxpresendco-leads.com", firstName: "L", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 2 }],
      }),
    });

    const threadId = await runInDurableObject(tenantStub(tenantId), (_instance, state) =>
      state.storage.sql.exec<{ thread_id: string }>(`SELECT thread_id FROM scheduled_sends LIMIT 1`).one().thread_id,
    );

    const thread = await api<ThreadDetail>(`/threads/${threadId}`, { token });
    expect(thread.status).toBe(200);
    expect(thread.body.mailboxEmail).toBeNull();
  });
});
