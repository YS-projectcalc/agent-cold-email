/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { ALLOWED_UNISOLATED_LOOPS, findUnisolatedLoopSites, isAllowedUnisolatedLoop } from "./loop-isolation-scan.js";

// See loop-isolation-scan.ts for the class, the scanner, and the allowlist.
// This file is the assertions + the proof that the scanner isn't a no-op.
//
// SCOPE, mandatory per the sweep doc §4a: the glob spans apps/platform/src,
// apps/engine/src (IN-7 lives there) and packages/*/src, not just
// apps/platform/src — a platform-only glob would be a coverage lie exactly
// like the standing lesson about spend-ceiling-coverage.test.ts. apps/dashboard
// is deliberately NOT globbed: the sweep doc §5.5 explicitly says it was
// never audited for a client-side equivalent (a list render aborting on one
// bad row), so including it here would silently claim a coverage property
// that was never verified — a real gap, not a closed one.
const PLATFORM = import.meta.glob("../src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>;
const ENGINE = import.meta.glob("../../engine/src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<
  string,
  string
>;
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

const SOURCES: Record<string, string> = {
  ...reroot(PLATFORM, "../", "apps/platform/"),
  ...reroot(ENGINE, "../../engine/", "apps/engine/"),
  ...reroot(PACKAGES, "../../../packages/", "packages/"),
};

describe("loop-isolation coverage — every per-item loop over a durable collection is isolated or explicitly allowlisted", () => {
  it("sees the real source tree across all three swept trees (non-vacuous)", () => {
    const keys = Object.keys(SOURCES);
    expect(keys.length).toBeGreaterThan(80);
    expect(keys).toContain("apps/platform/src/isolated-loop.ts");
    expect(keys).toContain("apps/engine/src/engine.ts");
    expect(keys).toContain("packages/cli/src/client.ts");
    expect(keys.some((k) => k.startsWith("packages/shared/src/"))).toBe(true);
  });

  it("every detected unisolated loop is a genuinely allowlisted (or explicitly flagged STILL OPEN) site", () => {
    const offenders = findUnisolatedLoopSites(SOURCES);
    const unexplained = offenders.filter((o) => !isAllowedUnisolatedLoop(o));
    expect(
      unexplained,
      `${unexplained.length} loop(s) reach an await/durable-write per item with no isolation and no allowlist entry:\n` +
        unexplained.map((o) => `  ${o.file} — ${o.header}`).join("\n") +
        `\nRoute through forEachIsolated (apps/platform/src/isolated-loop.ts), wrap the loop body in its own try/catch, ` +
        `or add a justified entry to ALLOWED_UNISOLATED_LOOPS in loop-isolation-scan.ts — do NOT allowlist a genuinely new HOL-blocking site.`,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries (a fixed/renamed/removed loop can't linger as an unverified claim)", () => {
    const offenders = findUnisolatedLoopSites(SOURCES);
    const stale = ALLOWED_UNISOLATED_LOOPS.filter((a) => !offenders.some((o) => o.file === a.file && o.header === a.header));
    expect(
      stale.map((s) => `${s.file} — ${s.header}`),
      "these allowlist entries no longer match anything the scan finds (the loop was isolated, renamed, or removed) — delete the entry",
    ).toEqual([]);
  });

  // The detection logic itself is proven against synthetic sources, so the
  // guard cannot rot into a no-op that silently accepts a real bypass: if
  // these fail, the two assertions above are meaningless regardless of what
  // the real tree looks like.
  describe("detection logic (proven against synthetic sources)", () => {
    it("flags a NEW raw sequential loop with an unguarded await over a collection", () => {
      const rogue = {
        "apps/platform/src/engine/new-feature.ts": `
          export async function drainThing(ctx: TenantContext, items: Item[]) {
            for (const item of items) {
              await ctx.adapters.mailbox.provision(item);
            }
          }`,
      };
      expect(findUnisolatedLoopSites(rogue)).toEqual([
        { file: "apps/platform/src/engine/new-feature.ts", header: "for (const item of items)" },
      ]);
    });

    it("flags a NEW loop whose body only has a durable write, no await", () => {
      const rogue = {
        "apps/platform/src/engine/new-feature2.ts": `
          function markAll(ctx: TenantContext, ids: string[]) {
            for (const id of ids) {
              ctx.sql.exec(\`UPDATE mailboxes SET status = 'x' WHERE id = ?\`, id);
              logAction(ctx, "X", id, {});
            }
          }`,
      };
      // Only the durable write matters here; either pattern alone is sufficient to trip the scan.
      expect(findUnisolatedLoopSites(rogue)).toEqual([
        { file: "apps/platform/src/engine/new-feature2.ts", header: "for (const id of ids)" },
      ]);
    });

    it("does NOT flag a loop routed through forEachIsolated inside its own body", () => {
      const compliant = {
        "apps/platform/src/engine/batched.ts": `
          async function drainBatch(ctx: TenantContext, batches: Item[][]) {
            for (const batch of batches) {
              await forEachIsolated(batch, (item) => ctx.adapters.mailbox.provision(item), { onItemError: recordFailure });
            }
          }`,
      };
      expect(findUnisolatedLoopSites(compliant)).toEqual([]);
    });

    it("does NOT flag a loop with its own inline try/catch", () => {
      const compliant = {
        "apps/platform/src/engine/inline.ts": `
          async function pollAll(ctx: TenantContext, mailboxes: Mailbox[]) {
            for (const mailbox of mailboxes) {
              try {
                await ctx.adapters.email.poll(mailbox.email, mailbox.poll_cursor);
              } catch (err) {
                console.error(err);
              }
            }
          }`,
      };
      expect(findUnisolatedLoopSites(compliant)).toEqual([]);
    });

    it("does NOT flag a loop with no await and no durable write (plain sync transform)", () => {
      const benign = {
        "apps/platform/src/engine/sync-only.ts": `
          function toNames(items: Item[]): string[] {
            const out: string[] = [];
            for (const item of items) {
              out.push(item.name.toUpperCase());
            }
            return out;
          }`,
      };
      expect(findUnisolatedLoopSites(benign)).toEqual([]);
    });

    it("does NOT flag .forEach/Promise.all fan-out — out of scope by design (sequential loops only)", () => {
      const benign = {
        "apps/platform/src/engine/fanout.ts": `
          async function pollConcurrently(ctx: TenantContext, mailboxes: Mailbox[]) {
            await Promise.all(mailboxes.map(async (m) => ctx.adapters.email.poll(m.email, m.poll_cursor)));
          }`,
      };
      expect(findUnisolatedLoopSites(benign)).toEqual([]);
    });

    it("respects the allowlist for a known-benign site and rejects an unlisted lookalike", () => {
      const twoSites = {
        "apps/platform/src/admin/db.ts": `
          function markEmailed(ctx: TenantContext, ids: string[]) {
            for (let i = 0; i < ids.length; i += MARK_EMAILED_CHUNK_SIZE) {
              ctx.sql.exec(\`UPDATE leads SET emailed = 1\`);
            }
          }`,
        "apps/platform/src/admin/db2.ts": `
          function markEmailedElsewhere(ctx: TenantContext, ids: string[]) {
            for (let i = 0; i < ids.length; i += MARK_EMAILED_CHUNK_SIZE) {
              ctx.sql.exec(\`UPDATE leads SET emailed = 1\`);
            }
          }`,
      };
      const offenders = findUnisolatedLoopSites(twoSites);
      expect(offenders).toEqual([
        { file: "apps/platform/src/admin/db.ts", header: "for (let i = 0; i < ids.length; i += MARK_EMAILED_CHUNK_SIZE)" },
        { file: "apps/platform/src/admin/db2.ts", header: "for (let i = 0; i < ids.length; i += MARK_EMAILED_CHUNK_SIZE)" },
      ]);
      // Real allowlist covers db.ts's exact header; the lookalike in db2.ts (a
      // different file) is correctly still unexplained.
      expect(offenders.filter((o) => !isAllowedUnisolatedLoop(o))).toEqual([
        { file: "apps/platform/src/admin/db2.ts", header: "for (let i = 0; i < ids.length; i += MARK_EMAILED_CHUNK_SIZE)" },
      ]);
    });
  });
});
