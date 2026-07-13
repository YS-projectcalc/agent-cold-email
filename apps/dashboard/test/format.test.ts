import { describe, expect, it } from "vitest";
import { smartTruncateMiddle } from "../src/lib/format";

// M5 R2 item 7 — sandbox mailboxes share a long common prefix and differ
// only in their last 1-2 characters (provisioning.ts's
// `${personaSlug}${domainIndex+1}${mailboxIndex+1}`). Plain end-ellipsis
// hides exactly that distinguishing suffix; smartTruncateMiddle keeps both
// ends instead.
describe("smartTruncateMiddle", () => {
  it("leaves a short value untouched", () => {
    expect(smartTruncateMiddle("sender1")).toBe("sender1");
  });

  it("keeps the head and tail, dropping the indistinguishable middle", () => {
    expect(smartTruncateMiddle("founderoutreach1")).toBe("founde…ach1");
  });

  it("keeps two run mailboxes visually distinct where end-ellipsis alone would collapse them", () => {
    const a = smartTruncateMiddle("founderoutreach11");
    const b = smartTruncateMiddle("founderoutreach12");
    expect(a).not.toBe(b);
    expect(a.endsWith("11")).toBe(true);
    expect(b.endsWith("12")).toBe(true);
  });

  it("respects a custom head/tail split", () => {
    expect(smartTruncateMiddle("abcdefghijklmnop", 3, 3)).toBe("abc…nop");
  });

  it("never truncates a value at or under the head+tail+ellipsis length", () => {
    expect(smartTruncateMiddle("abcdefghijk", 6, 4)).toBe("abcdefghijk"); // exactly 11 chars
  });
});
