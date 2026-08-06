import { describe, expect, it } from "vitest";
import billingSource from "../src/engine/billing.ts?raw";
import { HANDLED_STRIPE_EVENT_TYPES } from "../src/billing/stripe-webhook.js";

// Failing-by-construction guards for docs/adversarial/audit-stripe-webhook-2026-08-06.md,
// in the same spirit as spend-armed-env-coverage.test.ts: the FIX is in the
// code, but nothing stops the next person reopening the class, so the guard is
// a test that goes red when they do. A doc comment is not a systemic guard.

describe("HANDLED_STRIPE_EVENT_TYPES stays in step with the handler switch", () => {
  // The route uses this set to decide whether an unroutable event deserves a
  // founder alert, and the DO uses it to decide whether an event participates
  // in the ordering watermark. If someone adds a `case` to
  // applyStripeEventEffects without adding it here, that new event type would
  // silently skip BOTH — an unroutable one would fail quietly (exactly the
  // silence finding 1 lived in) and a stale one would apply out of order.
  const switchCases = [...billingSource.matchAll(/^\s{4}case "([a-z_.]+)": \{$/gm)].map((m) => m[1]);

  it("finds the handler switch (guard is not vacuously green)", () => {
    expect(switchCases.length).toBeGreaterThanOrEqual(6);
  });

  it("every handled case is declared in HANDLED_STRIPE_EVENT_TYPES", () => {
    const missing = switchCases.filter((type) => !HANDLED_STRIPE_EVENT_TYPES.has(type as string));
    expect(missing).toEqual([]);
  });

  it("every declared type is actually handled", () => {
    const unhandled = [...HANDLED_STRIPE_EVENT_TYPES].filter((type) => !switchCases.includes(type));
    expect(unhandled).toEqual([]);
  });
});

describe("no test fixture may hand-place tenant metadata on an Invoice or a Dispute", () => {
  // THE defect this whole audit turned on: Stripe does not decorate Invoices or
  // Disputes with our metadata — an Invoice's own `metadata` is `{}` (the
  // subscription's lands under `subscription_details.metadata`) and a Dispute is
  // minted by Stripe with `metadata: {}` and no `customer`. Fixtures that
  // pretended otherwise made the dunning and chargeback lanes pass their tests
  // while resolving nothing in production. Real shapes live in
  // test/stripe-fixtures.ts; this keeps the fake ones from coming back.
  const sources = import.meta.glob("./*.test.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const UNDECORATED_TYPES = ["invoice.payment_failed", "charge.dispute.created", "charge.dispute.closed"];

  it("sees this suite's test sources (guard is not vacuously green)", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(Object.keys(sources).some((p) => p.includes("stripe-webhook-boundary"))).toBe(true);
  });

  it("no fixture pairs one of those event types with metadata.tenantId", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      if (path.includes("stripe-webhook-guards")) continue; // this file names the types on purpose
      for (const type of UNDECORATED_TYPES) {
        let from = source.indexOf(type);
        while (from !== -1) {
          // A fixture literal for one of these types, with tenant metadata
          // anywhere in the object that follows it.
          const window = source.slice(from, from + 400);
          if (/metadata:\s*\{\s*tenantId/.test(window)) offenders.push(`${path} (${type})`);
          from = source.indexOf(type, from + 1);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
