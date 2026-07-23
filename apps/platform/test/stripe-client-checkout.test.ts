import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripeCheckoutSession } from "../src/billing/stripe-client.js";

// I2 (self-serve activation design §2.5) — promo-code checkout.
// F2 (adversarial 2026-07-21, BLOCKING): promo eligibility is restricted to
// the `launch` plan IN CODE — a growth/scale session must never enable
// `allow_promotion_codes`, regardless of what a founder-minted coupon
// restricts it to at Stripe, so a code can never be entered against a
// higher-value tier through this session at all.

describe("createStripeCheckoutSession — promo code params (F2 plan-restricted)", () => {
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
    successUrl: "https://example.com/success",
    cancelUrl: "https://example.com/cancel",
  };

  it("enables allow_promotion_codes + payment_method_collection:if_required for the launch plan", async () => {
    const capture = stubFetchCapture();
    await createStripeCheckoutSession("sk_test_fake", { ...baseParams, plan: "launch", priceCents: 9_900, label: "Launch" });

    const body = capture.body();
    expect(body.get("allow_promotion_codes")).toBe("true");
    expect(body.get("payment_method_collection")).toBe("if_required");
  });

  it("does NOT enable promo codes for growth — plan-restricted in code (F2)", async () => {
    const capture = stubFetchCapture();
    await createStripeCheckoutSession("sk_test_fake", { ...baseParams, plan: "growth", priceCents: 29_900, label: "Growth" });

    const body = capture.body();
    expect(body.get("allow_promotion_codes")).toBeNull();
    expect(body.get("payment_method_collection")).toBeNull();
  });

  it("does NOT enable promo codes for scale — plan-restricted in code (F2)", async () => {
    const capture = stubFetchCapture();
    await createStripeCheckoutSession("sk_test_fake", { ...baseParams, plan: "scale", priceCents: 79_900, label: "Scale" });

    const body = capture.body();
    expect(body.get("allow_promotion_codes")).toBeNull();
    expect(body.get("payment_method_collection")).toBeNull();
  });

  it("still carries the tenant/plan metadata regardless of promo eligibility (positive control)", async () => {
    const capture = stubFetchCapture();
    await createStripeCheckoutSession("sk_test_fake", { ...baseParams, plan: "launch", priceCents: 9_900, label: "Launch" });

    const body = capture.body();
    expect(body.get("client_reference_id")).toBe("ten_test");
    expect(body.get("metadata[plan]")).toBe("launch");
    expect(body.get("mode")).toBe("subscription");
  });
});

// Brand class-sweep (2026-07-22, founder ORDER, ROADMAP.md): the checkout
// page must show the ratified "Coldrig" brand, never the retired "ColdStart"
// working name — and the "(test mode)" suffix must be DERIVED from the
// secret key's sk_test_/sk_live_ prefix (the same key already threaded into
// this function), not hardcoded, so a live-mode customer never sees a
// test-mode label.
describe("createStripeCheckoutSession — product name brand + test-mode derivation", () => {
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
    successUrl: "https://example.com/success",
    cancelUrl: "https://example.com/cancel",
    plan: "launch",
    priceCents: 9_900,
    label: "Launch",
  };

  it("names the product 'Coldrig <label> (test mode)' for a sk_test_ key", async () => {
    const capture = stubFetchCapture();
    await createStripeCheckoutSession("sk_test_fake", baseParams);

    const name = capture.body().get("line_items[0][price_data][product_data][name]");
    expect(name).toBe("Coldrig Launch (test mode)");
  });

  it("names the product 'Coldrig <label>' with NO suffix for a sk_live_ key", async () => {
    const capture = stubFetchCapture();
    await createStripeCheckoutSession("sk_live_fake", baseParams);

    const name = capture.body().get("line_items[0][price_data][product_data][name]");
    expect(name).toBe("Coldrig Launch");
  });
});

// Reintroduction tripwire for this surface lives in brand-copy-guard.test.ts
// (scans the raw source of every customer-visible-surface file, this one
// included, for the retired brand string).
