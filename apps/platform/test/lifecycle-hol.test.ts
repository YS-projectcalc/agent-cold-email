// T2 instantiated for the two LIFECYCLE members of the head-of-line-blocking
// class (docs/adversarial/class-sweep-hol-blocking-2026-08-17.md, IN-3 + IN-4).
//
// Both loops walk a durably-selected, stably-ordered list and both used to let
// ONE item's vendor failure end the whole call. Because the next attempt
// re-selects the same list in the same order, the failure was permanent: every
// mailbox behind a stuck one kept `released_at IS NULL` and kept BILLING, and a
// teardown that threw mid-loop wrote no anchor at all, so the entire teardown
// restarted from zero and re-died at the same domain, forever.

import { describe, expect, it } from "vitest";
import {
  VendorError,
  type CancelWarmupResult,
  type DomainDnsResult,
  type DomainPort,
  type LookalikeCandidate,
  type MailboxHealth,
  type MailboxPort,
  type MailboxReadiness,
  type OwnedDomain,
  type ProvisionedMailbox,
  type PurchasedDomain,
  type ReleaseResult,
} from "@coldstart/shared";
import { getTeardownSummary, releaseMailboxes, teardownTenant } from "../src/engine/lifecycle.js";
import type { TenantContext } from "../src/tenant-context.js";
import { mintTenant, withTenantContext } from "./helpers.js";

/** Releases everything except ONE address, which it permanently 404s. */
class PartlyStuckMailboxPort implements MailboxPort {
  readonly releaseCalls: string[] = [];
  constructor(private readonly stuckEmail: string) {}
  async provision(): Promise<ProvisionedMailbox> {
    throw new Error("not used");
  }
  async provisioningState(): Promise<MailboxReadiness> {
    throw new Error("not used");
  }
  async getHealth(): Promise<MailboxHealth> {
    throw new Error("not used");
  }
  async startWarmup(): Promise<{ started: boolean; startedAt: number }> {
    throw new Error("not used");
  }
  async cancelWarmup(): Promise<CancelWarmupResult> {
    throw new Error("not used");
  }
  async release(email: string): Promise<ReleaseResult> {
    this.releaseCalls.push(email);
    if (email === this.stuckEmail) {
      throw new VendorError("inboxkit mailboxes/release -> HTTP 404: mailbox not found", false);
    }
    return { released: true, releasedAt: Date.now() };
  }
}

/** Releases every domain except ONE, which it permanently refuses. */
class PartlyStuckDomainPort implements DomainPort {
  readonly releaseCalls: string[] = [];
  constructor(private readonly stuckDomain: string) {}
  async searchLookalikes(): Promise<LookalikeCandidate[]> {
    return [];
  }
  async listOwnedDomains(): Promise<OwnedDomain[]> {
    return [];
  }
  async buy(): Promise<PurchasedDomain> {
    throw new Error("not used");
  }
  async setDns(): Promise<DomainDnsResult> {
    throw new Error("not used");
  }
  async release(domain: string): Promise<ReleaseResult> {
    this.releaseCalls.push(domain);
    if (domain === this.stuckDomain) {
      throw new VendorError("inboxkit domains/release -> HTTP 403: domain locked", false);
    }
    return { released: true, releasedAt: Date.now() };
  }
}

function seedDomain(ctx: TenantContext, id: string, domain: string, purchasedAt: number): void {
  ctx.sql.exec(
    `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, connection_type) VALUES (?, ?, ?, 'active', ?, 'purchased')`,
    id,
    ctx.tenantId,
    domain,
    purchasedAt,
  );
}

/** `createdAt` is explicit: releaseMailboxes orders by it DESC, so it decides which row is the HEAD. */
function seedMailbox(ctx: TenantContext, id: string, email: string, createdAt: number): void {
  ctx.sql.exec(
    `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at, provider, slot_counted)
     VALUES (?, ?, 'dom_a', ?, ?, 50, ?, ?, 'google', 1)`,
    id,
    ctx.tenantId,
    email.split("@")[1],
    email,
    createdAt,
    createdAt,
  );
}

function liveMailboxes(ctx: TenantContext): string[] {
  return ctx.sql
    .exec<{ email: string }>(`SELECT email FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL ORDER BY email`, ctx.tenantId)
    .toArray()
    .map((r) => r.email);
}

