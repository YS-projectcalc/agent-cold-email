import { describe, expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import type { EngineMailboxClient } from "../src/engine/engine-mailbox-client.js";
import { teardownTenant } from "../src/engine/lifecycle.js";
import { activatePaidPlan, api, mintTenant, tenantStub, withTenantContext } from "./helpers.js";

interface TeardownSummary {
  reason: string;
  effective: string;
  domainsReleased: number;
  mailboxesReleased: number;
  campaignsStopped: number;
  annualDomainLiabilityCents: number;
}

interface CancelResponse {
  alreadyCanceled: boolean;
  billingState: string;
  effective: string;
  teardown: TeardownSummary | null;
}

interface AccountResponse {
  status: string;
  billingState: string;
  domains: number;
  mailboxes: number;
  teardown: TeardownSummary | null;
}

async function provisionAndLaunch(token: string): Promise<void> {
  const infra = await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand: "Cancel Co",
      primaryDomain: "cancel-co.com",
      domains: 2,
      inboxesEach: 2,
      persona: "Sender",
      physicalAddress: "1 Cancel St",
      senderIdentity: "Sender <s@cancel-co.com>",
    }),
  });
  expect(infra.status).toBe(202);

  const camp = await api("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({
      name: "Pre-cancel campaign",
      offer: "x",
      leads: [{ email: "lead@cancel-leads.com", firstName: "L", company: "Co" }],
      sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
    }),
  });
  expect(camp.status).toBe(201);
}

