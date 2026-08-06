import { describe, expect, it } from "vitest";
// `?raw` (Vite import suffix) pulls the SOURCE TEXT in at transform time — the
// same mechanism spend-armed-env-coverage.test.ts uses. We inspect source
// rather than runtime values because the property under test is "nowhere else
// constructs one", which has no runtime representation.
import clockSource from "../src/clock.ts?raw";
import tenantDoSource from "../src/tenant-do.ts?raw";

// The whole of src/, resolved at transform time (workerd has no filesystem) —
// the same mechanism send-governance-coverage.test.ts uses for its own sweep.
const SRC_SOURCES = import.meta.glob("../src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>;

/**
 * The ONLY file allowed to construct a tenant's VirtualClock. `clock.ts`
 * defines the class but never instantiates one for a tenant, so it is not on
 * this list either.
 */
const CLOCK_SELECTION_AUTHORITY = "../src/tenant-do.ts";

// WAVE 2, design test-plan item 9 — THE CLOCK-PROVENANCE GUARD.
//
// ARCHITECTURE.md #4 and the wave-2 clock law say TenantDO alone decides which
// clock a tenant gets: VirtualClock is sandbox/demo-only, and a paying tenant
// crosses to real time exactly once, through the one-shot migration. A stray
// `new VirtualClock(...)` anywhere else silently re-introduces a frozen clock
// for a tenant that has already migrated — and every row it stamps afterwards
// is permanently wrong, because the migration cannot be re-run.
//
// A doc comment cannot enforce that. This test does: adding a construction site
// outside the two blessed files trips RED until a human decides it belongs.

function constructionCount(source: string): number {
  return source.split("new VirtualClock(").length - 1;
}

/** The text between two member markers — fails loudly (empty) if either moves. */
function memberSource(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1 || end === -1) return "";
  return source.slice(start, end);
}

describe("clock provenance — only TenantDO may construct a tenant's clock", () => {
  it("clock.ts DEFINES the class and never constructs one for a tenant (non-vacuous)", () => {
    expect(clockSource).toContain("export class VirtualClock");
    expect(constructionCount(clockSource)).toBe(0);
  });

  it("NO file in src/ other than tenant-do.ts constructs a VirtualClock", () => {
    // The real sweep. A new `new VirtualClock(...)` anywhere in src/ — a helper,
    // a route, a future scheduler — trips this until a human decides it belongs,
    // because such a clock would be frozen for a tenant that already migrated
    // and every row it stamps afterwards is permanently wrong.
    expect(Object.keys(SRC_SOURCES).length, "the src/ glob resolved to nothing — this guard would be vacuous").toBeGreaterThan(20);
    const offenders = Object.entries(SRC_SOURCES)
      .filter(([path, source]) => path !== CLOCK_SELECTION_AUTHORITY && constructionCount(source) > 0)
      .map(([path]) => path);
    expect(
      offenders,
      `file(s) ${offenders.join(", ")} construct a VirtualClock. TenantDO is the only clock-selection authority (ARCHITECTURE.md #4 + the wave-2 clock law) — a clock built anywhere else bypasses the migration interlock.`,
    ).toEqual([]);
  });

  it("tenant-do.ts constructs a VirtualClock at exactly the two documented swap sites", () => {
    // Rehydrate (constructor) and initTenant. A third site would mean a code
    // path that decides a tenant's clock without going through the migration
    // interlock — the whole mechanism keeping the send driver off an unmigrated
    // tenant. Nothing else in src/ may construct one at all.
    expect(constructionCount(tenantDoSource)).toBe(2);
  });

  it("both constructions sit downstream of a plan check AND the migration marker", () => {
    const rehydrate = memberSource(tenantDoSource, "private selectClockOnRehydrate(", "private switchToRealClock(");
    expect(rehydrate, "selectClockOnRehydrate/switchToRealClock markers moved — re-derive this guard").not.toBe("");
    expect(rehydrate).toContain(`row.clock_mode === "real"`);
    expect(rehydrate).toContain("isPaidPlan(row.plan)");

    const initTenant = memberSource(tenantDoSource, "async initTenant(", "private buildAdapters(");
    expect(initTenant, "initTenant/buildAdapters markers moved — re-derive this guard").not.toBe("");
    expect(initTenant).toContain("isPaidPlan(input.plan)");
    expect(initTenant).toContain("paid ? new RealClock()");
  });

  it("the virtual-clock CONTROLS are narrowed through requireVirtualClock, never cast", () => {
    // `advanceClock` / the demo run are the only virtual-only controls. They
    // must narrow through the structural guard so a real-clock tenant gets a
    // loud throw rather than a TypeError or, worse, a silent no-op.
    expect(clockSource).toContain("export function requireVirtualClock");
    expect(tenantDoSource).toContain("requireVirtualClock(this.currentClock)");
    expect(tenantDoSource).not.toMatch(/as unknown as VirtualClock|<VirtualClock>/);
  });
});