function actionsFor(ctx: TenantContext, action: string): string[] {
  return ctx.sql
    .exec<{ target: string }>(`SELECT target FROM deliverability_actions WHERE tenant_id = ? AND action = ?`, ctx.tenantId, action)
    .toArray()
    .map((r) => r.target);
}

describe("IN-3 — one unreleasable mailbox must not leave the mailboxes behind it billing", () => {
  it("releases every other mailbox, keeps the stuck one live, and records the failure", async () => {
    const { tenantId } = await mintTenant("Stuck Mbx Co", "managed");
    // ORDER BY created_at DESC, so the NEWEST row is the head of the loop.
    const port = new PartlyStuckMailboxPort("head@stuck.com");

    const result = await withTenantContext(tenantId, async (ctx) => {
      seedDomain(ctx, "dom_a", "stuck.com", Date.now());
      seedMailbox(ctx, "mbx_head", "head@stuck.com", 3_000);
      seedMailbox(ctx, "mbx_mid", "mid@stuck.com", 2_000);
      seedMailbox(ctx, "mbx_tail", "tail@stuck.com", 1_000);
      return releaseMailboxes({ ...ctx, adapters: { ...ctx.adapters, mailbox: port } });
    });

    // Pre-fix: releaseCalls === ["head@stuck.com"] and the call threw, so BOTH
    // healthy mailboxes stayed live and billing on every retry, forever.
    expect(port.releaseCalls).toEqual(["head@stuck.com", "mid@stuck.com", "tail@stuck.com"]);
    expect(result).toEqual({ releasedCount: 2, slotCountedReleased: 2, failedCount: 1 });

    await withTenantContext(tenantId, (ctx) => {
      // Only the mailbox we genuinely could not release still counts.
      expect(liveMailboxes(ctx)).toEqual(["head@stuck.com"]);
      // ...and it is loud, not silent: an unreleased mailbox bills on both sides.
      expect(actionsFor(ctx, "MAILBOX_RELEASE_FAILED")).toEqual(["head@stuck.com"]);
    });
  });
});

describe("IN-4 — one unreleasable domain must not make teardown restart and re-die forever", () => {
  it("tears down the rest, writes the idempotency anchor, and leaves the stuck domain held + recorded", async () => {
    const { tenantId } = await mintTenant("Stuck Dom Co", "managed");
    const port = new PartlyStuckDomainPort("locked.com");
    const now = Date.now();

    const summary = await withTenantContext(tenantId, async (ctx) => {
      seedDomain(ctx, "dom_a", "locked.com", now);
      seedDomain(ctx, "dom_b", "healthy.com", now);
      seedMailbox(ctx, "mbx_1", "a@healthy.com", now);
      return teardownTenant({ ...ctx, adapters: { ...ctx.adapters, domain: port } }, {
        reason: "voluntary_cancel",
        effective: "immediate",
      });
    });

    // Pre-fix: teardownTenant THREW at locked.com. No teardown_records row was
    // written, so the early-return never armed — mailboxes were never released,
    // campaigns never stopped, and the next attempt re-ran the whole thing and
    // re-died at the same domain.
    expect(port.releaseCalls).toEqual(["locked.com", "healthy.com"]);
    expect(summary.domainsReleased).toBe(1); // reclaimed, not merely attempted
    expect(summary.mailboxesReleased).toBe(1); // step 2 was REACHED

    await withTenantContext(tenantId, (ctx) => {
      // The anchor exists, so a re-cancel is a no-op instead of a second run.
      expect(getTeardownSummary(ctx)).not.toBeNull();
      // The stuck domain keeps its status: we still hold it, and the record says so.
      const rows = ctx.sql
        .exec<{ domain: string; status: string }>(`SELECT domain, status FROM domains WHERE tenant_id = ? ORDER BY domain`, ctx.tenantId)
        .toArray();
      expect(rows).toEqual([
        { domain: "healthy.com", status: "released" },
        { domain: "locked.com", status: "active" },
      ]);
      expect(actionsFor(ctx, "DOMAIN_RELEASE_FAILED")).toEqual(["locked.com"]);
      // No liability booked for a domain we never actually gave back.
      const booked = ctx.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM ledger_entries WHERE tenant_id = ? AND kind = 'liability'`, ctx.tenantId)
        .one().n;
      expect(booked).toBe(1);
    });
  });
});
