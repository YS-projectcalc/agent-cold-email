import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, signup, tenantStub } from "./helpers.js";

// ELEVATED finding (N2 in docs/adversarial/audit-dashboard-idempotency-2026-08-06.md),
// raised to blocking because auto-send is armed: a duplicate campaign is
// duplicate REAL cold outreach to the same prospects, plus quota burn and
// deliverability damage. The audit drove a sequential replay and a concurrent
// pair through `POST /campaigns` and got four identical "Q3 Outbound"
// campaigns, every one of them scheduled to send.
//
// The idempotency key already worked on both transports; what was missing was
// any protection for the caller that doesn't send one — which is every browser
// caller. A same-content launch inside the double-submit window is refused with
// a structured 409 naming the campaign that already exists.

interface CampaignRow {
  campaignId: string;
  name: string;
}

const LEADS = [{ email: "prospect@buyer.com", firstName: "P", company: "Buyer Co" }];
const SEQUENCE = [{ step: 1, subject: "Quick question", body: "Hi {{firstName}}", delayDays: 0 }];

function campaignBody(name: string) {
  return JSON.stringify({ name, offer: "10x your pipeline", leads: LEADS, sequence: SEQUENCE });
}

function launch(token: string, name: string, idempotencyKey?: string) {
  return api<{ campaignId?: string; error?: string; code?: string; existingCampaignId?: string }>("/campaigns", {
    method: "POST",
    token,
    body: campaignBody(name),
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
}

async function campaigns(token: string): Promise<CampaignRow[]> {
  const res = await api<CampaignRow[]>("/campaigns", { token });
  return res.body;
}

describe("ELEVATED — an identical campaign launch inside the double-submit window is refused", () => {
  it("a sequential unkeyed replay is a structured 409, not a second campaign", async () => {
    const { token } = await signup("Replay Campaign Co", "founder@replaycamp.com");

    const first = await launch(token, "Q3 Outbound");
    expect(first.status).toBe(201);

    const replay = await launch(token, "Q3 Outbound");

    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("duplicate_campaign");
    expect(replay.body.existingCampaignId).toBe(first.body.campaignId);
    expect(await campaigns(token)).toHaveLength(1);
  });

  it("a concurrent unkeyed double-submit creates exactly one campaign", async () => {
    const { token } = await signup("Concurrent Campaign Co", "founder@conccamp.com");

    const [a, b] = await Promise.all([launch(token, "Q3 Outbound"), launch(token, "Q3 Outbound")]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await campaigns(token)).toHaveLength(1);
  });

  it("still sends no duplicate work: the refused launch schedules nothing", async () => {
    const { tenantId, token } = await signup("No Dup Sends Co", "founder@nodupsends.com");

    await launch(token, "Q3 Outbound");
    await launch(token, "Q3 Outbound");

    const scheduled = await runInDurableObject(
      tenantStub(tenantId),
      (_i, state) =>
        state.storage.sql
          .exec<{ n: number }>(`SELECT COUNT(*) as n FROM scheduled_sends WHERE tenant_id = ?`, tenantId)
          .one().n,
    );
    expect(scheduled).toBe(1);
  });
});

describe("ELEVATED — legitimate launches are never blocked", () => {
  it("a DIFFERENT campaign launches straight away", async () => {
    const { token } = await signup("Distinct Campaign Co", "founder@distinctcamp.com");

    expect((await launch(token, "Q3 Outbound")).status).toBe(201);
    expect((await launch(token, "Q4 Outbound")).status).toBe(201);

    expect(await campaigns(token)).toHaveLength(2);
  });

  it("the same content relaunches once the double-submit window has passed", async () => {
    const { tenantId, token } = await signup("Window Campaign Co", "founder@windowcamp.com");
    await launch(token, "Q3 Outbound");

    // Age the first launch past the window. The guard measures REAL elapsed
    // time (a double-click is a wall-clock event), so this backdates the real
    // stamp, not the tenant's virtual clock.
    await runInDurableObject(tenantStub(tenantId), (_i, state) => {
      state.storage.sql.exec(`UPDATE campaigns SET launched_at_real = 1 WHERE tenant_id = ?`, tenantId);
    });

    expect((await launch(token, "Q3 Outbound")).status).toBe(201);
    expect(await campaigns(token)).toHaveLength(2);
  });

  it("a keyed retry still replays the first campaign instead of refusing it", async () => {
    const { token } = await signup("Keyed Campaign Co", "founder@keyedcamp.com");

    const first = await launch(token, "Q3 Outbound", "launch-1");
    const replay = await launch(token, "Q3 Outbound", "launch-1");

    expect(replay.status).toBe(201);
    expect(replay.body.campaignId).toBe(first.body.campaignId);
    expect(await campaigns(token)).toHaveLength(1);
  });
});
