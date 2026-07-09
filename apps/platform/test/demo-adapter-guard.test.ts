import { describe, expect, it } from "vitest";
import { NotActivatedError } from "@coldstart/shared";
import { VirtualClock } from "../src/clock.js";
import { createVendorAdapters } from "../src/vendors/factory.js";

// ARCHITECTURE.md #8 / SPEC.md §0.1: "free/demo tenants must be structurally
// unable to get a real adapter." This test FAILS if that guarantee is ever
// weakened — it forces `realAdaptersActivated: true` (simulating a future
// bug or a bypass attempt) and asserts a demo/free tenant STILL gets the
// sandbox bundle.
describe("vendor adapter factory — demo/free tenants cannot reach a real adapter", () => {
  const clock = new VirtualClock(Date.now(), 0, 1);

  it("forces sandbox for a demo-plan tenant even when real adapters are (hypothetically) activated", () => {
    const bundle = createVendorAdapters("demo", clock, /* realAdaptersActivated */ true);
    expect(bundle.kind).toBe("sandbox");
  });

  it("forces sandbox for a free-plan tenant even when real adapters are (hypothetically) activated", () => {
    const bundle = createVendorAdapters("free", clock, /* realAdaptersActivated */ true);
    expect(bundle.kind).toBe("sandbox");
  });

  it("keeps a paid-plan tenant on sandbox too while the global activation flag is false (current build reality)", () => {
    const bundle = createVendorAdapters("paid", clock, /* realAdaptersActivated */ false);
    expect(bundle.kind).toBe("sandbox");
  });

  it("even a genuinely 'real' bundle (paid + activated) throws NotActivatedError on first use — defense in depth", async () => {
    const bundle = createVendorAdapters("paid", clock, /* realAdaptersActivated */ true);
    expect(bundle.kind).toBe("real");
    await expect(bundle.domain.buy("evil.com", "idem-1")).rejects.toThrow(NotActivatedError);
  });

  it("sandbox adapters actually work (positive control — the guard isn't just returning broken adapters)", async () => {
    const bundle = createVendorAdapters("demo", clock, false);
    const candidates = await bundle.domain.searchLookalikes("Acme", "acme.com", 2);
    expect(candidates.length).toBe(2);
  });
});
