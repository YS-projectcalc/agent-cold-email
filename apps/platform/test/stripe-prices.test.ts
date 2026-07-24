import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureStripePrices,
  getSubscription,
  setSubscriptionItemQuantity,
  STRIPE_PRICES,
} from "../src/billing/stripe-client.js";

// Quantity-billing migration (design §3, §8.2, §10 N3) — the durable-Price
// bootstrap + the licensed set-to-N quantity call + subscription-item
// resolution, all against a stubbed fetch (the established
// stripe-client-checkout.test.ts hermetic pattern — the real-Stripe crux is
// the Tier-2 test-mode gate, tools/billing-gate/). These assert the request
// shapes + the N3 duplicate-lookup_key race handling that a self-authored
// sandbox cannot prove.

interface Call {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

function stubFetch(handler: (call: Call) => Response): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: String(init.method ?? "GET"),
        body: String(init.body ?? ""),
        headers: (init.headers ?? {}) as Record<string, string>,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return { calls };
}

function priceListResponse(lookupKey: string | null, id = "price_existing"): Response {
  const data = lookupKey ? [{ id, lookup_key: lookupKey }] : [];
  return new Response(JSON.stringify({ data }), { status: 200 });
}

describe("ensureStripePrices — durable lookup_key bootstrap", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns existing Price ids without creating anything when every lookup_key already resolves", async () => {
    const { calls } = stubFetch((c) => {
      const lk = new URL(c.url).searchParams.get("lookup_keys[]");
      return priceListResponse(lk, `price_for_${lk}`);
    });

    const map = await ensureStripePrices("sk_test_fake");

    expect(map.platform_monthly).toBe(`price_for_${STRIPE_PRICES.platform_monthly.lookupKey}`);
    expect(map.mailbox_monthly).toBe(`price_for_${STRIPE_PRICES.mailbox_monthly.lookupKey}`);
    // No Product or Price creation when all four already exist.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("creates the Product + Price for a missing lookup_key", async () => {
    const { calls } = stubFetch((c) => {
      if (c.url.includes("/prices?")) return priceListResponse(null); // nothing exists yet
      if (c.url.includes("/products/search")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (c.url.endsWith("/products")) return new Response(JSON.stringify({ id: "prod_new" }), { status: 200 });
      if (c.url.endsWith("/prices")) return new Response(JSON.stringify({ id: "price_new" }), { status: 200 });
      throw new Error(`unexpected url ${c.url}`);
    });

    const map = await ensureStripePrices("sk_test_fake");

    expect(map.platform_monthly).toBe("price_new");
    // A Price was actually created (POST /prices), carrying the lookup_key.
    const priceCreate = calls.find((c) => c.method === "POST" && c.url.endsWith("/prices"));
    expect(priceCreate).toBeDefined();
    expect(new URLSearchParams(priceCreate!.body).get("lookup_key")).toBe(STRIPE_PRICES.platform_monthly.lookupKey);
  });

  it("N3 race: a duplicate-lookup_key create error re-fetches the existing Price instead of throwing", async () => {
    let priceCreateAttempts = 0;
    const { calls } = stubFetch((c) => {
      if (c.url.includes("/prices?")) {
        // First GET (pre-create) finds nothing; the post-error re-fetch finds the racing winner.
        const lk = new URL(c.url).searchParams.get("lookup_keys[]");
        return priceCreateAttempts === 0 ? priceListResponse(null) : priceListResponse(lk, "price_raced_winner");
      }
      if (c.url.includes("/products/search")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (c.url.endsWith("/products")) return new Response(JSON.stringify({ id: "prod_x" }), { status: 200 });
      if (c.url.endsWith("/prices")) {
        priceCreateAttempts++;
        return new Response(
          JSON.stringify({ error: { message: "Lookup_key already exists on another price" } }),
          { status: 400 },
        );
      }
      throw new Error(`unexpected url ${c.url}`);
    });

    const map = await ensureStripePrices("sk_test_fake");
    // Converged on the racing winner — never surfaced the 400 to the caller.
    expect(map.platform_monthly).toBe("price_raced_winner");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/prices"))).toBe(true);
  });
});

describe("setSubscriptionItemQuantity — absolute set-to-N + proration direction", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the absolute quantity + proration_behavior + an Idempotency-Key to the item endpoint", async () => {
    const { calls } = stubFetch(() => new Response("{}", { status: 200 }));

    await setSubscriptionItemQuantity("sk_test_fake", "si_123", 12, "create_prorations", "idem-abc");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.stripe.com/v1/subscription_items/si_123");
    expect(call.method).toBe("POST");
    const body = new URLSearchParams(call.body);
    expect(body.get("quantity")).toBe("12"); // absolute, not an increment
    expect(body.get("proration_behavior")).toBe("create_prorations");
    expect((call.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-abc");
  });

  it("passes proration_behavior 'none' on a decrease (founder ruling 2 — no mid-cycle credit)", async () => {
    const { calls } = stubFetch(() => new Response("{}", { status: 200 }));
    await setSubscriptionItemQuantity("sk_test_fake", "si_123", 5, "none", "idem-dec");
    expect(new URLSearchParams(calls[0]!.body).get("proration_behavior")).toBe("none");
  });
});

describe("getSubscription — resolves item ids by lookup_key", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps items.data to { id, lookupKey, priceId, quantity }", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            items: {
              data: [
                { id: "si_platform", quantity: 1, price: { id: "price_p", lookup_key: "coldrig_platform_monthly_v1" } },
                { id: "si_mailbox", quantity: 8, price: { id: "price_m", lookup_key: "coldrig_mailbox_monthly_v1" } },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    const items = await getSubscription("sk_test_fake", "sub_1");
    expect(items).toHaveLength(2);
    const mailbox = items.find((i) => i.lookupKey === "coldrig_mailbox_monthly_v1");
    expect(mailbox).toEqual({ id: "si_mailbox", lookupKey: "coldrig_mailbox_monthly_v1", priceId: "price_m", quantity: 8 });
  });
});
