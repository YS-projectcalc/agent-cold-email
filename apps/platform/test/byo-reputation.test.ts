import { describe, expect, it } from "vitest";
import { computeReputationBranch } from "../src/engine/byo-reputation.js";

// SPEC.md §20.5 — the non-primary reputation ladder + the primary-axis-first
// gate. Blocklisted rejects at intake for BOTH primary and non-primary
// (deliverability lane, not the abuse gate). Primary domains never branch
// into established_good/unknown_fresh -- they always take the full standard
// ramp regardless of reputation signal (byo-ramp.ts's rampTierFor already
// pins this on isPrimary alone, but computeReputationBranch itself must also
// report the primary-standard branch honestly rather than lying about which
// composite signal applies).

const GOOD_SIGNAL = { isPrimary: false, ageDays: 800, blocklisted: false, dmarcEnforced: true, activeSendingEvidence: true };

describe("computeReputationBranch", () => {
  it("is 'blocklisted_reject' whenever blocklisted is true, primary or not", () => {
    expect(computeReputationBranch({ ...GOOD_SIGNAL, blocklisted: true }).branch).toBe("blocklisted_reject");
    expect(computeReputationBranch({ ...GOOD_SIGNAL, isPrimary: true, blocklisted: true }).branch).toBe("blocklisted_reject");
  });

  it("is 'primary_standard' for any primary domain that isn't blocklisted, regardless of the other signals", () => {
    expect(computeReputationBranch({ ...GOOD_SIGNAL, isPrimary: true }).branch).toBe("primary_standard");
    expect(
      computeReputationBranch({ isPrimary: true, ageDays: null, blocklisted: false, dmarcEnforced: false, activeSendingEvidence: false })
        .branch,
    ).toBe("primary_standard");
  });

  it("is 'established_good' only when age>=2yr AND dmarc-enforced AND active-sending-evidence ALL hold (non-primary)", () => {
    expect(computeReputationBranch(GOOD_SIGNAL).branch).toBe("established_good");
  });

  it("falls to 'unknown_fresh' when age is under 2 years even with everything else present", () => {
    expect(computeReputationBranch({ ...GOOD_SIGNAL, ageDays: 400 }).branch).toBe("unknown_fresh");
  });

  it("falls to 'unknown_fresh' when DMARC is not yet in enforcement", () => {
    expect(computeReputationBranch({ ...GOOD_SIGNAL, dmarcEnforced: false }).branch).toBe("unknown_fresh");
  });

  it("falls to 'unknown_fresh' for an aged-dormant domain with NO active-sending evidence (age+clean alone is insufficient)", () => {
    // The exact adversarial-round finding: age>=2y + clean + DMARC-enforced but
    // no proof of actual mail flow must NOT qualify for the shortcut.
    expect(computeReputationBranch({ ...GOOD_SIGNAL, activeSendingEvidence: false }).branch).toBe("unknown_fresh");
  });

  it("falls to 'unknown_fresh' when ageDays is null (unknown age, no disqualifying signal either)", () => {
    expect(computeReputationBranch({ ...GOOD_SIGNAL, ageDays: null }).branch).toBe("unknown_fresh");
  });
});
