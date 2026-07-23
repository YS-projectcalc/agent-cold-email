import { describe, expect, it } from "vitest";
import { parseSdnCsv } from "../src/ofac/sdn-parse.js";
import sdnEmptyCsv from "./fixtures/ofac/sdn-empty.csv?raw";
import sdnMalformedCsv from "./fixtures/ofac/sdn-malformed.csv?raw";
import sdnValidCsv from "./fixtures/ofac/sdn-valid.csv?raw";

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
