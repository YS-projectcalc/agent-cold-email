import { describe, expect, it } from "vitest";
import {
  domainDnsResult,
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
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { listSurfacedTenantMessages } from "../src/engine/tenant-messages.js";
import { activatePaidPlan, mintTenant, signup, withTenantContext } from "./helpers.js";

// Wire point A (system->agent message channel, increment 1): when
// setup_infrastructure's setDns retry is exhausted (H2, INCIDENT
// 2026-08-05 — the exact race that stranded goauthorpitchdesk.com), the
// caller sees a RETRYABLE VendorError but previously had no channel to learn
// "retry this" other than a human relaying it. Drives the REAL wire point in
// provisioning.ts's runSetupInfrastructure catch, through the real
// domain-port seam, exactly like test/provisioning-saga.test.ts's H2 test.

/** A DomainPort whose setDns ALWAYS fails — the exhausted-retry case. */
function stuckDnsDomainPort(setDnsMessage: string): DomainPort {
  return {
    async searchLookalikes(): Promise<LookalikeCandidate[]> {
      return [{ domain: "tryretrysetup.com", available: true }];
    },
    async listOwnedDomains(): Promise<OwnedDomain[]> {
      return [];
    },
    async buy(domain: string): Promise<PurchasedDomain> {
      return { domain, purchasedAt: Date.now(), registrar: "test-registrar", connectionType: "purchased" };
    },
    async setDns(): Promise<DomainDnsResult> {
      throw new VendorError(setDnsMessage, true);
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };
}

/**
 * F1 (gate 2026-08-05) — TWO stable candidates so a same-idempotency-key
 * RETRY, which excludes the first-attempt domain from `usable` (it's already
 * owned), still has a SECOND name to satisfy `usable.length >= input.domains`
 * and reach the wire-A catch on the RESUME path — instead of the original
 * single-candidate fixture's `usable=[]` short-circuiting on ValidationError
 * BEFORE wire A is ever exercised (the gate's traced false-green cause).
 * setDns ALWAYS fails (retryable) — exhausted retry on every call.
 */
function multiCandidateStuckDnsDomainPort(): { port: DomainPort; buyCalls: string[] } {
  const buyCalls: string[] = [];
  const port: DomainPort = {
    async searchLookalikes(): Promise<LookalikeCandidate[]> {
      return [
        { domain: "resumelook1.com", available: true },
        { domain: "resumelook2.com", available: true },
      ];
    },
    async listOwnedDomains(): Promise<OwnedDomain[]> {
      return [];
    },
    async buy(domain: string): Promise<PurchasedDomain> {
      buyCalls.push(domain);
      return { domain, purchasedAt: Date.now(), registrar: "test-registrar", connectionType: "purchased" };
    },
    async setDns(): Promise<DomainDnsResult> {
      throw new VendorError("inboxkit domains/nameservers failed: domain not found", true);
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };
  return { port, buyCalls };
}

/** A DomainPort whose DNS is always ready — the domain leg is not the subject here. */
function healthyDomainPort(): DomainPort {
  return {
    async searchLookalikes(): Promise<LookalikeCandidate[]> {
      return [{ domain: "gowireamailbox.com", available: true }];
    },
    async listOwnedDomains(): Promise<OwnedDomain[]> {
      return [];
    },
    async buy(domain: string): Promise<PurchasedDomain> {
      return { domain, purchasedAt: Date.now(), registrar: "test-registrar", connectionType: "purchased" };
    },
    async setDns(): Promise<DomainDnsResult> {
      return domainDnsResult({ kind: "ready" });
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };
}

/**
 * A MailboxPort whose buy is accepted but never finishes provisioning
 * (InboxKit's "scheduled") — exhausts `awaitMailboxReady`'s in-call budget
 * and throws a RETRYABLE VendorError with `step: "mailbox purchase"`
 * (mailbox-provisioning.ts:275). This is the gate's exact repro for finding
 * #2 (docs/adversarial/wave-integration-gate-2026-08-05.md): DNS is already
 * ready, so the ONLY retryable throw reaching wire A's catch is the mailbox
 * leg, not setDnsWithRetry.
 */
function stuckMailboxPort(): MailboxPort {
  return {
    async provision(domain: string, localPart: string): Promise<ProvisionedMailbox> {
      return { email: `${localPart}@${domain}`, provider: "google", provisionedAt: Date.now() };
    },
    async provisioningState(): Promise<MailboxReadiness> {
      return { kind: "not_yet" }; // never reaches 'ready' within the backoff budget
    },
    async startWarmup(): Promise<{ started: boolean; startedAt: number }> {
      throw new Error("startWarmup must never be reached before the mailbox is ready");
    },
    async cancelWarmup(): Promise<CancelWarmupResult> {
      return { cancelled: true, cancelledAt: Date.now() };
    },
    async getHealth(email: string): Promise<MailboxHealth> {
      return { email, reputationScore: 90, bounceRate: 0, complaintRate: 0, placementRate: 1 };
    },
    async release(): Promise<ReleaseResult> {
      return { released: true, releasedAt: Date.now() };
    },
  };
}

const SETUP_INPUT = {
  brand: "Retry Setup Co",
  primaryDomain: "retrysetup.com",
  domains: 1,
  inboxesEach: 1,
  persona: "Sender",
  physicalAddress: "1 St",
  senderIdentity: "S <s@retrysetup.com>",
  quoteOnly: false,
};

describe("retry_setup tenant message — fires when setDns retry is exhausted", () => {
  it("emits kind=retry_setup with actionHint naming the SAME idempotencyKey, and the domain is still on the books (H2 unchanged)", async () => {
    const { tenantId } = await signup("Retry Setup Co", "founder@retrysetup.test");
    const idempotencyKey = "retry-key-1";

    const err = await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain: stuckDnsDomainPort("inboxkit domains/nameservers failed: domain not found") } },
        SETUP_INPUT,
        undefined,
        idempotencyKey,
      ).catch((e: unknown) => e),
    );
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);

    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "retry_setup",
      severity: "action_required",
      source: "system",
      actionHint: { tool: "setup_infrastructure", idempotencyKey },
    });
    // The domain itself is still recorded (H2's own invariant, unaffected).
    const domains = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ domain: string; dns_status: string }>(`SELECT domain, dns_status FROM domains WHERE tenant_id = ?`, tenantId).toArray(),
    );
    expect(domains).toHaveLength(1);
    expect(domains[0]!.dns_status).toBe("pending");
  });

  it("a second retry with the SAME idempotencyKey does not spam a second message (GUARDRAIL A)", async () => {
    const { tenantId } = await signup("Retry Spam Co", "founder@retryspam.test");
    const idempotencyKey = "retry-key-spam";
    const run = () =>
      withTenantContext(tenantId, (base) =>
        runSetupInfrastructure(
          { ...base, adapters: { ...base.adapters, domain: stuckDnsDomainPort("inboxkit domains/nameservers failed: domain not found") } },
          SETUP_INPUT,
          undefined,
          idempotencyKey,
        ).catch((e: unknown) => e),
      );

    const outcomes = [await run(), await run(), await run()];

    // Every attempt has to REACH the wire-A catch for the dedup to be what
    // holds the count at 1. Retries 2 and 3 used to die earlier and cheaper, on
    // the ValidationError this file's own multiCandidateStuckDnsDomainPort
    // comment calls "the gate's traced false-green cause": the single-candidate
    // fixture leaves `usable` empty once attempt 1 owns that name, and the
    // candidate requirement was sized against the whole ask rather than the
    // shortfall. A retry that needs to buy NOTHING no longer needs a candidate
    // at all (BLOCKING-1), so all three now converge onto the same domain, fail
    // the same retryable way, and genuinely exercise GUARDRAIL A.
    for (const outcome of outcomes) {
      expect(outcome).toBeInstanceOf(VendorError);
      expect((outcome as VendorError).retryable).toBe(true);
    }

    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages).toHaveLength(1);
    // Three real DNS retry cycles, each with setDnsWithRetry's in-call backoff.
  }, 20_000);

  it("GUARDRAIL B — the stored body/actionHint never leaks the raw vendor error text or an internal marker", async () => {
    const { tenantId } = await signup("Retry Secret Co", "founder@retrysecret.test");
    // A vendor error message loaded with exactly the shapes guardrail B bans:
    // an internal URL, a private IP, an env-var name, and a token-shaped string.
    const leaky =
      "upstream call to https://internal.inboxkit.example/v2/register failed from 10.4.2.9 " +
      "(check ENGINE_BASE_URL / ACTIVATION.md) token=sk_live_abcdef0123456789ZZZZ";

    await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain: stuckDnsDomainPort(leaky) } },
        SETUP_INPUT,
        undefined,
        "retry-key-secret",
      ).catch(() => undefined),
    );

    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages).toHaveLength(1);
    const stored = `${messages[0]!.body} ${JSON.stringify(messages[0]!.actionHint)}`;
    for (const marker of ["http://", "https://", "10.4.2.9", "ACTIVATION.md", "ENGINE_BASE_URL", "sk_live_abcdef0123456789ZZZZ", "internal.inboxkit.example"]) {
      expect(stored).not.toContain(marker);
    }
  });

  it("F1 (gate 2026-08-05) — a multi-candidate RESUME names the domain the resume branch actually touches, never a fresh unrelated candidate", async () => {
    const { tenantId } = await signup("Resume Multi Co", "founder@resumemulti.test");
    const idempotencyKey = "resume-multi-key";
    const { port, buyCalls } = multiCandidateStuckDnsDomainPort();
    const run = () =>
      withTenantContext(tenantId, (base) =>
        runSetupInfrastructure(
          { ...base, adapters: { ...base.adapters, domain: port } },
          SETUP_INPUT,
          undefined,
          idempotencyKey,
        ).catch((e: unknown) => e),
      );

    // Call 1: buys resumelook1.com; DNS is exhausted -> retry_setup fires
    // naming resumelook1.com (the only candidate this call ever touches).
    const err1 = await run();
    expect(err1).toBeInstanceOf(VendorError);

    // Call 2 — SAME idempotency key, a genuine retry. The ordinal-0 intent is
    // already 'committed' to resumelook1.com (owned), so THIS call's `usable`
    // excludes it and offers resumelook2.com instead — a fresh candidate the
    // resume branch (which re-drives DNS on the committed intent's domain)
    // never touches. DNS is still exhausted.
    const err2 = await run();
    expect(err2).toBeInstanceOf(VendorError);

    // Only ONE real buy ever happened — the resume branch re-drives DNS on the
    // already-owned domain rather than re-buying (H1/H2, unaffected by this fix).
    expect(buyCalls).toEqual(["resumelook1.com"]);

    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    // GUARDRAIL A must collapse across the stuck domain: exactly ONE row, which
    // only holds if both calls' dedupKey named the SAME (real) domain.
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toContain("resumelook1.com");
    // The phantom domain — genuinely never bought on either call — must never
    // appear in a customer-facing message.
    expect(messages[0]!.body).not.toContain("resumelook2.com");
  });

  it("gate finding #2 (2026-08-06) — a MAILBOX-leg retryable failure names the mailbox step, not DNS", async () => {
    // DNS is already ready (healthyDomainPort); the only retryable throw wire A
    // can see is awaitMailboxReady's. The pre-fix message hard-coded DNS prose
    // regardless of which leg actually failed — the exact contradiction the
    // gate executed: REST body step="mailbox purchase", agent message blamed DNS.
    const { tenantId } = await mintTenant("Wire A Mailbox Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const idempotencyKey = "wire-a-mailbox-1";

    const err = await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain: healthyDomainPort(), mailbox: stuckMailboxPort() } },
        { ...SETUP_INPUT, brand: "Wire A Mailbox", primaryDomain: "gowireamailbox.com", senderIdentity: "S <s@gowireamailbox.com>" },
        undefined,
        idempotencyKey,
      ).catch((e: unknown) => e),
    );
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
    expect((err as VendorError).step).toBe("mailbox purchase");

    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.kind).toBe("retry_setup");
    // The two customer surfaces (this message + the REST error's `step`) must
    // agree: the failing leg was the mailbox, never DNS.
    expect(messages[0]!.body).toMatch(/mailbox/i);
    expect(messages[0]!.body).not.toMatch(/DNS/i);
  });

  it("the DNS-leg case still names DNS, unchanged by step-awareness", async () => {
    const { tenantId } = await signup("Retry DNS Still Co", "founder@retrydnsstill.test");
    const err = await withTenantContext(tenantId, (base) =>
      runSetupInfrastructure(
        { ...base, adapters: { ...base.adapters, domain: stuckDnsDomainPort("inboxkit domains/nameservers failed: domain not found") } },
        SETUP_INPUT,
        undefined,
        "retry-key-dns-still",
      ).catch((e: unknown) => e),
    );
    expect(err).toBeInstanceOf(VendorError);

    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toMatch(/DNS/i);
    expect(messages[0]!.body).not.toMatch(/mailbox/i);
  });
});
