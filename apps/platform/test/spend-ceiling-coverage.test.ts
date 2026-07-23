import { describe, expect, it } from "vitest";
// `?raw` (Vite import suffix) pulls the source text in at transform time — the
// same mechanism spend-armed-env-coverage.test.ts uses. We parse the SOURCE so
// a NEW unwrapped money-out call site trips RED by construction, not just when a
// behavior test happens to exercise it.
import provisioningSource from "../src/engine/provisioning.ts?raw";

// G0/G2 systemic guard (ga-gates-design-2026-07-22.md §"Systemic guards") — the
// spend-bypass class, sibling of spend-armed-env-coverage.test.ts. Every
// money-out vendor call (design §0 inventory) MUST funnel through the
// withSpendCeiling choke-point; a new unwrapped spend site silently over-spends
// past the ceiling. This makes that MECHANICAL: enumerate every spend-bearing
// call and assert each is lexically wrapped by withSpendCeiling( within its own
// statement.
//
// MAINTENANCE: all three money-out sites live in provisioning.ts today (the
// shared provision loop both setup_infrastructure and REPLACE_DOMAIN reuse). A
// new money-out vendor call in ANOTHER file must be added to SPEND_SOURCES below
// AND wrapped — same discipline as KNOWN_NON_SPEND_ARMING in the sibling test.
const SPEND_SOURCES: { file: string; source: string }[] = [{ file: "engine/provisioning.ts", source: provisioningSource }];

// The money-out vendor calls (design §0 inventory). Reads/config calls
// (getHealth, release, searchLookalikes, setDns) are NOT money-out and are
// deliberately absent.
const SPEND_CALL_PATTERNS = [
  "adapters.mailbox.provision(",
  "adapters.mailbox.startWarmup(",
  "adapters.domain.buy(",
];

/** All (pattern, index) occurrences of any spend call in a source string. */
function spendCallSites(source: string): { pattern: string; index: number }[] {
  const sites: { pattern: string; index: number }[] = [];
  for (const pattern of SPEND_CALL_PATTERNS) {
    let from = 0;
    for (;;) {
      const index = source.indexOf(pattern, from);
      if (index === -1) break;
      sites.push({ pattern, index });
      from = index + pattern.length;
    }
  }
  return sites;
}

/**
 * True iff a `withSpendCeiling(` wraps the call at `callIndex` — i.e. it appears
 * between the call and the nearest preceding STATEMENT boundary (`;`/`{`/`}`).
 * The wrapper and the call sit in one expression with no `;` between them, so
 * an UNwrapped call's statement text would not contain `withSpendCeiling(`.
 * (`=>` is deliberately NOT a boundary — it sits between the wrapper and the
 * call, e.g. `withSpendCeiling(ctx, "mailbox", () => ctx.adapters.mailbox…`.)
 */
function isWrapped(source: string, callIndex: number): boolean {
  const boundary = Math.max(
    source.lastIndexOf(";", callIndex - 1),
    source.lastIndexOf("{", callIndex - 1),
    source.lastIndexOf("}", callIndex - 1),
  );
  const statement = source.slice(boundary + 1, callIndex);
  return statement.includes("withSpendCeiling(");
}

describe("G0/G2 — every money-out vendor call is inside the withSpendCeiling choke-point", () => {
  const allSites = SPEND_SOURCES.flatMap(({ file, source }) =>
    spendCallSites(source).map((site) => ({ file, ...site })),
  );

  it("finds the enumerated spend sites (non-vacuous — the 3 design-§0 money-out calls)", () => {
    // If this drifts to 0 the whole guard is silently vacuous. Pin the count so a
    // REMOVED wrap (or a moved call) is noticed too.
    expect(allSites.length).toBe(3);
    expect(new Set(allSites.map((s) => s.pattern))).toEqual(new Set(SPEND_CALL_PATTERNS));
  });

  it("every spend call is lexically wrapped by withSpendCeiling — a new unwrapped site trips RED", () => {
    for (const site of allSites) {
      expect(
        isWrapped(SPEND_SOURCES.find((s) => s.file === site.file)!.source, site.index),
        `${site.file}: '${site.pattern}' is NOT inside a withSpendCeiling( wrapper — this money-out vendor call bypasses the spend ceiling. Wrap it (design §0 choke-point) or the ceiling is a lie.`,
      ).toBe(true);
    }
  });
});
