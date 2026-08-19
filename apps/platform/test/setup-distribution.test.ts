import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { resolveDistribution, SetupInfrastructureInput } from "@coldstart/shared";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, tenantStub } from "./helpers.js";

// I4 — PER-DOMAIN DISTRIBUTION (founder ruling Q2, design §7.3).
//
// `inboxesEach` is uniform across ordinals, so "5 mailboxes over 2 domains" was
// not expressible in this API at all: the closest ask was `{domains:2,
// inboxesEach:3}`, which provisions SIX and bills for six. An overshoot the
// customer is told about is a product limitation; one discovered on the invoice
// is a defect — and the recommendation this wave emits has to be an EXACT fit
// or it is recommending a bill increase.
//
// ADDITIVE. `inboxesEach` is untouched and every existing caller is
// byte-identical: `resolveDistribution` widens it to a uniform distribution at
// the boundary, so there is ONE target type downstream and no dual authority.

function body(over: Record<string, unknown>): Record<string, unknown> {
  return {
    brand: "Distribution Co",
    primaryDomain: "distributionco.com",
    domains: 2,
    inboxesEach: 3,
    persona: "Sender",
    physicalAddress: "1 Main St",
    senderIdentity: "Sales Team",
    ...over,
  };
}

describe("I4 — the distribution at the boundary", () => {
  it("accepts a distribution whose length matches `domains`", () => {
    expect(SetupInfrastructureInput.safeParse(body({ distribution: [3, 2] })).success).toBe(true);
  });

  it("rejects a distribution whose length disagrees with `domains`, naming the field", () => {
    const parsed = SetupInfrastructureInput.safeParse(body({ domains: 3, distribution: [3, 2] }));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues.find((i) => i.path.join(".") === "distribution");
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("domains");
  });

  it("rejects a per-element count outside the same 1..10 bound `inboxesEach` carries", () => {
    expect(SetupInfrastructureInput.safeParse(body({ distribution: [3, 0] })).success).toBe(false);
    expect(SetupInfrastructureInput.safeParse(body({ distribution: [3, 11] })).success).toBe(false);
  });

  it("rejects more ordinals than the 20-domain ceiling", () => {
    const twentyOne = Array.from({ length: 21 }, () => 1);
    expect(SetupInfrastructureInput.safeParse(body({ domains: 21, distribution: twentyOne })).success).toBe(false);
  });

  it("an omitted distribution still parses — this is additive", () => {
    expect(SetupInfrastructureInput.safeParse(body({})).success).toBe(true);
  });
});

describe("I4 — resolveDistribution is the ONE target type", () => {
  it("widens a legacy uniform ask", () => {
    expect(resolveDistribution({ domains: 3, inboxesEach: 2 })).toEqual([2, 2, 2]);
  });

  it("a supplied distribution is the target — `inboxesEach` is only the shorthand for one", () => {
    expect(resolveDistribution({ domains: 2, inboxesEach: 3, distribution: [3, 2] })).toEqual([3, 2]);
  });
});

describe("I4 — end to end", () => {
  async function readMailboxes(tenantId: string): Promise<string[]> {
    return runInDurableObject(tenantStub(tenantId), (_i, state) =>
      state.storage.sql
        .exec<{ email: string }>(`SELECT email FROM mailboxes WHERE released_at IS NULL ORDER BY email`)
        .toArray()
        .map((r) => r.email),
    );
  }

  async function readIntentSpecs(tenantId: string): Promise<{ key: string; inboxes_each: number | null }[]> {
    return runInDurableObject(tenantStub(tenantId), (_i, state) =>
      state.storage.sql
        .exec<{ key: string; inboxes_each: number | null }>(
          `SELECT key, inboxes_each FROM domain_intents WHERE tenant_id = ? ORDER BY key`,
          tenantId,
        )
        .toArray(),
    );
  }

  it("provisions the per-ordinal counts, and slot ordinals stay keyed on (ordinal, slot)", async () => {
    await seedBenignSdnList();
    const { token, tenantId } = await mintTenant("Distribution Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const res = await api<{ billing?: { provisionedAfter: number } }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify(body({ domains: 2, distribution: [2, 1] })),
    });
    expect(res.status).toBe(202);

    const mailboxes = await readMailboxes(tenantId);
    expect(mailboxes).toHaveLength(3);
    // Address determinism under a distribution (gate R7's failed attack):
    // `managedMailboxAddress` is keyed on (ordinal, slot) and NEVER on the
    // per-domain count, so ordinal 1's single slot is still slot 0 -> "...21@".
    const localParts = mailboxes.map((e) => e.split("@")[0]).sort();
    expect(localParts).toEqual(["sender11", "sender12", "sender21"]);
    expect(res.body?.billing?.provisionedAfter).toBe(3);
  });

  it("persists the DESIRED spec per ordinal, not a uniform number", async () => {
    await seedBenignSdnList();
    const { token, tenantId } = await mintTenant("Distribution Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify(body({ domains: 2, distribution: [2, 1] })),
    });

    const specs = await readIntentSpecs(tenantId);
    expect(specs.map((s) => s.inboxes_each)).toEqual([2, 1]);
  });

  it("a uniform `inboxesEach` call is byte-identical to the distribution that widens from it", async () => {
    await seedBenignSdnList();
    const { token: uniformToken, tenantId: uniformTenant } = await mintTenant("Distribution Co", "managed");
    await activatePaidPlan(uniformTenant, "managed");
    const { token: explicitToken, tenantId: explicitTenant } = await mintTenant("Distribution Co", "managed");
    await activatePaidPlan(explicitTenant, "managed");

    await api("/setup-infrastructure", { method: "POST", token: uniformToken, body: JSON.stringify(body({ domains: 2, inboxesEach: 2 })) });
    await api("/setup-infrastructure", {
      method: "POST",
      token: explicitToken,
      body: JSON.stringify(body({ domains: 2, inboxesEach: 2, distribution: [2, 2] })),
    });

    const uniformParts = (await readMailboxes(uniformTenant)).map((e) => e.split("@")[0]).sort();
    const explicitParts = (await readMailboxes(explicitTenant)).map((e) => e.split("@")[0]).sort();
    expect(explicitParts).toEqual(uniformParts);
    expect((await readIntentSpecs(uniformTenant)).map((s) => s.inboxes_each)).toEqual(
      (await readIntentSpecs(explicitTenant)).map((s) => s.inboxes_each),
    );
  });

  it("the sum is cap-checked — a distribution over the plan ceiling is a 400, not a partial buy", async () => {
    await seedBenignSdnList();
    const { token, tenantId } = await mintTenant("Distribution Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    // 20 ordinals x 10 = 200 mailboxes, well past the 60-mailbox self-serve cap.
    const over = Array.from({ length: 20 }, () => 10);
    const res = await api<{ error?: string }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify(body({ domains: 20, distribution: over })),
    });
    expect(res.status).toBe(400);
    expect(res.body?.error).toContain("mailboxes");
  });

  it("quoteOnly prices the distribution exactly, with no overshoot", async () => {
    await seedBenignSdnList();
    const { token, tenantId } = await mintTenant("Distribution Co", "managed");
    await activatePaidPlan(tenantId, "managed");

    const res = await api<{ quoteOnly: boolean; billing: { provisionedAfter: number } }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify(body({ domains: 2, distribution: [3, 2], quoteOnly: true })),
    });
    expect(res.status).toBe(200);
    // The exact fit: 5, not the 6 that `{domains:2, inboxesEach:3}` would quote.
    expect(res.body.billing.provisionedAfter).toBe(5);
  });
});
