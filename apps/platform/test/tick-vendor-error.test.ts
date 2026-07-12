import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { VendorError } from "@coldstart/shared";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

// A4 (CLASS A) — a graded billing failure on the post-send path. The pre-fix
// code reverted the row to 'pending' FOREVER on any failure (infinite retry).
// Now: a RETRYABLE VendorError retries under a cap then fails; a NON-retryable
// VendorError fails immediately. Either way the send becomes ops-visible.

const MAX_SEND_ATTEMPTS = 5; // must match engine/tick.ts

async function setupReadyTenant(brand: string, primaryDomain: string) {
  const { tenantId, token } = await signup(brand, `founder@${primaryDomain}`);
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain,
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: `Sender <s@${primaryDomain}>`,
    }),
  });
  await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
  return { tenantId, token };
}

const ONE_STEP = [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }];

interface BillingLike {
  recordUsage: (...a: unknown[]) => Promise<unknown>;
}

async function launchOne(instance: { launchCampaign: (i: unknown) => Promise<unknown> }, email: string) {
  await instance.launchCampaign({
    name: "vendor-error",
    offer: "x",
    leads: [{ email, firstName: "L", company: "Co" }],
    sequence: ONE_STEP,
    timezone: "UTC",
    sendWindow: { startHour: 0, endHour: 23 },
    stopOnReply: true,
  });
}

describe("tick grades a post-send vendor billing failure (A4)", () => {
  it("a RETRYABLE VendorError reverts to pending under a cap, then marks the send 'failed' (ops-visible)", async () => {
    const { tenantId } = await setupReadyTenant("Retry Cap Co", "retrycap.com");

    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      await launchOne(instance as never, "retry@retrycap-leads.com");
      await instance.infrastructureStatus(); // builds adapters

      const billing = (instance as unknown as { adapters: { billing: BillingLike } }).adapters.billing;
      billing.recordUsage = async () => {
        throw new VendorError("simulated transient billing outage", true);
      };

      const one = (sql: string) => state.storage.sql.exec<{ n: number }>(sql).one().n;
      const attempts = () =>
        state.storage.sql.exec<{ attempts: number }>(`SELECT attempts FROM scheduled_sends LIMIT 1`).one().attempts;
      const status = () =>
        state.storage.sql.exec<{ status: string }>(`SELECT status FROM scheduled_sends LIMIT 1`).one().status;

      // The first MAX_SEND_ATTEMPTS-1 ticks retry (row stays pending, attempts climb).
      for (let i = 1; i < MAX_SEND_ATTEMPTS; i++) {
        await instance.tick();
        expect(status()).toBe("pending");
        expect(attempts()).toBe(i);
      }
      // The cap tick fails the row instead of retrying forever.
      await instance.tick();
      expect(status()).toBe("failed");
      expect(attempts()).toBe(MAX_SEND_ATTEMPTS);
      expect(one(`SELECT COUNT(*) as n FROM events WHERE type = 'failed'`)).toBe(1);
      expect(one(`SELECT COUNT(*) as n FROM ledger_entries WHERE kind = 'usage'`)).toBe(0); // never billed
    });

    const summary = await tenantStub(tenantId).opsSummary(0);
    expect(summary.failedSends).toBe(1);
  });

  it("a NON-retryable VendorError marks the send 'failed' immediately (no retry loop)", async () => {
    const { tenantId } = await setupReadyTenant("No Retry Co", "noretry.com");

    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      await launchOne(instance as never, "noretry@noretry-leads.com");
      await instance.infrastructureStatus();

      const billing = (instance as unknown as { adapters: { billing: BillingLike } }).adapters.billing;
      billing.recordUsage = async () => {
        throw new VendorError("simulated permanent billing rejection", false);
      };

      await instance.tick();
      const row = state.storage.sql
        .exec<{ status: string; attempts: number }>(`SELECT status, attempts FROM scheduled_sends LIMIT 1`)
        .one();
      expect(row.status).toBe("failed");
      expect(row.attempts).toBe(1); // failed on the FIRST attempt — no retry loop
      expect(
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE type = 'failed'`).one().n,
      ).toBe(1);
    });
  });
});
