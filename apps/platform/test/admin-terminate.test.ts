import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { activatePaidPlan, adminApi, api, mintTenant, tenantStub } from "./helpers.js";

interface TerminateResponse {
  tenantId: string;
  terminated: boolean;
  enforcementLogged: boolean;
  suspended: boolean;
  alreadyTornDown: boolean;
  teardown: { domainsReleased: number; mailboxesReleased: number; campaignsStopped: number };
}

async function provision(token: string, brand: string): Promise<void> {
  const infra = await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain: `${brand.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`,
      domains: 2,
      inboxesEach: 2,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: `Sender <s@${brand.toLowerCase().replace(/[^a-z0-9]/g, "")}.com>`,
    }),
  });
  expect(infra.status).toBe(202);
  const camp = await api("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({
      name: `${brand} campaign`,
      offer: "x",
      leads: [{ email: `lead@${brand.toLowerCase().replace(/[^a-z0-9]/g, "")}-leads.com`, firstName: "L", company: "Co" }],
      sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
    }),
  });
  expect(camp.status).toBe(201);
}

async function seedSuppression(tenantId: string, email: string): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
    state.storage.sql.exec(
      `INSERT INTO suppressions (tenant_id, email, reason, ts) VALUES (?, ?, 'unsubscribe', ?)`,
      tenantId,
      email,
      Date.now(),
    );
  });
}

