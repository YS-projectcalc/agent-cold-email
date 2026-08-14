// ROADMAP.md:32 — FOUNDER RULED "BYO teardown": NEVER touch a
// customer-connected domain at teardown. Teardown must skip the vendor
// domain-release for connection_type='connected'/BYO domains — remove only
// OUR records/mailboxes; the customer disconnects their own domain
// themselves. This file is the dedicated test surface for that rule (kept
// out of lifecycle-cancel.test.ts — a distinct responsibility, CLAUDE.md
// rule b), asserting on the vendor-call surface itself (a RecordingDomainPort
// capturing every release() call) rather than on internals only — the
// standing trap here is a sandbox port that always succeeds silently, which
// can never prove an ABSENCE of a call.

import { describe, expect, it } from "vitest";
import type {
  CancelWarmupResult,
  DomainDnsResult,
  DomainPort,
  LookalikeCandidate,
  MailboxHealth,
  MailboxPort,
  MailboxReadiness,
  OwnedDomain,
  ProvisionedMailbox,
  PurchasedDomain,
  ReleaseResult,
} from "@coldstart/shared";
import type { OpsEmailMessage, OpsMailer, OpsSendResult } from "../src/ops-mail/ops-mailer.js";
import { registerByoDomain } from "../src/engine/byo-intake.js";
import { releaseMailboxes, teardownTenant } from "../src/engine/lifecycle.js";
import type { TenantContext } from "../src/tenant-context.js";
import { mintTenant, signup, withTenantContext } from "./helpers.js";

/** Every release() call is captured (not just its count) so a test can prove
 * ABSENCE for a specific domain, not merely "fewer calls than domains". */
class RecordingDomainPort implements DomainPort {
  readonly releaseCalls: string[] = [];
  async searchLookalikes(): Promise<LookalikeCandidate[]> {
    return [];
  }
  async listOwnedDomains(): Promise<OwnedDomain[]> {
    return [];
  }
  async buy(): Promise<PurchasedDomain> {
    throw new Error("RecordingDomainPort.buy should never be called by teardownTenant");
  }
  async setDns(): Promise<DomainDnsResult> {
    throw new Error("RecordingDomainPort.setDns should never be called by teardownTenant");
  }
  async release(domain: string, _idempotencyKey: string): Promise<ReleaseResult> {
    this.releaseCalls.push(domain);
    return { released: true, releasedAt: Date.now() };
  }
}

/** Captures every send() so a test can assert an alert fired (or didn't) —
 * `createOpsMailer` picks RealOpsMailer under vitest-pool-workers because
 * Miniflare simulates the `send_email` binding as present/truthy, so tests
 * that care about alert delivery must inject this instead of relying on the
 * ctx.env default. */
class RecordingOpsMailer implements OpsMailer {
  readonly sent: OpsEmailMessage[] = [];
  async send(message: OpsEmailMessage): Promise<OpsSendResult> {
    this.sent.push(message);
    return { messageId: "recorded" };
  }
}

/** Every release() call is captured so a test can prove ABSENCE for a
 * specific mailbox, matching RecordingDomainPort's rationale exactly. */
class RecordingMailboxPort implements MailboxPort {
  readonly releaseCalls: string[] = [];
  async provision(): Promise<ProvisionedMailbox> {
    throw new Error("RecordingMailboxPort.provision should never be called by releaseMailboxes");
  }
  async provisioningState(): Promise<MailboxReadiness> {
    throw new Error("RecordingMailboxPort.provisioningState should never be called by releaseMailboxes");
  }
  async getHealth(): Promise<MailboxHealth> {
    throw new Error("RecordingMailboxPort.getHealth should never be called by releaseMailboxes");
  }
  async startWarmup(): Promise<{ started: boolean; startedAt: number }> {
    throw new Error("RecordingMailboxPort.startWarmup should never be called by releaseMailboxes");
  }
  async cancelWarmup(): Promise<CancelWarmupResult> {
    throw new Error("RecordingMailboxPort.cancelWarmup should never be called by releaseMailboxes");
  }
  async release(email: string, _idempotencyKey: string): Promise<ReleaseResult> {
    this.releaseCalls.push(email);
    return { released: true, releasedAt: Date.now() };
  }
}

function withFakeDomainPort(ctx: TenantContext, port: DomainPort): TenantContext {
  return { ...ctx, adapters: { ...ctx.adapters, domain: port } };
}

function withFakeMailboxPort(ctx: TenantContext, port: MailboxPort): TenantContext {
  return { ...ctx, adapters: { ...ctx.adapters, mailbox: port } };
}

