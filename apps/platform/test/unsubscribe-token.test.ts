import { describe, expect, it } from "vitest";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../src/unsubscribe-token.js";

const PEPPER = "test-pepper-for-unsubscribe-token";

// B4 opt-out — the hosted RFC 8058 endpoint's ONLY security boundary is this
// HMAC. A false-accept here is a mass-suppression primitive (anyone who can
// guess/enumerate tenantId+email could silently kill a competitor's outbound
// campaign); a false-reject would break a legitimate recipient's opt-out.
describe("unsubscribe-token: HMAC forgery/tamper resistance", () => {
  it("accepts the exact (tenant, email, sig) triplet it minted", async () => {
    const sig = await signUnsubscribeToken(PEPPER, "ten_abc123", "prospect@example.com");
    expect(await verifyUnsubscribeToken(PEPPER, "ten_abc123", "prospect@example.com", sig)).toBe(true);
  });

  it("rejects a single flipped hex character in the signature (tamper)", async () => {
    const sig = await signUnsubscribeToken(PEPPER, "ten_abc123", "prospect@example.com");
    const flippedChar = sig[0] === "0" ? "1" : "0";
    const tampered = flippedChar + sig.slice(1);
    expect(await verifyUnsubscribeToken(PEPPER, "ten_abc123", "prospect@example.com", tampered)).toBe(false);
  });

  it("rejects a valid signature presented against a DIFFERENT tenantId", async () => {
    const sig = await signUnsubscribeToken(PEPPER, "ten_victim", "prospect@example.com");
    expect(await verifyUnsubscribeToken(PEPPER, "ten_attacker", "prospect@example.com", sig)).toBe(false);
  });

  it("rejects a valid signature presented against a DIFFERENT email (cannot mass-suppress by reusing one real token's sig)", async () => {
    const sig = await signUnsubscribeToken(PEPPER, "ten_abc123", "real-recipient@example.com");
    expect(await verifyUnsubscribeToken(PEPPER, "ten_abc123", "someone-else@example.com", sig)).toBe(false);
  });

  it("rejects an empty signature", async () => {
    expect(await verifyUnsubscribeToken(PEPPER, "ten_abc123", "prospect@example.com", "")).toBe(false);
  });

  it("rejects a well-formed but unrelated signature (not just a length mismatch)", async () => {
    const unrelatedSig = await signUnsubscribeToken(PEPPER, "ten_other", "nobody@example.com");
    expect(await verifyUnsubscribeToken(PEPPER, "ten_abc123", "prospect@example.com", unrelatedSig)).toBe(false);
  });

  it("a DIFFERENT pepper (e.g. a different deployment) produces a non-interchangeable signature", async () => {
    const sig = await signUnsubscribeToken(PEPPER, "ten_abc123", "prospect@example.com");
    expect(await verifyUnsubscribeToken("a-totally-different-pepper", "ten_abc123", "prospect@example.com", sig)).toBe(
      false,
    );
  });

  it("signing is deterministic for the same inputs (no per-call randomness to break repeat-click idempotency)", async () => {
    const first = await signUnsubscribeToken(PEPPER, "ten_abc123", "prospect@example.com");
    const second = await signUnsubscribeToken(PEPPER, "ten_abc123", "prospect@example.com");
    expect(first).toBe(second);
  });
});
