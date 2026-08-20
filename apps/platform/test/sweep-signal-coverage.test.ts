import { describe, expect, it } from "vitest";
import { LEG_SHAPES } from "../src/admin/sweep-signals.js";
import { SWEEP_FANOUT_RPCS_PER_TENANT, SWEEP_RPCS_PER_TENANT } from "../src/admin/sweep-budget.js";
import scheduledSource from "../src/scheduled.ts?raw";

// W-M3 (docs/adversarial/sweep-completeness-pass-2026-08-17.md) — the tripwire
// that makes `collectLegSignals`' coverage claim TRUE.
//
// The old docblock said: "a NEW leg is covered the moment it is added to that
// object — there is no per-leg list to keep in sync." It was false. Coverage
// required the leg to name its counter exactly `errors` | `budgetExpiries` |
// `skippedForLegDeadline` AND to return `null` on throw; a new leg reporting
// seven failures under any other plausible field name read perfectly clean.
// Executed against the old code, it did.
//
// There is a per-leg list now (`LEG_SHAPES`), which is honest — and this file
// is what keeps it in sync, so the honesty does not depend on the next author
// remembering. It also pins the OTHER accounting the leg bag feeds: the
// per-tenant RPC budget in sweep-budget.ts, which sizes the tick's tenant slice.

/** The keys of `scheduled.ts`'s own `const legs = { ... }` bag. */
function legBagKeys(source: string): string[] {
  const block = source.match(/const legs = \{([\s\S]*?)\n {2}\};/)?.[1];
  if (!block) throw new Error("could not find the `const legs = {...}` bag in scheduled.ts");
  return [...block.matchAll(/^\s{4}([a-zA-Z0-9_]+)[,:]/gm)].map((m) => m[1]!);
}

/** Leg names whose `runLeg(...)` invocation hands the call a `scope` — i.e.
 * every leg that fans out per tenant and is therefore bounded by the slice. */
function scopedLegNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/runLeg<?[^>]*>?\(\s*"([a-zA-Z0-9_]+)"([\s\S]*?)\);/g)) {
    if (match[2]!.includes("scope")) names.push(match[1]!);
  }
  return names;
}

describe("the leg bag and the reducer that reads it cannot drift", () => {
  it("finds the bag at all (a regex that matched nothing would make this vacuous)", () => {
    const keys = legBagKeys(scheduledSource);
    expect(keys).toContain("sendPipeline");
    expect(keys).toContain("watchtower");
    expect(keys.length).toBeGreaterThanOrEqual(10);
  });

  it("every leg in the bag has a declared reporting shape", () => {
    const undeclared = legBagKeys(scheduledSource).filter((name) => !(name in LEG_SHAPES));
    expect(
      undeclared,
      "a cron leg was added to scheduled.ts's `legs` bag without telling admin/sweep-signals.ts how it " +
        "reports failure. Add it to LEG_SHAPES: 'counters' (an `errors` field), 'alert-outcomes' " +
        "(AlertOutcome[]), 'outcome-reason' (a {reason:'failed'} field), or 'no-signal' (only a throw " +
        "tells). Leaving it out means its failures are counted as zero, silently.",
    ).toEqual([]);
  });

  it("declares no shape for a leg that is not in the bag", () => {
    const keys = new Set(legBagKeys(scheduledSource));
    const orphaned = Object.keys(LEG_SHAPES).filter((name) => !keys.has(name));
    expect(orphaned, "LEG_SHAPES describes a leg scheduled.ts no longer runs — delete it (CLAUDE.md rule a)").toEqual([]);
  });
});

describe("the per-tenant RPC budget accounts for every fan-out leg", () => {
  it("finds the scoped legs at all", () => {
    const scoped = scopedLegNames(scheduledSource);
    expect(scoped).toContain("deliverability");
    expect(scoped).toContain("sendPipeline");
  });

  it("budgets at least one RPC per tenant for each leg that fans out", () => {
    const scoped = scopedLegNames(scheduledSource);
    // The send pipeline costs TWO (poll + tick) and is the only one that does;
    // everything else is one, plus the conditional extras enumerated in
    // sweep-budget.ts (dunning's suspend, the watchtower's continuity nudge).
    expect(
      SWEEP_RPCS_PER_TENANT,
      "a new per-tenant cron leg was added without raising SWEEP_RPCS_PER_TENANT (admin/sweep-budget.ts). " +
        "That constant is what sizes the tick's tenant slice, so under-counting it hands the sweep a slice " +
        "it cannot afford — which is exactly how the dead-man heartbeat used to vanish.",
    ).toBeGreaterThanOrEqual(scoped.length + 1);
    expect(SWEEP_FANOUT_RPCS_PER_TENANT).toBeGreaterThanOrEqual(scoped.length - 1);
  });
});
