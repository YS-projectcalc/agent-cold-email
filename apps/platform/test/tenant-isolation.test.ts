import { describe, expect, it } from "vitest";
import { api, signup } from "./helpers.js";

interface AccountSummary {
  domains: number;
  mailboxes: number;
  campaigns: number;
  leads: number;
}

// CLAUDE.md rule h: "per-tenant isolation is mandatory in every
// query/DO access." Each tenant is a wholly separate TenantDO instance with
// its own SQLite storage, so this isn't just a WHERE-clause filter — a
// second tenant's token literally routes to a different DO. This test
// proves that architectural isolation holds end-to-end over HTTP.
describe("tenant isolation — a second tenant cannot see the first tenant's data", () => {
  it("blocks cross-tenant reads of campaigns, inbox, and account data", async () => {
    const tenant1 = await signup("Tenant One", "one@isolation-test.example");
    const tenant2 = await signup("Tenant Two", "two@isolation-test.example");
    expect(tenant1.tenantId).not.toBe(tenant2.tenantId);
    expect(tenant1.token).not.toBe(tenant2.token);

    await api("/setup-infrastructure", {
      method: "POST",
      token: tenant1.token,
      body: JSON.stringify({
        brand: "Tenant One",
        primaryDomain: "tenant-one.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 One St",
        senderIdentity: "Sender <s@tenant-one.com>",
      }),
    });
    const campaignRes = await api<{ campaignId: string }>("/campaigns", {
      method: "POST",
      token: tenant1.token,
      body: JSON.stringify({
        name: "Tenant one campaign",
        offer: "x",
        leads: [{ email: "lead@tenant-one-leads.com", firstName: "L", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    const tenant1CampaignId = campaignRes.body.campaignId;

    // tenant2 has done nothing yet — its own account must show zero infra.
    const tenant2Account = await api<AccountSummary>("/account", { token: tenant2.token });
    expect(tenant2Account.body.domains).toBe(0);
    expect(tenant2Account.body.mailboxes).toBe(0);
    expect(tenant2Account.body.campaigns).toBe(0);
    expect(tenant2Account.body.leads).toBe(0);

    // tenant1's own account correctly shows its infra (control: proves the
    // zeroes above aren't just a broken account() implementation).
    const tenant1Account = await api<AccountSummary>("/account", { token: tenant1.token });
    expect(tenant1Account.body.domains).toBe(1);
    expect(tenant1Account.body.mailboxes).toBe(1);
    expect(tenant1Account.body.campaigns).toBe(1);
    expect(tenant1Account.body.leads).toBe(1);

    // tenant2's inbox must be empty, not tenant1's threads.
    const tenant2Inbox = await api<unknown[]>("/inbox", { token: tenant2.token });
    expect(tenant2Inbox.body).toEqual([]);

    // tenant2 using tenant1's campaign id must NOT reach tenant1's data —
    // it 404s because that campaign id doesn't exist in tenant2's own DO storage.
    const crossRead = await api(`/campaigns/${tenant1CampaignId}/results`, { token: tenant2.token });
    expect(crossRead.status).toBe(404);

    // an invalid/unknown token is rejected outright.
    const noAuth = await api("/account", { token: "cs_live_not-a-real-token" });
    expect(noAuth.status).toBe(401);
  });
});
