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

interface EmailLike {
  send: (...a: unknown[]) => Promise<unknown>;
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

  it("a NON-retryable billing VendorError marks the send 'failed' immediately (no retry loop)", async () => {
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

// Persist-before-confirm class: the send() network call itself can THROW with
// the real EmailPort (the sandbox never does). The pre-fix code awaited send()
// UNGUARDED, so a throw propagated out of runTick and left the row stuck
// 'sending' forever (no reclaim existed). These fail on the old code: the
// unguarded throw makes tick() REJECT and leaves status='sending'.
describe("tick grades a THROWING send() and reclaims orphaned 'sending' rows", () => {
  it("a transient throwing send() reverts to 'pending' (not stuck 'sending') and tick() does not throw", async () => {
    const { tenantId } = await setupReadyTenant("Send Throw Co", "sendthrow.com");

    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      await launchOne(instance as never, "st@sendthrow-leads.com");
      await instance.infrastructureStatus();

      const email = (instance as unknown as { adapters: { email: EmailLike } }).adapters.email;
      email.send = async () => {
        throw new VendorError("simulated transient SMTP/engine outage", true);
      };

      // Old code: this REJECTS (unguarded throw out of runTick). Fixed: resolves.
      await expect(instance.tick()).resolves.toBeDefined();

      const row = state.storage.sql
        .exec<{ status: string; attempts: number; sending_since: number | null }>(
          `SELECT status, attempts, sending_since FROM scheduled_sends LIMIT 1`,
        )
        .one();
      expect(row.status).toBe("pending"); // reverted, NOT stuck 'sending'
      expect(row.attempts).toBe(1);
      expect(row.sending_since).toBeNull();
      // No message went out, so nothing billed and no 'sent' event recorded.
      expect(state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE type = 'sent'`).one().n).toBe(0);
    });
  });

  it("a permanent throwing send() marks the row 'failed' immediately (message_id NULL)", async () => {
    const { tenantId } = await setupReadyTenant("Perm Throw Co", "permthrow.com");

    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      await launchOne(instance as never, "pt@permthrow-leads.com");
      await instance.infrastructureStatus();

      const email = (instance as unknown as { adapters: { email: EmailLike } }).adapters.email;
      email.send = async () => {
        throw new VendorError("simulated permanent unknown-mailbox", false);
      };

      await expect(instance.tick()).resolves.toBeDefined();
      const row = state.storage.sql
        .exec<{ status: string; attempts: number }>(`SELECT status, attempts FROM scheduled_sends LIMIT 1`)
        .one();
      expect(row.status).toBe("failed");
      expect(row.attempts).toBe(1);
      const failed = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE type = 'failed' AND message_id IS NULL`)
        .one().n;
      expect(failed).toBe(1);
    });
  });

  it("reclaims a row orphaned in 'sending' (a DO that died mid-send) back to 'pending'", async () => {
    const { tenantId } = await setupReadyTenant("Orphan Co", "orphan.com");

    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      await launchOne(instance as never, "orphan@orphan-leads.com");
      await instance.infrastructureStatus();

      // Simulate an orphaned claim: stuck 'sending' with an ancient
      // sending_since, and pushed not-due so the reclaim's revert-to-pending is
      // observable (the same tick won't immediately re-send it).
      state.storage.sql.exec(
        `UPDATE scheduled_sends SET status = 'sending', sending_since = 1, send_at = 9000000000000`,
      );
      await instance.tick();

      const row = state.storage.sql
        .exec<{ status: string; sending_since: number | null }>(`SELECT status, sending_since FROM scheduled_sends LIMIT 1`)
        .one();
      expect(row.status).toBe("pending"); // reclaimed
      expect(row.sending_since).toBeNull();
    });
  });

  // The stuck-'sending' reclaim used to revert to 'pending' WITHOUT bumping
  // attempts, so a row that kept getting orphaned would reclaim→retry forever
  // (no ceiling — engine-host-review-2026-07-14). Now each reclaim bumps
  // attempts and the existing cap terminates the loop. FAILS on the old code:
  // attempts stays 0 and the row never reaches 'failed'.
  it("bumps attempts on each reclaim and fails the row at the cap (bounded orphan loop)", async () => {
    const { tenantId } = await setupReadyTenant("Reclaim Cap Co", "reclaimcap.com");

    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      await launchOne(instance as never, "rc@reclaimcap-leads.com");
      await instance.infrastructureStatus();

      const orphan = () =>
        state.storage.sql.exec(
          `UPDATE scheduled_sends SET status = 'sending', sending_since = 1, send_at = 9000000000000`,
        );
      const row = () =>
        state.storage.sql
          .exec<{ status: string; attempts: number }>(`SELECT status, attempts FROM scheduled_sends LIMIT 1`)
          .one();

      // Re-orphan before each tick (ancient sending_since ⇒ the TTL reclaim
      // fires; not-due ⇒ the reclaimed 'pending' row isn't re-sent that tick).
      for (let i = 1; i < MAX_SEND_ATTEMPTS; i++) {
        orphan();
        await instance.tick();
        expect(row().status).toBe("pending"); // reclaimed, under the cap
        expect(row().attempts).toBe(i); // bumped each reclaim (old code: 0)
      }

      // One more orphaned reclaim reaches the cap → terminal 'failed' + event.
      orphan();
      await instance.tick();
      const capped = row();
      expect(capped.status).toBe("failed");
      expect(capped.attempts).toBe(MAX_SEND_ATTEMPTS);
      expect(
        state.storage.sql
          .exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE type = 'failed' AND message_id IS NULL`)
          .one().n,
      ).toBe(1);
    });
  });
});
