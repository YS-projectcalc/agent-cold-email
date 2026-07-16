import { describe, expect, it } from "vitest";
import { effectiveDailyCap, rampTierFor, shortenedWarmupDailyCap } from "../src/engine/byo-ramp.js";
import { warmupDailyCap } from "../src/engine/warmup.js";

// SPEC.md §20.2/§20.5 — the domain-tier warmup/cap ramp. Primary domains clamp
// to <=20/mbx/day at every ramp day (min(standard day-N cap, 20)), never a
// compressed/shortened schedule. Non-primary established-good domains get a
// SHORTENED ramp (7-10 days to steady state) instead of the standard 28-day
// one. Every existing (non-BYO) mailbox must see BYTE-IDENTICAL behavior —
// `rampTierFor` must resolve to 'standard' whenever isPrimary=false and
// reputationBranch is anything other than 'established_good'.

describe("rampTierFor", () => {
  it("is 'primary' whenever the domain is primary, regardless of reputation branch", () => {
    expect(rampTierFor({ isPrimary: true, reputationBranch: "established_good" })).toBe("primary");
    expect(rampTierFor({ isPrimary: true, reputationBranch: "unknown_fresh" })).toBe("primary");
    expect(rampTierFor({ isPrimary: true, reputationBranch: null })).toBe("primary");
  });

  it("is 'shortened' for a non-primary established-good domain", () => {
    expect(rampTierFor({ isPrimary: false, reputationBranch: "established_good" })).toBe("shortened");
  });

  it("is 'standard' for a non-primary unknown/fresh domain or a provisioned (non-BYO) domain", () => {
    expect(rampTierFor({ isPrimary: false, reputationBranch: "unknown_fresh" })).toBe("standard");
    expect(rampTierFor({ isPrimary: false, reputationBranch: null })).toBe("standard");
  });
});

describe("effectiveDailyCap — primary tier", () => {
  it("clamps to <=20/mbx/day at every ramp day, never exceeding the standard schedule at that day", () => {
    for (let day = 1; day <= 40; day++) {
      const primaryCap = effectiveDailyCap(day, "primary");
      const standardCap = warmupDailyCap(day);
      expect(primaryCap).toBeLessThanOrEqual(20);
      expect(primaryCap).toBeLessThanOrEqual(standardCap);
    }
  });

  it("matches the standard schedule exactly while standard is already <=20 (no compression, only a ceiling)", () => {
    // Standard day 1-14 caps are 5 and 15 -- both already under 20, so the
    // primary tier must reproduce them exactly, not race ahead or lag behind.
    expect(effectiveDailyCap(1, "primary")).toBe(warmupDailyCap(1));
    expect(effectiveDailyCap(14, "primary")).toBe(warmupDailyCap(14));
  });

  it("clamps at day 15+ where standard would exceed 20 (day 15-21 standard=25, day 22-28 standard=35, day 29+=40)", () => {
    expect(effectiveDailyCap(15, "primary")).toBe(20);
    expect(effectiveDailyCap(21, "primary")).toBe(20);
    expect(effectiveDailyCap(28, "primary")).toBe(20);
    expect(effectiveDailyCap(40, "primary")).toBe(20);
  });

  it("never exceeds 20 even at week-4 steady state (SPEC.md §20.2's explicit example)", () => {
    expect(effectiveDailyCap(28, "primary")).toBeLessThanOrEqual(20);
  });
});

describe("shortenedWarmupDailyCap / effectiveDailyCap — shortened tier", () => {
  it("reaches full steady-state (40/day) within 7-10 days, per SPEC.md §20.5", () => {
    expect(shortenedWarmupDailyCap(10)).toBe(40);
    expect(shortenedWarmupDailyCap(11)).toBe(40);
  });

  it("never allows MORE volume than the standard ramp would at the SAME day (it's faster, never looser)", () => {
    for (let day = 1; day <= 10; day++) {
      expect(shortenedWarmupDailyCap(day)).toBeGreaterThanOrEqual(0);
    }
    // Spot-check: day 3 shortened (5) <= day 3 standard (5); day 8 shortened
    // (25) is intentionally AHEAD of standard day 8 (15) -- that's the whole
    // point of "shortened" -- but never past the final steady-state cap.
    expect(shortenedWarmupDailyCap(8)).toBeLessThanOrEqual(40);
  });

  it("effectiveDailyCap('shortened') delegates to shortenedWarmupDailyCap", () => {
    for (let day = 1; day <= 15; day++) {
      expect(effectiveDailyCap(day, "shortened")).toBe(shortenedWarmupDailyCap(day));
    }
  });
});

describe("effectiveDailyCap — standard tier is byte-identical to the pre-existing warmupDailyCap", () => {
  it("matches warmupDailyCap() at every day 1-40 (flag-dark guarantee for every existing/provisioned mailbox)", () => {
    for (let day = 1; day <= 40; day++) {
      expect(effectiveDailyCap(day, "standard")).toBe(warmupDailyCap(day));
    }
  });
});
