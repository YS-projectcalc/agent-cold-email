import { describe, expect, it } from "vitest";
import { evaluatePrimaryDomainBreaker } from "../src/engine/byo-breaker.js";

// SPEC.md §20.2 — the primary-domain complaint-rate circuit breaker. NEVER a
// bare rate: hard-pause requires ALL THREE of (1) >=100 trailing-7d sends
// (volume floor), (2) >=3 trailing-7d complaints (absolute floor), (3) >=0.10%
// trailing-7d rate. Below the volume floor, any complaint (>=1) is a SOFT
// response (halve cap + flag), never an automatic pause. This is the exact
// formula round 2/3 of the adversarial review fought over (bare-rate griefing
// vector at low volume) — pinned here so a regression can't silently reopen it.

describe("evaluatePrimaryDomainBreaker", () => {
  it("is OK with zero sends/complaints", () => {
    expect(evaluatePrimaryDomainBreaker({ windowSends: 0, windowComplaints: 0 })).toEqual({ type: "ok" });
  });

  it("does NOT hard-pause on a single complaint at griefing-vector volume (the R2 bare-rate defect)", () => {
    // 1 complaint / 20 sends = 5% by bare rate — would trip a naive 0.10% rule
    // instantly. Below the 100-send volume floor -> soft response, not a pause.
    const verdict = evaluatePrimaryDomainBreaker({ windowSends: 20, windowComplaints: 1 });
    expect(verdict.type).toBe("soft_response");
  });

  it("soft-responds on ANY complaint below the volume floor, even just 1", () => {
    const verdict = evaluatePrimaryDomainBreaker({ windowSends: 99, windowComplaints: 1 });
    expect(verdict.type).toBe("soft_response");
  });

  it("never hard-pauses on 1-2 complaints regardless of volume (the absolute-complaint floor)", () => {
    // 2 complaints / 5000 sends = 0.04% (below rate floor anyway) but even at
    // a volume where 2 complaints WOULD clear a bare 0.10% rate, the absolute
    // floor of 3 still blocks it.
    const verdict = evaluatePrimaryDomainBreaker({ windowSends: 1500, windowComplaints: 2 });
    expect(verdict.type).not.toBe("hard_pause");
  });

  it("stays OK above the volume floor with complaints under the absolute floor (normal background noise)", () => {
    const verdict = evaluatePrimaryDomainBreaker({ windowSends: 500, windowComplaints: 2 });
    expect(verdict).toEqual({ type: "ok" });
  });

  it("hard-pauses only when all three conditions hold together", () => {
    // 100 sends, 3 complaints, rate = 3% >= 0.10% -- all three conditions met.
    const verdict = evaluatePrimaryDomainBreaker({ windowSends: 100, windowComplaints: 3 });
    expect(verdict.type).toBe("hard_pause");
  });

  it("does not hard-pause at the volume floor with 3 complaints but a rate just under 0.10% (impossible in practice, but the rate leg must still gate)", () => {
    // 3 complaints / 5000 sends = 0.06% < 0.10% -- volume + absolute floors
    // both clear, but the rate leg does not -> must stay OK (rate genuinely gates).
    const verdict = evaluatePrimaryDomainBreaker({ windowSends: 5000, windowComplaints: 3 });
    expect(verdict.type).toBe("ok");
  });

  it("hard-pauses at high volume once the rate crosses 0.10% with the absolute floor cleared", () => {
    // 10 complaints / 5000 sends = 0.20% >= 0.10%, 10 >= 3, 5000 >= 100.
    const verdict = evaluatePrimaryDomainBreaker({ windowSends: 5000, windowComplaints: 10 });
    expect(verdict.type).toBe("hard_pause");
  });

  it("the 3-complaint floor binds below ~3000 trailing sends (adversarial round-3 arithmetic)", () => {
    // At 3000 sends, 3 complaints = exactly 0.10% -- right at the boundary,
    // rate condition satisfied (>=), so this pauses on the absolute floor +
    // rate together, confirming the ~3000-send crossover the adversarial
    // record cites.
    const verdict = evaluatePrimaryDomainBreaker({ windowSends: 3000, windowComplaints: 3 });
    expect(verdict.type).toBe("hard_pause");
  });
});