async function seedDomain(ctx: TenantContext, domain: string, connectionType: string | null, purchasedAt: number): Promise<void> {
  ctx.sql.exec(
    `INSERT INTO domains (id, tenant_id, domain, status, purchased_at, connection_type) VALUES (?, ?, ?, 'active', ?, ?)`,
    `dom_${domain.replace(/[^a-z0-9]/g, "")}`,
    ctx.tenantId,
    domain,
    purchasedAt,
    connectionType,
  );
}

async function seedMailbox(ctx: TenantContext, opts: { id: string; domainId: string; email: string; provider: string }): Promise<void> {
  const now = Date.now();
  ctx.sql.exec(
    `INSERT INTO mailboxes (id, tenant_id, domain_id, domain, email, daily_cap, warmup_started_at, created_at, provider)
     VALUES (?, ?, ?, ?, ?, 50, ?, ?, ?)`,
    opts.id,
    ctx.tenantId,
    opts.domainId,
    opts.email.split("@")[1],
    opts.email,
    now,
    now,
    opts.provider,
  );
}

describe("teardownTenant — connection-type-gated domain release (ROADMAP.md:32)", () => {
  it("never calls vendor release for a 'connected' domain, yet still marks it released locally", async () => {
    const { tenantId } = await mintTenant("Byo Teardown Co", "managed");
    const port = new RecordingDomainPort();
    const now = Date.now();

    const summary = await withTenantContext(tenantId, async (ctx) => {
      await seedDomain(ctx, "purchased-co.com", "purchased", now);
      await seedDomain(ctx, "connected-co.com", "connected", now);
      return teardownTenant(withFakeDomainPort(ctx, port), { reason: "voluntary_cancel", effective: "immediate" });
    });

    // The vendor call surface: exactly the purchased domain, never the connected one.
    expect(port.releaseCalls).toEqual(["purchased-co.com"]);
    expect(summary.domainsReleased).toBe(2);

    // Local bookkeeping still completes for BOTH — "remove only OUR records".
    await withTenantContext(tenantId, (ctx) => {
      const rows = ctx.sql
        .exec<{ domain: string; status: string }>(`SELECT domain, status FROM domains WHERE tenant_id = ? ORDER BY domain`, ctx.tenantId)
        .toArray();
      expect(rows).toEqual([
        { domain: "connected-co.com", status: "released" },
        { domain: "purchased-co.com", status: "released" },
      ]);
    });
  });

  it("never books an annual-domain liability for a connected domain — that registration cost was never ours", async () => {
    const { tenantId } = await mintTenant("Byo Liability Co", "managed");
    const port = new RecordingDomainPort();
    const now = Date.now();

    const summary = await withTenantContext(tenantId, async (ctx) => {
      await seedDomain(ctx, "purchased-co.com", "purchased", now);
      await seedDomain(ctx, "connected-co.com", "connected", now);
      return teardownTenant(withFakeDomainPort(ctx, port), { reason: "voluntary_cancel", effective: "immediate" });
    });

    expect(summary.annualDomainLiabilityCents).toBeGreaterThan(0);

    await withTenantContext(tenantId, (ctx) => {
      const row = ctx.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM ledger_entries WHERE tenant_id = ? AND kind = 'liability'`, ctx.tenantId)
        .one();
      // Only the purchased domain's liability is booked, not the connected one's.
      expect(row.n).toBe(1);
    });
  });

  it("'unknown' (NULL connection_type — every BYO row, and any legacy row) is treated as connected: never released, no liability", async () => {
    const { tenantId } = await mintTenant("Byo Unknown Co", "managed");
    const port = new RecordingDomainPort();
    const now = Date.now();

    const summary = await withTenantContext(tenantId, async (ctx) => {
      await seedDomain(ctx, "legacy-co.com", null, now);
      return teardownTenant(withFakeDomainPort(ctx, port), { reason: "voluntary_cancel", effective: "immediate" });
    });

    expect(port.releaseCalls).toEqual([]);
    expect(summary.annualDomainLiabilityCents).toBe(0);
  });

  it("still releases a 'purchased' domain exactly as before (no regression to the existing path)", async () => {
    const { tenantId } = await mintTenant("Byo Purchased Co", "managed");
    const port = new RecordingDomainPort();
    const now = Date.now();

    await withTenantContext(tenantId, async (ctx) => {
      await seedDomain(ctx, "purchased-co.com", "purchased", now);
      return teardownTenant(withFakeDomainPort(ctx, port), { reason: "voluntary_cancel", effective: "immediate" });
    });

    expect(port.releaseCalls).toEqual(["purchased-co.com"]);
  });
});

describe("teardownTenant — unresolved connection type raises a human-actionable alert (ROADMAP.md:32)", () => {
  it("logs an ops-visible action AND sends a founder alert for an 'unknown' domain, but not for an explicit 'connected' one", async () => {
    const { tenantId } = await mintTenant("Byo Alert Co", "managed");
    const port = new RecordingDomainPort();
    const mailer = new RecordingOpsMailer();
    const now = Date.now();

    await withTenantContext(tenantId, async (ctx) => {
      await seedDomain(ctx, "legacy-co.com", null, now);
      await seedDomain(ctx, "connected-co.com", "connected", now);
      return teardownTenant(withFakeDomainPort(ctx, port), { reason: "voluntary_cancel", effective: "immediate" }, undefined, mailer);
    });

    // Exactly one alert, naming the unresolved domain — never the explicitly-connected one.
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.text).toContain("legacy-co.com");
    expect(mailer.sent[0]?.text).not.toContain("connected-co.com");

    await withTenantContext(tenantId, (ctx) => {
      const rows = ctx.sql
        .exec<{ target: string }>(
          `SELECT target FROM deliverability_actions WHERE tenant_id = ? AND action = 'DOMAIN_TEARDOWN_UNRESOLVED_CONNECTION_TYPE'`,
          ctx.tenantId,
        )
        .toArray();
      expect(rows).toEqual([{ target: "legacy-co.com" }]);
    });
  });

  it("teardown never throws on the default (non-injected) mailer path, alert delivery aside", async () => {
    const { tenantId } = await mintTenant("Byo Alert Dark Co", "managed");
    const port = new RecordingDomainPort();
    const now = Date.now();

    // No mailer injected -> production default (createOpsMailer(ctx.env)),
    // which under vitest-pool-workers resolves to RealOpsMailer against
    // Miniflare's simulated send_email binding (wrangler.toml's
    // OPS_ALERT_EMAIL is a real, non-empty value in this env) — this proves
    // teardown's own outcome (release gating + summary) never depends on
    // whether the alert send actually lands.
    const summary = await withTenantContext(tenantId, async (ctx) => {
      await seedDomain(ctx, "legacy-co.com", null, now);
      return teardownTenant(withFakeDomainPort(ctx, port), { reason: "voluntary_cancel", effective: "immediate" });
    });
    expect(summary.domainsReleased).toBe(1);
    expect(port.releaseCalls).toEqual([]);
  });
});

// Closing the class at the root (team-lead follow-up, 2026-08-06): every
// future BYO domain is created by byo-intake.ts's registerByoDomain, which
// previously left connection_type NULL — so every legitimate BYO teardown
// rode the 'unknown' backstop forever, firing a founder alert on a case that
// isn't actually ambiguous at all (we KNOW it's BYO/connected at the moment
// we intake it). The 'unknown' backstop above stays exactly as built, for
// the genuinely ambiguous case (a legacy pre-column row) — this closes the
// one writer that was manufacturing false positives against it.
describe("registerByoDomain stamps connection_type='connected' at intake (closes the false-positive class against the unknown backstop)", () => {
  it("a fresh BYO intake row persists connection_type='connected'", async () => {
    const { tenantId } = await signup("Byo Stamp Co", "stamp@example.com");
    await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "byo-stamp-co.com", domainRelationship: "fresh_standalone" }),
    );

    await withTenantContext(tenantId, (ctx) => {
      const row = ctx.sql
        .exec<{ connection_type: string | null }>(`SELECT connection_type FROM domains WHERE tenant_id = ? AND domain = ?`, ctx.tenantId, "byo-stamp-co.com")
        .one();
      expect(row.connection_type).toBe("connected");
    });
  });

  it("that domain's teardown takes the connected path — no vendor release, no alert, no ops-action row", async () => {
    const { tenantId } = await signup("Byo Stamp Teardown Co", "stamp2@example.com");
    await withTenantContext(tenantId, (ctx) =>
      registerByoDomain(ctx, { domain: "byo-stamp-teardown.com", domainRelationship: "fresh_standalone" }),
    );

    const port = new RecordingDomainPort();
    const mailer = new RecordingOpsMailer();
    const summary = await withTenantContext(tenantId, (ctx) =>
      teardownTenant(withFakeDomainPort(ctx, port), { reason: "voluntary_cancel", effective: "immediate" }, undefined, mailer),
    );

    expect(port.releaseCalls).toEqual([]);
    expect(summary.annualDomainLiabilityCents).toBe(0);
    expect(mailer.sent).toHaveLength(0);

    await withTenantContext(tenantId, (ctx) => {
      const rows = ctx.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) as n FROM deliverability_actions WHERE tenant_id = ? AND action = 'DOMAIN_TEARDOWN_UNRESOLVED_CONNECTION_TYPE'`,
          ctx.tenantId,
        )
        .one();
      expect(rows.n).toBe(0);
    });
  });
});

