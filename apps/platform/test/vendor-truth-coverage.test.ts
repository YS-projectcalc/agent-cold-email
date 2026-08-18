/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import {
  ALLOWED_PERMANENT,
  ALLOWED_SPLIT_GUARD,
  BILLED_EFFECTS,
  findHandBuiltPermanentSites,
  findUnguardedBilledEffects,
  isAllowedPermanent,
  isAllowedSplitGuard,
} from "./vendor-truth-scan.js";

// See vendor-truth-scan.ts for the two classes, the scanners and the
// allowlists. This file is the assertions + the proof the scanners are not
// no-ops — the same split, and the same `?raw` glob mechanism, as
// loop-isolation-coverage.test.ts.
//
// WHY THESE ARE STRUCTURAL AND NOT BEHAVIOURAL TESTS: both defects were
// invisible to a behaviour suite. A hand-built permanent grade produces a
// perfectly ordinary VendorError that every test happily catches, and a missing
// pre-check only costs money in a crash window no fixture reproduces by
// accident. The source is the only place the omission is visible.

const PLATFORM = import.meta.glob("../src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>;
const ENGINE = import.meta.glob("../../engine/src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>;
const PACKAGES = import.meta.glob("../../../packages/*/src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<
  string,
  string
>;

/** Re-keys a glob's paths (relative to this test file) onto a stable repo-relative path. */
function reroot(glob: Record<string, string>, stripPrefix: string, addPrefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, source] of Object.entries(glob)) {
    out[addPrefix + key.slice(stripPrefix.length)] = source;
  }
  return out;
}

// THREE ROOTS, mandatory. The billed-effect scan in particular must span
// apps/engine and packages: a money-out call moved into either would leave a
// platform-only glob reporting a clean tree — the "moved call goes unscanned"
// hole spend-ceiling-coverage.test.ts's own maintenance note warns about.
const SOURCES: Record<string, string> = {
  ...reroot(PLATFORM, "../", "apps/platform/"),
  ...reroot(ENGINE, "../../engine/", "apps/engine/"),
  ...reroot(PACKAGES, "../../../packages/", "packages/"),
};

/** The grader's own file is excluded: it is what "graded" MEANS. */
const GRADER_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(SOURCES).filter(
    ([file]) =>
      (file.startsWith("apps/platform/src/vendors/real/") || file === "apps/platform/src/engine/engine-mailbox-client.ts") &&
      file !== "apps/platform/src/vendors/real/inboxkit-errors.ts",
  ),
);

