import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env.js";
import { insertTenantIndex } from "../src/db.js";
import { runSendPipelineAllTenants } from "../src/admin/ops-sweep.js";
import { SEND_PIPELINE_TENANT_CAP, SEND_PIPELINE_SUBREQUESTS, SEND_PIPELINE_RPCS_PER_TENANT } from "../src/admin/sweep-budget.js";
import { DEFERRAL_COUNTER_NAMES } from "../src/admin/sweep-signals.js";

// NB-5 (gate 2026-08-24) — the send pipeline's per-tick COUNT cap.
//
// It became a leg with a fan-out of its own on 2026-08-24, when the cron stopped
// handing it the tenant slice. B1's lesson is that such a leg needs a DECLARED
// count its subrequest term is derived from — a deadline alone is what let the
// stale-reserve reaper spend ~901 subrequests ahead of the heartbeat. The cap
// shipped with arithmetic coverage on the CONSTANT and nothing driving the
// `break` itself, which is a brand-new break in a hot-path send loop.

describe("the send pipeline's tenant cap actually binds", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tenants_index").run();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("stops at the cap and reports the overflow under its OWN counter", async () => {
    const total = SEND_PIPELINE_TENANT_CAP + 2;
    for (let i = 0; i < total; i++) {
      await insertTenantIndex(env as Env, {
        id: `ten_cap_${String(i).padStart(4, "0")}`,
        apiTokenHash: `cap-hash-${i}`,
        brand: `Cap ${i}`,
        plan: "free",
        createdAt: 1_800_000_000_000,
        contactEmail: null,
      });
    }

    // A leg deadline large enough that it CANNOT be what stops the loop —
    // otherwise this test would pass on the deadline break and prove nothing
    // about the cap.
    const summary = await runSendPipelineAllTenants(env as Env, Date.now(), { legDeadlineMs: 10 * 60 * 1000 });

    expect(summary.tenantsScanned).toBe(total);
    expect(summary.skippedForTenantCap, "the cap did not bind").toBe(2);
    // ITS OWN COUNTER, not the deadline's. Two capacity causes sharing one
    // counter makes `cron_legs` report a count-cap break as a latency problem,
    // and the two want opposite responses.
    expect(summary.skippedForLegDeadline).toBe(0);
    // Positive control: the loop really did drive the cap's worth of tenants.
    expect(summary.errors + summary.tenantsRan).toBeGreaterThan(0);
  }, 300_000);

  it("does not bind below the cap", async () => {
    for (let i = 0; i < 4; i++) {
      await insertTenantIndex(env as Env, {
        id: `ten_nocap_${i}`,
        apiTokenHash: `nocap-hash-${i}`,
        brand: `NoCap ${i}`,
        plan: "free",
        createdAt: 1_800_000_000_000,
        contactEmail: null,
      });
    }
    const summary = await runSendPipelineAllTenants(env as Env, Date.now(), { legDeadlineMs: 10 * 60 * 1000 });
    expect(summary.skippedForTenantCap).toBe(0);
    expect(summary.tenantsScanned).toBe(4);
  }, 120_000);

  it("the new counter is a DEFERRAL, so cron_legs cannot read it as a failure", () => {
    // The class this repo has been burned by twice: a counter the signal reducer
    // does not know about is silently zero, and one filed under the wrong
    // heading pins a check permanently unhealthy. `skippedForTenantCap` is
    // capacity, exactly like `skippedForLegDeadline`.
    expect(DEFERRAL_COUNTER_NAMES).toContain("skippedForTenantCap");
    expect(DEFERRAL_COUNTER_NAMES).toContain("skippedForLegDeadline");
    expect(DEFERRAL_COUNTER_NAMES).not.toContain("errors");
  });

  it("the declared subrequest term is derived from the cap it enforces", () => {
    expect(SEND_PIPELINE_SUBREQUESTS).toBe(SEND_PIPELINE_TENANT_CAP * SEND_PIPELINE_RPCS_PER_TENANT);
  });
});