// D5.2 — abuse offboarding (executes the AUP consequence ladder). Required
// cases: admin terminate -> tenant suspended + infra reclaimed + suppression
// retained + enforcement_action logged; non-admin -> 401; and the isolation
// invariant: terminating tenant A leaves tenant B's infra untouched.
describe("POST /admin/tenants/:id/terminate — abuse offboarding (D5)", () => {
  it("non-admin (wrong or tenant token) is rejected 401 before any effect", async () => {
    const { tenantId } = await mintTenant("Term NoAuth Co", "launch");

    const wrongAdmin = await adminApi(`/admin/tenants/${tenantId}/terminate`, {
      method: "POST",
      adminToken: "not-the-admin-token",
      body: JSON.stringify({ reason: "spam" }),
    });
    expect(wrongAdmin.status).toBe(401);

    // A tenant's own bearer token must not reach the admin surface either.
    const { token } = await mintTenant("Term NoAuth2 Co", "launch");
    const tenantToken = await api(`/admin/tenants/${tenantId}/terminate`, {
      method: "POST",
      token,
      body: JSON.stringify({ reason: "spam" }),
    });
    expect(tenantToken.status).toBe(401);
  });

  it("suspends + reclaims infra + retains suppressions + logs enforcement, and leaves a second tenant untouched", async () => {
    const a = await mintTenant("Term A Co", "launch");
    await activatePaidPlan(a.tenantId, "launch");
    await provision(a.token, "TermA");
    await seedSuppression(a.tenantId, "optout@example.com");

    const b = await mintTenant("Term B Co", "launch");
    await activatePaidPlan(b.tenantId, "launch");
    await provision(b.token, "TermB");

    // Terminate A only.
    const term = await adminApi<TerminateResponse>(`/admin/tenants/${a.tenantId}/terminate`, {
      method: "POST",
      body: JSON.stringify({ reason: "spam-trap hits + third-party brand impersonation", evidence: { complaintRate: 0.04 } }),
    });
    expect(term.status).toBe(200);
    expect(term.body.terminated).toBe(true);
    expect(term.body.suspended).toBe(true);
    expect(term.body.enforcementLogged).toBe(true);
    expect(term.body.teardown.domainsReleased).toBe(2);
    expect(term.body.teardown.mailboxesReleased).toBe(4);
    expect(term.body.teardown.campaignsStopped).toBe(1);

    // A's token is now locked out — cannot re-provision to undo the reclaim.
    const aAccount = await api("/account", { token: a.token });
    expect(aAccount.status).toBe(401);
    const aReprovision = await api("/setup-infrastructure", {
      method: "POST",
      token: a.token,
      body: JSON.stringify({
        brand: "TermA",
        primaryDomain: "terma.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 Test St",
        senderIdentity: "Sender <s@terma.com>",
      }),
    });
    expect(aReprovision.status).toBe(401);

    // A's DO: infra reclaimed, suppression RETAINED (CAN-SPAM opt-outs survive
    // termination), status suspended.
    await runInDurableObject(tenantStub(a.tenantId), async (_i, state) => {
      const liveDomains = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE tenant_id = ? AND status != 'released'`, a.tenantId)
        .one().n;
      expect(liveDomains).toBe(0);
      const liveMailboxes = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, a.tenantId)
        .one().n;
      expect(liveMailboxes).toBe(0);
      const suppressions = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM suppressions WHERE tenant_id = ?`, a.tenantId)
        .one().n;
      expect(suppressions).toBe(1); // opt-out retained
      const status = state.storage.sql
        .exec<{ status: string }>(`SELECT status FROM tenant_profile WHERE id = ?`, a.tenantId)
        .one().status;
      expect(status).toBe("suspended");
    });

    // Enforcement action logged to D1 with the reason + evidence.
    const enf = await env.DB.prepare(
      `SELECT action, reason, evidence_json FROM enforcement_actions WHERE tenant_id = ?`,
    )
      .bind(a.tenantId)
      .all<{ action: string; reason: string; evidence_json: string }>();
    expect(enf.results.length).toBe(1);
    expect(enf.results[0]?.action).toBe("TERMINATE");
    expect(enf.results[0]?.reason).toContain("spam-trap");
    expect(JSON.parse(enf.results[0]?.evidence_json ?? "{}")).toMatchObject({ complaintRate: 0.04 });

    // ISOLATION: tenant B is entirely untouched by A's terminate.
    const bAccount = await api<{ status: string; domains: number; mailboxes: number; teardown: unknown }>("/account", {
      token: b.token,
    });
    expect(bAccount.status).toBe(200); // B's token still works
    expect(bAccount.body.status).toBe("active");
    expect(bAccount.body.domains).toBe(2);
    expect(bAccount.body.mailboxes).toBe(4);
    expect(bAccount.body.teardown).toBeNull();

    await runInDurableObject(tenantStub(b.tenantId), async (_i, state) => {
      const releasedDomains = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE tenant_id = ? AND status = 'released'`, b.tenantId)
        .one().n;
      expect(releasedDomains).toBe(0);
      const releasedMailboxes = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NOT NULL`, b.tenantId)
        .one().n;
      expect(releasedMailboxes).toBe(0);
      const activeCampaigns = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM campaigns WHERE tenant_id = ? AND status = 'active'`, b.tenantId)
        .one().n;
      expect(activeCampaigns).toBe(1);
    });

    // B has no enforcement action.
    const bEnf = await env.DB.prepare(`SELECT COUNT(*) as n FROM enforcement_actions WHERE tenant_id = ?`)
      .bind(b.tenantId)
      .first<{ n: number }>();
    expect(bEnf?.n).toBe(0);
  });

  it("is idempotent — a re-terminate re-suspends but logs no second enforcement action", async () => {
    const { tenantId, token } = await mintTenant("Term Idem Co", "launch");
    await activatePaidPlan(tenantId, "launch");
    await provision(token, "TermIdem");

    const first = await adminApi<TerminateResponse>(`/admin/tenants/${tenantId}/terminate`, {
      method: "POST",
      body: JSON.stringify({ reason: "abuse" }),
    });
    expect(first.body.enforcementLogged).toBe(true);
    expect(first.body.alreadyTornDown).toBe(false);

    const second = await adminApi<TerminateResponse>(`/admin/tenants/${tenantId}/terminate`, {
      method: "POST",
      body: JSON.stringify({ reason: "abuse again" }),
    });
    expect(second.status).toBe(200);
    expect(second.body.terminated).toBe(true);
    expect(second.body.alreadyTornDown).toBe(true);
    expect(second.body.enforcementLogged).toBe(false); // no duplicate audit row

    const enf = await env.DB.prepare(`SELECT COUNT(*) as n FROM enforcement_actions WHERE tenant_id = ?`)
      .bind(tenantId)
      .first<{ n: number }>();
    expect(enf?.n).toBe(1);
  });
});
