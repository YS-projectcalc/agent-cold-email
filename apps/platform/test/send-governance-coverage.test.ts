/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

// A failing-by-construction guard for the UNGOVERNED-SEND class (warm-lead Q3 /
// adversary R1-R2). The instance was `replyToThread` calling
// `ctx.adapters.email.send` directly, so a manual reply escaped every cap /
// deliverability-pause / suppression check the tick enforced INLINE in its own
// loop. The underlying defect is structural: governance written as loop-local
// control flow is a property of that loop, not a policy — any second entry
// point to the same effect silently gets zero enforcement, and the metering
// column is never incremented, so the read-only status API keeps reporting
// compliance while the bypass runs.
//
// Fixing the one instance does not close the class: the NEXT feature that needs
// to send one-off mail (schedule_followup's drain is already on the roadmap)
// can reintroduce it in a new file. A doc comment is not a guard at all, so
// this test is a TRIPWIRE — it parses the SOURCE of every file under src/ and
// asserts the outbound-send effect is reachable from exactly two places, both
// of which enforce governance.
//
// TRIPWIRE, NOT A SANDBOX (adversary N-a, 2026-08-02 — this docstring
// previously overclaimed the property as "MECHANICAL"). It is a lexical scan,
// so it catches the shapes a developer plausibly WRITES — including the
// accidental `?.send(` — and the obvious deliberate dodges, but it cannot stop
// someone determined to route around it (a string-built member name, a
// dynamic import, an indirection through another module's re-export). Its job
// is to make the honest mistake loud, not to be a capability boundary. The
// detectors are proven against synthetic sources at the bottom of this file so
// the tripwire itself cannot silently rot into a no-op.
//
// Source text (not runtime reflection) is the only option: a call site is a
// syntactic fact with nothing to reflect at runtime, and workerd has no
// filesystem. `import.meta.glob(..., { query: "?raw" })` resolves at transform
// time, the same mechanism test/spend-armed-env-coverage.test.ts and
// test/setup.ts already rely on.
const SOURCES = import.meta.glob("../src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>;

/** Normalizes a glob key ("../src/engine/tick.ts") to a repo-relative path. */
function normalize(key: string): string {
  return key.replace(/^\.\.\//, "");
}

// The ONLY files permitted to invoke the outbound email port, each with the
// reason it is allowed to. Adding a file here is a deliberate act that should
// not survive review unless it genuinely enforces send governance.
const ALLOWED_SEND_CALL_SITES = new Map([
  ["src/engine/tick.ts", "the campaign tick — enforces caps/pause/suppression/window inline before each send"],
  ["src/engine/guarded-send.ts", "the shared guarded single-send primitive — IS the governance choke point"],
]);

// Either member of the chain can be written as a bracket-indexed string
// literal (`adapters["email"]`, `.email["send"]`), and the port access can be
// optional-chained. Composed once so every detector below stays consistent.
const EMAIL_MEMBER = String.raw`(?:\.\s*email\b|\[\s*["'\`]email["'\`]\s*\])`;
const SEND_MEMBER = String.raw`(?:\.\s*send\b|\[\s*["'\`]send["'\`]\s*\])`;
const OPTIONAL = String.raw`\s*\??\.?\s*`;

/**
 * Files invoking the outbound send effect, in any notation that actually
 * reaches it: plain member access, bracket indexing on either member, and
 * optional chaining (`?.send(`) — the last of which a developer could write by
 * accident (adversary N-a).
 *
 * Deliberately keyed on the `.email…send(` CHAIN rather than on an `adapters.`
 * prefix. That is what closes the bundle-aliasing dodge (`const a =
 * ctx.adapters; a.email.send(...)`) — the alias renames the bundle but cannot
 * rename the two members. Verified zero false positives: a bare-chain grep of
 * apps/platform/src + packages/shared/src returns exactly the two governed
 * sites.
 */
export function findSendCallSites(sources: Record<string, string>): string[] {
  const call = new RegExp(String.raw`${EMAIL_MEMBER}${OPTIONAL}${SEND_MEMBER}\s*\(`);
  return Object.entries(sources)
    .filter(([, source]) => call.test(source))
    .map(([key]) => normalize(key))
    .sort();
}

/**
 * Files that BIND a step of the chain to a name instead of calling straight
 * through — the shapes that reach `send` without ever writing the
 * `.email…send(` chain the call-site scan looks for:
 *   1. port alias    — `const port = ctx.adapters.email` (then `port.send(...)`)
 *   2. destructure   — `const { email } = ctx.adapters` (then `email.send(...)`)
 *   3. method handle — `const s = ctx.adapters.email.send` (then `s(...)`)
 * Ordinary member access (`.email.send(...)`, `.email.poll(...)`) is NOT a
 * binding and must not be flagged.
 *
 * A fourth shape the adversary raised — aliasing the BUNDLE (`const a =
 * ctx.adapters`) — is deliberately NOT matched here. Every regex for it also
 * matches ordinary object-literal shorthand (`{ sql, tenantId, adapters, env }`)
 * and spreads (`{ ...base.adapters, domain }`, tenant-do.ts:468), because
 * telling an alias from a property position needs a parser, not a lexer. A
 * guard that cries wolf gets silenced, so instead that dodge is covered where
 * it is cleanly detectable: the resulting `a.email.send(...)` call still trips
 * the chain-keyed call-site scan above.
 */
export function findEmailPortAliases(sources: Record<string, string>): string[] {
  const patterns = [
    // 1 + 3: `= <expr>.adapters.email` (optionally `.send`) with no call attached.
    new RegExp(String.raw`=[^=\n]*adapters${OPTIONAL}${EMAIL_MEMBER}(${OPTIONAL}${SEND_MEMBER})?\s*(?![\s.\w$["'\`(])`),
    // 2: `const { email } = ctx.adapters` / `const { email: x } = adapters`
    /\{[^}\n]*\bemail\b[^}\n]*\}\s*=\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?adapters\b/,
  ];
  return Object.entries(sources)
    .filter(([, source]) => patterns.some((p) => p.test(source)))
    .map(([key]) => normalize(key))
    .sort();
}