// D5.1 — voluntary cancellation + infra teardown/reclaim.
describe("POST /cancel — voluntary cancellation + teardown/reclaim (D5)", () => {
  // Adversarial panel-03 finding #7: the DEFAULT (end-of-period) cancel used to
  // tear everything down IMMEDIATELY while claiming effective:end_of_period —
  // the customer paid for a period during which they had zero infra. Teardown
  // is now DEFERRED for end_of_period; infra stays live (the tick freeze still
  // stops any new spend). This test FAILS on the old code (old code returns a
  // non-null teardown with 2 domains released + drops the live counts to 0).
  it("end_of_period cancel DEFERS teardown — domains/mailboxes stay live until the period boundary", async () => {
    const { tenantId, token } = await mintTenant("Cancel Co", "launch");
    await activatePaidPlan(tenantId, "launch");
    await provisionAndLaunch(token);

    // Default cancel = end-of-billing-period.
    const cancel = await api<CancelResponse>("/cancel", { method: "POST", token });
    expect(cancel.status).toBe(200);
    expect(cancel.body.alreadyCanceled).toBe(false);
    expect(cancel.body.billingState).toBe("canceling");
    expect(cancel.body.effective).toBe("end_of_period");
    // No teardown yet — deferred to the period boundary.
    expect(cancel.body.teardown).toBeNull();

    // account() shows canceling, but the infra is STILL LIVE and un-reclaimed.
    const account = await api<AccountResponse>("/account", { token });
    expect(account.body.billingState).toBe("canceling");
    expect(account.body.domains).toBe(2);
    expect(account.body.mailboxes).toBe(4);
    expect(account.body.teardown).toBeNull();

    // Ground truth: nothing released, nothing paused, no liability booked yet.
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const activeDomains = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE tenant_id = ? AND status = 'active'`, tenantId)
        .one().n;
      expect(activeDomains).toBe(2);
      const liveMailboxes = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, tenantId)
        .one().n;
      expect(liveMailboxes).toBe(4);
      const liability = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM ledger_entries WHERE tenant_id = ? AND kind = 'liability'`, tenantId)
        .one().n;
      expect(liability).toBe(0);
    });

    // But 'canceling' is a FROZEN state (finding #5): the tick sends nothing
    // even though the step-1 send is due (delayDays 0) and mailboxes are live.
    const frozenTick = await tenantStub(tenantId).tick();
    expect(frozenTick.sent).toBe(0);
  });

  it("immediate cancel releases all infra, stops campaigns, books annual-domain liability, and reflects in account()", async () => {
    const { tenantId, token } = await mintTenant("Cancel Co", "launch");
    await activatePaidPlan(tenantId, "launch");
    await provisionAndLaunch(token);

    const cancel = await api<CancelResponse>("/cancel", {
      method: "POST",
      token,
      body: JSON.stringify({ immediate: true }),
    });
    expect(cancel.status).toBe(200);
    expect(cancel.body.alreadyCanceled).toBe(false);
    expect(cancel.body.billingState).toBe("canceled");
    expect(cancel.body.effective).toBe("immediate");
    expect(cancel.body.teardown).not.toBeNull();
    const teardown = cancel.body.teardown!;
    expect(teardown.reason).toBe("voluntary_cancel");
    expect(teardown.effective).toBe("immediate");
    expect(teardown.domainsReleased).toBe(2);
    expect(teardown.mailboxesReleased).toBe(4);
    expect(teardown.campaignsStopped).toBe(1);
    // 2 domains reclaimed at effectively the start of their annual term ->
    // near the full 2 x $11.08 = $22.16 liability (integer cents).
    expect(teardown.annualDomainLiabilityCents).toBeGreaterThan(2000);
    expect(teardown.annualDomainLiabilityCents).toBeLessThanOrEqual(2216);

    // account() reflects the canceled state + teardown summary.
    const account = await api<AccountResponse>("/account", { token });
    expect(account.body.billingState).toBe("canceled");
    expect(account.body.teardown).not.toBeNull();
    expect(account.body.teardown?.domainsReleased).toBe(2);
    expect(account.body.teardown?.mailboxesReleased).toBe(4);

    // Ground-truth the DO state: every domain released, every mailbox released
    // + paused (send-side kill), every campaign paused, one liability ledger
    // row per domain.
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const activeDomains = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE tenant_id = ? AND status != 'released'`, tenantId)
        .one().n;
      expect(activeDomains).toBe(0);

      const liveMailboxes = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, tenantId)
        .one().n;
      expect(liveMailboxes).toBe(0);

      const unpausedMailboxes = state.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND deliv_status != 'paused'`,
          tenantId,
        )
        .one().n;
      expect(unpausedMailboxes).toBe(0);

      const activeCampaigns = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM campaigns WHERE tenant_id = ? AND status = 'active'`, tenantId)
        .one().n;
      expect(activeCampaigns).toBe(0);

      const liability = state.storage.sql
        .exec<{ n: number; total: number | null }>(
          `SELECT COUNT(*) as n, SUM(amount_cents) as total FROM ledger_entries WHERE tenant_id = ? AND kind = 'liability'`,
          tenantId,
        )
        .one();
      expect(liability.n).toBe(2);
      expect(liability.total).toBe(teardown.annualDomainLiabilityCents);
    });
  });

  it("is idempotent — a re-cancel is a no-op that never double-books liability or re-releases infra", async () => {
    const { tenantId, token } = await mintTenant("Cancel Co", "launch");
    await activatePaidPlan(tenantId, "launch");
    await provisionAndLaunch(token);

    const first = await api<CancelResponse>("/cancel", {
      method: "POST",
      token,
      body: JSON.stringify({ immediate: true }),
    });
    expect(first.body.alreadyCanceled).toBe(false);
    const firstLiability = first.body.teardown!.annualDomainLiabilityCents;

    // Re-cancel — must return the EXISTING teardown, not apply a second one.
    const second = await api<CancelResponse>("/cancel", {
      method: "POST",
      token,
      body: JSON.stringify({ immediate: true }),
    });
    expect(second.status).toBe(200);
    expect(second.body.alreadyCanceled).toBe(true);
    expect(second.body.teardown!.domainsReleased).toBe(2);
    expect(second.body.teardown!.annualDomainLiabilityCents).toBe(firstLiability);

    // Exactly 2 liability rows total (one per domain) — not 4.
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const n = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM ledger_entries WHERE tenant_id = ? AND kind = 'liability'`, tenantId)
        .one().n;
      expect(n).toBe(2);
    });
  });

  // Adversarial panel-03 finding #8 — /cancel had no Content-Length body cap.
  it("rejects an over-cap request body with 413 (finding #8)", async () => {
    const { token } = await mintTenant("Cancel Body Co", "launch");
    const oversized = JSON.stringify({ immediate: false, pad: "x".repeat(9 * 1024) });
    const res = await api("/cancel", { method: "POST", token, body: oversized });
    expect(res.status).toBe(413);
  });
});

