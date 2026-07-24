import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncMailboxQuantity } from "../src/engine/billing.js";
import { activatePaidPlan, mintTenant, seedBenignSdnList, tenantStub, withTenantContext } from "./helpers.js";

// Quantity-billing migration (design §2/§8) — the set-to-N mailbox-quantity
// mirror + the checkout.session.completed subscription-item capture. The
// Stripe REST call is fetch-stubbed (hermetic; the real-Stripe crux is the
// Tier-2 gate, tools/billing-gate/) and STRIPE_SECRET_KEY is temp-set the same
// way checkout.test.ts's F1 cases do — syncMailboxQuantity is called DIRECTLY
// (not through the checkout HTTP route), so isRealSpendArmed's route guards
// don't apply. These assert behavior that fails on the pre-migration code
// (there was no quantity mirror at all).

const CAPTURE: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];

function stubStripeFetch(subscriptionItems?: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit) => {
      CAPTURE.push({
        url: String(url),
        method: String(init.method ?? "GET"),
        body: String(init.body ?? ""),
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      if (String(url).includes("/subscriptions/") && subscriptionItems) {
        return new Response(JSON.stringify({ items: { data: subscriptionItems } }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }),
  );
}

/** Seeds a live (released_at IS NULL) mailbox row directly in a tenant's DO SQLite. */
async function insertMailboxes(tenantId: string, count: number): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
    for (let i = 0; i < count; i++) {
      state.storage.sql.exec(
        `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, sent_today, sent_today_epoch_day, status, warmup_started_at, created_at)
         VALUES (?, ?, 'dom_x', 'x.com', ?, 5, 0, 0, 'warming', 0, 0)`,
        `mbx_${crypto.randomUUID()}`,
        tenantId,
        `m${i}@x.com`,
      );
    }
  });
}

/** Directly sets the tenant's stored Stripe subscription/item state (what a real checkout would have captured). */
async function seedSubscriptionState(
  tenantId: string,
  fields: { subId?: string | null; mailboxItemId?: string | null; syncedQty?: number },
): Promise<void> {
  await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
    state.storage.sql.exec(
      `UPDATE tenant_profile SET stripe_subscription_id = ?, stripe_mailbox_item_id = ?, mailbox_qty_synced = ? WHERE id = ?`,
      fields.subId ?? null,
      fields.mailboxItemId ?? null,
      fields.syncedQty ?? 0,
      tenantId,
    );
  });
}

function readSyncedQty(tenantId: string): Promise<number> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql.exec<{ q: number }>(`SELECT mailbox_qty_synced as q FROM tenant_profile WHERE id = ?`, tenantId).one().q,
  );
}

