// Name normalization + tokenization shared by the SDN list build (sdn-parse.ts)
// and the tenant-side matcher (match.ts) — BOTH sides must normalize
// identically or a genuine match is missed (design line 52: "normalize both
// sides: lowercase, strip punctuation/diacritics, collapse whitespace,
// tokenize").

/** Lowercase, strip diacritics (NFKD decompose + drop combining marks), strip
 * punctuation (keep only letters/digits/whitespace), collapse whitespace. */
export function normalizeName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokenizes an already-normalized name on whitespace. Empty input -> []. */
export function tokenize(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(" ");
}
