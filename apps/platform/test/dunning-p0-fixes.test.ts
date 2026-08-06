import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { runDunningSweep } from "../src/admin/ops-sweep.js";
import { runScheduledOpsSweep } from "../src/scheduled.js";
import { TenantDO } from "../src/tenant-do.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { failPayment, mintTenant, tenantStub } from "./helpers.js";

// Adversarial audit 2026-08-05 (docs/adversarial/audit-dunning-2026-08-05.md)
// found 3 BLOCKING defects in the LIVE dunning cron (wrangler.toml crons
// armed every 5 min). Each test below fault-injects the REAL path — a
// TenantDO.prototype patch, the established pattern for this suite (see
// login.test.ts:301's RealOpsMailer.prototype.send patch) — and asserts
// durable D1/DO state, never a mock call count.

afterEach(() => vi.restoreAllMocks());

async function driveToSuspendThreshold(tenantId: string): Promise<void> {
  await failPayment(tenantId); // cycle 1 -> retry
  await failPayment(tenantId); // cycle 2 -> escalate
  await failPayment(tenantId); // cycle 3
  await failPayment(tenantId); // cycle 4 -> suspend threshold
}

async function dunningEventRow(tenantId: string, cycle: number): Promise<{ id: string } | null> {
  const row = await env.DB.prepare(`SELECT id FROM dunning_events WHERE tenant_id = ? AND cycle = ?`)
    .bind(tenantId, cycle)
    .first<{ id: string }>();
  return row ?? null;
}

describe("F1 — one tenant's throw must not abort the sweep for the rest (ops-sweep.ts:42-65 was the only unguarded per-tenant loop)", () => {
  it("a wedged tenant's opsSummary throw does not prevent a later past_due tenant from being actioned", async () => {
    const { tenantId: wedgedId } = await mintTenant("Wedged Co", "managed");
    const { tenantId: healthyId } = await mintTenant("Healthy Past-Due Co", "managed");
    await failPayment(wedgedId);
    await failPayment(healthyId);

    const originalOpsSummary = TenantDO.prototype.opsSummary;
    (TenantDO.prototype as any).opsSummary = function (this: any, sinceMs: number) {
      if (this.tenantId === wedgedId) throw new Error("simulated wedged DO (storage error / overload)");
      return originalOpsSummary.call(this, sinceMs);
    };

    try {
      const mailer = new SandboxOpsMailer();
      const summary = await runDunningSweep(env, Date.now(), mailer);
      const healthyResult = summary.results.find((r) => r.tenantId === healthyId);
      expect(healthyResult).toBeDefined();
      expect(healthyResult?.action).toBe("retry");
      expect(healthyResult?.applied).toBe(true);
    } finally {
      TenantDO.prototype.opsSummary = originalOpsSummary;
    }
  });

  it("a leg that still throws (buildOpsDigest's unguarded per-tenant Promise.all — reported sibling, not fixed here) does not abort watchtower/webhooks/spend-reaper/sdn legs", async () => {
    const { tenantId: wedgedId } = await mintTenant("Wedged Digest Co", "managed");

    const originalOpsSummary = TenantDO.prototype.opsSummary;
    (TenantDO.prototype as any).opsSummary = function (this: any, sinceMs: number) {
      if (this.tenantId === wedgedId) throw new Error("simulated wedged DO");
      return originalOpsSummary.call(this, sinceMs);
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runScheduledOpsSweep(env);
      // On OLD code (no per-leg wrap) the wedged tenant's throw propagates all
      // the way out of runScheduledOpsSweep BEFORE this final log line — so
      // logSpy is never called at all. Reaching it proves every later leg
      // (watchtower, webhooks, spend-reservation reaper, sdnRefresh,
      // sdnRecovery) still ran this tick despite the earlier throw.
      expect(logSpy).toHaveBeenCalledWith("scheduled ops sweep", expect.any(String));
    } finally {
      TenantDO.prototype.opsSummary = originalOpsSummary;
      logSpy.mockRestore();
    }
  });
});

