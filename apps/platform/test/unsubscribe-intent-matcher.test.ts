import { describe, expect, it } from "vitest";
import { isUnsubscribeIntentReply } from "../src/engine/reply-processor.js";

// backend gaps brief item 3 / B4 TODO (tick.ts:46-56) — engine/reply-
// processor.ts had ZERO inbound opt-out parsing before this. Deliberately
// conservative: a false positive silently drops a real engaged lead, so the
// matcher requires the ENTIRE (cleaned) reply body to BE one of a small
// phrase set, not merely mention one.
describe("isUnsubscribeIntentReply — conservative exact-phrase matching", () => {
  it("matches the bare word", () => {
    expect(isUnsubscribeIntentReply("unsubscribe")).toBe(true);
  });

  it("matches common short phrasings", () => {
    expect(isUnsubscribeIntentReply("remove me")).toBe(true);
    expect(isUnsubscribeIntentReply("opt out")).toBe(true);
    expect(isUnsubscribeIntentReply("opt-out")).toBe(true);
    expect(isUnsubscribeIntentReply("unsubscribe me")).toBe(true);
    expect(isUnsubscribeIntentReply("take me off this list")).toBe(true);
  });

  it("matches with a leading or trailing 'please' and trailing punctuation", () => {
    expect(isUnsubscribeIntentReply("Please unsubscribe.")).toBe(true);
    expect(isUnsubscribeIntentReply("unsubscribe please")).toBe(true);
    expect(isUnsubscribeIntentReply("Please remove me from your list.")).toBe(true);
    expect(isUnsubscribeIntentReply("Unsubscribe!")).toBe(true);
  });

  it("is case-insensitive and tolerates surrounding whitespace/newlines", () => {
    expect(isUnsubscribeIntentReply("  UNSUBSCRIBE  \n")).toBe(true);
  });

  it("strips quoted-reply lines ('>' prefix) before matching", () => {
    const body = "unsubscribe\n> On Tue, someone wrote:\n> please don't remove me, this is a quote";
    expect(isUnsubscribeIntentReply(body)).toBe(true);
  });

  it("strips a top-posting quote header ('On ... wrote:') before matching", () => {
    const body = "unsubscribe\nOn Mon, Jan 1, 2026 at 9:00 AM Sender <s@x.com> wrote:\nHi there, following up...";
    expect(isUnsubscribeIntentReply(body)).toBe(true);
  });

  it("strips a plain-text '-----Original Message-----' separator before matching", () => {
    const body = "remove me\n-----Original Message-----\nFrom: sender@x.com\nSubject: Hi";
    expect(isUnsubscribeIntentReply(body)).toBe(true);
  });

  // The core conservative-bias requirement (brief): a reply that MERELY
  // MENTIONS the word, embedded in a longer sentence, must NOT match — a
  // false positive here silently kills a real, engaged lead.
  it("does NOT match a reply that merely mentions 'unsubscribe' mid-sentence", () => {
    expect(
      isUnsubscribeIntentReply(
        "I tried to unsubscribe from a different list last month and nobody responded — can you help with that one too?",
      ),
    ).toBe(false);
  });

  it("does NOT match an ordinary business reply", () => {
    expect(isUnsubscribeIntentReply("Thanks for reaching out, can we set up a call next week?")).toBe(false);
  });

  it("does NOT match an out-of-office auto-responder", () => {
    expect(isUnsubscribeIntentReply("I am out of the office until Monday and will respond then.")).toBe(false);
  });

  it("does NOT match a longer sentence that merely contains a phrase from the set as a substring", () => {
    expect(isUnsubscribeIntentReply("please remove me from your list, but keep me on the other newsletter, thanks")).toBe(
      false,
    );
  });

  it("does NOT match an empty or whitespace-only body", () => {
    expect(isUnsubscribeIntentReply("")).toBe(false);
    expect(isUnsubscribeIntentReply("   \n  ")).toBe(false);
  });
});
