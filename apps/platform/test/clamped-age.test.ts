import { describe, expect, it } from "vitest";
import { clampedAge, realNowMs } from "../src/engine/clamped-age.js";

// §7.19 — THE WAVE-LEVEL CLOCK RULE, and the tripwire it mandates.
//
// > Any timestamp this wave ages from is read as MIN(anchorTs, realNow).
//
// It is a RULE rather than a per-site judgement because `clock-migration.ts`
// shifts a closed list of exactly SIX columns, and every other `ctx.clock`-
// stamped timestamp in the schema is virtual-domain forever for any tenant that
// lived on the demo/free VirtualClock — which runs up to 1440x ahead of real
// time — before upgrading. The migration route is also permanently closed:
// `migrateTenantClockToReal` is one-shot per tenant and has already run for
// every paid tenant, so a column this wave newly starts reading can NEVER be
// shifted by it.
//
// THE FAILURE SIGNATURE, and why it is worse than a false positive: a
// future-dated anchor makes `now - anchor` negative, so an age bound is never
// crossed and the check SILENTLY NEVER FIRES. It does not error, it does not
// alert, and it looks identical to a healthy tenant.

const FILES_BOUND_BY_THE_RULE = import.meta.glob("../src/engine/{next-steps,clamped-age,provisioning-plan}.ts", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

/** Strips comments, so prose describing the rule never trips the tripwire enforcing it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("clampedAge", () => {
  it("reports an ordinary past anchor's real age", () => {
    const now = 1_000_000;
    expect(clampedAge(now - 5000, now)).toBe(5000);
  });

  it("clamps a FUTURE anchor to zero — the direction that delays, never one that fires early", () => {
    const now = 1_000_000;
    expect(clampedAge(now + 999_999, now)).toBe(0);
    // The raw subtraction this replaces, for contrast: permanently negative, so
    // permanently below any grace bound.
    expect(now - (now + 999_999)).toBeLessThan(0);
  });

  it("never returns a negative value for ANY anchor", () => {
    const now = 1_000_000;
    for (const anchor of [0, now - 1, now, now + 1, now * 2, Number.MAX_SAFE_INTEGER]) {
      expect(clampedAge(anchor, now)).toBeGreaterThanOrEqual(0);
    }
  });

  it("distinguishes a MISSING anchor from a zero-age one", () => {
    const now = 1_000_000;
    expect(clampedAge(null, now)).toBeNull();
    expect(clampedAge(undefined, now)).toBeNull();
    expect(clampedAge(now, now)).toBe(0);
  });

  it("`realNowMs` is real wall-clock, not a tenant's VirtualClock", () => {
    const before = Date.now();
    const value = realNowMs();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("the tripwire: one helper, so the rule cannot be half-applied", () => {
  // Every file this wave ages a timestamp in must route through `clampedAge`.
  // A raw `x - somethingAt` is the exact shape that silently disables a check,
  // and it is invisible to every other guard in the suite.
  it("no wave file subtracts a raw timestamp identifier", () => {
    const offenders: { file: string; snippet: string }[] = [];
    // `<expr> - <identifier ending in At/_at>` — the shape a developer plausibly
    // writes when reaching for an age without the helper.
    const RAW_SUBTRACTION = /-\s*(?:[A-Za-z_$][\w$.]*\.)?[A-Za-z_$][\w$]*(?:At|_at)\b/g;
    for (const [path, source] of Object.entries(FILES_BOUND_BY_THE_RULE)) {
      const code = stripComments(source);
      for (const match of code.matchAll(RAW_SUBTRACTION)) {
        // `Math.min(anchorTs, realNow)` inside the helper itself is the ONE
        // sanctioned subtraction, and it does not match this shape — it
        // subtracts a `Math.min(...)` call, not a bare `*At` identifier.
        offenders.push({ file: path, snippet: match[0] });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the tripwire actually fires — it is not a no-op that matches nothing", () => {
    const RAW_SUBTRACTION = /-\s*(?:[A-Za-z_$][\w$.]*\.)?[A-Za-z_$][\w$]*(?:At|_at)\b/g;
    const planted = stripComments(`
      // const age = now - intent.updatedAt; a comment must NOT count
      const age = now - intent.updatedAt;
      const other = realNow - first_paid_at;
      const fine = clampedAge(intent.updatedAt, realNow);
    `);
    expect([...planted.matchAll(RAW_SUBTRACTION)]).toHaveLength(2);
  });

  it("the glob it scans is not empty — a coverage lie is the other way to pass", () => {
    expect(Object.keys(FILES_BOUND_BY_THE_RULE).length).toBeGreaterThanOrEqual(3);
  });
});