// Orchestrator ruling (2026-08-06): the founder's teardown principle — "never
// issue a vendor-destructive op against a customer-owned resource" — covers a
// provider='byo' mailbox (byo-mailbox-composition.ts's connectByoMailbox rows,
// the customer's OWN IMAP/SMTP/OAuth connection) exactly as it covers a
// connected domain. Gated at the ROOT (lifecycle.ts's shared releaseMailboxes),
// so both callers below inherit it automatically.
describe("releaseMailboxes — never vendor-releases a provider='byo' mailbox (orchestrator ruling 2026-08-06)", () => {
  it("teardown issues ZERO mailbox.release calls for a byo mailbox, while still releasing a vendor-provisioned sibling and tombstoning its creds", async () => {
    const { tenantId } = await mintTenant("Byo Mailbox Teardown Co", "managed");
    const mailboxPort = new RecordingMailboxPort();
    const now = Date.now();

    await withTenantContext(tenantId, async (ctx) => {
      await seedDomain(ctx, "vendor-owned.com", "purchased", now);
      await seedMailbox(ctx, { id: "mbx_vendor", domainId: "dom_vendorownedcom", email: "sales@vendor-owned.com", provider: "google" });
      await seedMailbox(ctx, { id: "mbx_byo", domainId: "dom_vendorownedcom", email: "sales@byo-connected.com", provider: "byo" });
      // A pushed-credential row for the vendor-provisioned mailbox only — a byo
      // mailbox never goes through the engine credential-push flow at all, so
      // there is nothing to tombstone for it; this just proves the vendor
      // mailbox's tombstone still fires exactly as before.
      ctx.sql.exec(
        `INSERT INTO mailbox_cred_pushes (email, tenant_id, status, created_at, updated_at) VALUES (?, ?, 'pushed', ?, ?)`,
        "sales@vendor-owned.com",
        ctx.tenantId,
        now,
        now,
      );

      const summary = await teardownTenant(withFakeMailboxPort(ctx, mailboxPort), { reason: "voluntary_cancel", effective: "immediate" });
      expect(summary.mailboxesReleased).toBe(2);
    });

    // The vendor call surface: exactly the vendor-provisioned mailbox, never the byo one.
    expect(mailboxPort.releaseCalls).toEqual(["sales@vendor-owned.com"]);

    await withTenantContext(tenantId, (ctx) => {
      const rows = ctx.sql
        .exec<{ email: string; released_at: number | null }>(`SELECT email, released_at FROM mailboxes WHERE tenant_id = ? ORDER BY email`, ctx.tenantId)
        .toArray();
      // Local cleanup (released_at) completes for BOTH, vendor call or not.
      expect(rows.every((r) => r.released_at !== null)).toBe(true);

      const tombstoned = ctx.sql
        .exec<{ status: string }>(`SELECT status FROM mailbox_cred_pushes WHERE tenant_id = ? AND email = ?`, ctx.tenantId, "sales@vendor-owned.com")
        .one();
      expect(tombstoned.status).toBe("revoked");
    });
  });

  it("the REPLACE_DOMAIN call surface (releaseMailboxes scoped to one domainId) likewise never vendor-releases a byo mailbox on that domain", async () => {
    const { tenantId } = await mintTenant("Byo Mailbox Replace Co", "managed");
    const mailboxPort = new RecordingMailboxPort();
    const now = Date.now();

    const result = await withTenantContext(tenantId, async (ctx) => {
      await seedDomain(ctx, "burning-domain.com", "purchased", now);
      await seedMailbox(ctx, { id: "mbx_vendor2", domainId: "dom_burningdomaincom", email: "a@burning-domain.com", provider: "google" });
      await seedMailbox(ctx, { id: "mbx_byo2", domainId: "dom_burningdomaincom", email: "b@burning-domain.com", provider: "byo" });

      // The EXACT call applyReplaceDomain makes (deliverability-actions.ts) —
      // scoped to the one burning domainId.
      return releaseMailboxes(withFakeMailboxPort(ctx, mailboxPort), { domainId: "dom_burningdomaincom" });
    });

    expect(result.releasedCount).toBe(2);
    expect(mailboxPort.releaseCalls).toEqual(["a@burning-domain.com"]);
  });
});
