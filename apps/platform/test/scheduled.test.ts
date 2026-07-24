import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";
import sdnValidCsv from "./fixtures/ofac/sdn-valid.csv?raw";
import { failPayment, mintTenant } from "./helpers.js";

// G1a — `scheduled()` now also drives the once-daily SDN refresh
// (src/ofac/sdn-refresh.ts), which fetches `env.OFAC_LIST_URL` (a real public
// Treasury URL — a plain wrangler.toml `[vars]` entry, not neutralized by the
// .dev.vars hermetic sweep). Stub `fetch` here so this test NEVER makes a real
// network call to treasury.gov (build brief hard rule) — same pattern as
// real-inboxkit-client.test.ts.
afterEach(() => vi.restoreAllMocks());

// D2 (brief) — "Wire it [the dunning sweep] + the deliverability sweep +
// metrics as Cron-triggerable handlers." Proves the `scheduled()` export
// (src/scheduled.ts) actually runs the ops sweep end to end — this is what
// the commented-out `[triggers]` cron in wrangler.toml will invoke once
// armed at activation.
describe("scheduled() — the Cron Trigger entry point", () => {
  it("runs the dunning sweep for every past_due tenant without throwing", async () => {
    const { tenantId } = await mintTenant("Cron Co", "managed");
    await failPayment(tenantId);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(sdnValidCsv, { status: 200 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(logSpy).toHaveBeenCalledWith("scheduled ops sweep", expect.stringContaining(tenantId));
    logSpy.mockRestore();
  });
});
