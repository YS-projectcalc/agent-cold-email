import { describe, expect, it } from "vitest";
import { LEG_SHAPES } from "../src/admin/sweep-signals.js";
import { LEG_SUBREQUEST_COSTS, SWEEP_FANOUT_RPCS_PER_TENANT, SWEEP_RPCS_PER_TENANT } from "../src/admin/sweep-budget.js";
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

/** Leg names handed the SHARED-SUMMARY scope specifically — the legs that read
 * the tick's one prefetched ops summary instead of fetching their own. */
function sharedSummaryLegNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/runLeg<?[^>]*>?\(\s*"([a-zA-Z0-9_]+)"([\s\S]*?)\);/g)) {
    if (match[2]!.includes("scopeWithSummaries")) names.push(match[1]!);
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

  it("every leg that fans out per tenant is priced, and a ZERO price is explained", () => {
    // WAS `SWEEP_RPCS_PER_TENANT >= scoped.length + 1`, a headcount proxy for
    // "each fan-out leg costs at least one RPC". That stopped being true on
    // 2026-08-24: the ops-summary dedupe made `digest` cost ZERO per tenant
    // (it reads the tick's shared prefetch), and two legs already cost zero
    // because they fan out over a population of their own. A headcount cannot
    // tell a legitimate zero from an unpriced leg — which is the thing this
    // guard exists to catch — so it is replaced by one that can.
    for (const name of scopedLegNames(scheduledSource)) {
      const cost = LEG_SUBREQUEST_COSTS[name];
      expect(cost, `leg "${name}" fans out per tenant and LEG_SUBREQUEST_COSTS does not price it`).toBeTruthy();
      if (cost!.perTenant === 0) {
        expect(
          cost!.ownFanout > 0 || cost!.sharedSummary === true,
          `leg "${name}" is priced at ZERO DO RPCs per tenant with no explanation. A slice leg costs nothing ` +
            "only if it fans out over its own population (`ownFanout`) or it consumes the tick's shared " +
            "ops-summary prefetch (`sharedSummary`). An unexplained zero is an unpriced leg, and an unpriced " +
            "leg is spend the slice arithmetic does not know about — that is B1.",
        ).toBe(true);
      }
    }
    // ...and the budget still covers every leg that DOES spend per tenant.
    const pricedLegs = scopedLegNames(scheduledSource).filter((n) => (LEG_SUBREQUEST_COSTS[n]?.perTenant ?? 0) > 0);
    expect(SWEEP_RPCS_PER_TENANT).toBeGreaterThanOrEqual(pricedLegs.length);
    expect(SWEEP_FANOUT_RPCS_PER_TENANT).toBeGreaterThanOrEqual(pricedLegs.length - 2);
  });

  it("the sharedSummary flag matches the legs the SCHEDULER actually hands the shared map", () => {
    // A DUAL ORACLE for the dedupe, the same shape B1's fix used: the budget
    // file's flag and the scheduler's wiring are two independent sources and
    // both have to say the same thing. Flagging a leg that does NOT get the map
    // under-prices it by one RPC per tenant per tick; wiring a leg that is not
    // flagged over-prices it, and the slice silently shrinks.
    const flagged = Object.entries(LEG_SUBREQUEST_COSTS)
      .filter(([, cost]) => cost.sharedSummary === true)
      .map(([name]) => name)
      .sort();
    const wired = [...new Set(sharedSummaryLegNames(scheduledSource))].sort();
    expect(wired, "could not find the shared-summary legs in scheduled.ts — this guard would be vacuous").not.toEqual([]);
    expect(wired).toEqual(flagged);
  });

  it("the shared prefetch leg itself is scoped, priced, and runs BEFORE its consumers", () => {
    const scoped = scopedLegNames(scheduledSource);
    expect(scoped).toContain("opsSummary");
    expect(LEG_SUBREQUEST_COSTS["opsSummary"]?.perTenant).toBe(1);
    // Ordering is load-bearing: the consumers read a map the prefetch fills, and
    // they share its deadline, so its coverage must be a SUPERSET of theirs.
    const prefetchAt = scheduledSource.indexOf('runLeg("opsSummary"');
    for (const consumer of ["dunning", "digest", "watchtower"]) {
      expect(prefetchAt, `the opsSummary prefetch must run before "${consumer}"`).toBeLessThan(
        scheduledSource.indexOf(`runLeg("${consumer}"`),
      );
    }
  });
});
