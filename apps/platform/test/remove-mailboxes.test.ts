import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeMailboxes } from "../src/engine/billing.js";
import { activatePaidPlan, api, mintTenant, seedBenignSdnList, signup, tenantStub, withTenantContext } from "./helpers.js";

// Quantity-billing migration (design §2, §11) — the customer-initiated
// downgrade + the quote-before-add preview. Downgrade releases the N newest
// live mailboxes NOW and syncs the LOWER Stripe quantity with proration
// 'none' (no mid-cycle credit — founder ruling 2). Stripe call fetch-stubbed.

const CAPTURE: { url: string; body: string }[] = [];

function stubStripeFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit) => {
      CAPTURE.push({ url: String(url), body: String(init.body ?? "") });
      return new Response("{}", { status: 200 });
    }),
  );
}

async function withStripeKey<T>(fn: () => Promise<T>): Promise<T> {
  const saved = env.STRIPE_SECRET_KEY;
  (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = "sk_test_fake_remove";
  try {
    return await fn();
  } finally {
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = saved;
  }
}

async function seedActiveWithMailboxes(brand: string, count: number, syncedQty: number) {
  await seedBenignSdnList();
  const { tenantId } = await mintTenant(brand, "managed");
  await activatePaidPlan(tenantId, "managed");
  await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
    state.storage.sql.exec(
      `UPDATE tenant_profile SET stripe_subscription_id = 'sub_r', stripe_mailbox_item_id = 'si_mbx', mailbox_qty_synced = ? WHERE id = ?`,
      syncedQty,
      tenantId,
    );
    for (let i = 0; i < count; i++) {
      state.storage.sql.exec(
        `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at)
         VALUES (?, ?, 'dom_x', 'x.com', ?, 5, 0, 0, 'active', 0, ?)`,
        `mbx_${crypto.randomUUID()}`,
        tenantId,
        `m${i}@x.com`,
        i,
      );
    }
  });
  return tenantId;
}

describe("removeMailboxes — customer-initiated downgrade (design §2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    CAPTURE.length = 0;
  });

  it("releases the N newest live mailboxes and syncs the lower quantity with proration 'none'", async () => {
    const tenantId = await seedActiveWithMailboxes("Downgrade Co", 8, 8);

    const result = await withStripeKey(() =>
      withTenantContext(tenantId, async (ctx) => {
        stubStripeFetch();
        return removeMailboxes(ctx, { count: 3, acknowledged: true });
      }),
    );

    expect(result.releasedCount).toBe(3);
    expect(result.quote.mailboxes).toBe(5); // 8 - 3 = 5 live
    // The lower Stripe quantity went out with NO credit (founder ruling 2).
    const setReq = CAPTURE.find((c) => c.url.endsWith("/subscription_items/si_mbx"));
    expect(setReq).toBeDefined();
    expect(new URLSearchParams(setReq!.body).get("quantity")).toBe("5");
    expect(new URLSearchParams(setReq!.body).get("proration_behavior")).toBe("none");

    const live = await runInDurableObject(tenantStub(tenantId), async (_i, s) =>
      s.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, tenantId).one().n,
    );
    expect(live).toBe(5);
  });

  it("floors the projected bill at the $99 minimum when the release drops the count below 5", async () => {
    const tenantId = await seedActiveWithMailboxes("Downgrade Floor Co", 6, 6);
    const result = await withStripeKey(() =>
      withTenantContext(tenantId, async (ctx) => {
        stubStripeFetch();
        return removeMailboxes(ctx, { count: 6, acknowledged: true }); // release all 6
      }),
    );
    expect(result.releasedCount).toBe(6);
    expect(result.quote.mailboxes).toBe(5); // floored
    expect(result.quote.monthlyCents).toBe(9_900); // $99 floor
  });
});

describe("POST /remove-mailboxes — quoted consent at the boundary", () => {
  it("rejects a body without acknowledged:true (400 at the zod boundary)", async () => {
    const { token } = await signup("Consent Co", "founder@consent.test");
    const res = await api("/remove-mailboxes", { method: "POST", token, body: JSON.stringify({ count: 1 }) });
    expect(res.status).toBe(400);
    const res2 = await api("/remove-mailboxes", { method: "POST", token, body: JSON.stringify({ count: 1, acknowledged: false }) });
    expect(res2.status).toBe(400);
  });

  it("requires auth", async () => {
    const res = await api("/remove-mailboxes", { method: "POST", body: JSON.stringify({ count: 1, acknowledged: true }) });
    expect(res.status).toBe(401);
  });
});

describe("quote-before-add — setup_infrastructure quoteOnly preview (SPEC §18)", () => {
  it("returns the projected new count + monthly WITHOUT provisioning anything", async () => {
    const { token } = await mintTenant("Quote Preview Co", "managed");

    const res = await api<{ quoteOnly: boolean; quote: { mailboxes: number; monthlyCents: number } }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Quote Preview Co",
        primaryDomain: "quotepreview.com",
        domains: 2,
        inboxesEach: 5, // proposes 10 mailboxes
        persona: "Sender",
        physicalAddress: "1 St",
        senderIdentity: "Sender <s@quotepreview.com>",
        quoteOnly: true,
      }),
    });

    expect(res.status).toBe(200); // preview, not 202 (nothing provisioned)
    expect(res.body.quoteOnly).toBe(true);
    expect(res.body.quote.mailboxes).toBe(10);
    expect(res.body.quote.monthlyCents).toBe(4_900 + 10 * 1_000); // $149

    // Nothing was actually provisioned.
    const status = await api<{ mailboxes: number }>("/infrastructure-status", { token });
    expect(status.body.mailboxes).toBe(0);
  });
});