describe("send-governance coverage — every outbound send goes through a governed path", () => {
  it("sees the real source tree (non-vacuous: the glob resolved actual files)", () => {
    // Without this, a broken glob would make every assertion below pass on an
    // empty set — the classic vacuous-guard failure mode.
    const keys = Object.keys(SOURCES).map(normalize);
    expect(keys.length).toBeGreaterThan(50);
    expect(keys).toContain("src/engine/tick.ts");
    expect(keys).toContain("src/engine/guarded-send.ts");
    expect(keys).toContain("src/engine/threads.ts");
  });

  it("the outbound send effect is invoked ONLY from governed call sites", () => {
    const found = findSendCallSites(SOURCES);
    const ungoverned = found.filter((f) => !ALLOWED_SEND_CALL_SITES.has(f));
    expect(
      ungoverned,
      `file(s) ${ungoverned.join(", ")} call adapters.email.send directly, bypassing send governance ` +
        `(per-mailbox daily cap, sent_today metering, deliverability pause, suppression re-check). ` +
        `Route the send through engine/guarded-send.ts's sendWithGuards instead. Do NOT simply add the ` +
        `file to ALLOWED_SEND_CALL_SITES — that allowlist is for paths that genuinely ENFORCE governance.`,
    ).toEqual([]);
    // Both governed sites must still be present: if the tick or the primitive
    // stopped calling send, this guard would be protecting nothing.
    expect(found).toEqual([...ALLOWED_SEND_CALL_SITES.keys()].sort());
  });

  it("no file aliases the email port to a local binding (which would evade the call-site check)", () => {
    const aliases = findEmailPortAliases(SOURCES);
    expect(
      aliases,
      `file(s) ${aliases.join(", ")} bind ctx.adapters.email to a name. That routes around the ` +
        `call-site assertion above while still reaching send(); call through engine/guarded-send.ts instead.`,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries (a deleted/renamed governed file can't linger)", () => {
    const keys = new Set(Object.keys(SOURCES).map(normalize));
    const stale = [...ALLOWED_SEND_CALL_SITES.keys()].filter((f) => !keys.has(f));
    expect(stale, `ALLOWED_SEND_CALL_SITES names file(s) ${stale.join(", ")} that no longer exist`).toEqual([]);
  });

  // The detection logic itself is proven against synthetic sources, so the
  // guard cannot rot into a no-op that silently accepts a real bypass: if these
  // fail, the two assertions above are meaningless regardless of what the real
  // tree looks like.
  describe("detection logic (proven against synthetic sources)", () => {
    it("flags a NEW ungoverned call site", () => {
      const rogue = {
        "../src/engine/schedule-followup.ts": `
          export async function drainFollowups(ctx: TenantContext) {
            const result = await ctx.adapters.email.send(message, key);
            return result;
          }`,
      };
      expect(findSendCallSites({ ...rogue })).toEqual(["src/engine/schedule-followup.ts"]);
    });

    it("flags an aliased email port, the obvious way around a call-site scan", () => {
      const aliased = {
        "../src/engine/sneaky.ts": `const port = ctx.adapters.email;\nawait port.send(m, k);`,
        "../src/engine/destructured.ts": `const { email } = ctx.adapters;\nawait email.send(m, k);`,
      };
      expect(findEmailPortAliases(aliased)).toEqual(["src/engine/destructured.ts", "src/engine/sneaky.ts"]);
    });

    // Every shape the adversary demonstrated as an evasion (N-a, 2026-08-02).
    // Each was verified to EVADE the pre-fix regexes.
    it("flags bracket notation on either member of the chain", () => {
      expect(findSendCallSites({ "../src/a.ts": `ctx.adapters["email"].send(m, k);` })).toEqual(["src/a.ts"]);
      expect(findSendCallSites({ "../src/b.ts": `ctx.adapters.email["send"](m, k);` })).toEqual(["src/b.ts"]);
      expect(findSendCallSites({ "../src/c.ts": `ctx.adapters["email"]["send"](m, k);` })).toEqual(["src/c.ts"]);
    });

    it("flags optional chaining — the evasion a developer writes by ACCIDENT", () => {
      expect(findSendCallSites({ "../src/a.ts": `await ctx.adapters.email?.send(m, k);` })).toEqual(["src/a.ts"]);
      expect(findSendCallSites({ "../src/b.ts": `await ctx.adapters?.email?.send(m, k);` })).toEqual(["src/b.ts"]);
    });

    it("flags a method reference taken without calling it", () => {
      const handle = { "../src/engine/handle.ts": `const s = ctx.adapters.email.send;\nawait s(m, k);` };
      expect(findEmailPortAliases(handle)).toEqual(["src/engine/handle.ts"]);
    });

    it("catches BUNDLE aliasing via the call, since the alias can't rename the members", () => {
      // `const a = ctx.adapters` is not itself matchable without a parser (see
      // findEmailPortAliases' doc) — the resulting call is, which is what matters.
      const bundle = { "../src/engine/bundle.ts": `const a = ctx.adapters;\nawait a.email.send(m, k);` };
      expect(findSendCallSites(bundle)).toEqual(["src/engine/bundle.ts"]);
    });

    it("does NOT flag ordinary object shorthand or a bundle spread (no crying wolf)", () => {
      // Real shapes from src/: a guard that fires on these gets silenced, and a
      // silenced guard protects nothing.
      const benign = {
        "../src/tenant-do.ts": `const ctx: TenantContext = { sql, tenantId, plan, clock, adapters, env };`,
        "../src/tenant-do2.ts": `adapters: { ...base.adapters, domain: this.selectSetupDomainPort(base.adapters, input) },`,
      };
      expect(findEmailPortAliases(benign)).toEqual([]);
      expect(findSendCallSites(benign)).toEqual([]);
    });

    it("does NOT flag legitimate non-send port use (inbound poll) or the type-only reference", () => {
      const benign = {
        "../src/engine/reply-processor.ts": `const { events } = await ctx.adapters.email.poll(mailbox.email, cursor);`,
        "../src/engine/tick-types.ts": `let result: Awaited<ReturnType<typeof ctx.adapters.email.send>>;`,
      };
      expect(findSendCallSites(benign)).toEqual([]);
      expect(findEmailPortAliases(benign)).toEqual([]);
    });
  });
});
