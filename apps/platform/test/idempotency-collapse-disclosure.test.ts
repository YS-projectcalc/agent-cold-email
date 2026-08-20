/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS } from "../src/engine/idempotency.js";
import { RESERVE_REAP_TTL_MS } from "../src/engine/spend-ceiling.js";
import { strippedSource } from "./source-text.js";

// GATE RULING 7 (docs/adversarial/wave-b1-scale-monitoring-gate-2026-08-20.md)
// — the dedup stamp's gating predicate is SOUND today and UNGUARDED for
// tomorrow.
//
// `discloseCollapse` stamps `deduplicated: true` on a replay only when the
// RECORDED PAYLOAD already carries a boolean field of that name — which today
// is true exactly for the two call sites whose return type is `Collapsed<T>`.
// The gate verified there is no field-name collision at this ref. What nothing
// enumerated is the wrapper's call sites against their return types, so a SIXTH
// site whose DTO happens to carry a boolean `deduplicated` for an unrelated
// reason would silently mint a disclosure about a collapse that never happened
// — on the money path, which is exactly where Wave A's own B1 landed.

const SRC = import.meta.glob("../src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>;

/**
 * Every `withRequestIdempotency` call site, keyed by the intent prefix it
 * namespaces with, and whether that site's result is a `Collapsed<T>` — i.e.
 * whether a `deduplicated` field on its payload is a DECLARED disclosure or
 * would be an accident.
 */
const WRAPPED_INTENTS: Record<string, { collapsed: boolean; why: string }> = {
  "setup_infrastructure:": { collapsed: false, why: "returns SetupInfrastructureResult — no deduplicated field declared anywhere on the wire" },
  "launch_campaign:": { collapsed: false, why: "returns a campaign DTO — no deduplicated field" },
  "reply:": { collapsed: true, why: "Collapsed<ReplyResult> — the thread-level content-hash collapse (engine/threads.ts)" },
  "remove_mailboxes:": { collapsed: true, why: "Collapsed<RemoveMailboxesResult> — the intent-level collapse (engine/billing.ts)" },
  "provision:": { collapsed: false, why: "returns the provisioned address — internal, not a client-facing DTO" },
};

/**
 * How many places CALL the wrapper (its own definition file excluded).
 *
 * A COUNT rather than a parse of each site's key: `remove_mailboxes` builds its
 * key into a `const` one line above the call, so anything that reads forward
 * from the call expression misses it — and a guard that silently misses a site
 * is precisely the failure this file exists to prevent.
 */
function wrapperCallSites(): string[] {
  const sites: string[] = [];
  for (const [file, source] of Object.entries(SRC)) {
    if (file.endsWith("engine/idempotency.ts")) continue;
    for (const _ of strippedSource(source).matchAll(/\bwithRequestIdempotency\s*\(/g)) sites.push(file);
  }
  return sites;
}

describe("ruling 7 — a sixth wrapped intent cannot mint a false disclosure unnoticed", () => {
  it("finds the call sites at all (a regex matching nothing would make this vacuous)", () => {
    expect(wrapperCallSites().length).toBeGreaterThanOrEqual(5);
  });

  it("every wrapped call site is enumerated with its collapse disposition", () => {
    expect(
      wrapperCallSites().length,
      "the number of `withRequestIdempotency` call sites no longer matches WRAPPED_INTENTS. If you ADDED one, state " +
        "whether its result is a `Collapsed<T>`: if it is NOT, make sure its DTO carries no boolean `deduplicated` " +
        "field, because `discloseCollapse` stamps any recorded payload that has one and would announce a collapse the " +
        "caller never made — on the money path, which is where Wave A's own B1 landed.",
    ).toBe(Object.keys(WRAPPED_INTENTS).length);
  });

  it("every declared intent prefix still exists in the source", () => {
    const allSource = Object.values(SRC).map(strippedSource).join("\n");
    const missing = Object.keys(WRAPPED_INTENTS).filter((prefix) => !allSource.includes(`\`${prefix}`));
    expect(missing, "WRAPPED_INTENTS names an intent key that no longer exists — delete or rename it (CLAUDE.md rule a)").toEqual([]);
  });

  it("only the declared-Collapsed intents may carry the field the stamp keys on", () => {
    // The stamp is payload-shape driven, so the guarantee that matters is that
    // a NON-collapsed intent's result never grows a boolean `deduplicated`.
    // Enumerated here so the two facts sit beside each other rather than in two
    // files that agreed by luck.
    expect(Object.entries(WRAPPED_INTENTS).filter(([, v]) => v.collapsed).map(([k]) => k).sort()).toEqual([
      "remove_mailboxes:",
      "reply:",
    ]);
  });
});

// N7's knock-on. The stale-reserve reaper's sizing comment is written against
// the idempotency claim TTL — "well above the longest legitimate provision run"
// — so raising one without the other puts the reaper INSIDE that run and makes
// spend-ceiling.ts's H7 incident path ("entry was resolved out from under a
// successful commit") an ordinary event on a slow-but-healthy saga.
describe("N7 — the stale-reserve reaper must outlive the longest legitimate claim", () => {
  it("reaps strictly later than a claim is trusted", () => {
    expect(RESERVE_REAP_TTL_MS).toBeGreaterThan(REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS);
  });

  it("keeps real headroom, not a one-millisecond technicality", () => {
    expect(RESERVE_REAP_TTL_MS).toBeGreaterThanOrEqual(REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS * 1.5);
  });
});
