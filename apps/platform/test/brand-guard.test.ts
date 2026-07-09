import { describe, expect, it } from "vitest";
import { ValidationError } from "@coldstart/shared";
import { assertBrandOwnership } from "../src/engine/brand-guard.js";
import { api, signup } from "./helpers.js";

// panel-02 abuse-cost-dos: the lookalike generator did NOT reject third-party
// brands, so brand="Google"/primaryDomain="google.com" provisioned
// trygoogle.com mailboxes — the central documented safety guardrail was absent
// from code. These tests FAIL on the old (validator-less) code.
describe("lookalike third-party-brand guardrail — assertBrandOwnership (enforced in code)", () => {
  it("hard-rejects a well-known third-party brand by brand name", () => {
    expect(() => assertBrandOwnership({ brand: "Google", primaryDomain: "google.com" })).toThrow(ValidationError);
  });

  it("hard-rejects a third-party brand named only in the primary domain", () => {
    expect(() => assertBrandOwnership({ brand: "My Cool Startup", primaryDomain: "paypal.com" })).toThrow(
      ValidationError,
    );
  });

  it("rejects a lookalike of a domain that does NOT correspond to the tenant's own brand", () => {
    // Not on the denylist, but 'acmerockets' is unrelated to 'someone-elses.com'
    // — the ownership-consistency gate blocks impersonating an unasserted domain.
    expect(() => assertBrandOwnership({ brand: "Acme Rockets", primaryDomain: "someone-elses.com" })).toThrow(
      ValidationError,
    );
  });

  it("allows the tenant's OWN brand + matching primary domain", () => {
    expect(() => assertBrandOwnership({ brand: "Acme Rockets", primaryDomain: "acmerockets.com" })).not.toThrow();
    expect(() => assertBrandOwnership({ brand: "Pause Co", primaryDomain: "pauseco.com" })).not.toThrow();
  });

  it("does not false-positive a real word that merely contains a brand substring", () => {
    // 'metadata' must not be rejected as the 'meta' brand (token match, not substring).
    expect(() => assertBrandOwnership({ brand: "Metadata Insights", primaryDomain: "metadatainsights.com" })).not.toThrow();
  });
});

describe("POST /setup-infrastructure — third-party-brand hard-reject at the boundary", () => {
  const OWN_BODY = {
    brand: "Northwind Traders",
    primaryDomain: "northwindtraders.com",
    domains: 1,
    inboxesEach: 1,
    persona: "Sender",
    physicalAddress: "1 North St",
    senderIdentity: "Sender <s@northwindtraders.com>",
  };

  it("returns 400 when setup_infrastructure names a denylisted third-party brand", async () => {
    const { token } = await signup("Impersonator Co", "impersonator@brand-test.example");
    const res = await api<{ error: string }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({ ...OWN_BODY, brand: "Google", primaryDomain: "google.com" }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/third-party brand/i);

    // And it did NOT provision any infrastructure.
    const status = await api<{ domains: number; mailboxes: number }>("/infrastructure-status", { token });
    expect(status.body.domains).toBe(0);
    expect(status.body.mailboxes).toBe(0);
  });

  it("allows setup_infrastructure for the tenant's own brand + domain (202, provisions)", async () => {
    const { token } = await signup("Northwind Traders", "founder@brand-test.example");
    const res = await api<{ jobId: string }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify(OWN_BODY),
    });
    expect(res.status).toBe(202);
    const status = await api<{ domains: number; mailboxes: number }>("/infrastructure-status", { token });
    expect(status.body.domains).toBe(1);
    expect(status.body.mailboxes).toBe(1);
  });
});
