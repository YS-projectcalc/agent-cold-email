import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

interface InfraStatus {
  mailboxHealth: { email: string; lastPolledAt: number | null }[];
}

// SPEC.md §19.2/§19.6/[F7] — `mailboxes.last_polled_at` is written by every
// runPollInbox() poll (engine/reply-processor.ts:236) but was never returned
// by getInfrastructureStatus()/MailboxHealthReport — the dashboard's
// mailbox_health widget + Settings->Mailboxes "last polled" claim (§19.6)
// had nothing to read. This asserts the field is present end-to-end.
describe("GET /infrastructure-status — mailboxHealth[].lastPolledAt (§19.2/[F7])", () => {
  it("is null before any poll, then the poll timestamp after pollInbox() runs", async () => {
    const { tenantId, token } = await signup("Last Polled Co", "founder@lastpolledco.test");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Last Polled Co",
        primaryDomain: "lastpolledco.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 Test St",
        senderIdentity: "Sender <s@lastpolledco.com>",
      }),
    });

    const beforePoll = await api<InfraStatus>("/infrastructure-status", { token });
    expect(beforePoll.status).toBe(200);
    expect(beforePoll.body.mailboxHealth).toHaveLength(1);
    expect(beforePoll.body.mailboxHealth[0]!.lastPolledAt).toBeNull();

    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
    await tenantStub(tenantId).pollInbox();

    const afterPoll = await api<InfraStatus>("/infrastructure-status", { token });
    const mbx = afterPoll.body.mailboxHealth[0]!;
    expect(mbx.lastPolledAt).not.toBeNull();
    expect(typeof mbx.lastPolledAt).toBe("number");

    // A second, later poll advances the marker again (every poll re-stamps it,
    // including a zero-event one — reply-processor.ts's runPollInbox comment).
    await tenantStub(tenantId).advanceClock(ONE_DAY_MS);
    await tenantStub(tenantId).pollInbox();
    const afterSecondPoll = await api<InfraStatus>("/infrastructure-status", { token });
    expect(afterSecondPoll.body.mailboxHealth[0]!.lastPolledAt).toBeGreaterThan(mbx.lastPolledAt!);
  });
});