describe("class A tripwire — no permanent vendor refusal is graded by hand without a written reason", () => {
  it("sees the real source tree (non-vacuous)", () => {
    expect(Object.keys(GRADER_SOURCES)).toContain("apps/platform/src/vendors/real/mailbox-port.ts");
    expect(Object.keys(GRADER_SOURCES)).toContain("apps/platform/src/vendors/real/inboxkit-domain-port.ts");
    expect(Object.keys(GRADER_SOURCES)).toContain("apps/platform/src/engine/engine-mailbox-client.ts");
  });

  it("every hand-built permanent VendorError is allowlisted with a reason", () => {
    const offenders = findHandBuiltPermanentSites(GRADER_SOURCES);
    const unexplained = offenders.filter((o) => !isAllowedPermanent(o));
    expect(
      unexplained,
      `${unexplained.length} permanent VendorError(s) bypass the three-valued grader:\n` +
        unexplained.map((o) => `  ${o.file} — ${o.snippet}`).join("\n") +
        `\nBuild it with mapInboxKitError/inboxKitAppError, pass an explicit { operatorActionable } if you know the answer at the ` +
        `site, or add a justified entry to ALLOWED_PERMANENT in vendor-truth-scan.ts. A refusal graded permanent by hand reaches ` +
        `the customer's agent as "check your inputs, retrying will not help" — which is what an empty vendor wallet said for a week.`,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries (a regraded or deleted throw cannot linger as an unverified claim)", () => {
    const offenders = findHandBuiltPermanentSites(GRADER_SOURCES);
    const stale = ALLOWED_PERMANENT.filter((a) => !offenders.some((o) => o.file === a.file && o.snippet === a.snippet));
    expect(
      stale.map((s) => `${s.file} — ${s.snippet}`),
      "these ALLOWED_PERMANENT entries match nothing the scan finds (the throw was regraded, moved or removed) — delete the entry",
    ).toEqual([]);
  });

  it("every allowlist entry carries a real reason, not a placeholder", () => {
    for (const entry of ALLOWED_PERMANENT) {
      expect(entry.reason.length, `${entry.file} — ${entry.snippet}`).toBeGreaterThan(40);
    }
  });

  describe("detection logic (proven against synthetic sources)", () => {
    it("flags a NEW hand-built permanent refusal", () => {
      const rogue = {
        "apps/platform/src/vendors/real/new-port.ts": `
          async function buyThing() {
            if (body.error) {
              throw new VendorError(\`vendor rejected the purchase: \${body.message}\`, false);
            }
          }`,
      };
      expect(findHandBuiltPermanentSites(rogue)).toEqual([
        {
          file: "apps/platform/src/vendors/real/new-port.ts",
          snippet: "new VendorError(`vendor rejected the purchase: ${body.message}`, false)",
        },
      ]);
    });

    it("does NOT flag a grader-built error", () => {
      const compliant = {
        "apps/platform/src/vendors/real/new-port.ts": `
          if (body.error) throw inboxKitAppError(\`vendor rejected it\`, body);`,
      };
      expect(findHandBuiltPermanentSites(compliant)).toEqual([]);
    });

    it("does NOT flag a site that answers the third question explicitly", () => {
      const compliant = {
        "apps/platform/src/vendors/real/new-port.ts": `
          throw new VendorError(\`the wallet is empty\`, false, { operatorActionable: true });`,
      };
      expect(findHandBuiltPermanentSites(compliant)).toEqual([]);
    });

    it("does NOT flag a RETRYABLE throw — the class is about permanence, and re-grading those reopens the vendor-verdict class", () => {
      const benign = {
        "apps/platform/src/vendors/real/new-port.ts": `
          throw new VendorError(\`vendor listing failed, retry\`, true);`,
      };
      expect(findHandBuiltPermanentSites(benign)).toEqual([]);
    });

    it("is not fooled by a message template containing commas, parens or the word false", () => {
      const rogue = {
        "apps/platform/src/vendors/real/new-port.ts":
          "throw new VendorError(`vendor said (no, really): ${fmt(a, b)} false`, true);",
      };
      // The grade is `true` — the commas and the literal word "false" inside the
      // template must not make a naive split read the wrong argument.
      expect(findHandBuiltPermanentSites(rogue)).toEqual([]);
    });
  });
});

describe("class E tripwire — every billed vendor effect has a vendor pre-check AND a durable claim before it", () => {
  it("finds the enumerated billed effects (non-vacuous — the guard is worthless at zero)", () => {
    const found = BILLED_EFFECTS.flatMap((pattern) =>
      Object.entries(SOURCES)
        .filter(([, source]) => source.includes(pattern))
        .map(([file]) => ({ file, pattern })),
    );
    expect(found.length).toBeGreaterThan(0);
    // Each billed effect must still exist SOMEWHERE, or the pattern has drifted
    // out of date and this scan is silently watching nothing.
    for (const pattern of BILLED_EFFECTS) {
      expect(found.some((f) => f.pattern === pattern), `no call site found for '${pattern}' — the pattern is stale`).toBe(true);
    }
  });

  it("every billed effect is guarded in its own function, or its split is allowlisted", () => {
    const offenders = findUnguardedBilledEffects(SOURCES);
    const unexplained = offenders.filter((o) => !isAllowedSplitGuard(o));
    expect(
      unexplained,
      `${unexplained.length} billed vendor call(s) run without a vendor-state pre-check and a durable claim ahead of them:\n` +
        unexplained.map((o) => `  ${o.file} — ${o.enclosing}() calls ${o.pattern}`).join("\n") +
        `\nAsk the vendor what it already holds BEFORE spending, and write a durable claim BEFORE the call — a marker written ` +
        `after it cannot close the window it sits inside (class E, class-sweep-vendor-truth-2026-08-18.md).`,
    ).toEqual([]);
  });

  it("the split-guard allowlist has no stale entries", () => {
    const offenders = findUnguardedBilledEffects(SOURCES);
    const stale = ALLOWED_SPLIT_GUARD.filter((a) => !offenders.some((o) => o.file === a.file && o.enclosing === a.enclosing));
    expect(
      stale.map((s) => `${s.file} — ${s.enclosing}`),
      "these ALLOWED_SPLIT_GUARD entries match nothing the scan finds — the guard moved in-function, or the call was removed. Delete the entry",
    ).toEqual([]);
  });

  describe("detection logic (proven against synthetic sources)", () => {
    it("flags a billed call with NO pre-check and NO claim", () => {
      const rogue = {
        "apps/platform/src/engine/new-saga.ts": `
          export async function provisionSomething(ctx: TenantContext) {
            const bought = await ctx.adapters.mailbox.provision(domain, localPart, key);
            markMailboxIntent(ctx, key, "bought");
            return bought;
          }`,
      };
      // The marker is AFTER the call, which is the defect, not the guard.
      expect(findUnguardedBilledEffects(rogue)).toEqual([
        { file: "apps/platform/src/engine/new-saga.ts", pattern: "mailbox.provision(", enclosing: "provisionSomething" },
      ]);
    });

    it("flags a billed call with a claim but NO vendor pre-check", () => {
      const rogue = {
        "apps/platform/src/engine/new-saga2.ts": `
          export async function enrolSomething(ctx: TenantContext) {
            recordMailboxIntent(ctx, key, email);
            return ctx.adapters.mailbox.startWarmup(email, key);
          }`,
      };
      expect(findUnguardedBilledEffects(rogue)).toEqual([
        { file: "apps/platform/src/engine/new-saga2.ts", pattern: "mailbox.startWarmup(", enclosing: "enrolSomething" },
      ]);
    });

    it("does NOT flag a call with both a vendor pre-check and a durable claim ahead of it", () => {
      const compliant = {
        "apps/platform/src/engine/new-saga3.ts": `
          export async function enrolSafely(ctx: TenantContext) {
            const intent = readMailboxIntent(ctx, key);
            if (intent?.status === "warming") return;
            const state = await ctx.adapters.mailbox.warmupSubscriptionState(email);
            if (state !== "absent") return;
            return ctx.adapters.mailbox.startWarmup(email, key);
          }`,
      };
      expect(findUnguardedBilledEffects(compliant)).toEqual([]);
    });

    it("scans apps/engine and packages too — a money-out call moved there is still seen", () => {
      const rogue = {
        "apps/engine/src/somewhere.ts": `
          export async function buyOverThere(ctx) {
            return ctx.adapters.domain.buy(domain, key);
          }`,
      };
      expect(findUnguardedBilledEffects(rogue)).toEqual([
        { file: "apps/engine/src/somewhere.ts", pattern: "domain.buy(", enclosing: "buyOverThere" },
      ]);
    });
  });
});