async function withStripeKey<T>(fn: () => Promise<T>): Promise<T> {
  const saved = env.STRIPE_SECRET_KEY;
  (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = "sk_test_fake_for_sync";
  try {
    return await fn();
  } finally {
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = saved;
  }
}

describe("syncMailboxQuantity — set-to-N mirror of the provisioned count", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    CAPTURE.length = 0;
  });

  it("pushes an INCREASE with create_prorations when the provisioned count rises above synced", async () => {
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Sync Up Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedSubscriptionState(tenantId, { subId: "sub_1", mailboxItemId: "si_mbx", syncedQty: 5 });
    await insertMailboxes(tenantId, 8); // provisioned 8 > synced 5

    const result = await withStripeKey(() =>
      withTenantContext(tenantId, (ctx) => {
        stubStripeFetch();
        return syncMailboxQuantity(ctx);
      }),
    );

    expect(result).toEqual({ pushed: true, quantity: 8, proration: "create_prorations" });
    const req = CAPTURE.find((c) => c.url.endsWith("/subscription_items/si_mbx"));
    expect(req).toBeDefined();
    const body = new URLSearchParams(req!.body);
    expect(body.get("quantity")).toBe("8"); // absolute set, not +3
    expect(body.get("proration_behavior")).toBe("create_prorations");
    expect(await readSyncedQty(tenantId)).toBe(8);
  });

  it("pushes a DECREASE with proration_behavior 'none' (no mid-cycle credit — founder ruling 2)", async () => {
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Sync Down Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedSubscriptionState(tenantId, { subId: "sub_1", mailboxItemId: "si_mbx", syncedQty: 8 });
    await insertMailboxes(tenantId, 5); // provisioned 5 < synced 8

    const result = await withStripeKey(() =>
      withTenantContext(tenantId, (ctx) => {
        stubStripeFetch();
        return syncMailboxQuantity(ctx);
      }),
    );

    expect(result).toEqual({ pushed: true, quantity: 5, proration: "none" });
    expect(new URLSearchParams(CAPTURE.find((c) => c.url.endsWith("/subscription_items/si_mbx"))!.body).get("proration_behavior")).toBe("none");
    expect(await readSyncedQty(tenantId)).toBe(5);
  });

  it("floors at the 5-mailbox minimum ($99) when the provisioned count is below 5", async () => {
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Sync Floor Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedSubscriptionState(tenantId, { subId: "sub_1", mailboxItemId: "si_mbx", syncedQty: 8 });
    await insertMailboxes(tenantId, 2); // provisioned 2 -> floors to 5

    const result = await withStripeKey(() => withTenantContext(tenantId, (ctx) => {
      stubStripeFetch();
      return syncMailboxQuantity(ctx);
    }));
    expect(result.quantity).toBe(5);
    expect(await readSyncedQty(tenantId)).toBe(5);
  });

  it("is a NO-OP with no drift (synced already equals max(5, provisioned)) — no Stripe call", async () => {
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("No Drift Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    await seedSubscriptionState(tenantId, { subId: "sub_1", mailboxItemId: "si_mbx", syncedQty: 5 });
    // provisioned 0 -> desired 5 == synced 5

    const result = await withStripeKey(() => withTenantContext(tenantId, (ctx) => {
      stubStripeFetch();
      return syncMailboxQuantity(ctx);
    }));
    expect(result.pushed).toBe(false);
    expect(CAPTURE).toHaveLength(0);
  });

  it("is a NO-OP for a non-active tenant even with drift (§7 active-only guard — teardown release never pushes)", async () => {
    const { tenantId } = await mintTenant("Frozen Co", "managed"); // billing_state stays 'none' (never checked out)
    await seedSubscriptionState(tenantId, { subId: "sub_1", mailboxItemId: "si_mbx", syncedQty: 8 });
    await insertMailboxes(tenantId, 2);

    const result = await withStripeKey(() => withTenantContext(tenantId, (ctx) => {
      stubStripeFetch();
      return syncMailboxQuantity(ctx);
    }));
    expect(result.pushed).toBe(false);
    expect(CAPTURE).toHaveLength(0);
    expect(await readSyncedQty(tenantId)).toBe(8); // synced untouched
  });

  it("is a NO-OP for a simulated tenant with no stored Stripe subscription (mechanic only applies to a real subscription)", async () => {
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Simulated Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    // No stripe_mailbox_item_id stored (a simulated checkout captures none).
    await insertMailboxes(tenantId, 8);

    const result = await withStripeKey(() => withTenantContext(tenantId, (ctx) => {
      stubStripeFetch();
      return syncMailboxQuantity(ctx);
    }));
    expect(result.pushed).toBe(false);
    expect(CAPTURE).toHaveLength(0);
  });
});

describe("checkout.session.completed — captures subscription state + discount (design §9)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    CAPTURE.length = 0;
  });

  it("resolves + stores the mailbox item id, confirmed quantity, interval, and discount %", async () => {
    await seedBenignSdnList();
    const { tenantId } = await mintTenant("Capture Co", "demo");

    const event = {
      id: `evt_${crypto.randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_1",
          subscription: "sub_cap_1",
          amount_subtotal: 14900,
          total_details: { amount_discount: 8940 }, // 60% off 14900
          metadata: { tenantId, plan: "managed" },
        },
      },
    };

    await withStripeKey(() =>
      runInDurableObject(tenantStub(tenantId), async (instance) => {
        stubStripeFetch([
          { id: "si_platform", quantity: 1, price: { id: "price_p", lookup_key: "coldrig_platform_monthly_v1" } },
          { id: "si_mbx", quantity: 10, price: { id: "price_m", lookup_key: "coldrig_mailbox_monthly_v1" } },
        ]);
        await instance.handleStripeWebhook(event);
      }),
    );

    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql
        .exec<{ mid: string | null; pid: string | null; q: number; interval: string; disc: number; bs: string }>(
          `SELECT stripe_mailbox_item_id as mid, stripe_platform_item_id as pid, mailbox_qty_synced as q, billing_interval as interval, checkout_discount_pct as disc, billing_state as bs FROM tenant_profile WHERE id = ?`,
          tenantId,
        )
        .one(),
    );
    expect(row.bs).toBe("active");
    expect(row.mid).toBe("si_mbx");
    expect(row.pid).toBe("si_platform");
    expect(row.q).toBe(10); // the quantity Stripe actually confirmed
    expect(row.interval).toBe("month");
    expect(row.disc).toBe(60); // 8940/14900 = 60%
  });
});
