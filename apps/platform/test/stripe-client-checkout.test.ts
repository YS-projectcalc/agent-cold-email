import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripeCheckoutSession } from "../src/billing/stripe-client.js";

// Quantity-billing migration (design §2/§3) — checkout builds TWO durable-Price
// line items (platform qty 1 + mailbox qty N) instead of one inline price. The
// tiers collapsed to one paid plan (`managed`), so promo entry is enabled for
// every checkout; `payment_method_collection: "if_required"` still collects a
// card whenever the discounted invoice is > $0 (design §10 scenario 5). The
// real-Stripe crux is the Tier-2 test-mode gate (tools/billing-gate/).

describe("createStripeCheckoutSession — two durable-Price line items", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetchCapture(): { body: () => URLSearchParams } {
    let captured = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        captured = String(init.body ?? "");
        return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/test" }), { status: 200 });
      }),
    );
    return { body: () => new URLSearchParams(captured) };
  }

  const baseParams = {
    tenantId: "ten_test",
    platformPriceId: "price_platform_monthly",
    mailboxPriceId: "price_mailbox_monthly",
    mailboxQuantity: 8,
    successUrl: "https://example.com/success",
    cancelUrl: "https://example.com/cancel",
  };

  it("emits a platform item (qty 1) + a mailbox item (qty N) referencing durable Price ids — no inline price_data", async () => {
    const capture = stubFetchCapture();
    await createStripeCheckoutSession("sk_test_fake", baseParams);

    const body = capture.body();
    expect(body.get("line_items[0][price]")).toBe("price_platform_monthly");
    expect(body.get("line_items[0][quantity]")).toBe("1");
    expect(body.get("line_items[1][price]")).toBe("price_mailbox_monthly");
    expect(body.get("line_items[1][quantity]")).toBe("8");
    // The retired inline-price shape is gone (un-couponable, un-durable).
    expect(body.get("line_items[0][price_data][unit_amount]")).toBeNull();
    expect(body.get("mode")).toBe("subscription");
  });

  it("enables allow_promotion_codes + payment_method_collection:if_required for the single managed plan", async () => {
    const capture = stubFetchCapture();
    await createStripeCheckoutSession("sk_test_fake", baseParams);

    const body = capture.body();
    expect(body.get("allow_promotion_codes")).toBe("true");
    expect(body.get("payment_method_collection")).toBe("if_required");
  });

  it("carries the tenant id + the managed plan on both session and subscription metadata", async () => {
    const capture = stubFetchCapture();
    await createStripeCheckoutSession("sk_test_fake", baseParams);

    const body = capture.body();
    expect(body.get("client_reference_id")).toBe("ten_test");
    expect(body.get("metadata[tenantId]")).toBe("ten_test");
    expect(body.get("metadata[plan]")).toBe("managed");
    expect(body.get("subscription_data[metadata][plan]")).toBe("managed");
  });
});

// Reintroduction tripwire for this surface lives in brand-copy-guard.test.ts
// (scans the raw source of every customer-visible-surface file, this one
// included, for the retired brand string). The customer-visible product names
// now live on the durable Products ("Coldrig Platform"/"Coldrig Mailbox",
// stripe-client.ts STRIPE_PRICES), not on the inline checkout payload.
