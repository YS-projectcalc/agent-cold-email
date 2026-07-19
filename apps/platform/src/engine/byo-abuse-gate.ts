// SPEC.md §20.3 — BYO abuse gate. TXT verification proves control of a
// domain, not legitimacy of its use — a bad actor can prove they control
// `paypa1-support.com` just as easily as a legitimate customer proves they
// control their own primary domain. Extends brand-guard's SAME denylist
// (CLAUDE.md rule c — imported, never duplicated) to the BYO domain ITSELF
// (not just the asserted `brand` field, which the lookalike path already
// checks), plus a registrable-lookalike/homoglyph check for the
// `paypa1.com` class the plain denylist misses.
//
// PURE — no I/O. Never a hard reject (unlike assertBrandOwnership): TXT
// already proves the customer controls this exact domain, so a hit here
// routes to human-review/KYC (not auto-admit), never an auto-reject —
// ownership proof and abuse screening are independent gates (§20.3).

import { DENYLISTED_BRANDS } from "./brand-guard.js";

export type ByoAbuseVerdict = "clear" | "kyc_required";

export interface ByoAbuseAssessment {
  verdict: ByoAbuseVerdict;
  reason: string;
}

// Single-character homoglyph/confusable substitutions — the paypa1.com class
// (digit-for-letter). Multi-character confusables (e.g. "rn" -> "m") are a
// noisier, rarer class and deliberately out of scope (YAGNI).
const HOMOGLYPH_MAP: Record<string, string> = {
  "0": "o",
  "1": "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  $: "s",
  "@": "a",
};

// Below this brand length, the fuzzy (homoglyph-normalize / edit-distance-1)
// checks are SKIPPED — short well-known-brand tokens (aws, ups, irs, ibm...)
// have a high false-positive collision rate under edit-distance-1 against
// ordinary short words (e.g. "ops" is edit-distance-1 from "ups"). The exact
// denylist-token match below still applies at every length; only the FUZZY
// leg is length-gated.
const MIN_BRAND_LENGTH_FOR_FUZZY_MATCH = 5;

function normalizeHomoglyphs(token: string): string {
  return token
    .split("")
    .map((ch) => HOMOGLYPH_MAP[ch] ?? ch)
    .join("");
}

function domainTokens(domain: string): string[] {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Levenshtein distance, bounded: returns `max + 1` (a cheap "definitely over
 * budget" sentinel) the moment a full row can no longer reach `max`, so this
 * never pays for the full O(n*m) matrix on a wildly different-length pair.
 */
function levenshteinAtMost(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array<number>(b.length + 1);
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      rowMin = Math.min(rowMin, curr[j]!);
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length]!;
}

export function assessByoDomainAbuse(domain: string): ByoAbuseAssessment {
  const tokens = domainTokens(domain);

  for (const token of tokens) {
    if (DENYLISTED_BRANDS.has(token)) {
      return { verdict: "kyc_required", reason: `"${token}" exactly matches a well-known third-party brand` };
    }

    const normalized = normalizeHomoglyphs(token);
    for (const brand of DENYLISTED_BRANDS) {
      if (brand.length < MIN_BRAND_LENGTH_FOR_FUZZY_MATCH) continue;
      if (normalized === brand) {
        return {
          verdict: "kyc_required",
          reason: `"${token}" normalizes to "${normalized}" — a homoglyph/confusable-substitution match against well-known brand "${brand}"`,
        };
      }
      if (Math.abs(normalized.length - brand.length) > 1) continue; // cheap pre-filter before the bounded Levenshtein
      if (levenshteinAtMost(normalized, brand, 1) <= 1) {
        return {
          verdict: "kyc_required",
          reason: `"${token}" is within edit-distance 1 of well-known brand "${brand}" — a registrable lookalike`,
        };
      }
    }
  }

  return { verdict: "clear", reason: "no denylist/homoglyph/lookalike hit" };
}
