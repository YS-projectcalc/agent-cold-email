import { describe, expect, it, vi } from "vitest";
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";
import { failPayment, mintTenant } from "./helpers.js";

// D2 (brief) — "Wire it [the dunning sweep] + the deliverability sweep +
// metrics as Cron-triggerable handlers." Proves the `scheduled()` export
// (src/scheduled.ts) actually runs the ops sweep end to end — this is what
// the commented-out `[triggers]` cron in wrangler.toml will invoke once
// armed at activation.
describe("scheduled() — the Cron Trigger entry point", () => {
  it("runs the dunning sweep for every past_due tenant without throwing", async () => {
    const { tenantId } = await mintTenant("Cron Co", "launch");
    await failPayment(tenantId);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(logSpy).toHaveBeenCalledWith("scheduled ops sweep", expect.stringContaining(tenantId));
    logSpy.mockRestore();
  });
});
