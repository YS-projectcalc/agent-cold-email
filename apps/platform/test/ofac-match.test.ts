import { describe, expect, it } from "vitest";
import { matchAgainstSdn } from "../src/ofac/match.js";
import type { SdnEntryRow } from "../src/ofac/sdn-list.js";
import { normalizeName, tokenize } from "../src/ofac/normalize.js";

function entry(uid: string, name: string, program: string | null = "TEST-PROGRAM"): SdnEntryRow {
  const nameNormalized = normalizeName(name);
  return { uid, nameNormalized, tokens: tokenize(nameNormalized), entityType: null, program };
}

const ENTRIES: SdnEntryRow[] = [
  entry("9001", "GLOBEX CORP"),
  entry("9002", "ACME"),
  entry("9003", "JOSE RAMIREZ"),
];

describe("matchAgainstSdn — conservative, review-not-reject matcher", () => {
  it("EXACT normalized-name match hits, even for a single-token SDN name", () => {
    const matches = matchAgainstSdn([{ field: "brand", text: "Acme" }], ENTRIES);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ uid: "9002", matchType: "exact", matchedField: "brand" });
  });

  it("SUBSET match hits when every token of a >=2-token SDN name is present in the candidate", () => {
    const matches = matchAgainstSdn([{ field: "brand", text: "Globex Corp International" }], ENTRIES);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ uid: "9001", matchType: "subset", matchedField: "brand" });
  });

  it("no hit when only SOME tokens of a >=2-token SDN name are present (a partial-name coincidence isn't a hit)", () => {
    const matches = matchAgainstSdn([{ field: "brand", text: "Corp International Holdings" }], ENTRIES);
    expect(matches).toEqual([]);
  });

  it("a benign, wholly unrelated brand never matches", () => {
    const matches = matchAgainstSdn([{ field: "brand", text: "Sunrise Bakery Co" }], ENTRIES);
    expect(matches).toEqual([]);
  });

  it("diacritic variants of the SAME name DO match (normalization handles this)", () => {
    const matches = matchAgainstSdn([{ field: "brand", text: "José Ramírez" }], ENTRIES);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ uid: "9003", matchType: "exact" });
  });

  it("documented v1 limitation: a differently-SPELLED phonetic near-miss does NOT match (no edit-distance/fuzzy matching in v1 — NB-4 honesty)", () => {
    // "Khaled Ramirez" is phonetically/visually close to neither exact nor a
    // token subset of "jose ramirez" — proving this matcher does NOT catch
    // spelling variants, only exact/subset-token hits. This is a documented
    // gap (docs/research/ofac-v1-honesty-statement-2026-07-23.md), not a bug.
    const matches = matchAgainstSdn([{ field: "brand", text: "Khaled Ramirez" }], ENTRIES);
    expect(matches).toEqual([]);
  });

  it("carries the matched field through so a reviewer knows WHAT was checked", () => {
    const matches = matchAgainstSdn(
      [
        { field: "brand", text: "Sunrise Bakery" },
        { field: "billingName", text: "Acme" },
      ],
      ENTRIES,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchedField).toBe("billingName");
  });

  it("empty candidate text is skipped, never treated as a wildcard match", () => {
    const matches = matchAgainstSdn([{ field: "contactEmailDomain", text: "" }], ENTRIES);
    expect(matches).toEqual([]);
  });
});
