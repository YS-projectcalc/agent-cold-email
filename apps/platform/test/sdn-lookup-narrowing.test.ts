import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { matchAgainstSdn, sdnLookupKeys, type ScreenCandidate } from "../src/ofac/match.js";
import { normalizeName, tokenize } from "../src/ofac/normalize.js";
import { getActiveSdnEntries, getSdnEntriesForLookup, sdnVersionHasEntries, swapInSdnList } from "../src/ofac/sdn-list.js";
import type { ParsedSdnEntry } from "../src/ofac/sdn-parse.js";

// S9 (docs/adversarial/scale-readiness-audit-2026-08-17.md) — every signup
// pulled the ENTIRE active SDN list into the Worker and JSON.parse'd every row's
// tokens: ~17k rows and ~17k parses per screen, "cheap in D1 billing, expensive
// in the one budget that matters".
//
// The screen now asks D1 for the only rows that COULD match. `matchAgainstSdn`
// is untouched and stays the authority — the narrowing is sound (a superset of
// the true matches), so it can change cost without ever changing a verdict.
// These tests exist to hold that "without ever changing a verdict" honest,
// because the failure direction of a bad narrowing on a SANCTIONS gate is a
// silent MISS.

function entry(uid: string, name: string): ParsedSdnEntry {
  const nameNormalized = normalizeName(name);
  return { uid, nameNormalized, tokens: tokenize(nameNormalized), entityType: null, program: "TEST" };
}

/** A realistic-shaped list: one real target buried in bulk filler. */
function bulkList(target: ParsedSdnEntry[], fillerCount: number): ParsedSdnEntry[] {
  const filler: ParsedSdnEntry[] = [];
  for (let i = 0; i < fillerCount; i++) filler.push(entry(`filler-${i}`, `Filler Entity Number ${i}`));
  return [...filler, ...target];
}

async function seed(listVersion: string, entries: ParsedSdnEntry[]): Promise<void> {
  await swapInSdnList(env, { listVersion, entries, publishedDate: "2026-08-20", fetchedAt: Date.now() });
}

