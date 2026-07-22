import { describe, expect, it } from "vitest";
import { api, signup } from "./helpers.js";

// Gate (d) — display honesty (adversary inboxkit-adapters-2026-07-20 finding 4).
// InboxKit's reputation score is derived from a coarse health_status enum and
// its "placement" is only the bounce-rate complement — VENDOR-REPORTED
// approximations, not first-party measurements. They must not render under
// names that read as measured truth; the `vendor*` prefix carries provenance.
describe("infrastructure-status — vendor-reported reputation/placement are labeled as such (gate d)", () => {
  it("surfaces vendorReputationScore/vendorPlacementRate and NOT the bare reputationScore/placementRate", async () => {
    const { token } = await signup("Vendor Fields Co", "founder@vendorfields.test");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand: "Vendor Fields Co",
        primaryDomain: "vendorfields.com",
        domains: 1,
        inboxesEach: 1,
        persona: "Sender",
        physicalAddress: "1 Test St",
        senderIdentity: "Sender <s@vendorfields.com>",
      }),
    });

    const res = await api<{ mailboxHealth: Array<Record<string, unknown>> }>("/infrastructure-status", { token });
    expect(res.status).toBe(200);
    const mbx = res.body.mailboxHealth[0]!;

    // Provenance-labeled fields are present (sandbox getHealth -> 92 / 0.95)...
    expect(mbx.vendorReputationScore).toBe(92);
    expect(mbx.vendorPlacementRate).toBe(0.95);
    // ...and the misleading first-party-looking names are GONE.
    expect(mbx.reputationScore).toBeUndefined();
    expect(mbx.placementRate).toBeUndefined();
    // First-party measured signals stay under their plain names.
    expect(mbx.bounceRate).toBeDefined();
    expect(mbx.complaintRate).toBeDefined();
  });
});
