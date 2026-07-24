import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { requestManagedByoMailboxes } from "../src/engine/byo-mailbox-composition.js";
import { registerByoDomain, pollByoDomainDns } from "../src/engine/byo-intake.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { api, mintTenant, seedBenignSdnList, signup, tenantStub, withTenantContext } from "./helpers.js";

// D4-build fix (quantity-billing build review 2026-07-24) — SPEC §18 "no silent
// capacity addition": EVERY mailbox-add response must return the proposed new
// count + projected monthly price, `provisionedAfter` reflecting REALITY (what
// landed) not the ask. These assert the `billing` field on the DEFAULT
// (quoteOnly:false) provision path of both add intents. RED on the old shape
// (there was no billing field on the default add response).

interface AddResult {
  jobId?: string;
  mailboxEmails?: string[];
  billing: { provisionedAfter: number; projectedMonthlyCents: number; formula: string };
}

describe("setup_infrastructure default add returns the §18 billing projection", () => {
  it("above the floor: billing reflects the actual provisioned count on the $10/mailbox curve", async () => {
    await seedBenignSdnList();
    const { token } = await mintTenant("Add Curve Co", "managed");
    const res = await api<AddResult>("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Add Curve Co",
        primaryDomain: "addcurve.com",
        domains: 3,
        inboxesEach: 2, // provisions 6 mailboxes
        persona: "Sender",
        physicalAddress: "1 St",
        senderIdentity: "Sender <s@addcurve.com>",
      }),
    });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toMatch(/^job_/);
    expect(res.body.billing.provisionedAfter).toBe(6);
    expect(res.body.billing.projectedMonthlyCents).toBe(4_900 + 6 * 1_000); // $109
    expect(res.body.billing.formula).toContain("$49");
  });

  it("floor-at-5: a 2-mailbox provision is billed at the $99 5-minimum (provisionedAfter=2, monthly=9900)", async () => {
    await seedBenignSdnList();
    const { token } = await mintTenant("Add Floor Co", "managed");
    const res = await api<AddResult>("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Add Floor Co",
        primaryDomain: "addfloor.com",
        domains: 1,
        inboxesEach: 2, // provisions 2 mailboxes -> below the 5 floor
        persona: "Sender",
        physicalAddress: "1 St",
        senderIdentity: "Sender <s@addfloor.com>",
      }),
    });
    expect(res.status).toBe(202);
    expect(res.body.billing.provisionedAfter).toBe(2); // reality, honest
    expect(res.body.billing.projectedMonthlyCents).toBe(9_900); // floored at the 5-minimum
  });

  it("capacity_pending partial: provisionedAfter reflects what LANDED, not the ask", async () => {
    await seedBenignSdnList();
    // Reset the account-level vendor tables (D1 is not rolled back per-test).
    await env.DB.prepare("DELETE FROM vendor_spend_entries").run();
    await env.DB.prepare("DELETE FROM vendor_spend_ledger").run();
    await env.DB.prepare("DELETE FROM vendor_slot_state").run();
    const saved = env.INBOXKIT_PLAN_SLOTS;
    (env as { INBOXKIT_PLAN_SLOTS?: string }).INBOXKIT_PLAN_SLOTS = "1"; // only ONE mailbox slot account-wide
    try {
      const { tenantId } = await mintTenant("Cap Partial Co", "managed");
      const result = await withTenantContext(tenantId, (base) => {
        // Force the bundle kind to 'real' so the spend/slot choke-point engages
        // (the sandbox ports still do the in-memory provision) — mirrors
        // spend-ceiling.test.ts's realCtx. The 2nd mailbox hits the slot cap.
        const ctx = { ...base, adapters: { ...base.adapters, kind: "real" as const } };
        return runSetupInfrastructure(
          ctx,
          {
            brand: "Cap Partial Co",
            primaryDomain: "cappartial.com",
            domains: 1,
            inboxesEach: 3, // ASK 3; only 1 slot -> 1 lands
            persona: "Sender",
            physicalAddress: "1 St",
            senderIdentity: "Sender <s@cappartial.com>",
            quoteOnly: false,
          },
          new SandboxOpsMailer(),
        );
      });
      if ("quoteOnly" in result) throw new Error("expected a provision result, got a quote");
      expect(result.jobId).toMatch(/^job_/);
      expect(result.billing.provisionedAfter).toBe(1); // what LANDED, not the ask (3)
      expect(result.billing.projectedMonthlyCents).toBe(9_900); // floored

      const live = await runInDurableObject(tenantStub(tenantId), async (_i, s) =>
        s.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, tenantId).one().n,
      );
      expect(live).toBe(1);
    } finally {
      (env as { INBOXKIT_PLAN_SLOTS?: string }).INBOXKIT_PLAN_SLOTS = saved;
    }
  });
});

describe("request_managed_byo_mailboxes default add returns the §18 billing projection", () => {
  afterEach(() => undefined);

  async function activeByoDomain(tenantId: string, domain: string) {
    const record = await withTenantContext(tenantId, (ctx) => registerByoDomain(ctx, { domain, domainRelationship: "fresh_standalone" }));
    await withTenantContext(tenantId, (ctx) => pollByoDomainDns(ctx, record.domainId));
    return record.domainId;
  }

  it("returns mailboxEmails AND the billing projection for the new count", async () => {
    const { tenantId } = await signup("Byo Add Billing Co", "byoadd@example.com");
    const domainId = await activeByoDomain(tenantId, "delegated-byoadd.com");

    const result = await withTenantContext(tenantId, (ctx) =>
      requestManagedByoMailboxes(ctx, domainId, { count: 2, quoteOnly: false }),
    );
    if (!("mailboxEmails" in result)) throw new Error("expected a provisioned result, got a quote");
    expect(result.mailboxEmails).toHaveLength(2);
    expect(result.billing.provisionedAfter).toBe(2);
    expect(result.billing.projectedMonthlyCents).toBe(9_900); // 2 mailboxes -> floored at the $99 minimum
    expect(result.billing.formula).toContain("$10/mailbox");
  });
});
