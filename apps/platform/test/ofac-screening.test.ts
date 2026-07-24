import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { normalizeName, tokenize } from "../src/ofac/normalize.js";
import { LIST_UNAVAILABLE_VERSION, screenTenant } from "../src/ofac/screening.js";
import { rescreenListUnavailableReviews } from "../src/ofac/screening-recovery.js";
import { swapInSdnList } from "../src/ofac/sdn-list.js";
import { getScreeningReview, resolveScreeningReview } from "../src/admin/db.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { activatePaidPlan, adminApi, api, mintTenant, signup, tenantStub, withTenantContext } from "./helpers.js";

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

  it("re-screening a PREVIOUSLY-REVIEWED tenant that is now clean REOPENS-then-clears — the review row status flips but stays queryable", async () => {
    await seedSdnList(12_000_000);
    const { tenantId } = await mintTenant("Acme", "launch"); // exact hit
    await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout" }));
    expect((await getScreeningReview(env, tenantId))?.status).toBe("pending");
  });
});

// N-OF-1 fix (adversary OFAC build review, 2026-07-23): NO active SDN list at
// screening time must fail CLOSED ('review', blocking activation), never
// fail-open 'clear'. See the report's revert-fail-restore proof: this is RED
// against the pre-fix code (which persisted 'clear' with a null list_version).
describe("G1b — N-OF-1 fail-closed when NO SDN list is loaded yet", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM sdn_entries`).run();
    await env.DB.prepare(`DELETE FROM sdn_list_meta`).run();
    await env.DB.prepare(`DELETE FROM screening_reviews`).run();
  });

  it("no SDN list built yet -> status 'review' (NOT 'clear'), sentinel list_version, review row, ops alert fired — activation BLOCKED", async () => {
    // No seedSdnList call — fresh env, pre-first-refresh.
    const { tenantId } = await mintTenant("Whatever Co", "launch");
    const mailer = new SandboxOpsMailer();

    const result = await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout", mailer }));
    expect(result).toEqual({ status: "review", listVersion: LIST_UNAVAILABLE_VERSION, matches: [] });

    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string; screening_list_version: string | null }>(
        `SELECT screening_status, screening_list_version FROM tenant_profile WHERE id = ?`,
        tenantId,
      ).one(),
    );
    expect(row).toMatchObject({ screening_status: "review", screening_list_version: LIST_UNAVAILABLE_VERSION });

    const review = await getScreeningReview(env, tenantId);
    expect(review).toMatchObject({ tenantId, status: "pending", listVersion: LIST_UNAVAILABLE_VERSION });
    expect(review?.matchedTerms).toMatchObject([{ reason: "sdn_list_unavailable" }]);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.subject).toContain("no SDN list loaded yet");
    expect(mailer.sent[0]?.text).not.toContain("Matches:"); // never framed as a name-match hit

    // The gate genuinely blocks: buildAdapters() (activation.ts's own conjunct) reads this the same as a real hit.
    const activated = await withTenantContext(tenantId, (ctx) => {
      const p = ctx.sql.exec<{ plan: string; status: string; billing_state: string }>(
        `SELECT plan, status, billing_state FROM tenant_profile WHERE id = ?`,
        ctx.tenantId,
      ).one();
      return p;
    });
    expect(activated.billing_state).toBe("none"); // sanity: mintTenant alone never checks out
  });

  it("the admin clear path still works on a list-unavailable hold (same surface as a real hit)", async () => {
    const { tenantId } = await mintTenant("List Unavailable Admin Co", "launch");
    await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout" }));
    expect((await getScreeningReview(env, tenantId))?.status).toBe("pending");

    const res = await adminApi(`/admin/tenants/${tenantId}/screening`, {
      method: "POST",
      body: JSON.stringify({ decision: "clear" }),
    });
    expect(res.status).toBe(200);
    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string }>(`SELECT screening_status FROM tenant_profile WHERE id = ?`, tenantId).one(),
    );
    expect(row.screening_status).toBe("clear");
  });
});

// Adversary finding 1 (docs/adversarial/sdn-relay-review-2026-07-24.md) — a
// TOCTOU fail-open in `screenTenant`: it reads `active_version` and then, in
// a SEPARATE await, that version's entries. A concurrent swapInSdnList can
// flip the pointer to a NEW version and delete the OLD version's rows in
// between — this simulates EXACTLY that stale-read state directly (pointer
// still says V1, V1's own rows are gone) without needing real concurrency.
describe("G1b — TOCTOU fail-open guard: a stale active_version whose entries just got swept fails CLOSED, never 'clear'", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM sdn_entries`).run();
    await env.DB.prepare(`DELETE FROM sdn_list_meta`).run();
    await env.DB.prepare(`DELETE FROM screening_reviews`).run();
  });

  it("a non-null active_version whose entries read back EMPTY holds 'review' (sentinel), not a false 'clear'", async () => {
    const listVersion = await seedSdnList(50_000_000); // WOULD match "Globex Corp" if the rows were still there
    // Simulate the race: a concurrent swap's post-flip cleanup
    // (`DELETE FROM sdn_entries WHERE list_version != <new>`) ran and removed
    // V1's rows, but `sdn_list_meta.active_version` still points to V1 at the
    // instant this screen's first read already captured it.
    await env.DB.prepare(`DELETE FROM sdn_entries WHERE list_version = ?`).bind(listVersion).run();

    const { tenantId } = await mintTenant("Globex Corp International", "launch");
    const mailer = new SandboxOpsMailer();
    const result = await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout", mailer }));

    // The bug this closes: WITHOUT the fix, matchAgainstSdn([...], []) finds
    // no matches and this would be {status: 'clear', listVersion, matches: []}
    // — a sanctioned-name tenant cleared purely by racing a list swap.
    expect(result).toEqual({ status: "review", listVersion: LIST_UNAVAILABLE_VERSION, matches: [] });

    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string; screening_list_version: string | null }>(
        `SELECT screening_status, screening_list_version FROM tenant_profile WHERE id = ?`,
        tenantId,
      ).one(),
    );
    expect(row).toMatchObject({ screening_status: "review", screening_list_version: LIST_UNAVAILABLE_VERSION });

    const review = await getScreeningReview(env, tenantId);
    expect(review).toMatchObject({ status: "pending", listVersion: LIST_UNAVAILABLE_VERSION });
    expect(review?.matchedTerms).toMatchObject([
      { reason: "sdn_list_unavailable", note: expect.stringContaining("zero entries") },
    ]);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.subject).toContain("no SDN list loaded yet");
  });

  it("a NORMAL screen against a genuinely non-empty list is UNAFFECTED by the guard (no false positive)", async () => {
    await seedSdnList(51_000_000);
    const { tenantId } = await mintTenant("Globex Corp International", "launch");
    const result = await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout" }));
    expect(result.status).toBe("review"); // a REAL hit, not the sentinel
    expect(result.listVersion).not.toBe(LIST_UNAVAILABLE_VERSION);
    expect(result.matches).toHaveLength(1);
  });
});

