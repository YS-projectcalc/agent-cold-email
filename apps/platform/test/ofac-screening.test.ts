import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { normalizeName, tokenize } from "../src/ofac/normalize.js";
import { screenTenant } from "../src/ofac/screening.js";
import { swapInSdnList } from "../src/ofac/sdn-list.js";
import { getScreeningReview } from "../src/admin/db.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, api, mintTenant, signup, tenantStub, withTenantContext } from "./helpers.js";

function sdnEntry(uid: string, name: string) {
  const nameNormalized = normalizeName(name);
  return { uid, nameNormalized, tokens: tokenize(nameNormalized), entityType: null as string | null, program: "TEST-PROGRAM" };
}

async function seedSdnList(nowMs: number): Promise<string> {
  const listVersion = `test-${nowMs}`;
  await swapInSdnList(env, {
    listVersion,
    entries: [sdnEntry("9001", "Globex Corp"), sdnEntry("9002", "Acme")],
    publishedDate: "2026-07-23",
    fetchedAt: nowMs,
  });
  return listVersion;
}

describe("screenTenant — G1b real screening (unit level, direct call)", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM sdn_entries`).run();
    await env.DB.prepare(`DELETE FROM sdn_list_meta`).run();
    await env.DB.prepare(`DELETE FROM screening_reviews`).run();
  });

  it("no-hit brand -> status 'clear', list_version recorded, no review row, no alert", async () => {
    const listVersion = await seedSdnList(10_000_000);
    const { tenantId } = await mintTenant("Sunrise Bakery Co", "launch");
    const mailer = new SandboxOpsMailer();

    const result = await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout", mailer }));
    expect(result).toMatchObject({ status: "clear", listVersion, matches: [] });

    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string; screening_list_version: string | null }>(
        `SELECT screening_status, screening_list_version FROM tenant_profile WHERE id = ?`,
        tenantId,
      ).one(),
    );
    expect(row).toMatchObject({ screening_status: "clear", screening_list_version: listVersion });

    expect(await getScreeningReview(env, tenantId)).toBeNull();
    expect(mailer.sent).toHaveLength(0);
  });

  it("hit brand -> status 'review', review row with match context, ops alert fired — NEVER auto-rejects", async () => {
    await seedSdnList(11_000_000);
    const { tenantId } = await mintTenant("Globex Corp International", "launch");
    const mailer = new SandboxOpsMailer();

    const result = await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout", mailer }));
    expect(result.status).toBe("review");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ uid: "9001", matchType: "subset" });

    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string }>(`SELECT screening_status FROM tenant_profile WHERE id = ?`, tenantId).one(),
    );
    expect(row.screening_status).toBe("review");

    const review = await getScreeningReview(env, tenantId);
    expect(review).toMatchObject({ tenantId, status: "pending" });
    expect(review?.matchedTerms).toMatchObject([{ uid: "9001", matchType: "subset" }]);
    expect(review?.screenedFields).toMatchObject({ brand: "Globex Corp International" });

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe(env.OPS_ALERT_EMAIL);
    expect(mailer.sent[0]?.subject).toContain(tenantId);
    // NEVER "sanctions match"/reject framing in the founder alert either —
    // it explicitly states this is a hold for human review, never automatic.
    expect(mailer.sent[0]?.text).toContain("NEVER an auto-reject");
  });

  it("no SDN list built yet -> 'clear' with a NULL list_version (honestly distinguishable from a real screen)", async () => {
    // No seedSdnList call — fresh env, pre-first-refresh.
    const { tenantId } = await mintTenant("Whatever Co", "launch");
    const result = await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout" }));
    expect(result).toEqual({ status: "clear", listVersion: null, matches: [] });
  });

  it("re-screening a PREVIOUSLY-REVIEWED tenant that is now clean REOPENS-then-clears — the review row status flips but stays queryable", async () => {
    await seedSdnList(12_000_000);
    const { tenantId } = await mintTenant("Acme", "launch"); // exact hit
    await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout" }));
    expect((await getScreeningReview(env, tenantId))?.status).toBe("pending");
  });
});

// NB-1 disposition (adversary round 1, 2026-07-23) — the operative brand is
// rewritten at setup_infrastructure and must be RE-screened there, closing the
// evasion window: screen-clean at checkout, then set a sanctioned brand later.
describe("G1b — brand-change re-screen at setup_infrastructure (NB-1)", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM sdn_entries`).run();
    await env.DB.prepare(`DELETE FROM sdn_list_meta`).run();
    await env.DB.prepare(`DELETE FROM screening_reviews`).run();
  });

  it("a tenant that screened CLEAN at signup/checkout, then sets a matching brand at setup_infrastructure, is caught (not evaded)", async () => {
    await seedSdnList(13_000_000);
    // Signup + checkout brand is benign — screens clean.
    const { tenantId, token } = await signup("Sunrise Bakery Co", "founder@sunrisebakery.test");
    await activatePaidPlan(tenantId, "launch");
    const afterCheckout = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string }>(`SELECT screening_status FROM tenant_profile WHERE id = ?`, tenantId).one(),
    );
    expect(afterCheckout.screening_status).toBe("clear");

    // setup_infrastructure REWRITES the brand to a name that matches the SDN
    // list — this must re-screen and land 'review', not silently pass through.
    const infra = await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Globex Corp International",
        primaryDomain: "globexinternational.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 St",
        senderIdentity: "Sender <s@globexinternational.com>",
      }),
    });
    expect(infra.status).toBe(202);

    const afterBrandChange = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string }>(`SELECT screening_status FROM tenant_profile WHERE id = ?`, tenantId).one(),
    );
    expect(afterBrandChange.screening_status).toBe("review");
    expect((await getScreeningReview(env, tenantId))?.status).toBe("pending");
  });

  it("demo/free tenants are NOT re-screened at setup_infrastructure (they can never activate regardless — no wasted D1 reads on the common exploration path)", async () => {
    await seedSdnList(14_000_000);
    const { tenantId, token } = await signup("Sunrise Bakery Demo Co", "founder@sunrisebakerydemo.test");
    // Never checked out — stays 'demo'.
    const infra = await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Globex Corp International",
        primaryDomain: "globexinternational.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 St",
        senderIdentity: "Sender <s@globexinternational.com>",
      }),
    });
    expect(infra.status).toBe(202);
    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string; screening_list_version: string | null }>(
        `SELECT screening_status, screening_list_version FROM tenant_profile WHERE id = ?`,
        tenantId,
      ).one(),
    );
    // Column default, never actually screened (list_version stays NULL).
    expect(row).toMatchObject({ screening_status: "clear", screening_list_version: null });
    expect(await getScreeningReview(env, tenantId)).toBeNull();
  });
});

