import { describe, expect, it } from "vitest";
import { normalizeName, tokenize } from "../src/ofac/normalize.js";

describe("normalizeName — lowercase, strip diacritics/punctuation, collapse whitespace", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeName("ANGLO-CARIBBEAN CO., LTD.")).toBe("anglo caribbean co ltd");
  });

  it("strips diacritics (NFKD decompose)", () => {
    expect(normalizeName("José Ramírez")).toBe("jose ramirez");
  });

  it("collapses repeated/irregular whitespace and trims", () => {
    expect(normalizeName("  Globex   Corp  ")).toBe("globex corp");
  });

  it("empty/whitespace-only input normalizes to empty string", () => {
    expect(normalizeName("   ")).toBe("");
  });
});

describe("tokenize", () => {
  it("splits a normalized name on whitespace", () => {
    expect(tokenize("globex corp")).toEqual(["globex", "corp"]);
  });

  it("empty normalized string tokenizes to zero tokens (not [\"\"])", () => {
    expect(tokenize("")).toEqual([]);
  });
});