// I3 credential lifecycle (adversary i3i4-build-review-2026-07-23 finding 2,
// NON-BLOCKING): the engine's DELETE/revoke path was fully coded+tested but
// had ZERO production callers — a canceled tenant's released mailboxes left
// their pushed OAuth refresh tokens lingering on the engine daemon forever.
// teardownTenant now calls revokePushedMailboxCredentials for every released
// mailbox via an injectable `engineClient` seam (mirrors mailbox-credential-
// push.ts's CredentialPushDeps pattern).
describe("teardownTenant — I3 credential revoke wired into cancel/teardown (best-effort)", () => {
  async function releasedMailboxEmails(tenantId: string): Promise<string[]> {
    return withTenantContext(tenantId, (ctx) =>
      ctx.sql
        .exec<{ email: string }>(`SELECT email FROM mailboxes WHERE tenant_id = ? ORDER BY email ASC`, tenantId)
        .toArray()
        .map((r) => r.email),
    );
  }

  it("calls the engine's revoke for every released mailbox when the engine is armed", async () => {
    const { tenantId, token } = await mintTenant("Revoke Wired Co", "launch");
    await activatePaidPlan(tenantId, "launch");
    await provisionAndLaunch(token);
    const expectedEmails = await releasedMailboxEmails(tenantId);
    expect(expectedEmails).toHaveLength(4);

    const calls: string[] = [];
    const fakeClient = {
      isConfigured: true,
      removeMailbox: async (email: string) => {
        calls.push(email);
        return { email, removed: true };
      },
    } as unknown as EngineMailboxClient;

    const summary = await withTenantContext(tenantId, (ctx) =>
      teardownTenant(ctx, { reason: "voluntary_cancel", effective: "immediate" }, fakeClient),
    );
    expect(summary.mailboxesReleased).toBe(4);
    expect(calls.sort()).toEqual(expectedEmails.sort());
  });

  it("teardown still succeeds (correct summary, no throw) when the engine is armed but unreachable — best-effort never blocks/fails the cancel", async () => {
    const { tenantId, token } = await mintTenant("Revoke Unreachable Co", "launch");
    await activatePaidPlan(tenantId, "launch");
    await provisionAndLaunch(token);
    const expectedEmails = await releasedMailboxEmails(tenantId);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeClient = {
      isConfigured: true,
      removeMailbox: async () => {
        throw new Error("engine unreachable");
      },
    } as unknown as EngineMailboxClient;

    const summary = await withTenantContext(tenantId, (ctx) =>
      teardownTenant(ctx, { reason: "voluntary_cancel", effective: "immediate" }, fakeClient),
    );
    expect(summary.mailboxesReleased).toBe(expectedEmails.length);
    expect(summary.domainsReleased).toBe(2);
    // One best-effort log per failed revoke — never an uncaught throw.
    expect(spy).toHaveBeenCalledTimes(expectedEmails.length);
    vi.restoreAllMocks();
  });

  it("is a no-op (no revoke calls, no throw) when the engine is dark — the deployed default, matching every OTHER cancel test in this file", async () => {
    const { tenantId, token } = await mintTenant("Revoke Dark Co", "launch");
    await activatePaidPlan(tenantId, "launch");
    await provisionAndLaunch(token);

    // No engineClient injected -> the production default (built from
    // ctx.env, which has no ENGINE_BASE_URL/ENGINE_AUTH_SECRET in tests).
    const summary = await withTenantContext(tenantId, (ctx) => teardownTenant(ctx, { reason: "voluntary_cancel", effective: "immediate" }));
    expect(summary.mailboxesReleased).toBe(4);
  });
});
