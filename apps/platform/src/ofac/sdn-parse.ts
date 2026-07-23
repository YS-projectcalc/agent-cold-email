// Parses the US Treasury OFAC SDN.CSV feed into normalized entries ready to
// upsert into `sdn_entries` (design ga-gates-design-2026-07-22.md §G1a). The
// published file has NO header row — every line is data, exactly 12 columns
// (`ent_num,SDN_Name,SDN_Type,Program,Title,Call_Sign,Vess_type,Tonnage,GRT,
// Vess_flag,Vess_owner,Remarks`) — we use ent_num/SDN_Name/SDN_Type/Program
// only; the rest is vessel/aircraft metadata this v1 screen doesn't need.
//
// FAIL-LOUD by construction (F5 convention, adversary-cited
// selfserve-activation-design-review-2026-07-21.md:38-41): any row that
// doesn't have exactly 12 fields throws, and a zero-entry result throws — both
// signal a corrupt/truncated/wrong-shaped fetch. The caller (sdn-refresh.ts)
// catches this and keeps the prior good list rather than swapping in a
// half-built one.
import { normalizeName, tokenize } from "./normalize.js";
import { parseCsvRows } from "./csv.js";

const EXPECTED_COLUMNS = 12;

export interface ParsedSdnEntry {
  uid: string;
  nameNormalized: string;
  tokens: string[];
  entityType: string | null;
  program: string | null;
}

/** OFAC's own "no value" placeholder for several columns (SDN_Type is blank/
 * "-0-" for most individual persons). Normalized to `null`, never the literal
 * string. */
function nullableField(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === "" || trimmed === "-0-" ? null : trimmed;
}

/**
 * Parses SDN.CSV text into entries. Throws on ANY malformed row (wrong column
 * count) or a wholly empty result — see the module doc comment. Entries with
 * an empty/unusable name (after normalization) are skipped, not fatal — that
 * is a per-row data-quality issue, not a feed-shape corruption signal.
 */
export function parseSdnCsv(text: string): ParsedSdnEntry[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    throw new Error("SDN.CSV parse failed: zero rows found in fetched text");
  }

  const entries: ParsedSdnEntry[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    if (row.length !== EXPECTED_COLUMNS) {
      throw new Error(
        `SDN.CSV parse failed: row ${rowIndex + 1} has ${row.length} column(s), expected ${EXPECTED_COLUMNS} — feed shape looks corrupt/truncated`,
      );
    }
    const [entNum, sdnName, sdnType, program] = row;
    const nameNormalized = normalizeName(sdnName ?? "");
    if (nameNormalized.length === 0) continue; // no usable name on this row — skip, not fatal

    entries.push({
      uid: (entNum ?? "").trim(),
      nameNormalized,
      tokens: tokenize(nameNormalized),
      entityType: nullableField(sdnType ?? ""),
      program: nullableField(program ?? ""),
    });
  }

  if (entries.length === 0) {
    throw new Error("SDN.CSV parse failed: no usable entries after parsing — treating as an empty/corrupt fetch");
  }

  return entries;
}
