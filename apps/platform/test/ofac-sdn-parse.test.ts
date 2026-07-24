import { describe, expect, it } from "vitest";
import { parseSdnCsv } from "../src/ofac/sdn-parse.js";
import sdnEmptyCsv from "./fixtures/ofac/sdn-empty.csv?raw";
import sdnInteriorEofMarkerCsv from "./fixtures/ofac/sdn-interior-eof-marker.csv?raw";
import sdnMalformedCsv from "./fixtures/ofac/sdn-malformed.csv?raw";
import sdnValidCsv from "./fixtures/ofac/sdn-valid.csv?raw";
import sdnValidRealTailCrlfCsv from "./fixtures/ofac/sdn-valid-real-tail-crlf.csv?raw";
import sdnValidRealTailCsv from "./fixtures/ofac/sdn-valid-real-tail.csv?raw";

describe("parseSdnCsv — fail-loud on a corrupt/empty feed (F5 convention)", () => {
  it("parses a valid fixture into normalized entries", () => {
    const entries = parseSdnCsv(sdnValidCsv);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ uid: "36", nameNormalized: "aerocaribbean airlines", entityType: null, program: "CUBA" });
    expect(entries[0]?.tokens).toEqual(["aerocaribbean", "airlines"]);
    // "-0-" is OFAC's own no-value placeholder for entity_type -> normalized to null.
    const globex = entries.find((e) => e.uid === "9001");
    expect(globex).toMatchObject({ nameNormalized: "globex corp", program: "TEST-PROGRAM" });
    expect(globex?.tokens).toEqual(["globex", "corp"]);
  });

  it("throws on a malformed row (wrong column count) rather than silently truncating", () => {
    expect(() => parseSdnCsv(sdnMalformedCsv)).toThrow(/expected 12/);
  });

  it("throws on an empty feed rather than treating it as a zero-entry list", () => {
    expect(() => parseSdnCsv(sdnEmptyCsv)).toThrow(/zero rows/);
  });
});

// WIRE-SHAPE FIX (live-verified 2026-07-24 at first arming push): the real
// Treasury SDN.CSV — 5.6MB, 19,241 lines, otherwise exactly the assumed shape
// — ends with a legacy DOS EOF marker (a lone 0x1A / Ctrl-Z as the final
// "line"). Before the fix, this reached parseCsvRows as one more 1-field row
// and tripped the 12-column fail-loud check on EVERY real ingest attempt.
describe("parseSdnCsv — trailing DOS EOF marker (0x1A) tolerance, tail-anchored only", () => {
  it("parses cleanly when the file ends with a lone 0x1A (LF line endings, no trailing newline after it — the real feed's shape)", () => {
    const entries = parseSdnCsv(sdnValidRealTailCsv);
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.uid)).toEqual(["36", "9001", "9002", "9003"]);
  });

  it("parses cleanly when the file is CRLF-terminated and ends with \\r\\n\\x1a\\r\\n", () => {
    const entries = parseSdnCsv(sdnValidRealTailCrlfCsv);
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.uid)).toEqual(["36", "9001", "9002", "9003"]);
  });

  it("an INTERIOR 0x1A (real data both before AND after it) is NOT tolerated — still throws (mid-file corruption must stay fail-loud)", () => {
    expect(() => parseSdnCsv(sdnInteriorEofMarkerCsv)).toThrow(/expected 12/);
  });
});
