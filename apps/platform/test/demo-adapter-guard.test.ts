import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";
import { createVendorAdapters } from "../src/vendors/factory.js";
import { RealEmailPort } from "../src/vendors/real/email-port.js";
import { SandboxDomainPort } from "../src/vendors/sandbox/domain-port.js";
import { SandboxEmailPort } from "../src/vendors/sandbox/email-port.js";

// ARCHITECTURE.md #8 / SPEC.md §0.1: "free/demo tenants must be structurally
// unable to get a real adapter." This test FAILS if that guarantee is ever
// weakened — it forces `activated: true` (the I1 product-driven gate,
// self-serve activation design §2.1 — simulating a future bug or a bypass
// attempt) and asserts a demo/free tenant STILL gets the sandbox bundle.
describe("vendor adapter factory — demo/free tenants cannot reach a real adapter", () => {
  const clock = new VirtualClock(Date.now(), 0, 1);

  it("forces sandbox for a demo-plan tenant even when the activation gate is (hypothetically) true", () => {
    const bundle = createVendorAdapters("demo", clock, /* activated */ true);
    expect(bundle.kind).toBe("sandbox");
  });

  it("forces sandbox for a free-plan tenant even when the activation gate is (hypothetically) true", () => {
    const bundle = createVendorAdapters("free", clock, /* activated */ true);
    expect(bundle.kind).toBe("sandbox");
  });

  it("keeps a paid-plan tenant on sandbox while NOT activated (unpaid/frozen/none — the common case)", () => {
    const bundle = createVendorAdapters("launch", clock, /* activated */ false);
    expect(bundle.kind).toBe("sandbox");
  });

  it("a paid+activated tenant still gets SANDBOX domain/mailbox/billing without inboxKitConfig — `activated` is EmailPort-only (I1 scope; I3/I4 unbuilt)", () => {
    const bundle = createVendorAdapters("launch", clock, /* activated */ true);
    expect(bundle.kind).toBe("sandbox");
    expect(bundle.domain).toBeInstanceOf(SandboxDomainPort);
  });

  it("a paid+activated tenant WITHOUT engineConfig (the engine not armed yet — every test env, and prod before ACTIVATION.md's Cloudflare Tunnel step) still gets a WORKING sandbox EmailPort, not a permanently-dark one", async () => {
    const bundle = createVendorAdapters("launch", clock, /* activated */ true); // no engineConfig
    expect(bundle.email).toBeInstanceOf(SandboxEmailPort);
    const result = await bundle.email.send(
      { fromEmail: "a@b.test", toEmail: "c@d.test", subject: "s", body: "b", threadId: "t", inReplyToMessageId: null },
      "idem-1",
    );
    expect(result.messageId).toMatch(/@sandbox\.local>$/);
  });

  it("...but WITH engineConfig ALSO wired, that same activated+paid tenant's EmailPort DOES flip real — proves the gate is config-driven, not a dead/always-sandbox branch (instanceof only — no live network call)", () => {
    const bundle = createVendorAdapters("launch", clock, /* activated */ true, { baseUrl: "https://engine.example.internal", authSecret: "s" });
    expect(bundle.email).toBeInstanceOf(RealEmailPort);
  });

  it("sandbox adapters actually work (positive control — the guard isn't just returning broken adapters)", async () => {
    const bundle = createVendorAdapters("demo", clock, false);
    const candidates = await bundle.domain.searchLookalikes("Acme", "acme.com", 2);
    expect(candidates.length).toBe(2);
  });
});
