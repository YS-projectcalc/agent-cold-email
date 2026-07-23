import { describe, expect, it } from "vitest";
import { parseCsvRows } from "../src/ofac/csv.js";

describe("parseCsvRows — the minimal SDN.CSV-shaped quoted-CSV parser", () => {
  it("parses plain quoted fields", () => {
    expect(parseCsvRows('36,"AEROCARIBBEAN AIRLINES","-0-","CUBA"')).toEqual([
      ["36", "AEROCARIBBEAN AIRLINES", "-0-", "CUBA"],
    ]);
  });

  it("parses multiple rows separated by newlines", () => {
    const text = '1,"A"\n2,"B"\n';
    expect(parseCsvRows(text)).toEqual([
      ["1", "A"],
      ["2", "B"],
    ]);
  });

  it("handles CRLF line endings the same as LF", () => {
    const text = '1,"A"\r\n2,"B"\r\n';
    expect(parseCsvRows(text)).toEqual([
      ["1", "A"],
      ["2", "B"],
    ]);
  });

  it("handles an escaped double-quote (\"\") inside a quoted field", () => {
    expect(parseCsvRows('1,"CO., \"\"THE\"\" LTD"')).toEqual([["1", 'CO., "THE" LTD']]);
  });

  it("handles a comma embedded inside a quoted field (does not split it)", () => {
    expect(parseCsvRows('1,"SMITH, JOHN","-0-"')).toEqual([["1", "SMITH, JOHN", "-0-"]]);
  });

  it("handles an embedded newline inside a quoted field (does not treat it as a row break)", () => {
    expect(parseCsvRows('1,"LINE ONE\nLINE TWO","-0-"')).toEqual([["1", "LINE ONE\nLINE TWO", "-0-"]]);
  });

  it("empty text produces zero rows", () => {
    expect(parseCsvRows("")).toEqual([]);
  });

  it("a trailing newline at EOF produces no spurious extra row", () => {
    expect(parseCsvRows('1,"A"\n')).toEqual([["1", "A"]]);
  });
});