describe("F2 — the idempotency guard row must not commit before the suspend effect (permanent missed-suspend)", () => {
  it("a suspend RPC failure leaves no guard row, so the SAME (unchanged) cycle retries and succeeds on the next tick", async () => {
    const { tenantId } = await mintTenant("Suspend Fault Co", "managed");
    await driveToSuspendThreshold(tenantId);

    const originalSuspend = TenantDO.prototype.suspendForDunning;
    (TenantDO.prototype as any).suspendForDunning = function (this: any) {
      if (this.tenantId === tenantId) throw new Error("simulated suspend RPC failure");
      return originalSuspend.call(this);
    };

    try {
      const mailer = new SandboxOpsMailer();
      // Must not throw — F1's per-tenant containment applies here too.
      await runDunningSweep(env, Date.now(), mailer);

      // Nothing committed: no guard row for this cycle, tenant still active.
      expect(await dunningEventRow(tenantId, 4)).toBeNull();
      const stillActive = await tenantStub(tenantId).opsSummary(Date.now());
      expect(stillActive.status).toBe("active");
    } finally {
      TenantDO.prototype.suspendForDunning = originalSuspend;
    }

    // Retry with the fault cleared. On the OLD code (guard row committed
    // BEFORE the suspend effect) the row from the faulted attempt would
    // already exist for cycle 4, so `insertDunningEventIfNew` returns false,
    // the suspend is never retried, and the tenant stays active FOREVER
    // (Stripe's payment_failed retries are exhausted, so cycle never advances
    // past 4 again). On the FIXED code no row was committed, so this retry
    // re-decides 'suspend' and actually applies it.
    const mailer2 = new SandboxOpsMailer();
    await runDunningSweep(env, Date.now(), mailer2);
    const after = await tenantStub(tenantId).opsSummary(Date.now());
    expect(after.status).toBe("suspended");
    expect(await dunningEventRow(tenantId, 4)).not.toBeNull();
  });
});

describe("F3 — the suspend UPDATE must re-check billing_state (wrong-suspend of a paying customer, flap race)", () => {
  it("a billing_state flip to 'active' between the sweep's read and its suspend write must not end suspended", async () => {
    const { tenantId } = await mintTenant("Flap Race Co", "managed");
    await driveToSuspendThreshold(tenantId);

    // Simulate the race exactly where the audit found it: the sweep's read
    // (opsSummary) captures billingState='past_due', THEN — before the write
    // (suspendForDunning) — a recovery webhook lands in the gap and flips
    // billing_state to 'active'. Flipping storage as an opsSummary side
    // effect (while still returning the pre-flip past_due summary it read)
    // places the flip exactly between the sweep's read and its write, same
    // as the audit's P3 probe.
    const originalOpsSummary = TenantDO.prototype.opsSummary;
    (TenantDO.prototype as any).opsSummary = function (this: any, sinceMs: number) {
      const result = originalOpsSummary.call(this, sinceMs);
      if (this.tenantId === tenantId) {
        this.ctx.storage.sql.exec(`UPDATE tenant_profile SET billing_state = 'active' WHERE id = ?`, tenantId);
      }
      return result;
    };

    let mailer = new SandboxOpsMailer();
    try {
      await runDunningSweep(env, Date.now(), mailer);
    } finally {
      TenantDO.prototype.opsSummary = originalOpsSummary;
    }

    const after = await tenantStub(tenantId).opsSummary(Date.now());
    expect(after.status).toBe("active"); // NOT suspended — the paying customer must not be clobbered
    expect(after.billingState).toBe("active");
    expect(await dunningEventRow(tenantId, 4)).toBeNull(); // nothing to record — the suspend was a no-op
    expect(mailer.sent).toHaveLength(0); // no "you've been suspended" notice for a customer who wasn't
  });
});