function candidatesOf(...texts: string[]): ScreenCandidate[] {
  return texts.map((text) => ({ field: "brand", text }));
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM sdn_entries`).run();
  await env.DB.prepare(`DELETE FROM sdn_list_meta`).run();
});

describe("S9 — the screen reads the rows that could match, not the whole list", () => {
  it("returns a tiny fraction of a large list for a candidate that matches nothing", async () => {
    await seed("v-narrow", bulkList([entry("t1", "Globex Corp")], 500));

    const candidates = candidatesOf("Sunrise Bakery Co");
    const narrowed = await getSdnEntriesForLookup(env, "v-narrow", sdnLookupKeys(candidates));

    // The whole point, stated against the read it replaces: the old screen
    // pulled every row and parsed every tokens_json blob; this one pulls a
    // handful, and reaches the same verdict.
    expect(await getActiveSdnEntries(env, "v-narrow")).toHaveLength(501);
    expect(narrowed.length).toBeLessThan(10);
    expect(matchAgainstSdn(candidates, narrowed)).toEqual([]);
  });

  it("still finds an EXACT hit buried behind hundreds of filler rows", async () => {
    await seed("v-exact", bulkList([entry("t1", "Globex Corp")], 500));

    const candidates = candidatesOf("globex corp");
    const narrowed = await getSdnEntriesForLookup(env, "v-exact", sdnLookupKeys(candidates));
    const matches = matchAgainstSdn(candidates, narrowed);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ uid: "t1", matchType: "exact" });
  });

  it("still finds a SUBSET hit buried behind hundreds of filler rows", async () => {
    await seed("v-subset", bulkList([entry("t1", "Globex Corp")], 500));

    const candidates = candidatesOf("Globex Corp International");
    const narrowed = await getSdnEntriesForLookup(env, "v-subset", sdnLookupKeys(candidates));
    const matches = matchAgainstSdn(candidates, narrowed);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ uid: "t1", matchType: "subset" });
  });

  it("matches the full-scan verdict EXACTLY across a battery of candidates (no narrowing false negatives)", async () => {
    const targets = [
      entry("a1", "Globex Corp"),
      entry("a2", "Acme"),
      entry("a3", "Al Rashid Trading Company"),
      entry("a4", "Zenith Holdings Group"),
      entry("a5", "Filler Entity Number 7"), // deliberately collides with the filler's own shape
    ];
    await seed("v-parity", bulkList(targets, 300));

    const probes = [
      "Sunrise Bakery Co",
      "globex corp",
      "Globex Corp International",
      "ACME",
      "Acme Industries Worldwide",
      "Al Rashid Trading Company Ltd",
      "al rashid",
      "Zenith Holdings Group",
      "zenith holdings",
      "Filler Entity Number 7",
      "Number 7 Filler Entity", // same token SET, different order — subset rule is order-free
      "Globex", // single token, no exact name — must NOT subset-match a 2-token entry
      "",
      "!!!",
    ];

    const full = await getActiveSdnEntries(env, "v-parity");
    expect(full).toHaveLength(305); // the old behaviour, kept as the oracle

    for (const probe of probes) {
      const candidates = candidatesOf(probe);
      const narrowed = await getSdnEntriesForLookup(env, "v-parity", sdnLookupKeys(candidates));
      expect(matchAgainstSdn(candidates, narrowed), `narrowed verdict differs for ${JSON.stringify(probe)}`).toEqual(
        matchAgainstSdn(candidates, full),
      );
    }
  });

  it("narrows across MULTIPLE candidate fields in one read (brand + domain + billing name)", async () => {
    await seed("v-multi", bulkList([entry("t1", "Globex Corp"), entry("t2", "Zenith Holdings Group")], 200));

    const candidates: ScreenCandidate[] = [
      { field: "brand", text: "Sunrise Bakery" },
      { field: "contactEmailDomain", text: "globex corp" },
      { field: "billingName", text: "Zenith Holdings Group Trust" },
    ];
    const narrowed = await getSdnEntriesForLookup(env, "v-multi", sdnLookupKeys(candidates));
    const matches = matchAgainstSdn(candidates, narrowed);

    expect(matches.map((m) => m.uid).sort()).toEqual(["t1", "t2"]);
  });

  it("a candidate carrying LIKE/pattern metacharacters is matched literally, not as a pattern", async () => {
    await seed("v-meta", [entry("m1", "Globex Corp")]);

    // normalizeName strips punctuation to spaces, so these are token-shaped
    // inputs — the narrowing must never let one act as a wildcard.
    for (const probe of ["%", "_", "glob%x corp", "globe_ corp"]) {
      const candidates = candidatesOf(probe);
      const narrowed = await getSdnEntriesForLookup(env, "v-meta", sdnLookupKeys(candidates));
      expect(matchAgainstSdn(candidates, narrowed), `pattern leak on ${JSON.stringify(probe)}`).toEqual([]);
    }
  });
});

// The narrowed read makes "zero rows came back" AMBIGUOUS in a way the full scan
// never was: it now means "no candidate matched" far more often than "the list
// vanished". screening.ts's TOCTOU fail-closed guard keyed on exactly that
// emptiness, so it needs its own question to ask.
describe("S9 — list presence is asked directly, not inferred from an empty result", () => {
  it("reports a populated version as present and a swapped-away one as absent", async () => {
    await seed("v-present", [entry("p1", "Globex Corp")]);
    expect(await sdnVersionHasEntries(env, "v-present")).toBe(true);

    // swapInSdnList's post-flip cleanup deletes every non-active version — the
    // exact race the guard exists for.
    await seed("v-successor", [entry("s1", "Acme")]);
    expect(await sdnVersionHasEntries(env, "v-present")).toBe(false);
    expect(await sdnVersionHasEntries(env, "v-successor")).toBe(true);
  });
});
