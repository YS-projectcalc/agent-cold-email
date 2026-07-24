import { describe, expect, it } from "vitest";
import { api, mintTenant, signup } from "./helpers.js";

// Quantity-billing migration (design §4): the 3 tiers collapsed to one paid
// plan `managed` with the FLAT self-serve cap — 60 mailboxes, domains bundled
// at ceil(60/3)=20 (engine/quota.ts capFor). The cap is only the runaway guard
// on a single tenant's provisioning; the billed quantity is the live
// provisioned count (design §2). 61+ mailboxes is a custom quote (SPEC §18).

describe("setup_infrastructure enforces the flat self-serve provisioning cap (engine/quota.ts)", () => {
  it("rejects a managed tenant's request that would exceed the 60-mailbox self-serve cap", async () => {
    const { token } = await mintTenant("Over Quota Co", "managed");
    const res = await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Over Quota Co",
        primaryDomain: "overquota.com",
        domains: 7, // within the 20-domain bundle
        inboxesEach: 10, // 7 x 10 = 70 mailboxes > the 60-mailbox self-serve cap
        persona: "Sender",
        physicalAddress: "1 Quota St",
        senderIdentity: "Sender <s@overquota.com>",
      }),
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/mailboxes/);
  });

  it("allows a managed tenant's request that stays within the flat cap", async () => {
    const { token } = await mintTenant("Within Quota Co", "managed");
    const res = await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Within Quota Co",
        primaryDomain: "withinquota.com",
        domains: 2,
        inboxesEach: 2, // 4 mailboxes <= the 60-mailbox cap
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

  it("account() reports the flat managed-plan cap alongside current usage", async () => {
    const { token } = await mintTenant("Quota Report Co", "managed");
    const account = await api<{ plan: string; quota: { domains: number; mailboxes: number } }>("/account", { token });
    expect(account.body.plan).toBe("managed");
    expect(account.body.quota).toEqual({ domains: 20, mailboxes: 60 });
  });
});
