import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

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

const TWO_STEP = [
  { step: 1, subject: "First", body: "Hello", delayDays: 0 },
  { step: 2, subject: "Second", body: "Following up", delayDays: 2 },
];

async function launchWithStopOnReply(token: string, stopOnReply: boolean) {
  return api<{ campaignId: string }>("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({
      name: `stopOnReply=${stopOnReply}`,
      offer: "x",
      leads: [{ email: "reply.prospect@leads-test.com", firstName: "R", company: "Co" }],
      sequence: TWO_STEP,
      stopOnReply,
    }),
  });
}

function countPending(tenantId: string): Promise<number> {
  return runInDurableObject(tenantStub(tenantId), async (_instance, state) =>
    state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM scheduled_sends WHERE status = 'pending'`).one().n,
  );
}

function leadStatus(tenantId: string): Promise<string> {
  return runInDurableObject(tenantStub(tenantId), async (_instance, state) =>
    state.storage.sql.exec<{ global_status: string }>(`SELECT global_status FROM leads LIMIT 1`).one().global_status,
  );
}

// panel-02 correctness-engine: the stop_on_reply flag was stored but never
// read — replies always cancelled remaining steps. This FAILS on the old code
// (step 2 gets cancelled even though stopOnReply=false).
describe("reply processing respects the campaign stop_on_reply flag (finding #4)", () => {
  it("does NOT cancel remaining steps after a reply when stopOnReply=false", async () => {
    const { tenantId, token } = await setupReadyTenant("NoStop Co", "nostopco.com");
    const launched = await launchWithStopOnReply(token, false);

    await tenantStub(tenantId).tick(); // sends step 1 to the reply lead
    await tenantStub(tenantId).pollInbox(); // processes the sandbox reply

    // Reply is still recorded + status set unconditionally...
    const results = await api<{ reply: number }>(`/campaigns/${launched.body.campaignId}/results`, { token });
    expect(results.body.reply).toBe(1);
    expect(await leadStatus(tenantId)).toBe("replied");

    // ...but step 2 was NOT cancelled — it remains pending.
    expect(await countPending(tenantId)).toBe(1);
  });

  it("DOES cancel remaining steps after a reply when stopOnReply=true (control)", async () => {
    const { tenantId, token } = await setupReadyTenant("Stop Co", "stopco.com");
    await launchWithStopOnReply(token, true);

    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox();

    expect(await leadStatus(tenantId)).toBe("replied");
    expect(await countPending(tenantId)).toBe(0); // step 2 cancelled
  });
});
