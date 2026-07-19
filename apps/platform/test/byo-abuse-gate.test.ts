import { describe, expect, it } from "vitest";
import { assessByoDomainAbuse } from "../src/engine/byo-abuse-gate.js";

// SPEC.md §20.3 — TXT verification proves control of a domain, not legitimacy
// of its use. Extends brand-guard's denylist to the BYO domain itself (not
// just the asserted brand field) + a registrable-lookalike/homoglyph check
// (the paypa1.com class). TXT-verified-but-suspicious -> 'kyc_required', NOT
// an auto-reject and NOT an auto-admit -- ownership proof and abuse screening
// are independent gates.

describe("assessByoDomainAbuse", () => {
  it("is 'clear' for an ordinary, unrelated domain", () => {
    expect(assessByoDomainAbuse("mordy-outreach.com").verdict).toBe("clear");
  });

  it("routes to 'kyc_required' on an exact well-known-brand hit (a customer's OWN domain literally being a denylisted brand)", () => {
    expect(assessByoDomainAbuse("paypal.com").verdict).toBe("kyc_required");
  });

  it("catches the canonical homoglyph example: paypa1.com (digit-for-letter substitution)", () => {
    expect(assessByoDomainAbuse("paypa1.com").verdict).toBe("kyc_required");
  });

  it("catches an added-character lookalike within edit distance 1 of a denylisted brand", () => {
    expect(assessByoDomainAbuse("paypall.com").verdict).toBe("kyc_required");
  });

  it("catches a confusable-substitution lookalike of a different denylisted brand (chase -> ch4se)", () => {
    expect(assessByoDomainAbuse("ch4se.com").verdict).toBe("kyc_required");
  });

  it("does NOT flag a domain merely CONTAINING a brand-like substring as part of a longer unrelated word", () => {
    // "metadata" must never false-positive against "meta" (brand-guard.ts's
    // own documented false-positive class) -- exact-token / near-token match
    // only, never substring containment.
    expect(assessByoDomainAbuse("metadata-analytics.com").verdict).toBe("clear");
  });

  it("stays 'clear' for a generic-phish-shaped domain with no specific brand keyed (the named residual, §20.3)", () => {
    // secure-billing-support.com impersonates no specific brand, so the
    // homoglyph/denylist check has nothing to key off -- this is the
    // explicitly-named gap the complaint breaker backstops downstream, not this gate.
    expect(assessByoDomainAbuse("secure-billing-support.com").verdict).toBe("clear");
  });
});