// G1b — checkout write-site coverage (design line 40): both
// completeSimulatedCheckout AND the real-Stripe checkout.session.completed
// webhook path must screen.
describe("G1b — both checkout write sites screen", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM sdn_entries`).run();
    await env.DB.prepare(`DELETE FROM sdn_list_meta`).run();
    await env.DB.prepare(`DELETE FROM screening_reviews`).run();
  });

  it("completeSimulatedCheckout (GET /checkout/simulate) screens on completion", async () => {
    await seedSdnList(15_000_000);
    const { tenantId } = await signup("Globex Corp International", "founder@globexsimcheckout.test");
    // Insert the pending checkout_sessions row directly (mirroring
    // checkout.test.ts's own pattern) rather than going through POST
    // /checkout — this test's target is completeSimulatedCheckout's screen
    // call, not the session-creation path.
    const sessionId = `cs_ofac_sim_${tenantId}`;
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO checkout_sessions (id, tenant_id, plan, status, created_at) VALUES (?, ?, 'launch', 'pending', ?)`,
        sessionId,
        tenantId,
        Date.now(),
      );
    });
    const res = await api(`/checkout/simulate?tenant=${tenantId}&session=${sessionId}`);
    expect(res.status).toBe(200);

    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string }>(`SELECT screening_status FROM tenant_profile WHERE id = ?`, tenantId).one(),
    );
    expect(row.screening_status).toBe("review");
  });

  it("the real Stripe checkout.session.completed webhook path screens (activatePaidPlan helper)", async () => {
    await seedSdnList(16_000_000);
    const { tenantId } = await signup("Globex Corp International", "founder@globexwebhook.test");
    await activatePaidPlan(tenantId, "launch");

    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string }>(`SELECT screening_status FROM tenant_profile WHERE id = ?`, tenantId).one(),
    );
    expect(row.screening_status).toBe("review");
  });
});
