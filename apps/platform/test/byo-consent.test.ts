import { describe, expect, it } from "vitest";
import { buildConsentRecord, validateConsentAcknowledgment } from "../src/engine/byo-consent.js";

// SPEC.md §20.4 — primary-domain sending requires a separate, unbundled
// acknowledgment screen. The system logs the domain, a timestamp, and the
// pre-flight live-infra-scan result alongside the acknowledgment (so there's
// a record of exactly what risk was disclosed against what was actually
// found on the domain at consent time).

describe("buildConsentRecord", () => {
  it("captures the domain, timestamp, and scan snapshot verbatim", () => {
    const scanSnapshot = { liveInfraFound: true, reasons: ["existing MX record"] };
    const record = buildConsentRecord("mordy-primary.com", 1_700_000_000_000, scanSnapshot);
    expect(record).toEqual({
      domain: "mordy-primary.com",
      acknowledgedAt: 1_700_000_000_000,
      scanSnapshot,
    });
  });
});

describe("validateConsentAcknowledgment", () => {
  it("rejects when acknowledged is not explicitly true", () => {
    expect(() => validateConsentAcknowledgment({ acknowledged: false })).toThrow();
  });

  it("accepts an explicit true acknowledgment", () => {
    expect(() => validateConsentAcknowledgment({ acknowledged: true })).not.toThrow();
  });
});
