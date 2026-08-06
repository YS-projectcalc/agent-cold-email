import { describe, expect, it } from "vitest";
import { VendorError, type DnsRecordSet, type DomainPort, type LookalikeCandidate, type OwnedDomain, type PurchasedDomain, type ReleaseResult } from "@coldstart/shared";
import { runSetupInfrastructure } from "../src/engine/provisioning.js";
import { listSurfacedTenantMessages } from "../src/engine/tenant-messages.js";
import { signup, withTenantContext } from "./helpers.js";

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
      return { domain, purchasedAt: Date.now(), registrar: "test-registrar" };
    },
    async setDns(): Promise<DnsRecordSet> {
      throw new VendorError(setDnsMessage, true);
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

    await run();
    await run();
    await run();

    const messages = await withTenantContext(tenantId, (ctx) => listSurfacedTenantMessages(ctx));
    expect(messages).toHaveLength(1);
  });

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
});