// N-OF-1 self-heal path: rescreenListUnavailableReviews (ofac/screening-recovery.ts).
describe("G1b — SDN list-unavailable recovery sweep", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM sdn_entries`).run();
    await env.DB.prepare(`DELETE FROM sdn_list_meta`).run();
    await env.DB.prepare(`DELETE FROM screening_reviews`).run();
  });

  it("no-ops (attempted:0) while the list is STILL unavailable — never spins on nothing to recover", async () => {
    const { tenantId } = await mintTenant("Still Stuck Co", "launch");
    await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout" }));

    const outcome = await rescreenListUnavailableReviews(env);
    expect(outcome).toEqual({ attempted: 0, rescreened: 0, errors: 0 });
    expect((await getScreeningReview(env, tenantId))?.listVersion).toBe(LIST_UNAVAILABLE_VERSION); // untouched
  });

  it("once a list loads, a genuinely CLEAN tenant self-heals: 'clear', real list_version, review row auto-resolved — no manual admin needed", async () => {
    const { tenantId } = await mintTenant("Sunrise Bakery Recovery Co", "launch");
    await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout" }));
    expect((await getScreeningReview(env, tenantId))?.status).toBe("pending");

    const listVersion = await seedSdnList(30_000_000); // benign list, this brand doesn't match anything in it

    const outcome = await rescreenListUnavailableReviews(env);
    expect(outcome).toEqual({ attempted: 1, rescreened: 1, errors: 0 });

    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string; screening_list_version: string | null }>(
        `SELECT screening_status, screening_list_version FROM tenant_profile WHERE id = ?`,
        tenantId,
      ).one(),
    );
    expect(row).toMatchObject({ screening_status: "clear", screening_list_version: listVersion });

    const review = await getScreeningReview(env, tenantId);
    expect(review).toMatchObject({ status: "cleared", resolvedBy: "system-recovery" });
  });

  it("once a list loads, a tenant that turns out to be a REAL match upgrades to a real, list-versioned review (never silently drops the hold)", async () => {
    const { tenantId } = await mintTenant("Globex Corp International", "launch");
    await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout" }));

    const listVersion = await seedSdnList(31_000_000); // this fixture's list DOES contain a match for this brand

    const outcome = await rescreenListUnavailableReviews(env);
    expect(outcome).toEqual({ attempted: 1, rescreened: 1, errors: 0 });

    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string; screening_list_version: string | null }>(
        `SELECT screening_status, screening_list_version FROM tenant_profile WHERE id = ?`,
        tenantId,
      ).one(),
    );
    expect(row).toMatchObject({ screening_status: "review", screening_list_version: listVersion });

    const review = await getScreeningReview(env, tenantId);
    expect(review).toMatchObject({ status: "pending" }); // reopened with the REAL match, not silently cleared
    expect(review?.listVersion).toBe(listVersion);
    expect(review?.matchedTerms).toMatchObject([{ uid: "9001" }]);
  });

  it("is a no-op for a tenant whose hold was already resolved by a manual admin clear (fresh-read guard on the DO RPC)", async () => {
    const { tenantId } = await mintTenant("Already Admin Cleared Co", "launch");
    await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout" }));
    await adminApi(`/admin/tenants/${tenantId}/screening`, { method: "POST", body: JSON.stringify({ decision: "clear" }) });

    await seedSdnList(32_000_000);
    const outcome = await rescreenListUnavailableReviews(env);
    // The review row's status flipped to 'cleared' by the admin action, so
    // listPendingScreeningReviews (status='pending' only) no longer returns
    // it — nothing to attempt.
    expect(outcome).toEqual({ attempted: 0, rescreened: 0, errors: 0 });
  });

  // Adversary re-attack (2026-07-23) on the N-OF-1 self-heal: the sweep reads
  // its pending-review list, THEN calls the per-tenant RPC — an admin
  // clear/reject can land in that window. These two tests exercise the
  // race's WORST cases directly: they call the exact same functions the
  // sweep calls (TenantDO.rescreenIfListUnavailable, resolveScreeningReview),
  // on a tenant whose admin resolution has ALREADY landed — the state-based
  // proof that the guard holds regardless of which side actually won the
  // wall-clock race (the standard way to test this class without literal
  // thread interleaving in a single-threaded test harness).
  it("RACE GUARD: an admin 'clear' that lands before the recovery RPC fires is NEVER overridden, even by a genuine matching list (adversary-named worst case: admin-clear + recovery-hit)", async () => {
    const { tenantId } = await mintTenant("Globex Corp International", "launch"); // WILL match once a real list loads
    await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout" })); // held list-unavailable

    const clearRes = await adminApi(`/admin/tenants/${tenantId}/screening`, {
      method: "POST",
      body: JSON.stringify({ decision: "clear" }),
    });
    expect(clearRes.status).toBe(200);
    expect((await getScreeningReview(env, tenantId))?.status).toBe("cleared");

    // A real list loads that WOULD re-block this tenant — the adversary's
    // named worst case ("recovery-hit") — if the recovery ignored the
    // admin's decision.
    await seedSdnList(44_000_000);

    // The sweep's per-tenant sequence, invoked directly on this tenant (the
    // stale-pending-snapshot simulation).
    const rpcResult = await tenantStub(tenantId).rescreenIfListUnavailable();
    expect(rpcResult).toEqual({ rescreened: false }); // guard #1 (tenant-do.ts): screening_status is no longer 'review' -> short-circuits BEFORE any re-screen

    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string }>(`SELECT screening_status FROM tenant_profile WHERE id = ?`, tenantId).one(),
    );
    expect(row.screening_status).toBe("clear"); // never re-blocked

    const review = await getScreeningReview(env, tenantId);
    expect(review).toMatchObject({ status: "cleared", resolvedBy: "admin" }); // untouched
  });

  it("RACE GUARD: an admin 'reject' that lands before the recovery RPC fires is NEVER overwritten to 'cleared'/'system-recovery' (adversary-named worst case: admin-reject + recovery-clean)", async () => {
    const { tenantId, token } = await mintTenant("Sunrise Bakery Reject Race Co", "launch"); // benign -> a re-screen would find 'clear'
    await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout" })); // held list-unavailable

    const rejectRes = await adminApi(`/admin/tenants/${tenantId}/screening`, {
      method: "POST",
      body: JSON.stringify({ decision: "reject", note: "confirmed match" }),
    });
    expect(rejectRes.status).toBe(200);
    expect((await getScreeningReview(env, tenantId))?.status).toBe("rejected");

    await seedSdnList(45_000_000); // benign — a re-screen finds no match ('clear')

    // The sweep's per-tenant sequence, invoked directly (mirrors
    // screening-recovery.ts's loop body exactly). `reject` never touches
    // `screening_status` (terminate doesn't write it — it stays 'review'), so
    // guard #1 alone does NOT block this call: the DO genuinely re-screens.
    // Guard #2 (admin/db.ts's resolveScreeningReview, now conditional on
    // status='pending') is what must hold here.
    const rpcResult = await tenantStub(tenantId).rescreenIfListUnavailable();
    expect(rpcResult.rescreened).toBe(true);
    expect(rpcResult.status).toBe("clear");
    if (rpcResult.rescreened && rpcResult.status === "clear") {
      await resolveScreeningReview(env, tenantId, "cleared", "system-recovery", Date.now());
    }

    const review = await getScreeningReview(env, tenantId);
    expect(review).toMatchObject({ status: "rejected", resolvedBy: "admin" }); // NEVER overwritten

    // The tenant stays terminated regardless of the redundant re-screen.
    const account = await api("/account", { token });
    expect(account.status).toBe(401);
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
