import { describe, expect, it } from "vitest";
import { classifySupportMessage, triageSupportMessage } from "../src/admin/support-kb.js";
import { decideDunningAction, DUNNING_ESCALATE_AFTER_FAILURES, DUNNING_SUSPEND_AFTER_FAILURES } from "../src/admin/dunning.js";

// Unit tests for the PURE D1/D2 decision functions — no D1/DO/clock, mirrors
// test/deliverability.test.ts's style for engine/deliverability.ts's `evaluate`.

describe("classifySupportMessage / triageSupportMessage (D1)", () => {
  it("classifies a how-to question and drafts an answer naming the MCP tools", () => {
    const result = triageSupportMessage("How do I get started?", "How do I set up my agent to use this via MCP?");
    expect(result.category).toBe("how-to");
    expect(result.status).toBe("open");
    expect(result.draft).toContain("setup_infrastructure");
  });

  it("classifies a deliverability question and drafts an answer naming the auto-loop", () => {
    const result = triageSupportMessage("Emails bouncing", "My domain seems to be burning and bounce rate is high");
    expect(result.category).toBe("deliverability");
    expect(result.draft).toMatch(/control loop/i);
  });

  it("abuse-report keywords win even alongside billing words, and never draft", () => {
    // A message that mentions "charged" (billing keyword) AND "phishing"
    // (abuse keyword) must still escalate — CLAUDE.md rule h analogue for
    // this surface: never auto-answer anything abuse-adjacent.
    const category = classifySupportMessage("charged for phishing complaint", "someone was charged, this is phishing");
    expect(category).toBe("abuse-report");
    const result = triageSupportMessage("charged for phishing complaint", "someone was charged, this is phishing");
    expect(result.draft).toBeNull();
    expect(result.status).toBe("escalated");
  });

  it("falls back to 'other' (escalated) for an unrecognized message", () => {
    const result = triageSupportMessage("hello", "just saying hi, no real question here");
    expect(result.category).toBe("other");
    expect(result.draft).toBeNull();
    expect(result.status).toBe("escalated");
  });
});

describe("decideDunningAction (D2)", () => {
  it("retries on the first failures, below the escalate threshold", () => {
    expect(decideDunningAction(0)).toBe("retry");
    expect(decideDunningAction(1)).toBe("retry");
    expect(decideDunningAction(DUNNING_ESCALATE_AFTER_FAILURES - 1)).toBe("retry");
  });

  it("escalates at the escalate threshold, below the suspend threshold", () => {
    expect(decideDunningAction(DUNNING_ESCALATE_AFTER_FAILURES)).toBe("escalate");
    expect(decideDunningAction(DUNNING_SUSPEND_AFTER_FAILURES - 1)).toBe("escalate");
  });

  it("suspends at and beyond the suspend threshold", () => {
    expect(decideDunningAction(DUNNING_SUSPEND_AFTER_FAILURES)).toBe("suspend");
    expect(decideDunningAction(DUNNING_SUSPEND_AFTER_FAILURES + 10)).toBe("suspend");
  });
});
