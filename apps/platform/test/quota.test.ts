import { describe, expect, it } from "vitest";
import { api, mintTenant, signup } from "./helpers.js";

// B1 brief: "a Launch tenant requesting 20 mailboxes -> rejected; within-quota
// -> allowed; demo tenant -> 0 real (sandbox only, already guarded)."
// PLAN_QUOTAS.launch = { domains: 2, mailboxes: 5 } (packages/shared/src/pricing.ts).

describe("setup_infrastructure enforces the plan's provisioning cap (engine/quota.ts)", () => {
  it("rejects a Launch tenant's request that would exceed the plan's mailbox quota", async () => {
    const { token } = await mintTenant("Over Quota Co", "launch");
    const res = await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Over Quota Co",
        primaryDomain: "overquota.com",
        domains: 1, // within Launch's domain quota (2)
        inboxesEach: 10, // 10 mailboxes > Launch's mailbox quota (5)
        persona: "Sender",
        physicalAddress: "1 Quota St",
        senderIdentity: "Sender <s@overquota.com>",
      }),
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/mailboxes/);
  });

  it("allows a Launch tenant's request that stays within the plan's quota", async () => {
    const { token } = await mintTenant("Within Quota Co", "launch");
    const res = await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Within Quota Co",
        primaryDomain: "withinquota.com",
        domains: 2, // == Launch's domain quota
        inboxesEach: 2, // 4 mailboxes <= Launch's mailbox quota (5)
        persona: "Sender",
        physicalAddress: "1 Quota St",
        senderIdentity: "Sender <s@withinquota.com>",
      }),
    });
    expect(res.status).toBe(202);

    const status = await api<{ domains: number; mailboxes: number }>("/infrastructure-status", { token });
    expect(status.body.domains).toBe(2);
    expect(status.body.mailboxes).toBe(4);
  });

  it("rejects a demo tenant's request beyond the sandbox exploration cap (distinct runaway guard)", async () => {
    const { token } = await signup("Big Demo Co", "founder@bigdemo.test");
    const res = await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Big Demo Co",
        primaryDomain: "bigdemo.com",
        domains: 10, // > SANDBOX_PROVISIONING_CAP.domains (5)
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 Demo St",
        senderIdentity: "Sender <s@bigdemo.com>",
      }),
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/domains/);
  });

  it("account() reports the plan's quota alongside current usage", async () => {
    const { token } = await mintTenant("Quota Report Co", "growth");
    const account = await api<{ plan: string; quota: { domains: number; mailboxes: number } }>("/account", { token });
    expect(account.body.plan).toBe("growth");
    expect(account.body.quota).toEqual({ domains: 6, mailboxes: 20 });
  });
});
