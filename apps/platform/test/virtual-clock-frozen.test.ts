import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";

// C-M3, docs/adversarial/sweep-completeness-pass-2026-08-17.md §4(iii).
//
// `tenant_profile.clock_multiplier` stored 1440 for demo/free tenants and was
// NEVER APPLIED: `now()` returned `baseMs + offsetMs` and never consulted it,
// the only method that did (`advance(realMs)`) had zero call sites anywhere in
// `apps/` or `packages/`, and every real advance went through `advanceVirtual`,
// which bypassed it by design. A demo tenant's clock is FROZEN — it moves only
// in the discrete jumps something explicitly asks for — not running at 1440x.
//
// That mattered beyond the dead config itself: TWO independent class sweeps
// reasoned from the 1440x rate as though it were live and built findings on an
// exposure that does not exist ("the 30-day idempotency TTL expires in ~30 real
// minutes for these tenants"). This test pins the semantics that were true all
// along, so the next reader does not have to re-derive them from a column name.

describe("VirtualClock is frozen — no rate, only explicit jumps (C-M3)", () => {
  it("does not track real wall time", async () => {
    const clock = new VirtualClock(1_800_000_000_000, 0);
    const before = clock.now();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(clock.now()).toBe(before);
  });

  it("moves ONLY by the exact virtual duration it is given — never scaled", () => {
    const clock = new VirtualClock(1_800_000_000_000, 0);
    const base = clock.now();
    clock.advanceVirtual(60_000);
    expect(clock.now()).toBe(base + 60_000);
    clock.advanceVirtual(60_000);
    expect(clock.now()).toBe(base + 120_000);
  });

  it("rejects a negative jump rather than moving backwards", () => {
    const clock = new VirtualClock(1_800_000_000_000, 0);
    expect(() => clock.advanceVirtual(-1)).toThrow(RangeError);
  });

  it("resumes from a persisted offset (DO eviction/hibernation)", () => {
    const clock = new VirtualClock(1_800_000_000_000, 5_000);
    expect(clock.now()).toBe(1_800_000_005_000);
    expect(clock.offset).toBe(5_000);
  });
});
