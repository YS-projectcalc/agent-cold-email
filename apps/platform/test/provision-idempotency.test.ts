import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { MailboxHealth, MailboxPort, ProvisionedMailbox, ReleaseResult } from "@coldstart/shared";
import { VirtualClock } from "../src/clock.js";
import { readActivationState } from "../src/engine/activation.js";
import { provisionMailboxesForDomain } from "../src/engine/provisioning.js";
import type { TenantContext } from "../src/tenant-context.js";
import { createVendorAdapters } from "../src/vendors/factory.js";
import { signup, tenantStub } from "./helpers.js";

// Gate (c) — provision idempotency via the repo's own withRequestIdempotency
// (engine/provisioning.ts wraps the vendor buy). InboxKit's /mailboxes/buy has
// no idempotency-key primitive, so a redelivered/re-run provision would
// DOUBLE-CHARGE a paid slot. The wrap makes a re-run return the recorded
// mailbox WITHOUT a second vendor buy — the durable local record that replaced
// the fragile /already exists/i substring hack.

/** A MailboxPort that COUNTS how many times the vendor buy is actually invoked. */
function countingMailbox(): { port: MailboxPort; provisionCalls: () => number } {
  let calls = 0;
  const port: MailboxPort = {
    async provision(domain, localPart): Promise<ProvisionedMailbox> {
      calls++;
      return { email: `${localPart}@${domain}`, provider: "google", provisionedAt: Date.now() };
    },
    async startWarmup(): Promise<{ started: boolean; startedAt: number }> {
      return { started: true, startedAt: Date.now() };
    },
    async getHealth(email: string): Promise<MailboxHealth> {
      return { email, reputationScore: 90, bounceRate: 0.01, complaintRate: 0, placementRate: 0.99 };
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };
  return { port, provisionCalls: () => calls };
}

/** Builds a ctx (mirroring helpers.withTenantContext) but with an injected mailbox port. */
async function withInjectedMailbox<T>(tenantId: string, mailbox: MailboxPort, fn: (ctx: TenantContext) => Promise<T> | T): Promise<T> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) => {
    const sql = state.storage.sql;
    const p = sql.exec<{ plan: "demo" | "free" | "launch" | "growth" | "scale"; clock_base: number; clock_offset: number; clock_multiplier: number }>(
      `SELECT plan, clock_base, clock_offset, clock_multiplier FROM tenant_profile WHERE id = ?`,
      tenantId,
    ).one();
    const clock = new VirtualClock(p.clock_base, p.clock_offset, p.clock_multiplier);
    const { activated } = readActivationState(sql, tenantId);
    const ctx: TenantContext = {
      sql,
      tenantId,
      plan: p.plan,
      clock,
      adapters: { ...createVendorAdapters(p.plan, clock, activated), mailbox },
      env,
    };
    return fn(ctx);
  });
}

const OPTS = { domainId: "dom_test", domain: "seller-lookalike.com", domainKey: "seller-lookalike.com#0", domainOrdinal: 0, personaSlug: "ops", inboxesEach: 1 };

describe("Gate (c) — provision is idempotent via withRequestIdempotency (no double vendor buy)", () => {
  it("a re-run with the same idempotency key returns the recorded mailbox WITHOUT a second vendor buy", async () => {
    const { tenantId } = await signup("Provision Idem Co", "founder@provisionidem.test");
    const { port, provisionCalls } = countingMailbox();

    const first = await withInjectedMailbox(tenantId, port, (ctx) => provisionMailboxesForDomain(ctx, OPTS));
    const second = await withInjectedMailbox(tenantId, port, (ctx) => provisionMailboxesForDomain(ctx, OPTS));

    // Same deterministic key -> the vendor buy ran exactly once across both runs.
    expect(provisionCalls()).toBe(1);
    // Both runs resolve the SAME mailbox email (the recorded ProvisionedMailbox).
    expect(second).toEqual(first);
  });

  it("distinct mailboxes still each provision (the guard is per-key, not a blanket suppressor)", async () => {
    const { tenantId } = await signup("Provision Distinct Co", "founder@provisiondistinct.test");
    const { port, provisionCalls } = countingMailbox();
    await withInjectedMailbox(tenantId, port, (ctx) => provisionMailboxesForDomain(ctx, { ...OPTS, inboxesEach: 2 }));
    expect(provisionCalls()).toBe(2); // two distinct local parts -> two buys
  });
});
