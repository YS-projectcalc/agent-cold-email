// Conservative screening matcher (design ga-gates-design-2026-07-22.md §G1a
// "Match strategy — conservative, review-not-reject"). Pure function — no I/O
// — so it's unit-testable without D1/a DO.
//
// Two rules, deliberately narrow to hold false positives down (NB-3, adversary
// round 1, 2026-07-23 — accepted for v1: the review queue absorbs a flood, but
// must carry match context):
//   1. EXACT normalized-name match -> hit, any token count.
//   2. SUBSET match: every token of an SDN name is present in the candidate's
//      token set, for SDN names with >= 2 tokens. No single-token or
//      edit-distance fuzz in v1 — too noisy for a free-text brand field
//      (documented limitation, not pretended coverage — NB-4).
import { normalizeName, tokenize } from "./normalize.js";
import type { SdnEntryRow } from "./sdn-list.js";

export interface ScreenCandidate {
  /** Which tenant field this text came from (brand/contactEmailDomain/
   * billingName) — carried into the review row so a human sees WHAT matched. */
  field: string;
  text: string;
}

export type MatchType = "exact" | "subset";

export interface MatchedSdnEntry {
  uid: string;
  nameNormalized: string;
  entityType: string | null;
  program: string | null;
  matchType: MatchType;
  matchedField: string;
}

const MIN_SUBSET_MATCH_TOKENS = 2;

export function matchAgainstSdn(candidates: ScreenCandidate[], entries: SdnEntryRow[]): MatchedSdnEntry[] {
  const matches: MatchedSdnEntry[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeName(candidate.text);
    if (normalized.length === 0) continue;
    const candidateTokens = new Set(tokenize(normalized));

    for (const entry of entries) {
      if (entry.nameNormalized === normalized) {
        matches.push({
          uid: entry.uid,
          nameNormalized: entry.nameNormalized,
          entityType: entry.entityType,
          program: entry.program,
          matchType: "exact",
          matchedField: candidate.field,
        });
        continue; // exact already counted this entry for this candidate — don't also subset-match it
      }
      if (entry.tokens.length >= MIN_SUBSET_MATCH_TOKENS && entry.tokens.every((t) => candidateTokens.has(t))) {
        matches.push({
          uid: entry.uid,
          nameNormalized: entry.nameNormalized,
          entityType: entry.entityType,
          program: entry.program,
          matchType: "subset",
          matchedField: candidate.field,
        });
      }
    }
  }

  return matches;
}
