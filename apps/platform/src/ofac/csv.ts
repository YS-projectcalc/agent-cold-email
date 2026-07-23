// A small, dependency-free RFC-4180-ish CSV parser — just enough for OFAC's
// published SDN.CSV (quoted fields, `""` as an escaped quote inside a quoted
// field, commas/newlines allowed inside quotes). No header row (SDN.CSV is
// data-only) — see sdn-parse.ts for the column contract.
//
// Kept dependency-free rather than pulling in a CSV library: the format is
// small and fixed (12 columns, no exotic dialect features), and a Worker cron
// budget (design flag, ga-gates-design-2026-07-22.md:47) favors a minimal,
// allocation-light parser over a general-purpose one.

/** Parses raw CSV text into rows of string fields. Handles quoted fields,
 * escaped `""` quotes, and embedded commas/newlines inside quotes. A trailing
 * blank line (common at EOF) produces no row. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++; // normalize CRLF -> LF below
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // Final row (file may or may not end with a newline) — only emit if there is
  // pending content (avoids a spurious empty trailing row).
  if (field.length > 0 || row.length > 0) endRow();

  return rows;
}
